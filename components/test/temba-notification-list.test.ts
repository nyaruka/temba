import { expect, oneEvent } from '@open-wc/testing';
import { render } from 'lit';
import { useFakeTimers } from 'sinon';
import { CustomEventType, Notification } from '../src/interfaces';
import { NotificationList } from '../src/list/NotificationList';
import { setRealtimeContext } from '../src/live/Realtime';
import { setSocketProvider, SocketProvider } from '../src/live/SocketService';
import {
  assertScreenshot,
  clearMockPosts,
  getClip,
  getComponent,
  mockPOST,
  MockSocketProvider
} from './utils.test';

let clock: any;
let mockSocket: MockSocketProvider;
let previousProvider: SocketProvider;

const TAG = 'temba-notification-list';
const CHANNEL = 'notifications:org-uuid:user-uuid';
const ENDPOINT = '/test/assets/list/notifications.json';

const createList = async (attrs: any = {}) => {
  return (await getComponent(TAG, attrs, '', 350)) as NotificationList;
};

const getList = async (attrs: any = {}) => {
  attrs['endpoint'] = attrs['endpoint'] || ENDPOINT;
  const list = await createList(attrs);
  await new Promise<void>((resolve) => {
    list.addEventListener(
      CustomEventType.FetchComplete,
      () => {
        resolve();
      },
      { once: true }
    );
  });
  await list.updateComplete;
  return list;
};

const newNotification = (id: number, seen = false): Notification => {
  return {
    type: 'export:finished',
    created_on: '2021-03-31T00:00:00.000000Z',
    url: `/notification/read/${id}/`,
    is_seen: seen,
    export: {
      type: 'message',
      num_records: 35
    }
  };
};

