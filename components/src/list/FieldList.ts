import { css, html, PropertyValues, TemplateResult } from 'lit';
import { msg, str } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { ContactField, CustomEventType } from '../interfaces';
import { EndpointMonitorElement } from '../store/EndpointMonitorElement';
import { Icon } from '../Icons';
import { designTokens } from '../styles/designTokens';
import { formatCount, postJSON } from '../utils';

// resolved per call rather than held in a module-level map so the names
// reflect the locale, which is only known once the store has loaded
const TYPE_NAMES = (): { [type: string]: string } => ({
  text: msg('Text'),
  numeric: msg('Number'),
  number: msg('Number'),
  datetime: msg('Date & Time'),
  state: msg('State'),
  ward: msg('Ward'),
  district: msg('District')
});

// display name for a field's value type, falling back to the raw type
// rather than rendering "undefined" for an unmapped type
const typeName = (field: ContactField): string =>
  TYPE_NAMES()[field.value_type] || field.value_type || '';

const matches = (field: ContactField, query: string): boolean => {
  if (!query) {
    return true;
  }
  // separate the haystack parts so a query can't match across them
  const search = [field.label, field.key, typeName(field)]
    .join(' ')
    .toLowerCase();
  return search.indexOf(query.toLowerCase()) > -1;
};

// referenced flow / group / campaign in the detail modal's usages
interface UsageRef {
  uuid?: string;
  name: string;
  url?: string;
}

interface CampaignEventUsage {
  id: number;
  campaign: UsageRef;
  offset_display?: string;
}

interface FieldDetailResponse {
  field: {
    key: string;
    name: string;
    value_type: string;
    featured: boolean;
    agent_access: string;
  };
  usages: {
    flows: UsageRef[];
    groups: UsageRef[];
    campaign_events: CampaignEventUsage[];
  };
  counts: { flows: number; groups: number; campaign_events: number };
  can_edit?: boolean;
  can_delete?: boolean;
}

export class FieldList extends EndpointMonitorElement {
  // title shown in the page header; a `title` slot overrides it
  @property({ type: String, attribute: 'header-title' })
  headerTitle = '';

  // GET endpoint for the page's content menu (rapidpro's content-menu view);
  // menu clicks fire temba-selection with the item for the host to dispatch
  @property({ type: String, attribute: 'content-menu-endpoint' })
  contentMenuEndpoint = '';

  // POST endpoint taking {featured: [keys]} — the ordered featured set
  @property({ type: String, attribute: 'priority-endpoint' })
  priorityEndpoint: string;

  // base path for the field detail JSON; the field key is appended
  @property({ type: String, attribute: 'detail-endpoint' })
  detailEndpoint = '';

  // the full ordered featured set, regardless of any search query -
  // this is what gets saved, so it must never be narrowed by a filter
  @property({ type: Object, attribute: false })
  featuredFields: ContactField[];

  @property({ type: Object, attribute: false })
  otherFieldKeys: string[] = [];

  @property({ type: String })
  query = '';

  @state()
  private searchOpen = false;

  // the field whose detail modal is open
  @state()
  private detailField: ContactField = null;

  // the detail modal's usages/permissions - null while the fetch is in flight
  @state()
  private detail: FieldDetailResponse = null;

