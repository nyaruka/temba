import { Notification, ObjectReference, User } from '../interfaces';
import { Events } from '../events/eventRenderers';
import type { GroupAsset, StoreAsset } from '../store/Store';
import {
  onSocketDenied,
  PublicationHandler,
  recheckSocket,
  SocketSubscription,
  subscribeToSocket
} from './SocketService';
import { Watchers } from './Watchers';

/**
 * Typed access to our realtime topics. SocketService owns the shared
 * connection and per-channel fan-out; this module owns how topics map to
 * channel names, including the page identity (org and user uuids) needed to
 * address user-scoped channels, and what each topic publishes.
 *
 * The identity arrives via temba-store (hydrated from the page template), so
 * user-scoped subscriptions requested before the store mounts are queued and
 * activate when the context is set. On pages with no authenticated context
 * they simply never activate.
 *
 * That identity belongs to the browser's session rather than to the page, so
 * it can be pulled out from under a page that is still open: logging out, or
 * switching workspace, in another tab. The server stops authorizing the
 * page's own channels when that happens, which is how we find out - see
 * onWorkspaceAccessLost.
 *
 * Payload types below describe the wire, which is raw JSON - timestamps are
 * strings here even where the rendered equivalents in events.ts carry Dates.
 */

export interface RealtimeSubscription {
  unsubscribe(): void;
}

/** Anything published on any of our topics. */
export interface RealtimeEvent {
  type: string;
}

/**
 * org:<org-uuid> - workspace-wide state every component on the page shares.
 * An asset was created or renamed somewhere, so anything displaying it can
 * update. A group carries its query as well, so the store can cache one it
 * has never fetched.
 */
export interface AssetChangedEvent extends RealtimeEvent {
  type: 'asset_changed';
  asset: StoreAsset | GroupAsset;
}

export type OrganizationEvent = AssetChangedEvent;

/**
 * flow:<flow-uuid> - published once per committed sprint batch while a flow
 * is running. It carries no counts, it just says they moved: the editor reads
 * the current numbers over http when it sees one.
 */
export interface FlowActivityEvent extends RealtimeEvent {
  type: 'activity';
}

export type FlowEvent = FlowActivityEvent;

/**
 * history:<contact-uuid> and history:<contact-uuid>:<ticket-uuid> - the
 * engine's contact events (the payloads in events.ts, before their dates are
 * parsed) plus the ephemeral ones below, which are never persisted.
 */
export interface ContactHistoryEvent extends RealtimeEvent {
  uuid?: string;
  created_on?: string;
  _user?: User;
  // the rest of the payload varies by type. The contact-state events - the
  // ones we read fields off rather than hand straight to the renderers - are
  // typed below; events.ts describes the rendered shape of the others.
  // unknown rather than any, so reading a field nobody declared is a type
  // error at the point of use instead of silently spreading
  [key: string]: unknown;
}

/**
 * The events that change what a contact *is*, as opposed to recording
 * something that happened to them. These are the ones ContactWatch applies to
 * the contact it holds, so their payloads are what a server-side rename would
 * break.
 */
export interface ContactNameChangedEvent extends ContactHistoryEvent {
  type: Events.CONTACT_NAME_CHANGED;
  name: string;
}

export interface ContactLanguageChangedEvent extends ContactHistoryEvent {
  type: Events.CONTACT_LANGUAGE_CHANGED;
  language: string;
}

export interface ContactStatusChangedEvent extends ContactHistoryEvent {
  type: Events.CONTACT_STATUS_CHANGED;
  status: string;
}

export interface ContactFlowChangedEvent extends ContactHistoryEvent {
  type: Events.CONTACT_FLOW_CHANGED;
  flow: ObjectReference | null;
}

export interface ContactLastSeenChangedEvent extends ContactHistoryEvent {
  type: Events.CONTACT_LAST_SEEN_CHANGED;
  last_seen_on: string;
}

export interface ContactFieldChangedEvent extends ContactHistoryEvent {
  type: Events.CONTACT_FIELD_CHANGED;
  field: { key: string; name: string };
  // engine field values always carry text; typed representations are present
  // when the value parses as that type (see goflow's Value)
  value: { text: string; datetime?: string; number?: string } | null;
}

