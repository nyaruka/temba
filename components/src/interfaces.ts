export interface DirtyTrackable {
  dirtyMessage?: string;
  markClean(): void;
}

export interface Workspace {
  uuid: string;
  name: string;
  country: string;
  languages: string[];
  timezone: string;
  date_style: DateStyle;
  anon: boolean;
}

export interface Language {
  iso: string;
  name: string;
}

export interface Notification {
  created_on: string;
  type: string;
  url: string;
  is_seen: boolean;
  export?: {
    type: string;
    num_records: number;
  };
  import?: {
    type: string;
    num_records: number;
  };
  incident?: {
    type: string;
    started_on: string;
    ended_on?: string;
  };
}

export interface Attachment {
  uuid: string;
  content_type: string;
  url: string;
  filename: string;
  size: number;
  error: string;
}

/** A quick reply as stored/served by the server (engine shape) —
 * `text` buttons carry text, `location` requests may omit it. */
export interface QuickReply {
  type?: string;
  text?: string;
  extra?: string;
}

export enum DateStyle {
  DayFirst = 'day_first',
  MonthFirst = 'month_first',
  YearFirst = 'year_first'
}

export enum ScheduledEventType {
  CampaignEvent = 'campaign_event',
  ScheduledBroadcast = 'scheduled_broadcast',
  ScheduledTrigger = 'scheduled_trigger',
  SentBroadcast = 'sent_broadcast'
}

export enum TicketStatus {
  Open = 'open',
  Closed = 'closed'
}

export interface ScheduledEvent {
  type: ScheduledEventType;
  scheduled: string;
  repeat_period: string;
  campaign?: ObjectReference;
  flow?: ObjectReference;
  message?: string;
}

// one event definition in a campaign's schedule, offset from a date field
// on the contact - consumed by the temba-campaign-events component
export interface CampaignScheduleEvent {
  uuid: string;
  type: 'message' | 'flow';
  status: 'ready' | 'scheduling';
  offset: number;
  unit: string;
  offset_display: string;
  delivery_hour_display?: string;
  relative_to: { key: string; name: string; system?: boolean };
  flow?: ObjectReference;
  message?: string;
  count: number;
  edit_url: string;
  delete_url: string;
  fires_url: string;
}

export interface NamedUser extends User {
  name: string;
}

export interface User {
  id?: number;
  uuid?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  email?: string;
  role?: string;
  created_on?: string;
  avatar?: string;
}

export interface Ticket {
  uuid: string;
  subject: string;
  body?: string;
  closed_on: string;
  opened_on: string;
  status: string;
  contact: ObjectReference;
  topic: ObjectReference;
  assignee?: { email: string; name: string; avatar?: string };
}

export interface FlowResult {
  key: string;
  name: string;
  categories: string[];
  node_uuids: string[];
}

export interface FlowDetails {
  name: string;
  results: FlowResult[];
  modified_on: string;
  runs: {
    active: number;
    completed: number;
    expired: number;
    interrupted: number;
  };
}

/** A single row in the flow CRUDL list (`flows/flow_list.html`).
 * Distinct from {@link FlowDetails}, which is the per-flow editor
 * payload — this is the lighter list-row shape. */
export interface Flow {
  uuid: string;
  name: string;
  /** Flow type — drives the leading row icon. */
  type: 'messaging' | 'voice' | 'ivr' | 'background' | 'survey' | string;
  runs: number;
  ongoing: number;
  /** Completion ratio in the range 0–1. */
  completion: number;
  has_issues: boolean;
  labels: ObjectReference[];
  /** Recent daily engagement counts, oldest to newest — rendered as
   * a sparkline. Empty when there's been no recent engagement. */
  activity: number[];
}

/** A single row in the campaign CRUDL list
 * (`campaigns/campaign_list.html`). */
export interface Campaign {
  uuid: string;
  name: string;
  /** The contact group the campaign schedules against. */
  group: ObjectReference;
  /** Number of events (messages / flow starts) in the campaign. */
  events: number;
  /** Contacts currently in the campaign's group. */
  contacts: number;
  modified_on: string;
}

