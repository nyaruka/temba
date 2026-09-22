import { assert } from '@open-wc/testing';
import {
  onWorkspaceAccessLost,
  setRealtimeContext,
  setRealtimeTabsChannel,
  subscribeToContactHistory,
  subscribeToFlow,
  subscribeToNotifications,
  subscribeToOrganization
} from '../src/live/Realtime';
import { setSocketProvider, SocketProvider } from '../src/live/SocketService';
import { MockSocketProvider } from './utils.test';

describe('temba-realtime', () => {
  let mockSocket: MockSocketProvider;
  let previousProvider: SocketProvider;

  beforeEach(() => {
    mockSocket = new MockSocketProvider();
    previousProvider = setSocketProvider(mockSocket);
  });

  afterEach(() => {
    setRealtimeContext(null);
    setSocketProvider(previousProvider);
  });

  it('subscribes to notifications immediately when context is known', () => {
    setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });

    const received = [];
    subscribeToNotifications((notification) => received.push(notification));

    assert.deepEqual(mockSocket.activeChannels(), [
      'notifications:org-uuid:user-uuid'
    ]);

    mockSocket.publish('notifications:org-uuid:user-uuid', {
      type: 'export:finished',
      url: '/notification/read/1/'
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'export:finished');
  });

  it('queues notification subscriptions until context arrives', (done) => {
    let subscribed = false;
    subscribeToNotifications(
      () => {},
      () => {
        subscribed = true;
      }
    );

    // nothing yet, we don't know our channel
    assert.deepEqual(mockSocket.activeChannels(), []);

    setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });
    assert.deepEqual(mockSocket.activeChannels(), [
      'notifications:org-uuid:user-uuid'
    ]);

    // the mock confirms subscriptions asynchronously
    setTimeout(() => {
      assert.isTrue(subscribed);
      done();
    }, 0);
  });

  it('subscribes to the current organization when context is known', () => {
    setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });
    const received = [];
    subscribeToOrganization((event) => received.push(event));

    assert.deepEqual(mockSocket.activeChannels(), ['org:org-uuid']);
    mockSocket.serverPublish('org:org-uuid', {
      type: 'asset_changed',
      asset: { type: 'flow', uuid: 'flow-1', name: 'Registration' }
    });
    assert.equal(received[0].asset.name, 'Registration');
  });

  it('never subscribes when unsubscribed while pending', () => {
    const sub = subscribeToNotifications(() => {});
    sub.unsubscribe();

    setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });
    assert.deepEqual(mockSocket.activeChannels(), []);
  });

  it('unsubscribes an activated pending subscription', () => {
    const sub = subscribeToNotifications(() => {});
    setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });
    assert.deepEqual(mockSocket.activeChannels(), [
      'notifications:org-uuid:user-uuid'
    ]);

    sub.unsubscribe();
    assert.deepEqual(mockSocket.activeChannels(), []);
  });

  it('subscribes to contact history without context', () => {
    subscribeToContactHistory('contact-uuid', null, () => {});
    subscribeToContactHistory('contact-uuid', 'ticket-uuid', () => {});

    assert.deepEqual(mockSocket.activeChannels(), [
      'history:contact-uuid',
      'history:contact-uuid:ticket-uuid'
    ]);
  });

  it('subscribes to a flow without context', () => {
    const received = [];
    subscribeToFlow('flow-uuid', (event) => received.push(event));

    assert.deepEqual(mockSocket.activeChannels(), ['flow:flow-uuid']);
    mockSocket.serverPublish('flow:flow-uuid', { type: 'activity' });
    assert.deepEqual(received, [{ type: 'activity' }]);
  });

  describe('workspace access', () => {
    // stands in for another tab in the same browser, on a channel of our own
    // as the other test files are tabs of it too
    const tabsChannel = 'temba-realtime-test';
    let previousTabsChannel: string;
    let otherTab: BroadcastChannel;

    beforeEach(() => {
      previousTabsChannel = setRealtimeTabsChannel(tabsChannel);
      otherTab = new BroadcastChannel(tabsChannel);
    });

    afterEach(() => {
      otherTab.close();
      setRealtimeTabsChannel(previousTabsChannel);
    });

    // a broadcast lands on a later task, so give it a moment
    const delivered = () => new Promise((resolve) => setTimeout(resolve, 50));

    it('is lost when the server refuses one of the page channels', () => {
      setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });

      let lost = 0;
      onWorkspaceAccessLost(() => lost++);

      mockSocket.serverDeny('org:org-uuid');
      assert.equal(lost, 1);

      // and only the once
      mockSocket.serverDeny('notifications:org-uuid:user-uuid');
      assert.equal(lost, 1);
    });

    it('is not lost over a channel that can be refused on its own', () => {
      setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });

      let lost = 0;
      onWorkspaceAccessLost(() => lost++);

      mockSocket.serverDeny('history:contact-uuid');
      mockSocket.serverDeny('org:other-org-uuid');
      assert.equal(lost, 0);
    });

    it('tells a handler that arrives after the fact', async () => {
      setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });
      mockSocket.serverDeny('org:org-uuid');

      let lost = 0;
      onWorkspaceAccessLost(() => lost++);
      assert.equal(lost, 0);

      await Promise.resolve();
      assert.equal(lost, 1);
    });

    it('stops telling a handler once it unsubscribes', () => {
      setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });

      let lost = 0;
      onWorkspaceAccessLost(() => lost++).unsubscribe();

      mockSocket.serverDeny('org:org-uuid');
      assert.equal(lost, 0);
    });

    it('tells other tabs whose page it is', async () => {
      const heard = [];
      otherTab.onmessage = (event) => heard.push(event.data);

      setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });
      await delivered();

      assert.deepEqual(heard, [{ org: 'org-uuid', user: 'user-uuid' }]);
    });

    it('rechecks its channels when another tab is in a different workspace', async () => {
      setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });

      let lost = 0;
      onWorkspaceAccessLost(() => lost++);

      otherTab.postMessage({ org: 'other-org-uuid', user: 'user-uuid' });
      await delivered();

      assert.deepEqual(mockSocket.rechecked, [
        'org:org-uuid',
        'notifications:org-uuid:user-uuid'
      ]);

      // hearing from the tab is only a reason to ask the server
      assert.equal(lost, 0);
    });

    it('ignores another tab in the same workspace', async () => {
      setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });

      otherTab.postMessage({ org: 'org-uuid', user: 'user-uuid' });
      otherTab.postMessage(null);
      await delivered();

      assert.deepEqual(mockSocket.rechecked, []);
    });
  });
});
