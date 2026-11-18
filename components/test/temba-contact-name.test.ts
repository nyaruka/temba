import { assert } from '@open-wc/testing';
import { ContactName } from '../src/display/ContactName';
import { Events } from '../src/events/eventRenderers';
import { CustomEventType } from '../src/interfaces';
import { resetContactWatches, watchContact } from '../src/live/ContactWatch';
import { setSocketProvider, SocketProvider } from '../src/live/SocketService';
import {
  assertScreenshot,
  clearMockGets,
  getClip,
  getComponent,
  loadStore,
  mockGET,
  MockSocketProvider,
  waitForCondition
} from './utils.test';

const TAG = 'temba-contact-name';
const CONTACT = 'contact-dave-active';
const CHANNEL = `history:${CONTACT}`;

const getContactName = async (attrs: any = {}) => {
  return (await getComponent(TAG, attrs)) as ContactName;
};

describe(TAG, () => {
  let mockSocket: MockSocketProvider;
  let previousProvider: SocketProvider;

  beforeEach(async () => {
    mockSocket = new MockSocketProvider();
    previousProvider = setSocketProvider(mockSocket);
    // first match wins, so drop anything a previous test re-mocked
    clearMockGets();
    mockGET(
      /\/api\/v2\/contacts\.json\?expand_urns=true&urn_order=priority&uuid=contact-dave-active/,
      '/test/assets/contacts/contact-dave-active'
    );
    await loadStore();
  });

  afterEach(() => {
    resetContactWatches();
    setSocketProvider(previousProvider);
  });

  it('renders an explicitly set name without watching', async () => {
    const name = await getContactName({ name: 'Dave Matthews' });
    assert.include(
      name.shadowRoot.querySelector('.name').textContent,
      'Dave Matthews'
    );
    assert.deepEqual(mockSocket.activeChannels(), []);
  });

  it('leads with an avatar with the scheme inset when asked', async () => {
    const name = await getContactName({
      name: 'Dave Matthews',
      urn: 'tel:+12065551212',
      avatar: true
    });
    const avatar = name.shadowRoot.querySelector('temba-contact-avatar');
    assert.equal(avatar.getAttribute('name'), 'Dave Matthews');
    assert.equal(avatar.getAttribute('scheme'), 'tel');

    // the scheme is inset on the avatar rather than shown on its own
    assert.isNull(name.shadowRoot.querySelector(':scope > temba-urn'));
    await assertScreenshot('contacts/name-avatar', getClip(name));
  });

  it('names the avatar of a watched contact once it arrives', async () => {
    const name = await getContactName({ contact: CONTACT, avatar: true });
    await waitForCondition(() => !!name.urn);
    await name.updateComplete;

    const avatar = name.shadowRoot.querySelector('temba-contact-avatar');
    assert.equal(avatar.getAttribute('name'), 'Dave Matthews');
    assert.isNotEmpty(avatar.getAttribute('scheme'));
  });

  it('gets its initial value through the central watcher', async () => {
    const name = await getContactName({ contact: CONTACT });

    // registering interest opens the contact's history channel
    assert.deepEqual(mockSocket.activeChannels(), [CHANNEL]);

    // the initial value arrives without any socket event
    await waitForCondition(() => name.name === 'Dave Matthews');
    assert.equal(name.urn, 'telegram:dmb4ever');
  });

  it('updates live on name change events', async () => {
    const name = await getContactName({ contact: CONTACT });
    await waitForCondition(() => name.name === 'Dave Matthews');

    let refreshed = null;
    name.addEventListener(CustomEventType.Refreshed, (evt: CustomEvent) => {
      refreshed = evt.detail.data;
    });

    mockSocket.serverPublish(CHANNEL, {
      type: 'contact_name_changed',
      name: 'David J. Matthews'
    });

    assert.equal(name.name, 'David J. Matthews');

    // refresh notifications are coalesced into a microtask
    await waitForCondition(() => refreshed?.name === 'David J. Matthews');
  });

  it('updates the urn when deliverable urns change', async () => {
    const name = await getContactName({ contact: CONTACT });
    await waitForCondition(() => name.urn === 'telegram:dmb4ever');

    // the contact loses telegram and whatsapp becomes the destination - urn
    // events carry raw strings so the watcher refetches for channel info
    clearMockGets();
    mockGET(
      /\/api\/v2\/contacts\.json\?expand_urns=true&urn_order=priority&uuid=contact-dave-active/,
      {
        next: null,
        previous: null,
        results: [
          {
            uuid: CONTACT,
            name: 'Dave Matthews',
            urns: [
              {
                channel: { uuid: 'chan-1', name: 'WhatsApp Channel' },
                scheme: 'whatsapp',
                path: '5551212',
                display: null
              }
            ]
          }
        ]
      }
    );

    mockSocket.serverPublish(CHANNEL, {
      type: 'contact_urns_changed',
      urns: ['whatsapp:5551212']
    });

    await waitForCondition(() => name.urn === 'whatsapp:5551212');
    assert.equal(name.name, 'Dave Matthews');
  });

  it('shares one channel and unsubscribes with the last watcher', async () => {
    const first = await getContactName({ contact: CONTACT });
    const second = await getContactName({ contact: CONTACT });

    // both watch through a single subscription
    assert.deepEqual(mockSocket.activeChannels(), [CHANNEL]);

    // the late joiner is primed from the cached contact
    await waitForCondition(() => second.name === 'Dave Matthews');
    assert.equal(first.name, 'Dave Matthews');

    second.remove();
    assert.deepEqual(mockSocket.activeChannels(), [CHANNEL]);

    first.remove();
    assert.deepEqual(mockSocket.activeChannels(), []);
  });

  it('clears when the contact is unset', async () => {
    const name = await getContactName({ contact: CONTACT });
    await waitForCondition(() => name.name === 'Dave Matthews');

    name.contact = null;
    await name.updateComplete;

    assert.deepEqual(mockSocket.activeChannels(), []);
    assert.isNull(name.name);
    assert.isNull(name.urn);
  });

  it('recovers events that arrive before the initial fetch lands', async () => {
    // the initial fetch comes back with nothing, so the event that follows
    // has no snapshot to be applied to
    clearMockGets();
    mockGET(
      /\/api\/v2\/contacts\.json\?expand_urns=true&urn_order=priority&uuid=contact-dave-active/,
      { next: null, previous: null, results: [] }
    );

    const deliveries = [];
    watchContact(CONTACT, [Events.CONTACT_NAME_CHANGED], (event, contact) =>
      deliveries.push({ event, contact })
    );

    // let the empty fetch land before the event shows up
    await waitFor(50);

    mockSocket.serverPublish(CHANNEL, {
      type: 'contact_name_changed',
      name: 'David J. Matthews'
    });

    // the event reaches us with no contact to go with it
    assert.equal(deliveries.length, 1);
    assert.isNull(deliveries[0].contact);

    // but it schedules a refetch, which primes us with the change
    clearMockGets();
    mockGET(
      /\/api\/v2\/contacts\.json\?expand_urns=true&urn_order=priority&uuid=contact-dave-active/,
      {
        next: null,
        previous: null,
        results: [{ uuid: CONTACT, name: 'David J. Matthews', urns: [] }]
      }
    );

    await waitForCondition(
      () =>
        deliveries[deliveries.length - 1].contact?.name === 'David J. Matthews'
    );
  });

  it('keeps delivering when a watcher throws', async () => {
    const deliveries = [];
    const failing = watchContact(CONTACT, [Events.CONTACT_NAME_CHANGED], () => {
      throw new Error('watcher blew up');
    });
    const healthy = watchContact(
      CONTACT,
      [Events.CONTACT_NAME_CHANGED],
      (event, contact) => deliveries.push({ event, contact })
    );

    // the initial delivery gets past the watcher that throws
    await waitForCondition(() => deliveries.length === 1);
    assert.equal(deliveries[0].contact.name, 'Dave Matthews');

    // as does a live one
    mockSocket.serverPublish(CHANNEL, {
      type: 'contact_name_changed',
      name: 'David J. Matthews'
    });
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[1].contact.name, 'David J. Matthews');

    failing.unsubscribe();
    healthy.unsubscribe();
  });

  it('routes events by interest level', async () => {
    const nameDeliveries = [];
    const allEvents = [];

    const nameWatch = watchContact(
      CONTACT,
      [Events.CONTACT_NAME_CHANGED],
      (event, contact) => nameDeliveries.push({ event, contact })
    );
    const allWatch = watchContact(CONTACT, '*', (event) =>
      allEvents.push(event)
    );

    // the name interest gets an eventless initial delivery, the wildcard
    // watcher is an event-stream consumer and gets none
    await waitForCondition(() => nameDeliveries.length === 1);
    assert.isNull(nameDeliveries[0].event);
    assert.equal(nameDeliveries[0].contact.name, 'Dave Matthews');
    assert.equal(allEvents.length, 0);

    // an unrelated event only reaches the wildcard watcher
    mockSocket.serverPublish(CHANNEL, { type: 'msg_created', msg: {} });
    assert.equal(nameDeliveries.length, 1);
    assert.equal(allEvents.length, 1);

    // a name change reaches both, with the contact patched centrally
    mockSocket.serverPublish(CHANNEL, {
      type: 'contact_name_changed',
      name: 'David J. Matthews'
    });
    assert.equal(nameDeliveries.length, 2);
    assert.equal(nameDeliveries[1].event.name, 'David J. Matthews');
    assert.equal(nameDeliveries[1].contact.name, 'David J. Matthews');
    assert.equal(allEvents.length, 2);

    nameWatch.unsubscribe();
    assert.deepEqual(mockSocket.activeChannels(), [CHANNEL]);
    allWatch.unsubscribe();
    assert.deepEqual(mockSocket.activeChannels(), []);
  });
});