/** A single row in the call CRUDL list (`ivr/call_list.html`). */
export interface Call {
  uuid: string;
  /** `in` for calls the contact made, `out` for calls made to them. */
  direction: 'in' | 'out';
  /** Status slug — `pending`, `queued`, `wired`, `in_progress`,
   * `completed`, `errored` or `failed`. */
  status: string;
  /** Why an errored / failed call didn't connect — `provider`, `busy`,
   * `no_answer`, `machine` or `suspended`; null otherwise. */
  error_reason: string | null;
  contact: ObjectReference;
  /** Call length in seconds, zero if it never connected. */
  duration: number;
  /** The channel the call was made on, used to link to its logs. */
  channel: ObjectReference;
  created_on: string;
}

/** A single row in the trigger CRUDL list
 * (`triggers/trigger_list.html`): what starts the flow (type +
 * per-type details), any channel / group filters, and the flow it
 * starts. Rows key off the uuid, which also addresses the page's
 * update modal. */
export interface Trigger {
  uuid: string;
  /** Trigger type slug — drives the leading row icon and the
   * details cell (`keyword`, `catch_all`, `schedule`,
   * `inbound_call`, `missed_call`, `new_conversation`, `referral`,
   * `closed_ticket`, `opt_in`, `opt_out`). */
  type: string;
  /** The flow the trigger starts. */
  flow: ObjectReference;
  /** Channel the trigger is limited to, with its type icon. */
  channel?: (ObjectReference & { icon?: string }) | null;
  /** Groups the trigger is limited to. */
  groups?: ObjectReference[];
  /** Groups the trigger excludes. */
  exclude_groups?: ObjectReference[];
  /** Contacts a scheduled trigger starts directly. */
  contacts?: ObjectReference[];
  /** Keyword triggers only. */
  keywords?: string[];
  /** Keyword match type — `F` (starts with) or `O` (matches). */
  match_type?: string | null;
  /** Referral triggers only. */
  referrer_id?: string | null;
  /** Scheduled triggers only — `display` is the server-rendered
   * human schedule ("each week on Monday"); `next_fire` is unset
   * once the schedule is exhausted or paused. */
  schedule?: {
    repeat_period?: string;
    display?: string;
    next_fire?: string | null;
  } | null;
  priority?: number;
  created_on?: string;
}

/** A single row in the broadcast CRUDL lists — both the scheduled
 * list (`msgs/broadcast_scheduled.html`) and the sent list
 * (`msgs/broadcast_list.html`). Rows key off the uuid, which also
 * addresses the scheduled list's edit and delete modals. Content
 * fields carry the base-language translation. */
export interface Broadcast {
  uuid: string;
  /** Server status slug — `pending`, `queued`, `started`,
   * `completed`, `failed` or `interrupted`. Scheduled broadcasts
   * that haven't fired yet sit at `pending`. */
  status?: string;
  /** Send progress for an in-flight broadcast — total recipients
   * (-1 until the org's contact count resolves) and messages
   * created so far. */
  progress?: { total: number; started: number };
  /** Base-language message text. */
  text?: string;
  /** Base-language attachments (`{content_type, url}` objects or
   * `contentType:url` strings). */
  attachments?: (string | Attachment)[];
  /** Base-language quick replies — engine `{text}` objects, with
   * plain strings tolerated for older data. */
  quick_replies?: (string | QuickReply)[];
  /** The WhatsApp template the broadcast sends, when it uses one. */
  template?: ObjectReference | null;
  /** Recipient groups. */
  groups?: ObjectReference[];
  /** Recipient contacts. */
  contacts?: ObjectReference[];
  /** Raw recipient URNs (editors/admins only). */
  urns?: string[];
  /** Recipient contact query, for query-addressed broadcasts. */
  query?: string | null;
  /** Human-readable exclusion descriptions ("Skip inactive
   * contacts", ...) rendered in the detail view. */
  exclusions?: string[];
  /** Scheduled broadcasts only — `display` is the server-rendered
   * human repeat ("each week on Monday, Wednesday"); `next_fire` is
   * null once the schedule is exhausted or paused. */
  schedule?: {
    repeat_period?: string;
    display?: string;
    next_fire?: string | null;
  } | null;
  /** Messages created by a sent broadcast. */
  msg_count?: number;
  created_on?: string;
  /** Email of the user who created the broadcast. */
  created_by?: string | null;
  modified_on?: string;
}

