import { Contact } from '../interfaces';
import { Events } from '../events/eventRenderers';
import { getStore } from '../store/Store';
import { Watchers } from './Watchers';
import {
  ContactFieldChangedEvent,
  ContactFlowChangedEvent,
  ContactGroupsChangedEvent,
  ContactHistoryEvent,
  ContactEmailChangedEvent,
  ContactLanguageChangedEvent,
  ContactLastSeenChangedEvent,
  ContactNameChangedEvent,
  ContactStatusChangedEvent,
  RealtimeSubscription,
  subscribeToContactHistory
} from './Realtime';

/**
 * Central interest registry for live contact state. Components declare what
 * they care about - specific event types or '*' for everything - and this
 * module owns the rest: it holds the single socket subscription per contact
 * (the firehose on "history:<contact-uuid>"), fetches the contact so watchers
 * get an initial value without something having to change, and fans each
 * event out to just the watchers whose interest matches.
 *
 *   const watch = watchContact(uuid, [Events.CONTACT_NAME_CHANGED], (event, contact) => {
 *     ...
 *   });
 *   watch.unsubscribe();
 *
 * Every delivery hands the watcher the current contact alongside the event
 * that triggered it, so watchers can read state without knowing where the
 * data originally came from. The contact is kept current centrally: scalar
 * events are applied to it directly, while events whose full effect isn't in
 * the event payload (see refetchTypes) trigger a refetch. Initial values and
 * refetches arrive through the same handler as live changes, as a delivery
 * with no event, so watchers have a single code path. The fetch happens on
 * every (re)subscribe, including after reconnects, so watchers also catch up
 * on anything missed while offline. When the last watcher for a contact
 * unsubscribes the socket subscription and cached contact are dropped.
 *
 * Wildcard watchers are event-stream consumers (e.g. chat renders history) -
 * they get every live event but no eventless deliveries, and an entry with
 * only those holds no contact and fetches nothing. They keep their own copy
 * instead, applying events to it with applyContactEvent so how an event
 * changes a contact is still defined in one place. Any watcher can pass
 * onSubscribed to be told when the channel goes live, which is where a
 * stream consumer catches up on what it missed while offline.
 */

// same shape components previously fetched themselves - urns are expanded and
// priority ordered so watchers can pick the messaging destination
const CONTACT_ENDPOINT =
  '/api/v2/contacts.json?expand_urns=true&urn_order=priority&uuid=';

// how long we wait for an event burst (e.g. one flow sprint updating several
// fields) to settle before refetching
const REFETCH_DEBOUNCE = 100;

// a fetch can fail on an otherwise healthy socket, which would leave watchers
// with no contact at all until something else triggers a fetch - retry a few
// times, backing off between attempts
const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY = 1000;

// the contact-state events - everything that changes what a contact *is*, as
// opposed to recording something that happened to them. The default interest
// for components that render contact data
export const CONTACT_STATE_TYPES = [
  Events.CONTACT_NAME_CHANGED,
  Events.CONTACT_EMAIL_CHANGED,
  Events.CONTACT_URNS_CHANGED,
  Events.CONTACT_FIELD_CHANGED,
  Events.CONTACT_GROUPS_CHANGED,
  Events.CONTACT_LANGUAGE_CHANGED,
  Events.CONTACT_STATUS_CHANGED,
  Events.CONTACT_FLOW_CHANGED,
  Events.CONTACT_LAST_SEEN_CHANGED
];

export type ContactEventHandler = (
  event: ContactHistoryEvent | null,
  contact: Contact
) => void;

interface Watcher {
  types: string[] | '*';
  onEvent: ContactEventHandler;
  onSubscribed?: () => void;
}

interface WatchedContact {
  watchers: Watchers<Watcher>;
  sub: RealtimeSubscription;
  contact: Contact;
  fetchSeq: number;
  // fetches in flight - their responses predate anything arriving now, so
  // events landing while one is outstanding need a refetch to survive
  fetching: number;
  refetchTimer: number;
  // whether the channel is live, so watchers joining an already-subscribed
  // channel still get their initial catch-up call
  subscribed: boolean;
}

const watched = new Map<string, WatchedContact>();

const newWatchers = (watcher: Watcher): Watchers<Watcher> => {
  const watchers = new Watchers<Watcher>('contact watcher');
  watchers.add(watcher);
  return watchers;
};