export interface ContactGroupsChangedEvent extends ContactHistoryEvent {
  type: Events.CONTACT_GROUPS_CHANGED;
  groups_added?: ObjectReference[];
  groups_removed?: ObjectReference[];
}

export interface ContactURNsChangedEvent extends ContactHistoryEvent {
  type: Events.CONTACT_URNS_CHANGED;
  urns: string[];
}

export type ContactStateEvent =
  | ContactNameChangedEvent
  | ContactLanguageChangedEvent
  | ContactStatusChangedEvent
  | ContactFlowChangedEvent
  | ContactLastSeenChangedEvent
  | ContactFieldChangedEvent
  | ContactGroupsChangedEvent
  | ContactURNsChangedEvent;

/**
 * Published by agents as they compose, and echoed back to the publisher, so
 * consumers filter out their own by _user.
 */
export interface TypingEvent extends ContactHistoryEvent {
  type: Events.TYPING_STARTED | Events.TYPING_STOPPED;
  direction?: string;
  // whatsapp expresses typing as an operation on the contact's last incoming
  // message, so publications carry its external id when we have one
  msg_external_id?: string;
}

export interface RealtimeContext {
  org: string;
  user: string;
}

interface PendingSubscription {
  resolveChannel: (ctx: RealtimeContext) => string;
  onPublication: PublicationHandler;
  onSubscribed?: () => void;
  sub: SocketSubscription;
  cancelled: boolean;
}

let context: RealtimeContext = null;
const pending: PendingSubscription[] = [];

// the channels addressed by the page's own identity. The session can always
// have these, so being refused one means the session is no longer the one the
// page was rendered for - unlike say a history channel, which can be refused
// because of what happened to the contact
const contextChannels = (ctx: RealtimeContext): string[] => [
  `org:${ctx.org}`,
  `notifications:${ctx.org}:${ctx.user}`
];

export type WorkspaceAccessLostHandler = () => void;

const accessLostHandlers = new Watchers<WorkspaceAccessLostHandler>(
  'workspace access handler'
);
let accessLost = false;
let deniedWatch: SocketSubscription = null;

/**
 * Tabs share a session, so they tell each other whose page they are. The
 * server only re-authorizes a subscription every minute or so, and a tab
 * that hears from one rendered for a different identity needn't wait for
 * that - it has the server check again straight away. What another tab says
 * is only ever a reason to ask: the server's answer is what counts, so a tab
 * that is wrong, or legitimately different, costs a resubscribe and no more.
 */
let tabsChannel = 'temba-realtime-context';
let tabs: BroadcastChannel = null;

// for tests, whose files run as tabs of one browser and would otherwise hear
// each other, returns the previous name
export const setRealtimeTabsChannel = (name: string): string => {
  const previous = tabsChannel;
  tabsChannel = name;
  return previous;
};

const handleDenied = (channel: string) => {
  if (context && !accessLost && contextChannels(context).includes(channel)) {
    accessLost = true;
    accessLostHandlers.each((handler) => handler());
  }
};

const handleTabContext = (other: RealtimeContext) => {
  if (
    context &&
    !accessLost &&
    other &&
    (other.org !== context.org || other.user !== context.user)
  ) {
    contextChannels(context).forEach((channel) => recheckSocket(channel));
  }
};

const watchAccess = (ctx: RealtimeContext) => {
  if (!deniedWatch) {
    deniedWatch = onSocketDenied(handleDenied);
  }

  if (!tabs && typeof BroadcastChannel !== 'undefined') {
    tabs = new BroadcastChannel(tabsChannel);
    tabs.onmessage = (event: MessageEvent) => handleTabContext(event.data);
  }
  if (tabs) {
    tabs.postMessage(ctx);
  }
};

const unwatchAccess = () => {
  if (deniedWatch) {
    deniedWatch.unsubscribe();
    deniedWatch = null;
  }
  if (tabs) {
    tabs.close();
    tabs = null;
  }
  accessLost = false;
  accessLostHandlers.clear();
};