export interface Msg {
  /** Numeric id — present on persisted messages; absent on outbound
   * drafts and on the messages CRUDL endpoint, which identifies
   * messages by uuid. */
  id?: number;
  /** Message uuid — how the CRUDL list keys and selects rows. */
  uuid?: string;
  text: string;
  status: string;
  channel: ObjectReference;
  quick_replies: (string | QuickReply)[];
  urn: string;
  /** The message's contact — populated by the messages CRUDL
   * endpoint. Carries whichever of name/urn the endpoint exposes. */
  contact?: { uuid?: string; name?: string; urn?: string };
  direction: string;
  type: string;
  /** Message type as exposed by the messages CRUDL endpoint
   * (`text` / `optin` / …); mirrors `type` for that surface. */
  msg_type?: string;
  /** Attachments as exposed by the messages CRUDL endpoint, which
   * serializes each as a `{content_type, url}` object; some other
   * message surfaces carry them as `contentType:url` strings. */
  attachments: (string | Attachment)[];
  /** Labels applied to the message. */
  labels?: ObjectReference[];
  /** The flow the message was sent from, when there is one. */
  flow?: ObjectReference;
  /** When the message was created. */
  created_on?: string;
  unsendable_reason?:
    | 'no_route'
    | 'contact_blocked'
    | 'contact_stopped'
    | 'contact_archived'
    | 'org_suspended'
    | 'looping';
}

export interface ObjectReference {
  uuid: string;
  name: string;
  url?: string;
}

export interface Shortcut {
  uuid: string;
  name: string;
  text: string;
  modified_on: string;
}

/** One helpdesk article, as served by the articles endpoint. The
 * endpoint returns the whole tree flattened into display order, so
 * `depth` is what a row is nested by and `parent` is what the sort
 * endpoint is told about. */
export interface Article {
  uuid: string;
  title: string;
  /** a section's - plain text saying what it holds; empty for an article */
  description?: string;
  status: string;
  parent: string | null;
  depth: number;
  modified_on: string;
}

export interface ContactField {
  key: string;
  label: string;
  value_type: string;
  featured: boolean;
  priority: number;
  agent_access: string;
  type: string;
  usages: { campaign_events: number; flows: number; groups: number };
}

export interface ContactGroup {
  uuid: string;
  count: number;
  name: string;
  query?: string;
  status: string;
}

export interface URN {
  scheme: string;
  path: string;
  display?: string | null;
  channel?: ObjectReference | null;
}

export interface Group {
  name: string;
  uuid: string;
  is_dynamic?: boolean;
}

export interface ContactNote {
  text: string;
  created_on: string;
  created_by: NamedUser;
}

export interface ContactTicket {
  name: string;
  uuid: string;
  status: string;

  contact: {
    uuid: string;
    name: string;
    created_on: Date;
    last_seen_on: Date;
  };
}

export interface Contact {
  name: string;
  uuid: string;
  stopped: boolean;
  blocked: boolean;
  urns: URN[];
  language?: string;
  fields: { [key: string]: string };
  groups: Group[];
  notes: ContactNote[];
  modified_on: string;
  created_on: string;
  last_seen_on: string;
  status: string;

  ref?: string; // only returned for anon workspaces
  flow?: ObjectReference;
  last_msg?: Msg;
  direction?: string;
  ticket: {
    uuid: string;
    subject: string;
    closed_on?: string;
    last_activity_on: string;
    assignee?: User;
    topic?: ObjectReference;
  };
}

export interface FeatureProperties {
  name: string;
  osm_id: string;
  level: number;
  children?: FeatureProperties[];
  has_children?: boolean;
  aliases?: string;
  parent_osm_id?: string;
  id?: number;
  path?: string;
}

export interface Position {
  top: number;
  left: number;
}

export interface FunctionExample {
  template: string;
  output: string;
}

export interface CompletionOption {
  name?: string;
  summary: string;

  // functions
  signature?: string;
  detail?: string;
  examples?: FunctionExample[];
}

export interface CompletionResult {
  anchorPosition: Position;
  query: string;
  options: CompletionOption[];
  currentFunction: CompletionOption;
}

