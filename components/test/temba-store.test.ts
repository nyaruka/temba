import { aTimeout, assert, fixture } from '@open-wc/testing';
import { ASSET_CACHE_SIZE, Store } from '../src/store/Store';
import { getDependencyResolver } from '../src/store/AppState';
import {
  setRealtimeContext,
  subscribeToNotifications
} from '../src/live/Realtime';
import { setSocketProvider } from '../src/live/SocketService';
import {
  clearMockPosts,
  mockAssetResolver,
  mockPOST,
  MockSocketProvider
} from './utils.test';

const createStore = async (def: string): Promise<Store> => {
  const store = (await fixture(def)) as Store;
  await store.initialHttpComplete;
  return store;
};

// bodies of every asset request made to the given endpoint so far
const assetRequests = (endpoint: string): any[] =>
  (window.fetch as any)
    .getCalls()
    .filter((call) => `${call.args[0]}`.includes(endpoint))
    .map((call) => JSON.parse(call.args[1].body));

describe('temba-store', () => {
  afterEach(() => {
    clearMockPosts();
  });

  it('is defined', async () => {
    const store = await createStore('<temba-store></temba-store>');
    assert.instanceOf(store, Store);
  });

  it('completion schema', async () => {
    const store: Store = await createStore(
      "<temba-store completion='/test/assets/store/editor.json'></temba-store>"
    );
    assert.equal(store.getCompletionSchema().types.length, 16);
    assert.equal(store.getFunctions().length, 80);
  });

  it('globals', async () => {
    const store: Store = await createStore(
      "<temba-store globals='/test/assets/store/globals.json'></temba-store>"
    );
    assert.equal(store.getKeyedAssets().globals.length, 2);
  });

  it('fields', async () => {
    const store: Store = await createStore(
      "<temba-store fields='/test/assets/store/fields.json'></temba-store>"
    );

    assert.equal(store.getKeyedAssets().fields.length, 8);
  });

  it('exposes postUrl', async () => {
    const store = await createStore('<temba-store></temba-store>');
    const response = await store.postUrl('/no-endpoint');
    assert.equal(response.status, 404);
  });

  it('sets the realtime context from org and user', async () => {
    const mockSocket = new MockSocketProvider();
    const previousProvider = setSocketProvider(mockSocket);

    try {
      // subscribe before the store exists, it should be waiting on context
      subscribeToNotifications(() => {});
      assert.deepEqual(mockSocket.activeChannels(), []);

      await createStore(
        "<temba-store org='org-uuid' user='user-uuid'></temba-store>"
      );
      assert.deepEqual(mockSocket.activeChannels(), [
        'notifications:org-uuid:user-uuid',
        'org:org-uuid'
      ]);
    } finally {
      setRealtimeContext(null);
      setSocketProvider(previousProvider);
    }
  });

  it('tells the page when the session loses the workspace', async () => {
    const mockSocket = new MockSocketProvider();
    const previousProvider = setSocketProvider(mockSocket);

    let lost = 0;
    const onLost = () => lost++;
    document.addEventListener('temba-workspace-access-lost', onLost);

    try {
      await createStore(
        "<temba-store org='org-uuid' user='user-uuid'></temba-store>"
      );

      // say the session switched workspace in another tab
      mockSocket.serverDeny('org:org-uuid');
      assert.equal(lost, 1);
    } finally {
      document.removeEventListener('temba-workspace-access-lost', onLost);
      setRealtimeContext(null);
      setSocketProvider(previousProvider);
    }
  });

  it('lazily resolves assets once and fans out organization changes', async () => {
    const mockSocket = new MockSocketProvider();
    const previousProvider = setSocketProvider(mockSocket);
    const flowUuid = '11111111-1111-4111-8111-111111111111';
    const groupUuid = '3da236a9-9eed-4db3-a18e-cfb58030c249';
    const contactUuid = '22222222-2222-4222-8222-222222222222';

    try {
      mockAssetResolver();
      const store = await createStore(`
        <temba-store
          org="org-uuid"
          user="user-uuid"
          assets="/test/assets/store/assets.json"
        ></temba-store>
      `);
      const events = [];
      store.watchAssets(
        [
          { type: 'flow', uuid: flowUuid },
          { type: 'group', uuid: groupUuid },
          { type: 'contact', uuid: contactUuid }
        ],
        (event) => events.push(event)
      );
      await Promise.resolve();

      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: {
          type: 'flow',
          uuid: '99999999-9999-4999-8999-999999999999',
          name: 'Unrelated'
        }
      });
      assert.isNull(
        store.getAsset('flow', '99999999-9999-4999-8999-999999999999')
      );
      assert.deepEqual(events, [null]);

      assert.isNull(store.getAsset('flow', flowUuid));

      const requested = [
        {
          type: 'flow',
          uuid: flowUuid
        },
        {
          type: 'group',
          uuid: groupUuid
        },
        {
          type: 'contact',
          uuid: contactUuid
        }
      ];
      const assetRequestsBefore = (window.fetch as any)
        .getCalls()
        .filter((call) =>
          `${call.args[0]}`.includes('/store/assets.json')
        ).length;
      const first = await store.resolveAssets(requested);
      const second = await store.resolveAssets(requested);
      const assetRequests = (window.fetch as any)
        .getCalls()
        .filter((call) => `${call.args[0]}`.includes('/store/assets.json'));
      const request = assetRequests[assetRequests.length - 1];
      assert.equal(assetRequests.length, assetRequestsBefore + 1);
      assert.equal(request.args[1].method, 'POST');
      assert.deepEqual(JSON.parse(request.args[1].body), {
        flow: [flowUuid],
        group: [groupUuid],
        contact: [contactUuid]
      });

      assert.equal(store.getAsset('flow', flowUuid).name, 'Current Child Flow');
      assert.equal(store.getAsset('group', groupUuid).name, 'Farmers');
      assert.equal(store.getAsset('contact', contactUuid).name, 'Alice');
      assert.deepEqual(second, first);
      assert.deepEqual(events, [null]);

      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: {
          type: 'group',
          uuid: '3da236a9-9eed-4db3-a18e-cfb58030c249',
          name: 'Customers'
        }
      });

      assert.equal(events.length, 2);
      assert.equal(events[1].asset.name, 'Customers');
      assert.equal(
        store.getAsset('group', '3da236a9-9eed-4db3-a18e-cfb58030c249').name,
        'Customers'
      );
    } finally {
      setRealtimeContext(null);
      setSocketProvider(previousProvider);
    }
  });

  it('splits a large request into batches the endpoint accepts', async () => {
    const endpoint = '/test/assets/store/assets-batch.json';
    mockPOST(/assets-batch\.json/, { results: [] });
    const store = await createStore(
      `<temba-store assets="${endpoint}"></temba-store>`
    );

    const uuids = Array.from({ length: 150 }, (_, index) => `flow-${index}`);
    await store.resolveAssets(uuids.map((uuid) => ({ type: 'flow', uuid })));

    const requests = assetRequests(endpoint);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].flow.length, 100);
    assert.equal(requests[1].flow.length, 50);
    assert.deepEqual(
      [...requests[0].flow, ...requests[1].flow].sort(),
      [...uuids].sort()
    );
  });

  it('remembers identities the endpoint had no asset for', async () => {
    const endpoint = '/test/assets/store/assets-missing.json';
    mockPOST(/assets-missing\.json/, { results: [] });
    const store = await createStore(
      `<temba-store assets="${endpoint}"></temba-store>`
    );

    const reference = { type: 'flow', uuid: 'deleted-flow' };
    await store.resolveAssets([reference]);
    await store.resolveAssets([reference]);

    assert.equal(assetRequests(endpoint).length, 1);
    assert.isNull(store.getAsset('flow', 'deleted-flow'));
  });

  it('does not negatively cache identities a rejected request covered', async () => {
    const endpoint = '/test/assets/store/assets-error.json';
    // a 4xx resolves with an empty body rather than raising
    mockPOST(/assets-error\.json/, { error: 'nope' }, {}, '400');
    const store = await createStore(
      `<temba-store assets="${endpoint}"></temba-store>`
    );

    const reference = { type: 'flow', uuid: 'flow-1' };
    await store.resolveAssets([reference]);
    assert.equal(assetRequests(endpoint).length, 1);
    assert.isNull(store.getAsset('flow', 'flow-1'));

    clearMockPosts();
    mockPOST(/assets-error\.json/, {
      results: [{ type: 'flow', uuid: 'flow-1', name: 'Registration' }]
    });
    await store.resolveAssets([reference]);

    assert.equal(assetRequests(endpoint).length, 2);
    assert.equal(store.getAsset('flow', 'flow-1').name, 'Registration');
  });

  it('shares a single request between concurrent callers', async () => {
    const endpoint = '/test/assets/store/assets-concurrent.json';
    mockPOST(/assets-concurrent\.json/, {
      results: [{ type: 'group', uuid: 'group-1', name: 'Farmers' }]
    });
    const store = await createStore(
      `<temba-store assets="${endpoint}"></temba-store>`
    );

    const reference = { type: 'group', uuid: 'group-1' };
    const [first, second] = await Promise.all([
      store.resolveAssets([reference]),
      store.resolveAssets([reference])
    ]);

    assert.equal(assetRequests(endpoint).length, 1);
    assert.deepEqual(first, second);
    assert.equal(first[0].name, 'Farmers');
  });

  it('keeps a rename that arrives while a request is in flight', async () => {
    const endpoint = '/test/assets/store/assets-race.json';
    const groupUuid = 'group-1';
    const mockSocket = new MockSocketProvider();
    const previousProvider = setSocketProvider(mockSocket);

    try {
      mockPOST(/assets-race\.json/, {
        results: [{ type: 'group', uuid: groupUuid, name: 'Stale name' }]
      });
      const store = await createStore(`
        <temba-store
          org="org-uuid"
          user="user-uuid"
          assets="${endpoint}"
        ></temba-store>
      `);

      const pending = store.resolveAssets([{ type: 'group', uuid: groupUuid }]);
      // the response was already on the wire when this rename landed
      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: { type: 'group', uuid: groupUuid, name: 'Renamed' }
      });
      await pending;

      assert.equal(store.getAsset('group', groupUuid).name, 'Renamed');
    } finally {
      setRealtimeContext(null);
      setSocketProvider(previousProvider);
    }
  });

  it('matches a normalized uuid back to the reference that asked for it', async () => {
    const endpoint = '/test/assets/store/assets-uuid.json';
    const canonical = '11111111-1111-4111-8111-111111111111';
    // the endpoint normalizes uuids and echoes the normalized form
    mockPOST(/assets-uuid\.json/, {
      results: [{ type: 'flow', uuid: canonical, name: 'Registration' }]
    });
    const store = await createStore(
      `<temba-store assets="${endpoint}"></temba-store>`
    );

    const embedded = canonical.toUpperCase();
    const resolved = await store.resolveAssets([
      { type: 'flow', uuid: embedded }
    ]);

    assert.deepEqual(
      resolved.map((asset) => asset.name),
      ['Registration']
    );
    assert.equal(store.getAsset('flow', embedded).name, 'Registration');
    assert.equal(store.getAsset('flow', canonical).name, 'Registration');

    // and it isn't asked for a second time
    await store.resolveAssets([{ type: 'flow', uuid: embedded }]);
    assert.equal(assetRequests(endpoint).length, 1);
  });

  it('returns the names it has when a batch fails', async () => {
    const endpoint = '/test/assets/store/assets-partial.json';
    mockPOST(/assets-partial\.json/, {
      results: [{ type: 'flow', uuid: 'flow-1', name: 'Registration' }]
    });
    const store = await createStore(
      `<temba-store assets="${endpoint}"></temba-store>`
    );
    await store.resolveAssets([{ type: 'flow', uuid: 'flow-1' }]);

    clearMockPosts();
    mockPOST(/assets-partial\.json/, { detail: 'boom' }, {}, '500');
    const resolved = await store.resolveAssets([
      { type: 'flow', uuid: 'flow-1' },
      { type: 'flow', uuid: 'flow-2' }
    ]);

    assert.deepEqual(
      resolved.map((asset) => asset.name),
      ['Registration']
    );

    // the failed identity isn't remembered as resolved, so it can be retried
    clearMockPosts();
    mockPOST(/assets-partial\.json/, {
      results: [{ type: 'flow', uuid: 'flow-2', name: 'Follow up' }]
    });
    await store.resolveAssets([{ type: 'flow', uuid: 'flow-2' }]);
    assert.equal(store.getAsset('flow', 'flow-2').name, 'Follow up');
  });

  it('drops the oldest entries once the cache is full', async () => {
    const store = await createStore('<temba-store></temba-store>');
    store.cacheAssets(
      Array.from({ length: ASSET_CACHE_SIZE + 1 }, (_, index) => ({
        type: 'flow' as const,
        uuid: `flow-${index}`,
        name: `Flow ${index}`
      }))
    );

    // the evicted identity reads as unknown, so components keep the name their
    // own response carried
    assert.isNull(store.getAsset('flow', 'flow-0'));
    assert.equal(
      store.getAsset('flow', `flow-${ASSET_CACHE_SIZE}`).name,
      `Flow ${ASSET_CACHE_SIZE}`
    );
  });

  it('keeps a page-authoritative name written while a request is in flight', async () => {
    const endpoint = '/test/assets/store/assets-cached.json';
    mockPOST(/assets-cached\.json/, {
      results: [{ type: 'flow', uuid: 'flow-1', name: 'Stale name' }]
    });
    const store = await createStore(
      `<temba-store assets="${endpoint}"></temba-store>`
    );

    const pending = store.resolveAssets([{ type: 'flow', uuid: 'flow-1' }]);
    // a list whose own response carries canonical names seeds the cache while
    // the batch above is still on the wire
    store.cacheAssets([{ type: 'flow', uuid: 'flow-1', name: 'Fresh name' }]);
    await pending;

    assert.equal(store.getAsset('flow', 'flow-1').name, 'Fresh name');
  });

  it('refreshes watched assets when the socket resubscribes', async () => {
    const endpoint = '/test/assets/store/assets-reconnect.json';
    const groupUuid = 'group-1';
    const mockSocket = new MockSocketProvider();
    const previousProvider = setSocketProvider(mockSocket);

    try {
      mockPOST(/assets-reconnect\.json/, {
        results: [{ type: 'group', uuid: groupUuid, name: 'First' }]
      });
      const store = await createStore(`
        <temba-store
          org="org-uuid"
          user="user-uuid"
          assets="${endpoint}"
        ></temba-store>
      `);
      const events = [];
      store.watchAssets([{ type: 'group', uuid: groupUuid }], (event) =>
        events.push(event)
      );
      // let the initial subscription confirm
      await aTimeout(0);
      await store.resolveAssets([{ type: 'group', uuid: groupUuid }]);
      assert.equal(store.getAsset('group', groupUuid).name, 'First');
      assert.equal(assetRequests(endpoint).length, 1);

      clearMockPosts();
      mockPOST(/assets-reconnect\.json/, {
        results: [{ type: 'group', uuid: groupUuid, name: 'Second' }]
      });

      // a reconnect confirms the subscription again
      const organizationSub = mockSocket.subs.find(
        (sub) => sub.channel === 'org:org-uuid'
      );
      organizationSub.onSubscribed();
      await aTimeout(50);

      assert.equal(assetRequests(endpoint).length, 2);
      assert.deepEqual(assetRequests(endpoint)[1], { group: [groupUuid] });
      assert.equal(store.getAsset('group', groupUuid).name, 'Second');
      // watchers are told to reapply everything after a refresh
      assert.equal(events.length, 2);
      assert.isNull(events[1]);
    } finally {
      setRealtimeContext(null);
      setSocketProvider(previousProvider);
    }
  });

  it('ignores an interest with no identifier', async () => {
    const mockSocket = new MockSocketProvider();
    const previousProvider = setSocketProvider(mockSocket);

    try {
      const store = await createStore(
        "<temba-store org='org-uuid' user='user-uuid'></temba-store>"
      );
      const events = [];
      store.watchAssets([{ type: 'group' }], (event) => events.push(event));
      await aTimeout(0);

      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: { type: 'group', uuid: 'group-1', name: 'Customers' }
      });

      // only the initial eventless delivery, no wildcard match
      assert.deepEqual(events, [null]);
    } finally {
      setRealtimeContext(null);
      setSocketProvider(previousProvider);
    }
  });

  it('caches groups created since its fetch from the socket', async () => {
    const mockSocket = new MockSocketProvider();
    const previousProvider = setSocketProvider(mockSocket);

    try {
      const store = await createStore(`
        <temba-store
          org="org-uuid"
          user="user-uuid"
          groups="/test-assets/store/groups.json"
        ></temba-store>
      `);
      const reminders = '512e36c1-9101-4ca2-aceb-e638c520bf0c';
      const openTickets = '12e583b3-46f5-4d9d-85ca-15fb6153c1a0';

      assert.isFalse(store.isDynamicGroup(reminders));
      assert.isTrue(store.isDynamicGroup(openTickets));

      // a group we've never heard of can only be assumed smart
      assert.isTrue(store.isDynamicGroup('manual-1'));
      assert.isTrue(store.isDynamicGroup('smart-1'));

      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: {
          type: 'group',
          uuid: 'manual-1',
          name: 'Customers',
          query: null
        }
      });
      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: {
          type: 'group',
          uuid: 'smart-1',
          name: 'Adults',
          query: 'age > 18'
        }
      });

      assert.isFalse(store.isDynamicGroup('manual-1'));
      assert.isTrue(store.isDynamicGroup('smart-1'));

      // an event which doesn't say whether the group has a query can't add it
      mockSocket.serverPublish('org:org-uuid', {
        type: 'asset_changed',
        asset: { type: 'group', uuid: 'manual-2', name: 'Farmers' }
      });

      assert.isTrue(store.isDynamicGroup('manual-2'));
    } finally {
      setRealtimeContext(null);
      setSocketProvider(previousProvider);
    }
  });

  it('leaves the live resolver alone when an unrendered store is removed', async () => {
    const store = await createStore('<temba-store></temba-store>');
    const installed = getDependencyResolver();
    assert.isNotNull(installed);

    // created and removed before it ever rendered
    const orphan = document.createElement('temba-store');
    document.body.appendChild(orphan);
    orphan.remove();

    assert.equal(getDependencyResolver(), installed);
    assert.deepEqual(await installed([]), []);
    assert.deepEqual(await store.resolveAssets([]), []);
  });
});