/**
 * Serializes an engine field value from an event the way the read API
 * would - both read the same engine value dict, keyed by the field's type
 * (the API calls number fields "numeric"). A value that didn't parse as the
 * field's type serializes as null, same as the API. Returns undefined when
 * the field definition isn't known, since without it there's no way to tell
 * which engine value the API would have read.
 */
const serializeFieldValue = (key: string, value: any): string | undefined => {
  if (!value) {
    return null;
  }
  const fieldType = getStore()?.getContactField(key)?.value_type;
  if (!fieldType) {
    return undefined;
  }
  const engineType = fieldType === 'numeric' ? 'number' : fieldType;
  const engineValue = value[engineType];
  return engineValue != null ? String(engineValue) : null;
};

// how live events patch the cached contact so every delivery carries current
// state. Returning false means the event couldn't be applied and the contact
// needs a refetch to be current
const appliers: {
  [type: string]: (contact: Contact, event: any) => boolean | void;
} = {
  [Events.CONTACT_NAME_CHANGED]: (contact, event: ContactNameChangedEvent) => {
    contact.name = event.name;
  },
  [Events.CONTACT_EMAIL_CHANGED]: (
    contact,
    event: ContactEmailChangedEvent
  ) => {
    contact.email = event.email || null;
    // a changed address is never verified
    contact.email_verified_on = null;
  },
  [Events.CONTACT_LANGUAGE_CHANGED]: (
    contact,
    event: ContactLanguageChangedEvent
  ) => {
    contact.language = event.language;
  },
  [Events.CONTACT_STATUS_CHANGED]: (
    contact,
    event: ContactStatusChangedEvent
  ) => {
    contact.status = event.status;
  },
  [Events.CONTACT_FLOW_CHANGED]: (contact, event: ContactFlowChangedEvent) => {
    contact.flow = event.flow || null;
  },
  [Events.CONTACT_LAST_SEEN_CHANGED]: (
    contact,
    event: ContactLastSeenChangedEvent
  ) => {
    // last seen only ever moves forward - ignore out of order deliveries
    if (
      !contact.last_seen_on ||
      new Date(event.last_seen_on) > new Date(contact.last_seen_on)
    ) {
      contact.last_seen_on = event.last_seen_on;
    }
  },
  [Events.CONTACT_FIELD_CHANGED]: (
    contact,
    event: ContactFieldChangedEvent
  ) => {
    const key = event.field?.key;
    if (!key) {
      return;
    }
    const value = serializeFieldValue(key, event.value);
    if (value === undefined) {
      // no field definition to serialize against - don't guess at a value
      return false;
    }
    // replace rather than mutate so earlier deliveries keep their values
    contact.fields = { ...contact.fields, [key]: value };
  },
  [Events.CONTACT_GROUPS_CHANGED]: (
    contact,
    event: ContactGroupsChangedEvent
  ) => {
    const added = event.groups_added || [];
    const removed = new Set(
      (event.groups_removed || []).map((group) => group.uuid)
    );
    contact.groups = [
      ...(contact.groups || []).filter(
        (group) =>
          !removed.has(group.uuid) && !added.some((a) => a.uuid === group.uuid)
      ),
      // group references can arrive without a name, but consumers sort on it
      ...added.map((group) => ({
        uuid: group.uuid,
        name: group.name || ''
      }))
    ];
  }
};

// events whose new state can't be patched into the cached contact from the
// event alone - urns arrive as raw strings while the contact carries them
// expanded with their channels, which picking a messaging destination needs.
// Their arrival triggers a (debounced) refetch, which re-primes every
// watcher with current values.
const refetchTypes = new Set<string>([Events.CONTACT_URNS_CHANGED]);

const matches = (watcher: Watcher, type: string): boolean => {
  return watcher.types === '*' || watcher.types.includes(type);
};

/**
 * Whether anyone is watching this contact's *state*. Wildcard watchers are
 * stream consumers - they take the events and keep their own view of the
 * contact - so an entry with only those has no contact to hold current and
 * nothing to fetch.
 */
const needsContact = (entry: WatchedContact): boolean => {
  return entry.watchers.some((watcher) => watcher.types !== '*');
};

/**
 * Applies a live contact event to a contact, the same way the registry
 * applies it to the one it holds. Exposed for stream consumers that keep
 * their own copy, so how an event changes a contact is defined once.
 * Returns false when the event couldn't be applied.
 */