/**
 * Watches for the page's session no longer being the one it was rendered
 * for - it logged out, or moved to another workspace, somewhere else. Nothing
 * on the page can work after that, its requests will all be refused, so this
 * is the cue to tell the user to reload. Fires at most once, and straight
 * away for a handler that arrives after the fact.
 */
export const onWorkspaceAccessLost = (
  handler: WorkspaceAccessLostHandler
): RealtimeSubscription => {
  accessLostHandlers.add(handler);
  if (accessLost) {
    accessLostHandlers.prime(handler, (primed) => primed());
  }
  return {
    unsubscribe: () => {
      accessLostHandlers.remove(handler);
    }
  };
};

/**
 * Sets the page's realtime identity, flushing any subscriptions that were
 * waiting on it. Set once per page load - an org switch is a full page
 * load, so a real page never changes or clears its context. Passing null is
 * a full reset for tests: it discards the context, any still-queued
 * subscriptions, so handles handed out before the reset never activate, and
 * anyone watching for lost access.
 * Returns the previous context.
 */
export const setRealtimeContext = (
  ctx: RealtimeContext | null
): RealtimeContext | null => {
  const previous = context;
  context = ctx;
  if (ctx) {
    watchAccess(ctx);
    while (pending.length > 0) {
      const p = pending.shift();
      if (!p.cancelled) {
        p.sub = subscribeToSocket(
          p.resolveChannel(ctx),
          p.onPublication,
          p.onSubscribed
        );
      }
    }
  } else {
    pending.length = 0;
    unwatchAccess();
  }
  return previous;
};

const subscribeWhenReady = (
  resolveChannel: (ctx: RealtimeContext) => string,
  onPublication: PublicationHandler,
  onSubscribed?: () => void
): RealtimeSubscription => {
  if (context) {
    return subscribeToSocket(
      resolveChannel(context),
      onPublication,
      onSubscribed
    );
  }

  const p: PendingSubscription = {
    resolveChannel,
    onPublication,
    onSubscribed,
    sub: null,
    cancelled: false
  };
  pending.push(p);
  return {
    unsubscribe: () => {
      p.cancelled = true;
      if (p.sub) {
        p.sub.unsubscribe();
        p.sub = null;
      }
    }
  };
};

/**
 * The current user's notifications in the current workspace. onSubscribed
 * fires on every (re)subscribe, including after reconnects, so subscribers
 * can catch up on anything missed while offline.
 */
export const subscribeToNotifications = (
  onNotification: (notification: Notification) => void,
  onSubscribed?: () => void
): RealtimeSubscription => {
  return subscribeWhenReady(
    (ctx) => `notifications:${ctx.org}:${ctx.user}`,
    (data) => onNotification(data as Notification),
    onSubscribed
  );
};

/**
 * Workspace-wide state changes shared by every component on the page.
 */
export const subscribeToOrganization = (
  onEvent: (event: OrganizationEvent) => void,
  onSubscribed?: () => void
): RealtimeSubscription => {
  return subscribeWhenReady(
    (ctx) => `org:${ctx.org}`,
    (data) => onEvent(data as OrganizationEvent),
    onSubscribed
  );
};

/**
 * Realtime events for a flow open in the editor. Needs no page context
 * because the flow UUID uniquely identifies the authorized channel.
 */
export const subscribeToFlow = (
  flow: string,
  onEvent: (event: FlowEvent) => void,
  onSubscribed?: () => void
): RealtimeSubscription => {
  return subscribeToSocket(
    `flow:${flow}`,
    (data) => onEvent(data as FlowEvent),
    onSubscribed
  );
};

/**
 * A contact's history events, or a ticket's detail events when a ticket is
 * given. Needs no page context so subscribes immediately.
 */
export const subscribeToContactHistory = (
  contact: string,
  ticket: string | null,
  onEvent: (event: ContactHistoryEvent) => void,
  onSubscribed?: () => void
): RealtimeSubscription => {
  return subscribeToSocket(
    ticket ? `history:${contact}:${ticket}` : `history:${contact}`,
    (data) => onEvent(data as ContactHistoryEvent),
    onSubscribed
  );
};