describe('temba-notification-list', () => {
  beforeEach(() => {
    clock = useFakeTimers();
    clearMockPosts();
    mockSocket = new MockSocketProvider();
    previousProvider = setSocketProvider(mockSocket);
    setRealtimeContext({ org: 'org-uuid', user: 'user-uuid' });
  });

  afterEach(() => {
    setRealtimeContext(null);
    setSocketProvider(previousProvider);
    clock.restore();
  });

  it('renders items from the endpoint', async () => {
    const list = await getList();
    expect(list.items.length).to.equal(3);
    await assertScreenshot('list/notifications', getClip(list));
  });

  it('shows an empty message when there are no notifications', async () => {
    const list = await getList({
      endpoint: '/test/assets/list/notifications-empty.json'
    });
    expect(list.items.length).to.equal(0);

    const options = list.shadowRoot.querySelector('temba-options');
    await (options as any).updateComplete;
    const empty = options.shadowRoot.querySelector('.no-options');
    expect(empty.textContent.trim()).to.equal('No notifications');
    await assertScreenshot('list/notifications-empty', getClip(list));
  });

  it('subscribes to the notifications channel', async () => {
    const list = await getList();
    expect(mockSocket.activeChannels()).to.deep.equal([CHANNEL]);

    // and unsubscribes when removed from the dom
    list.remove();
    expect(mockSocket.activeChannels()).to.deep.equal([]);
  });

  it('does not poll', async () => {
    const list = await getList();

    // flush the initial subscribe confirmation
    clock.tick(0);

    const refreshKey = list.refreshKey;
    clock.tick(30000);
    expect(list.refreshKey).to.equal(refreshKey);
  });

  it('prepends publications and fires an event', async () => {
    const list = await getList();

    const eventReceived = oneEvent(
      list,
      CustomEventType.NotificationReceived,
      false
    );
    mockSocket.publish(CHANNEL, newNotification(4));

    const event = await eventReceived;
    expect(event.detail.notification.url).to.equal('/notification/read/4/');

    await list.updateComplete;
    expect(list.items.length).to.equal(4);
    expect(list.items[0].url).to.equal('/notification/read/4/');
    await assertScreenshot('list/notifications-published', getClip(list));
  });

  it('shows the title of incident types it has no message for', async () => {
    const list = await getList();
    const container = document.createElement('div');
    render(
      list.renderOption(
        {
          type: 'incident:started',
          created_on: '2021-03-31T00:00:00.000000Z',
          url: '/notification/read/5/',
          is_seen: false,
          incident: {
            type: 'custom:problem',
            title: 'Something Went Wrong',
            started_on: '2021-03-31T00:00:00.000000Z'
          }
        },
        false
      ),
      container
    );

    expect(container.textContent).to.contain('Something Went Wrong');
    expect(container.querySelector('temba-icon')).to.exist;
  });

  it('dedupes publications by url', async () => {
    const list = await getList();

    mockSocket.publish(CHANNEL, newNotification(4));
    mockSocket.publish(CHANNEL, newNotification(4));
    await list.updateComplete;

    expect(list.items.length).to.equal(4);
    expect(list.items[0].url).to.equal('/notification/read/4/');
  });

  it('buffers publications that arrive before the initial fetch', async () => {
    const list = await createList({ endpoint: ENDPOINT });

    // publish while the initial fetch is still in flight, including a dupe
    // of something in the fetch itself
    mockSocket.publish(CHANNEL, newNotification(4));
    mockSocket.publish(CHANNEL, newNotification(3));

    await new Promise<void>((resolve) => {
      list.addEventListener(
        CustomEventType.FetchComplete,
        () => {
          resolve();
        },
        { once: true }
      );
    });
    await list.updateComplete;

    // both applied, neither duplicated
    expect(list.items.length).to.equal(4);
    expect(list.items[0].url).to.equal('/notification/read/3/');
    expect(list.items[1].url).to.equal('/notification/read/4/');
  });

  it('keeps published items through a reconnect refetch', async () => {
    const list = await getList();
    clock.tick(0);

    // a notification arrives, then the connection bounces and the catch-up
    // refetch merges page one - the published item must survive
    mockSocket.publish(CHANNEL, newNotification(4));
    await list.updateComplete;

    mockSocket.subs[0].onSubscribed();
    await new Promise<void>((resolve) => {
      list.addEventListener(
        CustomEventType.Refreshed,
        () => {
          resolve();
        },
        { once: true }
      );
    });
    await list.updateComplete;

    expect(list.items.length).to.equal(4);
    expect(
      list.items.some((item) => item.url === '/notification/read/4/')
    ).to.equal(true);
  });

  it('marks seen without refetching, unbolding on the next call', async () => {
    mockPOST(/test\/assets\/list\/notifications\.json/, {});
    const list = await getList();

    // one unseen item from the fetch, plus one arriving over the socket
    mockSocket.publish(CHANNEL, newNotification(4));
    await list.updateComplete;
    expect(list.items.filter((item) => !item.is_seen).length).to.equal(2);

    const fetchCount = (window.fetch as any).getCalls().length;

    // first viewing marks them seen on the server but they stay bold
    list.markSeen();
    await list.updateComplete;
    expect(list.items.filter((item) => !item.is_seen).length).to.equal(2);

    const calls = (window.fetch as any).getCalls().slice(fetchCount);
    expect(calls.length).to.equal(1);
    expect(calls[0].args[1]?.method).to.equal('DELETE');

    // the next viewing unbolds them, and with nothing newly unseen there's
    // no request at all
    list.markSeen();
    await list.updateComplete;
    expect(list.items.filter((item) => !item.is_seen).length).to.equal(0);
    expect((window.fetch as any).getCalls().length).to.equal(fetchCount + 1);
  });

  it('keeps items bold and retries when marking seen fails', async () => {
    mockPOST(/test\/assets\/list\/notifications\.json/, {}, {}, '500');
    const list = await getList();

    const fetchCount = (window.fetch as any).getCalls().length;

    // the server refuses, so nothing advances
    expect(await list.markSeen()).to.equal(false);
    expect(await list.markSeen()).to.equal(false);
    await list.updateComplete;
    expect(list.items.filter((item) => !item.is_seen).length).to.equal(1);

    // and each call retried the delete
    const deletes = (window.fetch as any)
      .getCalls()
      .slice(fetchCount)
      .filter((call: any) => call.args[1]?.method === 'DELETE');
    expect(deletes.length).to.equal(2);
  });

  it('refetches on resubscribe but not on the initial subscribe', async () => {
    const list = await getList();

    // the initial subscribe confirmation typically arrives after the fetch
    // has already completed - it should never trigger a second fetch
    const refreshKey = list.refreshKey;
    clock.tick(0);
    expect(list.refreshKey).to.equal(refreshKey);

    // but a reconnect should refetch to catch up
    mockSocket.subs[0].onSubscribed();
    expect(list.refreshKey).to.not.equal(refreshKey);
  });
});