export interface CompletionProperty {
  key: string;
  help: string;
  type: string;
}

export interface CompletionType {
  name: string;

  key_source?: string;
  property_template?: CompletionProperty;
  properties?: CompletionProperty[];
}

export interface CompletionSchema {
  types: CompletionType[];
  root: CompletionProperty[];
  root_no_session: CompletionProperty[];
}

export type KeyedAssets = { [assetType: string]: string[] };

export enum CustomEventType {
  Loaded = 'temba-loaded',
  Loading = 'temba-loading',
  Canceled = 'temba-canceled',
  CursorChanged = 'temba-cursor-changed',
  Refreshed = 'temba-refreshed',
  WorkspaceAccessLost = 'temba-workspace-access-lost',
  Selection = 'temba-selection',
  ButtonClicked = 'temba-button-clicked',
  DialogHidden = 'temba-dialog-hidden',
  ScrollThreshold = 'temba-scroll-threshold',
  ScrollThresholdBottom = 'temba-scroll-threshold-bottom',
  ContentChanged = 'temba-content-changed',
  ContextChanged = 'temba-context-changed',
  FetchComplete = 'temba-fetch-complete',
  MessageSent = 'temba-message-sent',
  Submitted = 'temba-submitted',
  Redirected = 'temba-redirected',
  NoPath = 'temba-no-path',
  StoreUpdated = 'temba-store-updated',
  Ready = 'temba-ready',
  OrderChanged = 'temba-order-changed',
  ColumnOrderChanged = 'temba-column-order-changed',
  DragStart = 'temba-drag-start',
  DragStop = 'temba-drag-stop',
  DragExternal = 'temba-drag-external',
  DragInternal = 'temba-drag-internal',
  Resized = 'temba-resized',
  DetailsChanged = 'temba-details-changed',
  Error = 'temba-error',
  Interrupt = 'temba-interrupt',
  Opened = 'temba-opened',
  NotificationReceived = 'temba-notification',
  TicketUpdated = 'temba-ticket-updated',
  Moved = 'temba-moved',
  DateRangeChanged = 'temba-date-range-changed',
  NodeDeleted = 'temba-node-deleted',
  StickyNoteDeleted = 'temba-sticky-note-deleted',
  ActionEditRequested = 'temba-action-edit-requested',
  AddActionRequested = 'temba-add-action-requested',
  ActionSaved = 'temba-action-saved',
  ActionEditCanceled = 'temba-action-edit-canceled',
  NodeEditRequested = 'temba-node-edit-requested',
  NodeSaved = 'temba-node-saved',
  NodeEditCancelled = 'temba-node-edit-cancelled',
  FollowSimulation = 'temba-follow-simulation',
  ContactClicked = 'temba-contact-clicked',
  FlowClicked = 'temba-flow-clicked',
  GroupClicked = 'temba-group-clicked',
  ShowIssue = 'temba-show-issue',
  SizeChanged = 'temba-size-changed',
  IssueSelected = 'temba-issue-selected',
  IssuesClosed = 'temba-issues-closed',
  IssuesTabClicked = 'temba-issues-tab-clicked',
  RevisionViewed = 'temba-revision-viewed',
  RevisionCancelled = 'temba-revision-cancelled',
  RevisionReverted = 'temba-revision-reverted',
  RevisionsClosed = 'temba-revisions-closed',
  RowClick = 'temba-row-click',
  /** A helpdesk card's add button was clicked - detail carries the
   * section the new article should be filed under. */
  ArticleAddRequested = 'temba-article-add-requested',
  ShortcutEdit = 'temba-shortcut-edit',
  ShortcutDelete = 'temba-shortcut-delete',
  SelectionChange = 'temba-selection-change',
  BulkAction = 'temba-bulk-action',
  /** The label dropdown's "New Label…" row was clicked — detail
   * carries the action key and the selected row ids so the host can
   * open its create modal seeded with the selection. */
  LabelCreate = 'temba-label-create',
  /** A restorable piece of component state changed (page, sort, …).
   * Fired by lists so the host SPA can persist the state into the
   * browser's history entry (typically via `history.replaceState`).
   * Detail: `{ key: string, state: object }`. */
  HistoryChange = 'temba-history-change'
}
