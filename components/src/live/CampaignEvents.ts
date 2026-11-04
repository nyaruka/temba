import { css, html, PropertyValueMap, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import {
  CampaignScheduleEvent,
  CustomEventType,
  ObjectReference
} from '../interfaces';
import { EndpointMonitorElement } from '../store/EndpointMonitorElement';
import { Icon } from '../Icons';
import { designTokens } from '../styles/designTokens';
import { formatCount } from '../utils';
import {
  buttonChrome,
  buttonChromeActive,
  buttonChromeDestructive,
  buttonChromeDestructiveHover,
  buttonChromeHover
} from '../styles/buttonChrome';

interface CampaignEventsResponse {
  events: CampaignScheduleEvent[];
  campaign?: ObjectReference;
  can_edit?: boolean;
  can_delete?: boolean;
}

// one row in the recent-contacts popup
interface RecentFire {
  contact: ObjectReference;
  time: string;
  // the point was skipped for this contact rather than fired
  skipped?: boolean;
}

// distinct hues assigned per relative-to field so each field's "line" reads
// clearly apart - the same palette (and assignment scheme) the contact
// timeline uses for campaigns, so colors mean "grouping" in both places
const FIELD_COLORS = [
  '#1a86d0', // blue
  '#e8843f', // orange
  '#ec407a', // pink
  '#2bb2a6', // teal
  '#0a5290', // deep blue
  '#a25320', // deep orange
  '#a02153', // deep pink
  '#176a61' // deep teal
];

// uppercase the first letter of a localized display string - offset-0
// events lead the detail schedule with "On <field>"
const capitalize = (text: string): string =>
  text ? text.charAt(0).toUpperCase() + text.slice(1) : text;

// a section is one subway line: all the events anchored to the same date
// field, split into those firing before the field's date and those firing
// on or after it
interface Section {
  key: string;
  name: string;
  system: boolean;
  before: CampaignScheduleEvent[];
  onAfter: CampaignScheduleEvent[];
}

export class CampaignEvents extends EndpointMonitorElement {
  @property({ type: String })
  campaign: string;

  // optional endpoint override, defaults to the campaign's events endpoint
  @property({ type: String })
  endpoint: string;

  // title shown in the page header; a `title` slot overrides it
  @property({ type: String, attribute: 'header-title' })
  headerTitle = '';

  // subtitle under the title; a `subtitle` slot overrides it
  @property({ type: String })
  subtitle = '';

  // GET endpoint for the page's content menu (rapidpro's content-menu view);
  // menu clicks fire temba-selection with the item for the host to dispatch
  @property({ type: String, attribute: 'content-menu-endpoint' })
  contentMenuEndpoint = '';

  @property({ type: Object, attribute: false })
  data: CampaignEventsResponse;

  @property({ type: String })
  lang_scheduling = 'Scheduling';

  @property({ type: String })
  lang_edit = 'Edit';

  @property({ type: String })
  lang_delete = 'Delete';

  @property({ type: String })
  lang_recent_contacts = 'Recent Contacts';
  lang_skipped = 'Skipped';

  @property({ type: String })
  lang_scheduled = 'scheduled';

  @property({ type: String })
  lang_scheduled_contacts = 'Contacts scheduled for this event';

  @property({ type: String })
  lang_send_message = 'Send Message';

  @property({ type: String })
  lang_start_flow = 'Start Flow';

  @property({ type: String })
  lang_empty = 'No events';

  @property({ type: String })
  lang_empty_help =
    'Events send a message or start a flow for each contact in the group, offset from a date field on the contact.';

  // the event whose detail modal is open
  @state()
  private detailEvent: CampaignScheduleEvent = null;

  // the detail modal's recent contacts - null while the fetch is in flight
  @state()
  private fires: RecentFire[] = null;

  static get styles() {
    return css`
      ${designTokens}

      /* The page-header bar at the top, then one card per anchor field
         in a padded region below. */
      :host {
        display: flex;
        flex-direction: column;
        font-family: var(--font);
        color: var(--text-1);
        font-size: 13.5px;
      }

      /* The header is the same flush surface bar the fill-window lists
         render — full width, the lists' 12px inset, no card chrome —
         so a list page and this read page share one header treatment. */
      .header-panel {
        background: var(--surface);
        padding: 0 12px;
        border-bottom: 1px solid var(--border);
      }

      /* Card panel — the same surface treatment as the content lists so
         the read page reads as part of the same family. The anchor dots
         and tint mixes paint with the widget background, so inside a
         card that must be the card surface. */
      .panel {
        background: var(--surface);
        border-radius: var(--r);
        overflow: hidden;
        box-shadow: var(--shadow-1);
        --color-widget-bg: var(--surface);
      }

      /* badges (group, archived) get their own row between the header and
         the cards. Slotted links shouldn't pick up anchor styling - the
         labels inside them carry the look. */
      .badges {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 12px 0;
      }

      .badges ::slotted(*) {
        display: flex;
        align-items: center;
        gap: 8px;
        text-decoration: none;
      }

      /* the per-field cards stack in a padded region below the header */
      .content {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
      }

      /* the section cards sit inside the events wrapper, which stays out
         of layout so the cards participate in the content's column gap */
      .events {
        display: contents;
      }

      /* empty state follows the list design system: centered icon, a short
         title and muted explanatory copy */
      .empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 4em 1em;
        color: var(--text-color);
      }

      .empty temba-icon {
        margin-bottom: 0.75em;
        --icon-color: var(--text-3, #7b8593);
      }

      .empty-title {
        font-weight: 600;
        margin-bottom: 0.4em;
      }

      .empty-help {
        font-size: 0.875em;
        line-height: 1.5;
        max-width: 22em;
        margin-bottom: 1em;
        color: var(--text-3, #7b8593);
      }

      /* one subway line per anchor field, each in its own card */
      .section {
        display: flex;
        flex-direction: column;
        padding: 0.9em 12px 1em;
      }

      .row {
        display: flex;
        align-items: stretch;
      }

      /* the schedule offset ("3 days before"), vertically centered on its
         dot. mute via color (not opacity) so the hovered delivery-hour
         tooltip renders at full alpha */
      .time {
        width: 9em;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        padding-right: 0.65em;
        font-size: 0.8em;
        color: var(--text-3, #7b8593);
        white-space: nowrap;
      }

      .time temba-tip {
        cursor: default;
      }

      /* the subway rail */
      .track {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 1.75em;
        flex-shrink: 0;
      }

      .line {
        width: 2px;
        flex: 1;
        background: var(--color-borders, rgba(0, 0, 0, 0.12));
      }

      .line.hidden {
        background: transparent;
      }

      .dot {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        box-sizing: border-box;
        flex-shrink: 0;
        z-index: 1;
        border: 2px solid var(--dot-color);
        display: flex;
        align-items: center;
        justify-content: center;
        /* icons inside the dot take the dot's hue */
        --icon-color: var(--dot-color);
        /* plain widget bg for browsers without color-mix(); the tinted
           fill below needs the @supports gate since var() keeps an
           invalid declaration alive until computed-value time */
        background: var(--color-widget-bg, #fff);
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .dot {
          background: color-mix(
            in srgb,
            var(--dot-color) 12%,
            var(--color-widget-bg, #fff)
          );
        }
      }

      /* the anchor marks the field's date itself - painted with the widget
         background so it masks the rail behind it and reads as the station
         the line is built around */
      .dot.anchor {
        background: var(--color-widget-bg, #fff);
      }

      /* system fields aren't real contact fields - dashed and muted */
      .system-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 0.85em;
        line-height: 1.5;
        padding: 0.05em 0.65em;
        border-radius: 999px;
        white-space: nowrap;
        border: 1px dashed var(--border-strong, #9ca3af);
        color: var(--text-3, #7b8593);
        --icon-color: var(--text-3, #7b8593);
      }

      .anchor-label {
        display: flex;
        align-items: center;
        margin: 0.5em 0;
        padding: 0 0.6em;
      }

      /* flat event entry - no card chrome */
      .event {
        flex-grow: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0.4em 0.75em;
        margin: 0.1em 0;
        border-radius: var(--curvature);
        /* transparent by default so the hover border doesn't shift layout */
        border: 1px solid transparent;
      }

      .count {
        flex-shrink: 0;
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 0.35em;
        font-size: 0.8em;
        color: var(--text-3, #7b8593);
        white-space: nowrap;
        --icon-color: var(--text-3, #7b8593);
      }

      .event.clickable {
        cursor: pointer;
      }

      .event.clickable:hover {
        border-color: var(--border, #e4e7ec);
      }

      .title {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 0.45em;
        color: var(--text-color);
        line-height: 1.4;
      }

      .title-text {
        flex: 1;
        min-width: 0;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      /* the detail modal stands in for an event read page - page-like, no
         colored header bar. The header and gutter pin to the top and bottom
         with full-bleed rules; the body between them scrolls when needed. */
      .detail {
        display: flex;
        flex-direction: column;
      }

      .detail-body {
        display: flex;
        flex-direction: column;
        gap: 1.25em;
        overflow-y: auto;
        max-height: calc(100vh - 300px);
        padding: 1.25em 1.75em;
      }

      /* header and gutter share uniform padding on all sides, with the
         title vertically centered against the action buttons */
      .detail-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 1em;
        border-bottom: 1px solid var(--border, #e4e7ec);
      }

      .detail-title {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .detail-campaign {
        font-size: 15.5px;
        font-weight: var(--w-semibold, 600);
        color: var(--text-1);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* the schedule line leads the body - the offset, anchor field and
         delivery hour on the left, the labeled scheduled count on the right */
      .detail-schedule-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .detail-schedule {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.9em;
        color: var(--text-3, #7b8593);
      }

      .detail-count {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 0.35em;
        font-size: 0.85em;
        color: var(--text-3, #7b8593);
        --icon-color: var(--text-3, #7b8593);
      }

      .detail-actions {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      /* match the page header's content-menu buttons so the modal's actions
         read like page actions */
      .menu-button {
        ${buttonChrome}
      }

      .menu-button:hover {
        ${buttonChromeHover}
      }
      .menu-button:active {
        ${buttonChromeActive}
      }

      .menu-button.destructive {
        ${buttonChromeDestructive}
      }

      .menu-button.destructive:hover {
        ${buttonChromeDestructiveHover}
      }

      /* the event's action, contained with a leading type label. Children
         hug their content so a flow pill doesn't stretch the box's width. */
      .detail-action {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.6em;
        padding: 0.9em 1em 1em;
        /* pre-mixed fallback for browsers without color-mix() */
        background: #f9fafa;
        border: 1px solid var(--border, #e4e7ec);
        border-radius: var(--r);
        line-height: 1.5;
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .detail-action {
          background: color-mix(
            in srgb,
            var(--sunken, #f1f3f5) 45%,
            var(--surface, #fff)
          );
        }
      }

      /* the close (✕) in the header's upper right - the square
         hover-wash button treatment (the pager buttons'), sitting
         just outboard of the action buttons */
      .detail-close {
        flex-shrink: 0;
        margin-left: -4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: var(--r-sm);
        color: var(--text-3, #7b8593);
        cursor: pointer;
        user-select: none;
      }
      .detail-close:hover {
        background: var(--sunken);
        color: var(--text-1);
      }
      .detail-close temba-icon {
        --icon-color: currentColor;
      }

      .detail-section-title {
        margin-top: 0.25em;
        font-size: 0.75em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-3, #7b8593);
      }

      /* recent contacts - a simple name/time table */
      .fires {
        min-height: 2em;
        margin: -0.25em 0 0.5em;
      }

      .fire-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1em;
        padding: 0.4em 0.5em;
        border-radius: var(--r-sm);
        cursor: pointer;
      }

      .fire-row:hover {
        background: var(--color-selection, rgba(0, 0, 0, 0.04));
      }

      .fire-name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .fire-when {
        display: flex;
        align-items: center;
        gap: 0.5em;
        flex-shrink: 0;
        font-size: 0.85em;
        color: var(--text-3, #7b8593);
      }

      .fire-row.skipped .fire-name {
        color: var(--text-3, #7b8593);
      }

      .fire-skipped {
        font-size: 0.85em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
    `;
  }

  // the endpoint returns a custom {events: [...]} payload rather than the
  // paginated {results: [...]} shape that the store's fetch machinery
  // expects, so we fetch and assign data ourselves. The base class's
  // inherited `url` property is unsupported here - setting it would race
  // its monitored fetch against ours.
  private getEndpoint(): string | null {
    if (this.endpoint) {
      return this.endpoint;
    }
    return this.campaign
      ? `/campaign/events/${encodeURIComponent(this.campaign)}/`
      : null;
  }

  private async loadEvents(): Promise<void> {
    // capture the endpoint at request time so a slower in-flight response for
    // a previous campaign can't overwrite data for the one we're now showing
    const requestedEndpoint = this.getEndpoint();
    if (!requestedEndpoint) {
      this.data = null;
      return;
    }

    try {
      const response = await this.store.getUrl(requestedEndpoint, {
        force: true
      });
      if (this.getEndpoint() !== requestedEndpoint) {
        return;
      }
      this.data = response.json;
    } catch {
      // on failure leave the prior data in place so a transient blip doesn't
      // wipe the schedule; data is only cleared when the campaign changes
    }
  }

  public refresh(): void {
    this.loadEvents();
  }

  protected updated(
    changes: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.updated(changes);

    if (changes.has('campaign') || changes.has('endpoint')) {
      // blank immediately on a campaign switch so the previous campaign's
      // events aren't briefly visible while the new fetch is in flight
      this.data = null;
      this.loadEvents();
    }

    if (changes.has('data') && this.data) {
      const events = Array.isArray(this.data.events) ? this.data.events : [];
      this.fireCustomEvent(CustomEventType.DetailsChanged, {
        count: events.length
      });
    }
  }

  // events arrive sorted by field name then offset; group them into one
  // section per field, split around the field's date
  private getSections(events: CampaignScheduleEvent[]): Section[] {
    const sections: Section[] = [];
    const byKey: { [key: string]: Section } = {};

    for (const event of events) {
      const key = event.relative_to?.key || '';
      let section = byKey[key];
      if (!section) {
        section = {
          key,
          name: event.relative_to?.name || '',
          system: !!event.relative_to?.system,
          before: [],
          onAfter: []
        };
        byKey[key] = section;
        sections.push(section);
      }
      if (event.offset < 0) {
        section.before.push(event);
      } else {
        section.onAfter.push(event);
      }
    }
    return sections;
  }

  // whether this event can be edited - scheduling-state events are locked
  // until mailroom finishes rescheduling them
  private canEdit(event: CampaignScheduleEvent): boolean {
    return !!this.data?.can_edit && event.status === 'ready';
  }

  private canDelete(): boolean {
    return !!this.data?.can_delete;
  }

  // the detail modal also loads who the event recently fired for
  public handleEventClicked(event: CampaignScheduleEvent) {
    this.detailEvent = event;
    this.loadFires(event);
  }

  private async loadFires(event: CampaignScheduleEvent): Promise<void> {
    this.fires = null;
    try {
      const response = await this.store.getUrl(event.fires_url, {
        force: true
      });
      if (this.detailEvent !== event) {
        return;
      }
      this.fires = Array.isArray(response.json?.fires)
        ? response.json.fires
        : [];
    } catch {
      if (this.detailEvent === event) {
        this.fires = [];
      }
    }
  }

  // edit / delete close the detail modal before the host opens the edit or
  // delete-confirm modal in its place - modals never stack
  public handleEditClicked() {
    const event = this.detailEvent;
    this.detailEvent = null;
    this.fireCustomEvent(CustomEventType.Selection, {
      action: 'edit_event',
      event
    });
  }

  public handleDeleteClicked() {
    const event = this.detailEvent;
    this.detailEvent = null;
    this.fireCustomEvent(CustomEventType.Selection, {
      action: 'delete_event',
      event
    });
  }

  // clicking a flow pill navigates to the flow instead of opening the row's
  // detail modal (and closes the modal when clicked from inside it)
  public handlePillClicked(e: Event, event: CampaignScheduleEvent) {
    e.stopPropagation();
    this.detailEvent = null;
    this.fireCustomEvent(CustomEventType.Selection, event.flow);
  }

  // navigating to a contact from the detail modal closes it first
  public handleFireClicked(fire: RecentFire) {
    this.detailEvent = null;
    this.fireCustomEvent(CustomEventType.Selection, fire.contact);
  }

  // the dialog closes itself on its Close button / ESC (firing only
  // temba-button-clicked) and on mask clicks (temba-dialog-hidden) - our
  // open state must reset on every path or the next open is a no-op change
  // and the modal never reopens
  private handleDetailClosed = () => {
    this.detailEvent = null;
  };

  // activate a non-button row on Enter/Space (matches native button behavior)
  private handleActivationKey(e: KeyboardEvent, action: () => void) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  }

  // system fields (Created On, Last Seen On, ...) aren't editable contact
  // fields, so they get a dashed, muted pill instead of the field pill
  private renderFieldPill(field: {
    name?: string;
    system?: boolean;
  }): TemplateResult {
    if (field?.system) {
      return html`<span class="system-pill">
        <temba-icon name="fields" size="0.9"></temba-icon>
        ${field?.name}
      </span>`;
    }
    return html`<temba-label type="field" icon="fields"
      >${field?.name}</temba-label
    >`;
  }

  private renderTime(event: CampaignScheduleEvent): TemplateResult {
    // when the event fires at a specific hour, surface it on hover
    if (event.delivery_hour_display) {
      return html`
        <temba-tip text=${event.delivery_hour_display} position="top">
          ${event.offset_display}
        </temba-tip>
      `;
    }
    return html`${event.offset_display}`;
  }

  // the scheduled count (or scheduling state), shown inside the event's
  // selectable outline and on the detail modal
  private renderCount(event: CampaignScheduleEvent): TemplateResult {
    if (event.status === 'scheduling') {
      return html`<div class="count">${this.lang_scheduling}</div>`;
    }
    return html`
      <div class="count" title=${this.lang_scheduled_contacts}>
        ${formatCount(event.count || 0)}
        <temba-icon name=${Icon.contact} size="0.9"></temba-icon>
      </div>
    `;
  }

  private renderEvent(event: CampaignScheduleEvent): TemplateResult {
    // message events display the message text; flow events show a clickable
    // flow pill linking to the flow (the "start" action is implied)
    const body =
      event.type === 'message'
        ? html`<div class="title-text">
            <temba-expression-highlight
              >${event.message}</temba-expression-highlight
            >
          </div>`
        : event.flow
          ? html`<temba-label
              type="flow"
              clickable
              @click=${(e: Event) => this.handlePillClicked(e, event)}
              >${event.flow.name}</temba-label
            >`
          : html``;

    return html`
      <div
        class="event clickable"
        role="button"
        tabindex="0"
        @click=${() => this.handleEventClicked(event)}
        @keydown=${(e: KeyboardEvent) =>
          this.handleActivationKey(e, () => this.handleEventClicked(event))}
      >
        <div class="title">${body}</div>
        ${this.renderCount(event)}
      </div>
    `;
  }

  private renderEventRow(
    event: CampaignScheduleEvent,
    color: string,
    first: boolean,
    last: boolean
  ): TemplateResult {
    return html`
      <div class="row">
        <div class="time">${this.renderTime(event)}</div>
        <div class="track">
          <div class="line ${first ? 'hidden' : ''}"></div>
          <div class="dot" style="--dot-color:${color}">
            <temba-icon
              name=${event.type === 'message' ? Icon.message : Icon.flow}
              size="0.65"
            ></temba-icon>
          </div>
          <div class="line ${last ? 'hidden' : ''}"></div>
        </div>
        ${this.renderEvent(event)}
      </div>
    `;
  }

  // the anchor row marks the field's date itself - events before it sit
  // above, events on or after it sit below
  private renderAnchorRow(
    section: Section,
    color: string,
    first: boolean,
    last: boolean
  ): TemplateResult {
    return html`
      <div class="row anchor-row">
        <div class="time"></div>
        <div class="track">
          <div class="line ${first ? 'hidden' : ''}"></div>
          <div class="dot anchor" style="--dot-color:${color}"></div>
          <div class="line ${last ? 'hidden' : ''}"></div>
        </div>
        <div class="anchor-label">${this.renderFieldPill(section)}</div>
      </div>
    `;
  }

  // each field's line takes its hue from the section's position, so colors
  // are a pure function of the current payload
  private renderSection(section: Section, index: number): TemplateResult {
    const color = FIELD_COLORS[index % FIELD_COLORS.length];
    const total = section.before.length + 1 + section.onAfter.length;

    let idx = 0;
    const rows: TemplateResult[] = [];
    for (const event of section.before) {
      rows.push(this.renderEventRow(event, color, idx === 0, false));
      idx++;
    }
    rows.push(
      this.renderAnchorRow(section, color, idx === 0, idx === total - 1)
    );
    idx++;
    for (const event of section.onAfter) {
      rows.push(this.renderEventRow(event, color, false, idx === total - 1));
      idx++;
    }

    return html`<div class="panel section">${rows}</div>`;
  }

  // the page header — title + content menu — is temba-page-header, the
  // same header the content lists embed, so a list page and this read
  // page share one header treatment. Slot presence is probed at render
  // time (not reactive) - fine while hosts slot content declaratively.
  private renderHeader(): TemplateResult | null {
    const hasSubtitle =
      this.subtitle || this.querySelector('[slot="subtitle"]');
    if (!this.headerTitle && !this.contentMenuEndpoint && !hasSubtitle) {
      return null;
    }
    return html`
      <div class="header-panel">
        <temba-page-header content-menu-endpoint=${this.contentMenuEndpoint}>
          <slot name="title" slot="title">${this.headerTitle}</slot>
          ${hasSubtitle
            ? html`<slot name="subtitle" slot="subtitle"
                >${this.subtitle}</slot
              >`
            : null}
        </temba-page-header>
      </div>
    `;
  }

  private renderSchedule(): TemplateResult {
    if (!this.data) {
      return html``;
    }

    // tolerate a malformed/empty response rather than throwing
    const events = Array.isArray(this.data.events) ? this.data.events : [];

    if (events.length === 0) {
      return html`<div class="content">
        <div class="panel">
          <div class="empty">
            <slot name="empty">
              <temba-icon name=${Icon.campaign} size="2"></temba-icon>
              <div class="empty-title">${this.lang_empty}</div>
              <div class="empty-help">${this.lang_empty_help}</div>
            </slot>
          </div>
        </div>
      </div>`;
    }

    // each field's line is its own card
    return html`
      <div class="content">
        <div class="events">
          ${this.getSections(events).map((section, index) =>
            this.renderSection(section, index)
          )}
        </div>
      </div>
    `;
  }

  // badges (the campaign's group, archived state) get their own row
  // between the header and the cards. Same render-time slot probe as the
  // header - late-slotted badges won't toggle the row.
  private renderBadges(): TemplateResult | null {
    if (!this.querySelector('[slot="badges"]')) {
      return null;
    }
    return html`<div class="badges"><slot name="badges"></slot></div>`;
  }

  // the recent contacts section - omitted entirely when the event hasn't
  // fired for anyone
  private renderFires(): TemplateResult | null {
    if (!this.fires || this.fires.length === 0) {
      return null;
    }
    return html`
      <div class="detail-section-title">${this.lang_recent_contacts}</div>
      <div class="fires">
        ${this.fires.map(
          (fire) => html`
            <div
              class="fire-row ${fire.skipped ? 'skipped' : ''}"
              role="button"
              tabindex="0"
              @click=${() => this.handleFireClicked(fire)}
              @keydown=${(e: KeyboardEvent) =>
                this.handleActivationKey(e, () => this.handleFireClicked(fire))}
            >
              <div class="fire-name">${fire.contact.name}</div>
              <div class="fire-when">
                ${fire.skipped
                  ? html`<span class="fire-skipped">${this.lang_skipped}</span>`
                  : null}
                <temba-date value=${fire.time} display="timedate"></temba-date>
              </div>
            </div>
          `
        )}
      </div>
    `;
  }

  // modal detail view for an event, standing in for an event read page -
  // page-like (no colored header bar) with the schedule as its title, edit
  // and delete actions, the content, and the recent contacts
  private renderDetail(): TemplateResult {
    const event = this.detailEvent;

    return html`
      <temba-dialog
        size="xlarge"
        variant="flat"
        primaryButtonName=""
        cancelButtonName=""
        hideOnClick
        ?open=${!!event}
        @temba-dialog-hidden=${this.handleDetailClosed}
        @keyup=${(e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            this.handleDetailClosed();
          }
        }}
      >
        ${event
          ? html`
              <div class="detail">
                <div class="detail-header">
                  <div class="detail-title">
                    <div class="detail-campaign">
                      ${this.data?.campaign?.name || this.headerTitle}
                    </div>
                  </div>
                  ${this.canEdit(event) || this.canDelete()
                    ? html`<div class="detail-actions">
                        ${this.canEdit(event)
                          ? html`<button
                              class="menu-button"
                              @click=${this.handleEditClicked}
                            >
                              ${this.lang_edit}
                            </button>`
                          : null}
                        ${this.canDelete()
                          ? html`<button
                              class="menu-button destructive"
                              @click=${this.handleDeleteClicked}
                            >
                              ${this.lang_delete}
                            </button>`
                          : null}
                      </div>`
                    : null}
                  <div
                    class="detail-close"
                    role="button"
                    tabindex="0"
                    aria-label="Close"
                    @click=${this.handleDetailClosed}
                    @keydown=${(e: KeyboardEvent) =>
                      this.handleActivationKey(e, this.handleDetailClosed)}
                  >
                    <temba-icon name=${Icon.close} size="1.4"></temba-icon>
                  </div>
                </div>

                <div class="detail-body">
                  <div class="detail-schedule-row">
                    <div class="detail-schedule">
                      <span
                        >${event.offset === 0
                          ? capitalize(event.offset_display)
                          : event.offset_display}</span
                      >
                      ${this.renderFieldPill(event.relative_to)}
                      ${event.delivery_hour_display
                        ? html`<span>${event.delivery_hour_display}</span>`
                        : null}
                    </div>
                    <div
                      class="detail-count"
                      title=${event.status === 'scheduling'
                        ? ''
                        : this.lang_scheduled_contacts}
                    >
                      ${event.status === 'scheduling'
                        ? html`${this.lang_scheduling}`
                        : html`<temba-icon
                              name=${Icon.contact}
                              size="0.9"
                            ></temba-icon>
                            ${formatCount(event.count || 0)}
                            ${this.lang_scheduled}`}
                    </div>
                  </div>

                  <div class="detail-action">
                    <div class="detail-section-title">
                      ${event.type === 'message'
                        ? this.lang_send_message
                        : this.lang_start_flow}
                    </div>
                    ${event.type === 'message'
                      ? html`<temba-expression-highlight
                          >${event.message}</temba-expression-highlight
                        >`
                      : event.flow
                        ? html`<temba-label
                            type="flow"
                            clickable
                            @click=${(e: Event) =>
                              this.handlePillClicked(e, event)}
                            >${event.flow.name}</temba-label
                          >`
                        : null}
                  </div>

                  ${this.renderFires()}
                </div>
              </div>
            `
          : null}
      </temba-dialog>
    `;
  }

  public render(): TemplateResult {
    return html`${this.renderHeader()} ${this.renderBadges()}
    ${this.renderSchedule()} ${this.renderDetail()}`;
  }
}
