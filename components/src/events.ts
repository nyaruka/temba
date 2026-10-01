import { Msg, ObjectReference, User } from './interfaces';
import { ContactEvent } from './display/Chat';

export interface EventGroup {
  type: string;
  events: ContactEvent[];
  open: boolean;
}

export interface ContactLanguageChangedEvent extends ContactEvent {
  language: string;
}

// ephemeral state event - arrives over the socket but is never persisted,
// updates the contact's current flow rather than recording history
export interface ContactFlowChangedEvent extends ContactEvent {
  flow: ObjectReference | null;
}

// ephemeral state event - arrives over the socket but is never persisted,
// updates the contact's last seen rather than recording history
export interface ContactLastSeenChangedEvent extends ContactEvent {
  last_seen_on: string;
}

export interface ContactStatusChangedEvent extends ContactEvent {
  status: string;
}

export interface OptInEvent extends ContactEvent {
  optin: {
    uuid: string;
    name: string;
  };
}

export interface CallEvent extends ContactEvent {
  call?: {
    uuid: string;
    urn: string;
  };
}

export interface ChatStartedEvent extends ContactEvent {
  params?: object;
}

export interface MsgEvent extends ContactEvent {
  msg: Msg;
  optin?: ObjectReference;
  _status?: {
    created_on: string;
    status: 'wired' | 'sent' | 'delivered' | 'read' | 'errored' | 'failed';
    reason: 'error_limit' | 'too_old' | 'channel_removed';
  };
  _deleted?: {
    created_on: string;
    by_contact: boolean;
    user: { name: string; uuid: string };
  };
}

export interface RunEvent extends ContactEvent {
  flow: ObjectReference;
  status: string;
}

export interface URNsChangedEvent extends ContactEvent {
  urns: string[];
}

export interface TicketEvent extends ContactEvent {
  ticket: {
    // ticket_opened
    uuid: string;
    topic?: ObjectReference;
    assignee?: User;
  };
  ticket_uuid?: string; // all other event types
  assignee?: User;
  note?: string;
  topic?: ObjectReference;
}

export interface NameChangedEvent extends ContactEvent {
  name: string;
}

export interface ContactEmailChangedEvent extends ContactEvent {
  email: string;
}

export interface UpdateFieldEvent extends ContactEvent {
  field: { key: string; name: string };
  // engine field values always carry text; typed representations are
  // present when the value parses as that type (see goflow's Value)
  value: { text: string; datetime?: string; number?: string };
}

export interface ContactGroupsEvent extends ContactEvent {
  groups_added: ObjectReference[];
  groups_removed: ObjectReference[];
}

export interface AirtimeTransferredEvent extends ContactEvent {
  sender: string;
  recipient: string;
  currency: string;
  amount: string;
}

export type AirtimeStatus =
  | 'created'
  | 'confirmed'
  | 'rejected'
  | 'cancelled'
  | 'submitted'
  | 'completed'
  | 'reversed'
  | 'declined';

export interface AirtimeCreatedEvent extends ContactEvent {
  sender: string;
  recipient: string;
  currency: string;
  amount: string;
  external_id?: string;
  _status?: {
    created_on: string;
    status: AirtimeStatus;
  };
}

export type CallStartedEvent = ContactEvent;

export interface ContactHistoryPage {
  events: ContactEvent[];
  next: string | null;
}