export const applyContactEvent = (
  contact: Contact,
  event: ContactHistoryEvent
): boolean | void => {
  const apply = appliers[event.type];
  if (!contact || !apply) {
    return;
  }
  return apply(contact, event);
};

/**
 * Hands every non-wildcard watcher the current contact as an eventless
 * delivery.
 */
const primeAll = (entry: WatchedContact) => {
  entry.watchers.each(
    (watcher) => watcher.onEvent(null, entry.contact),
    (watcher) => watcher.types !== '*'
  );
};

const clearRefetch = (entry: WatchedContact) => {
  if (entry.refetchTimer) {
    window.clearTimeout(entry.refetchTimer);
    entry.refetchTimer = null;
  }
};

// a fetch that couldn't happen leaves watchers with no value at all, so try
// again with a backoff - anything that supersedes us in the meantime (a newer
// fetch, a local write, the last watcher leaving) cancels it
const retryFetch = (
  uuid: string,
  entry: WatchedContact,
  attempt: number,
  seq: number
) => {
  if (attempt >= FETCH_RETRIES) {
    return;
  }

  window.setTimeout(
    () => {
      if (watched.get(uuid) === entry && entry.fetchSeq === seq) {
        fetchContact(uuid, entry, attempt + 1);
      }
    },
    FETCH_RETRY_DELAY * Math.pow(2, attempt)
  );
};

const fetchContact = (uuid: string, entry: WatchedContact, attempt = 0) => {
  const store = getStore();
  if (!store) {
    // the store element can be added to the page after the components that
    // watch through it - come back for it instead of leaving watchers empty
    // for good. Claim a seq like a real fetch does so a later call supersedes
    // this chain instead of running alongside it
    retryFetch(uuid, entry, attempt, ++entry.fetchSeq);
    return;
  }

  // a pending debounce would only land behind us with the same data
  clearRefetch(entry);

  const seq = ++entry.fetchSeq;
  entry.fetching++;
  store
    // skip the store cache in both directions - we always want current data
    // and the cache holds this url in a different shape for components that
    // still fetch it themselves
    .getUrl(`${CONTACT_ENDPOINT}${uuid}`, { force: true, skipCache: true })
    // two-argument form so a throw out of the success handler isn't taken
    // for a failed fetch and retried on top of itself
    .then(
      (response) => {
        entry.fetching--;

        // ignore responses that arrive after everyone left or a newer fetch
        if (watched.get(uuid) !== entry || entry.fetchSeq !== seq) {
          return;
        }

        const contact = response.json?.results?.[0] || null;
        if (!contact) {
          return;
        }

        entry.contact = contact;
        primeAll(entry);
      },
      () => {
        entry.fetching--;

        if (watched.get(uuid) !== entry || entry.fetchSeq !== seq) {
          return;
        }

        retryFetch(uuid, entry, attempt, seq);
      }
    );
};

const scheduleRefetch = (uuid: string, entry: WatchedContact) => {
  clearRefetch(entry);
  entry.refetchTimer = window.setTimeout(() => {
    entry.refetchTimer = null;
    if (watched.get(uuid) === entry) {
      fetchContact(uuid, entry);
    }
  }, REFETCH_DEBOUNCE);
};

const handleEvent = (
  uuid: string,
  entry: WatchedContact,
  event: ContactHistoryEvent
) => {
  const apply = appliers[event.type];
  const applied = entry.contact && apply ? apply(entry.contact, event) : null;

  // a state event we couldn't fully apply leaves the contact stale - there
  // was no snapshot to patch, a fetch that predates the event is still in
  // flight, or the applier couldn't resolve what it needed. Scheduling ahead
  // of the fan-out keeps a throwing watcher from costing us the refetch, and
  // the debounce collapses a burst into a single fetch. Entries nobody needs
  // a contact from have nothing to keep current
  if (needsContact(entry)) {
    const stale =
      !!apply && (!entry.contact || entry.fetching > 0 || applied === false);
    if (stale || refetchTypes.has(event.type)) {
      scheduleRefetch(uuid, entry);
    }
  }

  entry.watchers.each(
    (watcher) => watcher.onEvent(event, entry.contact),
    (watcher) => matches(watcher, event.type)
  );
};

/**
 * A (re)subscribe on the contact's channel. Watchers that render contact
 * state get a fresh fetch; every watcher that asked for it gets told, so
 * stream consumers can fetch whatever they missed while we were away.
 */