  static get styles() {
    return css`
      ${designTokens}

      :host {
        display: flex;
        flex-direction: column;
        font-family: var(--font);
        color: var(--text-1);
        font-size: 13.5px;
      }

      /* The header is the same flush surface bar the fill-window lists
         render — full width, the lists' 12px inset, no card chrome —
         so this page and the list pages share one header treatment. */
      .header-panel {
        background: var(--surface);
        padding: 0 12px;
        border-bottom: 1px solid var(--border);
      }

      .header-actions {
        display: flex;
        align-items: center;
        gap: 14px;
        color: var(--text-2);
        font-size: 13px;
      }

      .action {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        user-select: none;
        height: 26px;
        box-sizing: border-box;
        padding: 0 10px;
        border: 1px solid var(--border-strong);
        border-radius: var(--r-sm);
        background: transparent;
        color: var(--text-2);
      }
      .action:hover {
        background: var(--sunken);
        color: var(--text-1);
      }
      .action temba-icon {
        --icon-color: currentColor;
      }

      /* Inline search bar — same treatment as the content lists, but
         filtering is live so there's no run/commit affordance. */
      .searchbar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        margin: -6px 0 12px 0;
        background: var(--sunken);
        border-radius: var(--r-sm);
        color: var(--text-3);
      }
      .searchbar input {
        flex: 1 1 auto;
        border: 0;
        background: transparent;
        outline: 0;
        font: inherit;
        color: var(--text-1);
        min-width: 0;
      }
      .searchbar input::placeholder {
        color: var(--text-3);
      }
      .searchbar .search-cancel {
        flex: 0 0 auto;
        margin-left: 5px;
        --icon-color: var(--text-3);
        --icon-color-circle-hover: rgba(15, 22, 36, 0.1);
      }

      .content {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 12px;
      }

      /* Card panel — the same surface treatment as the content lists */
      .panel {
        background: var(--surface);
        border-radius: var(--r);
        overflow: hidden;
        box-shadow: var(--shadow-1);
      }

      .section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--border);
        font-weight: var(--w-semibold, 600);
        color: var(--text-2);
        --icon-color: var(--text-3, #7b8593);
      }

      .rows {
        padding: 6px 0;
      }

      temba-sortable-list {
        display: block;
        width: 100%;
      }

      .field {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 12px;
        padding: 5px 12px;
        margin: 1px 6px;
        border: 1px solid transparent;
        border-radius: var(--curvature);
        user-select: none;
        cursor: pointer;
      }

      /* the row outline is the drag affordance, so it only appears when
         the pointer is on the drag handle itself */
      .field:has(.drag-handle:hover) {
        border-color: var(--border, #e4e7ec);
      }

      /* the drag affordance leads featured rows - always visible, and
         the only place a drag can start from */
      .field .drag-handle {
        flex-shrink: 0;
        cursor: grab;
        --icon-color: var(--text-3, #7b8593);
      }

      .field .name {
        min-width: 200px;
        width: 200px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-weight: var(--w-medium, 500);
      }

      .field .expression {
        flex-grow: 1;
        font-family: var(--font-mono, 'Roboto Mono', monospace);
        font-size: 0.85em;
        color: var(--text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .field .type {
        flex-shrink: 0;
        font-size: 0.85em;
        color: var(--text-3, #7b8593);
      }

      /* the star is the featured toggle - filled and gold when featured,
         hollow and muted when not */
      .star {
        flex-shrink: 0;
        --icon-color: var(--text-3, #7b8593);
      }

      .star.featured {
        --icon-color: #f5b60d;
      }

      .empty-note {
        padding: 1em 12px;
        color: var(--text-3, #7b8593);
        font-size: 0.9em;
      }

      /* the detail modal stands in for a field read page - page-like,
         no colored header bar (same shape as the campaign event modal) */
      .detail {
        display: flex;
        flex-direction: column;
      }

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
        align-items: center;
        gap: 10px;
        font-size: 15.5px;
        font-weight: var(--w-semibold, 600);
        color: var(--text-1);
      }

      .detail-actions {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .detail-actions .star {
        margin-right: 4px;
      }

      /* the way out - a quiet ✕ at the header's far right, same as the
         campaign event modal */
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

      /* match the page header's content-menu buttons so the modal's
         actions read like page actions */
      .menu-button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        box-sizing: border-box;
        height: 26px;
        padding: 0 10px;
        border: 1px solid var(--border-strong, #9ca3af);
        border-radius: var(--r-sm);
        font-size: 12.5px;
        font-weight: var(--w-regular, 400);
        cursor: pointer;
        user-select: none;
        background: var(--surface);
        color: var(--text-1);
        white-space: nowrap;
      }

      .menu-button:hover {
        background: var(--sunken);
      }

      .menu-button.destructive {
        color: #dc2626;
      }

      .menu-button.destructive:hover {
        border-color: #dc2626;
        /* pre-mixed fallback for browsers without color-mix() */
        background: #fdf2f2;
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .menu-button.destructive:hover {
          background: color-mix(in srgb, #dc2626 6%, var(--surface, #fff));
        }
      }

      .detail-body {
        display: flex;
        flex-direction: column;
        gap: 1.25em;
        overflow-y: auto;
        max-height: calc(100vh - 300px);
        padding: 1.25em 1.75em;
      }

      .detail-meta {
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 0.9em;
        color: var(--text-3, #7b8593);
      }

      .detail-meta .expression {
        font-family: var(--font-mono, 'Roboto Mono', monospace);
        color: var(--text-2);
      }

      .detail-section-title {
        margin-top: 0.25em;
        font-size: 0.75em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-3, #7b8593);
      }

      .usage-rows {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.5em;
        margin-top: 0.5em;
      }

      .usage-row {
        display: flex;
        align-items: center;
        gap: 0.6em;
      }

      .usage-row .usage-detail {
        font-size: 0.85em;
        color: var(--text-3, #7b8593);
      }

      .usage-more {
        font-size: 0.85em;
        color: var(--text-3, #7b8593);
      }

      .no-usages {
        color: var(--text-3, #7b8593);
        font-size: 0.9em;
      }
    `;
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.store?.fieldsEndpoint) {
      this.url = this.store.fieldsEndpoint;
    }
  }

  public willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('data') || changed.has('query')) {
      this.filterFields();
    }
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('searchOpen') && this.searchOpen) {
      const input = this.shadowRoot.querySelector(
        '.searchbar input'
      ) as HTMLInputElement;
      input?.focus();
    }
  }

  private filterFields() {
    const filteredKeys = this.store.getFieldKeys().filter((key) => {
      const field = this.store.getContactField(key);
      if (field.featured) {
        return false;
      }
      return matches(field, this.query);
    });

    // sort by the label instead of the key
    filteredKeys.sort((a, b) => {
      return this.store
        .getContactField(a)
        .label.localeCompare(this.store.getContactField(b).label);
    });

    this.otherFieldKeys = filteredKeys;
    this.featuredFields = [...this.store.getFeaturedFields()];
  }

  // the featured fields matching the current search query
  private getVisibleFeaturedFields(): ContactField[] {
    return this.featuredFields.filter((field) => matches(field, this.query));
  }

  // the featured set + order is saved as one atomic list; the server
  // derives show_in_table and descending priorities from it
  private savePriorities() {
    postJSON(this.priorityEndpoint, {
      featured: this.featuredFields.map((field) => field.key)
    })
      .catch((error) => {
        console.warn('Failed to save featured fields', error);
      })
      .finally(() => {
        // reconcile the optimistic featured/order state with server
        // truth on success and failure alike - the refetch recomputes
        // both lists via filterFields
        this.store.refreshFields();
      });
  }

  private isFeatured(key: string): boolean {
    return (this.featuredFields || []).some((field) => field.key === key);
  }

  // optimistically append a field to the featured list - the store
  // refresh after the save makes it durable; ordering is a drag affair
  private featureField(key: string) {
    const field = this.store.getContactField(key);
    if (!field || this.isFeatured(key)) {
      return;
    }
    this.featuredFields = [...this.featuredFields, field];
    this.otherFieldKeys = this.otherFieldKeys.filter((k) => k !== key);
    this.savePriorities();
  }

  private unfeatureField(key: string) {
    if (!this.isFeatured(key)) {
      return;
    }
    this.featuredFields = this.featuredFields.filter(
      (field) => field.key !== key
    );
    const keys = [...this.otherFieldKeys, key];
    keys.sort((a, b) =>
      this.store
        .getContactField(a)
        .label.localeCompare(this.store.getContactField(b).label)
    );
    this.otherFieldKeys = keys;
    this.savePriorities();
  }

  private toggleFeatured(key: string) {
    if (this.isFeatured(key)) {
      this.unfeatureField(key);
    } else {
      this.featureField(key);
    }
  }

  // dress the drag ghost as a lifted copy of the row: the row itself is
  // transparent over the card surface and offset by its margin, so give
  // the ghost its own surface and zero the margin (border-box keeps the
  // inlined padding from widening it past the measured rect)
  private prepareGhost = (ghost: HTMLElement) => {
    ghost.style.margin = '0';
    ghost.style.boxSizing = 'border-box';
    ghost.style.background = 'var(--surface, #fff)';
    ghost.style.border = '1px solid var(--border, #e4e7ec)';
    ghost.style.borderRadius = 'var(--curvature, 6px)';
    ghost.style.boxShadow = 'var(--shadow-1, 0 2px 6px rgba(0, 0, 0, 0.12))';
  };

  private handleFeaturedOrderChanged(event: CustomEvent) {
    const [fromIdx, toIdx] = event.detail.swap;
    const featured = [...this.featuredFields];
    const temp = featured[fromIdx];
    featured.splice(fromIdx, 1);
    featured.splice(toIdx, 0, temp);
    this.featuredFields = featured;
    this.savePriorities();
  }

  // the row star toggles featured without opening the row's detail modal
  private handleStarClicked(event: MouseEvent, field: ContactField) {
    event.stopPropagation();
    this.toggleFeatured(field.key);
  }

  // keyboard activation of the star must not also fire the row's keydown
  // (which would open the detail modal), so swallow the event here
  private handleStarKeydown(event: KeyboardEvent, field: ContactField) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
    }
    this.handleActivationKey(event, () => this.toggleFeatured(field.key));
  }

  private handleSearchInput(event: InputEvent) {
    // keep the visible text verbatim - matches() lowercases the query
    // itself, so no trim/lowercase here that would mutate what's typed
    this.query = (event.target as HTMLInputElement).value || '';
  }

  private toggleSearch() {
    this.searchOpen = !this.searchOpen;
    if (!this.searchOpen) {
      this.query = '';
    }
  }

  // in place of a field read page, clicking a row opens its detail
  // modal, which also lazily loads the field's usages and permissions
  private handleFieldClicked(field: ContactField) {
    this.detailField = field;
    this.loadDetail(field);
  }

  private async loadDetail(field: ContactField): Promise<void> {
    this.detail = null;
    if (!this.detailEndpoint) {
      return;
    }
    // tolerate a host passing the base path without a trailing slash
    const base = this.detailEndpoint.endsWith('/')
      ? this.detailEndpoint
      : `${this.detailEndpoint}/`;
    try {
      const response = await this.store.getUrl(
        `${base}${encodeURIComponent(field.key)}/`,
        { force: true }
      );
      if (this.detailField !== field) {
        return;
      }
      this.detail = response.json;
    } catch {
      // leave the modal usable with just the store's data
    }
  }

  // Everything the host must dispatch flows through temba-selection with
  // one of three payload shapes, matching the campaign events contract:
  // a content-menu item ({item, event, ...}) from the embedded page
  // header, a row action ({key, action: 'update'|'delete'}) to open the
  // edit/delete modals, or a usage reference ({uuid, name, url}) to
  // navigate to.

  // edit / delete close the detail modal before the host opens the edit
  // or delete-confirm modal in its place - modals never stack
  private handleEditClicked() {
    const field = this.detailField;
    this.detailField = null;
    this.fireCustomEvent(CustomEventType.Selection, {
      key: field.key,
      action: 'update'
    });
  }

  private handleDeleteClicked() {
    const field = this.detailField;
    this.detailField = null;
    this.fireCustomEvent(CustomEventType.Selection, {
      key: field.key,
      action: 'delete'
    });
  }

  private handleToggleFeatured() {
    this.toggleFeatured(this.detailField.key);
  }

  // navigating to a usage from the detail modal closes it first
  private handleUsageClicked(usage: UsageRef) {
    this.detailField = null;
    this.fireCustomEvent(CustomEventType.Selection, usage);
  }

  private handleDetailClosed = () => {
    this.detailField = null;
  };

  // activate a non-button row on Enter/Space (matches native button behavior)
  private handleActivationKey(e: KeyboardEvent, action: () => void) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      action();
    }
  }

  private renderHeader(): TemplateResult {
    return html`
      <div class="header-panel">
        <temba-page-header content-menu-endpoint=${this.contentMenuEndpoint}>
          <slot name="title" slot="title">${this.headerTitle}</slot>
          <div slot="actions" class="header-actions">
            ${!this.searchOpen
              ? html`
                  <span class="action" @click=${() => this.toggleSearch()}>
                    <temba-icon name=${Icon.search} size="0.95"></temba-icon>
                    Search
                  </span>
                `
              : null}
          </div>
        </temba-page-header>
        ${this.searchOpen
          ? html`
              <div class="searchbar">
                <input
                  type="text"
                  placeholder=${msg('Search fields')}
                  .value=${this.query}
                  @input=${this.handleSearchInput}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Escape') {
                      this.toggleSearch();
                    }
                  }}
                />
                <temba-icon
                  class="search-cancel"
                  name=${Icon.close}
                  size="1.1"
                  clickable
                  title=${msg('Cancel search')}
                  aria-label=${msg('Cancel search')}
                  @click=${() => this.toggleSearch()}
                ></temba-icon>
              </div>
            `
          : null}
      </div>
    `;
  }

  private renderStar(field: ContactField): TemplateResult {
    const featured = this.isFeatured(field.key);
    return html`
      <temba-icon
        class="star ${featured ? 'featured' : ''}"
        name=${featured ? Icon.featured_filled : Icon.featured}
        size="1.1"
        clickable
        role="button"
        tabindex="0"
        title=${featured ? msg('Featured') : msg('Not featured')}
        aria-label=${featured
          ? msg(str`Unfeature ${field.label}`)
          : msg(str`Feature ${field.label}`)}
        @click=${(e: MouseEvent) => this.handleStarClicked(e, field)}
        @keydown=${(e: KeyboardEvent) => this.handleStarKeydown(e, field)}
      ></temba-icon>
    `;
  }

  // sortable rows lead with a drag handle and are draggable from it;
  // every row trails with its featured-toggle star
  private renderField(field: ContactField, sortable = false): TemplateResult {
    return html`
      <div
        class="field ${sortable ? 'sortable' : ''}"
        id="${field.key}"
        tabindex="0"
        @click=${() => this.handleFieldClicked(field)}
        @keydown=${(e: KeyboardEvent) =>
          this.handleActivationKey(e, () => this.handleFieldClicked(field))}
      >
        ${sortable
          ? html`<temba-icon
              class="drag-handle"
              name=${Icon.drag}
            ></temba-icon>`
          : null}
        <div class="name">${field.label}</div>
        <div class="expression">@fields.${field.key}</div>
        <div class="type">${typeName(field)}</div>
        ${this.renderStar(field)}
      </div>
    `;
  }

  private renderFeaturedPanel(): TemplateResult {
    const visible = this.getVisibleFeaturedFields();
    let body: TemplateResult;
    if (visible.length === 0) {
      body = html`
        <div class="empty-note">
          ${this.query
            ? msg('No matches')
            : msg('Star a field to feature it on contact pages')}
        </div>
      `;
    } else if (this.query) {
      body = html`
        <div class="rows">
          ${visible.map((field) => this.renderField(field))}
        </div>
      `;
    } else {
      body = html`
        <div class="rows">
          <temba-sortable-list
            id="featured-list"
            dragHandle="drag-handle"
            .prepareGhost=${this.prepareGhost}
            @temba-order-changed=${this.handleFeaturedOrderChanged}
          >
            ${this.featuredFields.map((field) => this.renderField(field, true))}
          </temba-sortable-list>
        </div>
      `;
    }

    return html`
      <div class="panel" id="featured-panel">
        <div class="section-header">
          <temba-icon name=${Icon.featured_filled}></temba-icon>
          <div>${msg('Featured')}</div>
        </div>
        ${body}
      </div>
    `;
  }

  private renderOtherPanel(): TemplateResult {
    return html`
      <div class="panel" id="other-panel">
        <div class="section-header">
          <temba-icon name=${Icon.fields}></temba-icon>
          <div>${msg('Other Fields')}</div>
        </div>
        ${this.otherFieldKeys.length === 0
          ? html`<div class="empty-note">
              ${this.query ? msg('No matches') : msg('No fields')}
            </div>`
          : html`<div class="rows">
              ${this.otherFieldKeys.map((key) =>
                this.renderField(this.store.getContactField(key))
              )}
            </div>`}
      </div>
    `;
  }

  private renderUsageSection(
    title: string,
    type: string,
    items: UsageRef[],
    total: number
  ): TemplateResult | null {
    if (!items || items.length === 0) {
      return null;
    }
    return html`
      <div>
        <div class="detail-section-title">${title}</div>
        <div class="usage-rows">
          ${items.map(
            (usage) => html`
              <temba-label
                type=${type}
                clickable
                @click=${() => this.handleUsageClicked(usage)}
                >${usage.name}</temba-label
              >
            `
          )}
          ${total > items.length
            ? html`<div class="usage-more">
                ${msg(str`and ${formatCount(total - items.length)} more`)}
              </div>`
            : null}
        </div>
      </div>
    `;
  }

  private renderCampaignEventUsages(): TemplateResult | null {
    const events = this.detail?.usages?.campaign_events || [];
    if (events.length === 0) {
      return null;
    }
    const total = this.detail.counts?.campaign_events || events.length;
    return html`
      <div>
        <div class="detail-section-title">${msg('Campaign Events')}</div>
        <div class="usage-rows">
          ${events.map(
            (event) => html`
              <div class="usage-row">
                <temba-label
                  type="campaign"
                  clickable
                  @click=${() => this.handleUsageClicked(event.campaign)}
                  >${event.campaign?.name}</temba-label
                >
                ${event.offset_display
                  ? html`<div class="usage-detail">
                      ${event.offset_display}
                    </div>`
                  : null}
              </div>
            `
          )}
          ${total > events.length
            ? html`<div class="usage-more">
                ${msg(str`and ${formatCount(total - events.length)} more`)}
              </div>`
            : null}
        </div>
      </div>
    `;
  }

  private renderUsages(): TemplateResult {
    if (!this.detail) {
      return html`<temba-loading units="3" size="8"></temba-loading>`;
    }

    const usages = this.detail.usages || {
      flows: [],
      groups: [],
      campaign_events: []
    };
    const counts = this.detail.counts || {
      flows: 0,
      groups: 0,
      campaign_events: 0
    };

    const hasUsages =
      (usages.flows || []).length +
        (usages.groups || []).length +
        (usages.campaign_events || []).length >
      0;

    if (!hasUsages) {
      return html`<div class="no-usages">
        Not used by any flows, groups or campaigns.
      </div>`;
    }

    return html`
      ${this.renderUsageSection(
        msg('Flows'),
        'flow',
        usages.flows,
        counts.flows
      )}
      ${this.renderUsageSection(
        msg('Groups'),
        'group',
        usages.groups,
        counts.groups
      )}
      ${this.renderCampaignEventUsages()}
    `;
  }

  // modal detail view for a field, standing in for a field read page -
  // the feature toggle, edit and delete actions, and the field's usages
  private renderDetail(): TemplateResult {
    const field = this.detailField;
    const featured = field ? this.isFeatured(field.key) : false;

    return html`
      <temba-dialog
        size="xlarge"
        variant="flat"
        primaryButtonName=""
        cancelButtonName=""
        hideOnClick
        ?open=${!!field}
        @temba-dialog-hidden=${this.handleDetailClosed}
        @keyup=${(e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            this.handleDetailClosed();
          }
        }}
      >
        ${field
          ? html`
              <div class="detail">
                <div class="detail-header">
                  <div class="detail-title">${field.label}</div>
                  ${this.detail
                    ? html`<div class="detail-actions">
                        ${this.detail.can_edit
                          ? html`<temba-icon
                              class="star featured-toggle ${featured
                                ? 'featured'
                                : ''}"
                              name=${featured
                                ? Icon.featured_filled
                                : Icon.featured}
                              size="1.3"
                              clickable
                              role="button"
                              tabindex="0"
                              title=${featured
                                ? msg('Featured')
                                : msg('Not featured')}
                              aria-label=${featured
                                ? msg(str`Unfeature ${field.label}`)
                                : msg(str`Feature ${field.label}`)}
                              @click=${this.handleToggleFeatured}
                              @keydown=${(e: KeyboardEvent) =>
                                this.handleActivationKey(e, () =>
                                  this.handleToggleFeatured()
                                )}
                            ></temba-icon>`
                          : null}
                        ${this.detail.can_edit
                          ? html`<button
                              class="menu-button"
                              @click=${this.handleEditClicked}
                            >
                              Edit
                            </button>`
                          : null}
                        ${this.detail.can_delete
                          ? html`<button
                              class="menu-button destructive"
                              @click=${this.handleDeleteClicked}
                            >
                              Delete
                            </button>`
                          : null}
                      </div>`
                    : null}
                  <div
                    class="detail-close"
                    role="button"
                    tabindex="0"
                    aria-label=${msg('Close')}
                    @click=${this.handleDetailClosed}
                    @keydown=${(e: KeyboardEvent) =>
                      this.handleActivationKey(e, this.handleDetailClosed)}
                  >
                    <temba-icon name=${Icon.close} size="1.4"></temba-icon>
                  </div>
                </div>

                <div class="detail-body">
                  <div class="detail-meta">
                    <div class="expression">@fields.${field.key}</div>
                    <div>${typeName(field)}</div>
                  </div>
                  ${this.renderUsages()}
                </div>
              </div>
            `
          : null}
      </temba-dialog>
    `;
  }

  public render(): TemplateResult {
    if (!this.featuredFields) {
      return null;
    }

    return html`
      ${this.renderHeader()}
      <div class="content">
        ${this.renderFeaturedPanel()} ${this.renderOtherPanel()}
      </div>
      ${this.renderDetail()}
    `;
  }
}