const handleSubscribed = (uuid: string, entry: WatchedContact) => {
  entry.subscribed = true;
  if (needsContact(entry)) {
    fetchContact(uuid, entry);
  }
  entry.watchers.each(
    (watcher) => watcher.onSubscribed(),
    (watcher) => !!watcher.onSubscribed
  );
};

export const watchContact = (
  uuid: string,
  types: string[] | '*',
  onEvent: ContactEventHandler,
  onSubscribed?: () => void
): RealtimeSubscription => {
  const entry = watched.get(uuid);
  const watcher: Watcher = { types, onEvent, onSubscribed };

  if (!entry) {
    const newEntry: WatchedContact = {
      // registered before we subscribe so the first (re)subscribe already
      // knows whether anyone needs a contact held for them
      watchers: newWatchers(watcher),
      sub: null,
      contact: null,
      fetchSeq: 0,
      fetching: 0,
      refetchTimer: null,
      subscribed: false
    };
    watched.set(uuid, newEntry);
    newEntry.sub = subscribeToContactHistory(
      uuid,
      null,
      (event) => handleEvent(uuid, newEntry, event),
      // fires on every (re)subscribe incl. after reconnects - (re)fetch so
      // watchers see anything that changed while we weren't listening
      () => handleSubscribed(uuid, newEntry)
    );
    return unwatch(uuid, newEntry, watcher);
  }

  entry.watchers.add(watcher);

  // a watcher that renders contact state joining an entry that was holding
  // none (only stream consumers so far) needs one fetched for it. On a
  // channel that isn't live yet the pending (re)subscribe covers it
  if (types !== '*' && entry.subscribed && !entry.contact && !entry.fetching) {
    fetchContact(uuid, entry);
  }

  // late joiners on an already-fetched contact get their initial delivery
  // without waiting for another fetch - async so it mirrors the fetch path
  if (entry.contact && types !== '*') {
    const contact = entry.contact;
    entry.watchers.prime(watcher, () => watcher.onEvent(null, contact));
  }

  // and joiners on an already-live channel get their initial catch-up call,
  // which they'd otherwise wait for a reconnect to see
  if (entry.subscribed && onSubscribed) {
    entry.watchers.prime(watcher, () => watcher.onSubscribed());
  }

  return unwatch(uuid, entry, watcher);
};

const unwatch = (
  uuid: string,
  entry: WatchedContact,
  watcher: Watcher
): RealtimeSubscription => ({
  unsubscribe: () => {
    if (entry.watchers.remove(watcher) && entry.watchers.size === 0) {
      dropEntry(uuid, entry);
    } else if (!needsContact(entry)) {
      // only stream consumers left, and nothing keeps their contact current -
      // holding onto this one would leave it drifting until a state watcher
      // joined later and got primed with the drift
      entry.contact = null;
      clearRefetch(entry);
    }
  }
});

/**
 * Pushes a fresh copy of a contact into the registry, priming its watchers.
 * Components that write contact changes call this with the server's response
 * so every watcher on the page reflects an edit immediately, without waiting
 * for the change to echo back over the socket. A no-op for unwatched
 * contacts.
 */
export const updateContact = (uuid: string, contact: Contact) => {
  const entry = watched.get(uuid);
  if (entry) {
    // discard any in-flight fetch and any pending refetch - both started
    // before this write and could land after it with pre-write data
    entry.fetchSeq++;
    clearRefetch(entry);
    // the caller keeps using the object they handed us (it's their data and
    // the store's cache entry) while appliers patch ours in place - copy the
    // parts they touch so a live event can't reach back into it
    entry.contact = {
      ...contact,
      groups: (contact.groups || []).map((group) => ({ ...group })),
      fields: { ...contact.fields }
    };
    primeAll(entry);
  }
};

/**
 * Forces a refetch of a watched contact, re-priming its watchers. A no-op
 * for unwatched contacts.
 */
export const refreshContact = (uuid: string) => {
  const entry = watched.get(uuid);
  if (entry) {
    fetchContact(uuid, entry);
  }
};

const dropEntry = (uuid: string, entry: WatchedContact) => {
  watched.delete(uuid);
  clearRefetch(entry);
  entry.sub.unsubscribe();
};

// for tests - real pages just unwatch
export const resetContactWatches = () => {
  for (const [uuid, entry] of [...watched.entries()]) {
    entry.watchers.clear();
    dropEntry(uuid, entry);
  }
};
