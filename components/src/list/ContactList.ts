import { css, html, PropertyValues, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { ContentList, ContentListColumn } from './ContentList';
import { Icon } from '../Icons';
import { Contact } from '../interfaces';
import { getUrl, postJSON } from '../utils';
import { getStore } from '../store/Store';

const FIELD_PREFIX = 'field:';

/** Placeholder shown in any cell whose value is empty. */
const EMPTY = '--';

/** Ceiling on how many pages of fields we'll walk. The API serves 250
 * per page, so this is far past any real workspace — it exists only so
 * an endpoint that keeps handing back a `next` can't spin forever. */
const MAX_FIELD_PAGES = 20;

/**
 * Contact CRUDL list — drop-in replacement for the rapidpro
 * `contacts/contact_list.html` table. Each row carries a contact
 * silhouette as the leading icon, then the system columns (name,
 * URN, last-seen) followed by the workspace's featured fields.
 * Name + Last-seen are sortable.
 *
 * Featured contact fields render as extra columns after the system
 * columns. The component fetches them from
 * {@link ContactList.fieldsEndpoint} on connect; cells read each
 * contact's value out of `item.fields[<key>]`. Date/time fields
 * render as a relative duration, matching the Last-seen column.
 *
 * When {@link ContactList.priorityEndpoint} is set the field columns
 * can be dragged into a new order, which is saved as the workspace's
 * featured-field order (the list renders featured fields by priority,
 * so column order and field order are the same thing).
 */
export class ContactList extends ContentList<Contact> {
  static get styles() {
    return css`
      ${ContentList.styles}
      /* The contact name is the one cell that carries a slightly
         heavier weight — every other cell stays at the regular
         table weight so values don't read as emphasised. */
      .contact-name {
        color: inherit;
        font-weight: var(--w-medium);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .contact-urn {
        color: var(--text-3);
        font-size: 12.5px;
      }
    `;
  }

  /** Endpoint returning `{ results: ContactField[] }`. Fields where
   * `featured: true` become extra columns.
   *
   * The list deliberately fetches fields itself instead of reading the
   * global store: it has to work standalone (and against a custom
   * endpoint), and it may mount before any store exists on the page.
   * The store, when present, is only *told* about changes — see the
   * refresh after a priority save. The endpoint has no featured filter,
   * so the fetch pages through all fields and filters client-side. */
  @property({ type: String, attribute: 'fields-endpoint' })
  fieldsEndpoint = '/api/v2/fields.json';

  /** Endpoint accepting `{ featured: [keys...] }` to save featured-field
   * order (the same one the fields management page posts to). When set,
   * the field columns become drag-reorderable and a drop saves the new
   * order org-wide; the host only sets it for users holding the
   * update-priority permission. */
  @property({ type: String, attribute: 'priority-endpoint' })
  priorityEndpoint = '';

  /** Anonymous workspaces mask URN values, so instead of the URN
   * column the list shows each contact's ref (served as its own
   * anon-only key by the endpoint). */
  @property({ type: Boolean })
  anon = false;

  @state()
  private featuredFields: any[] = [];

  private pendingFieldsController?: AbortController;

  protected defaultEmptyMessage(): string {
    return msg('No contacts');
  }

  protected defaultSearchPlaceholder(): string {
    return msg('Search contacts');
  }

  constructor() {
    super();
    this.bulkActions = [
      { key: 'send', label: 'Send', icon: Icon.compose },
      { key: 'flow', label: 'Start flow', icon: Icon.flow },
      // Group toggle — a dropdown of the workspace's static (manual)
      // groups to add/remove the selection to/from, like the message
      // list's label dropdown.
      {
        key: 'label',
        label: 'Group',
        icon: Icon.group,
        labelsEndpoint: '/api/v2/groups.json?manual_only=1',
        labelsKey: 'groups'
      },
      // Archive trails the reversible actions; Delete, when offered,
      // always goes last.
      { key: 'archive', label: 'Archive', icon: Icon.archive },
      { key: 'delete', label: 'Delete', icon: Icon.delete, destructive: true }
    ];
  }

  public connectedCallback(): void {
    super.connectedCallback();
    this.loadFields();
  }

  public disconnectedCallback(): void {
    if (this.pendingFieldsController) {
      this.pendingFieldsController.abort();
      this.pendingFieldsController = undefined;
    }
    super.disconnectedCallback();
  }

  protected willUpdate(changes: PropertyValues): void {
    super.willUpdate(changes);
    // Rebuilding here (rather than in updated()) means a mounted
    // anon attribute is reflected in the first paint instead of
    // flashing the URN header for a frame.
    if (changes.has('anon') || changes.has('priorityEndpoint')) {
      this.refreshColumns();
    }
  }

  protected updated(changes: PropertyValues): void {
    super.updated(changes);
    if (changes.has('fieldsEndpoint') && this.fieldsEndpoint) {
      this.loadFields();
    }
  }

  private async loadFields(): Promise<void> {
    if (!this.fieldsEndpoint) return;
    // Abort any in-flight fields request so a stale response can't
    // overwrite featuredFields/columns after a new endpoint is set
    // or the component has disconnected.
    if (this.pendingFieldsController) {
      this.pendingFieldsController.abort();
    }
    const controller = new AbortController();
    this.pendingFieldsController = controller;
    try {
      // The fields API is cursor paginated (250 per page), and the
      // featured list a drop posts back is authoritative — any featured
      // field we never read would be silently un-featured org-wide. So
      // walk every page before deciding what's featured. Nothing is
      // assigned until the whole walk lands, so a page that fails leaves
      // the previous (complete) list in place rather than a truncated one.
      const all: any[] = [];
      const fetched = new Set<string>();
      let url: string = this.fieldsEndpoint;
      for (let page = 0; url && page < MAX_FIELD_PAGES; page++) {
        // an endpoint whose `next` points back at a page we've already
        // read would otherwise loop until the page cap
        if (fetched.has(url)) break;
        fetched.add(url);
        const response = await getUrl(url, controller);
        // If the controller has been swapped or cleared, the response
        // is from a stale request — drop it on the floor.
        if (this.pendingFieldsController !== controller) return;
        all.push(...(response.json?.results || []));
        url = response.json?.next || '';
      }
      this.featuredFields = all
        .filter((f: any) => f.featured)
        .sort((a: any, b: any) => (b.priority ?? 0) - (a.priority ?? 0));
      this.refreshColumns();
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        // eslint-disable-next-line no-console
        console.error('failed to fetch contact fields', err);
      }
    } finally {
      if (this.pendingFieldsController === controller) {
        this.pendingFieldsController = undefined;
      }
    }
  }

  /** Columns: name, urn, the featured fields, then last seen and
   * created on.
   *
   * Name leads, with URN, the workspace's custom fields, and the
   * last-seen / created-on dates trailing it. Columns through Last Seen
   * size to their content between min/max bounds and can be resized;
   * Created On grows to absorb any remaining browser width. Only Name is
   * pinned to the left edge, so identity stays anchored while everything
   * else scrolls.
   *
   * There is deliberately no group-membership column — contacts
   * routinely belong to dozens of groups, so a groups cell is
   * noise rather than signal in a list view. */
  protected buildColumns(): ContentListColumn[] {
    // Custom-field columns are all left-aligned for simplicity. Their
    // resize floor is deliberately half the generic 80px floor so users
    // can pack more workspace-specific fields into view; maxWidth caps a
    // runaway value.
    const fieldColumns: ContentListColumn[] = (this.featuredFields || []).map(
      (f: any) => ({
        key: FIELD_PREFIX + f.key,
        label: f.name || f.label || f.key,
        sortable: true,
        resizeMinWidth: '40px',
        maxWidth: '200px',
        resizable: true,
        // Field columns can be dragged into a new order, but only when
        // the host wired up somewhere to save it — reordering that
        // silently reverts on reload would read as broken.
        reorderable: !!this.priorityEndpoint
      })
    );
    // Name + URN are the pinned identity columns and are not
    // sortable — every other column (last-seen and the custom
    // fields) is.
    return [
      {
        key: 'name',
        label: msg('Name'),
        minWidth: '150px',
        maxWidth: '260px',
        pinned: true,
        resizable: true
      },
      this.anon
        ? {
            key: 'ref',
            label: msg('Ref'),
            minWidth: '120px',
            maxWidth: '190px',
            resizable: true
          }
        : {
            key: 'urn',
            label: msg('URN'),
            minWidth: '120px',
            maxWidth: '190px',
            resizable: true
          },
      ...fieldColumns,
      {
        key: 'last_seen_on',
        label: msg('Last seen'),
        sortable: true,
        minWidth: '96px',
        maxWidth: '150px',
        align: 'right',
        resizable: true
      },
      {
        key: 'created_on',
        label: msg('Created on'),
        sortable: true,
        minWidth: '96px',
        align: 'right',
        grow: true
      }
    ];
  }

  /** A committed header drag reordered the field columns — keep
   * featuredFields aligned with the new column order (so any rebuild
   * preserves it) and save it as the workspace's featured-field order.
   * Column order maps directly onto priority: leftmost = highest, the
   * same contract as the fields management page, whose endpoint this
   * posts to with the full featured list. */
  protected onColumnOrderChanged(columns: ContentListColumn[]): void {
    // A fields fetch still in flight was started against the old order
    // and would land on top of the drop, snapping the columns back with
    // the new order already on its way to the server.
    if (this.pendingFieldsController) {
      this.pendingFieldsController.abort();
      this.pendingFieldsController = undefined;
    }
    const keys = columns
      .filter((c) => c.key.startsWith(FIELD_PREFIX))
      .map((c) => c.key.substring(FIELD_PREFIX.length));
    this.featuredFields = keys
      .map((key) => (this.featuredFields || []).find((f: any) => f.key === key))
      .filter(Boolean);
    if (!this.priorityEndpoint) return;
    postJSON(this.priorityEndpoint, { featured: keys })
      .then((response) => {
        // postUrl only rejects on 5xx, so a 400/403/404 arrives here as a
        // perfectly resolved promise — the order was never stored and we
        // have to treat it as the failure it is.
        if (response.status < 200 || response.status >= 300) {
          throw response;
        }
      })
      .catch((error) => {
        console.warn('failed to save featured field order', error);
        // The list went away while the save was in flight — there are no
        // columns left to put back, and refetching would only leave a
        // request outstanding against a detached element.
        if (!this.isConnected) return;
        // Nothing made the dragged order durable, so stop showing it —
        // refetch and fall back on whatever the server still holds. The
        // success path deliberately doesn't refetch: we already display
        // exactly what we just saved, and a read-replica answering with
        // pre-write data would yank the columns back for no reason.
        this.loadFields();
      })
      .finally(() => {
        // Featured fields are workspace state other components on the
        // page read from the store (contact details, the fields page),
        // so its cached copy has to hear about the new order too. Looked
        // up here rather than cached on connect so a list that mounted
        // ahead of the store still finds it.
        getStore()
          ?.refreshFields()
          .catch(() => {
            // a stale store cache is cosmetic and elsewhere; the list
            // itself is already showing the saved order
          });
      });
  }

  protected getRowIcon(_item: Contact): string | null {
    return Icon.contact;
  }

  protected getRowHref(item: Contact): string | null {
    return item?.uuid ? `/contact/read/${item.uuid}/` : null;
  }

  protected renderCell(
    item: Contact,
    column: ContentListColumn
  ): TemplateResult | string {
    if (column.key.startsWith(FIELD_PREFIX)) {
      const fieldKey = column.key.substring(FIELD_PREFIX.length);
      const raw = item.fields?.[fieldKey];
      if (raw == null || raw === '') return EMPTY;
      // Location values are stored as a full hierarchy path
      // (e.g. "Nigeria > Yobe > Nguru > Dabule"); show only the leaf.
      if (this.isLocationField(fieldKey)) {
        const path = String(raw);
        return html`<span title=${path}>${this.locationLeaf(path)}</span>`;
      }
      // Date/time fields render via the timedate format.
      if (this.isDateField(fieldKey)) {
        return html`<temba-date value=${raw} display="timedate"></temba-date>`;
      }
      const value = String(raw);
      return html`<span title=${value}>${value}</span>`;
    }
    switch (column.key) {
      case 'name':
        return html`<span class="contact-name" title=${item.name || ''}
          >${item.name || EMPTY}</span
        >`;
      case 'urn':
        return html`<span class="contact-urn"
          >${this.primaryUrn(item) || EMPTY}</span
        >`;
      case 'ref':
        return html`<span class="contact-urn"
          >${(item as any).ref || EMPTY}</span
        >`;
      case 'last_seen_on':
        return item.last_seen_on
          ? html`<temba-date
              value=${item.last_seen_on}
              display="timedate"
            ></temba-date>`
          : EMPTY;
      case 'created_on':
        return item.created_on
          ? html`<temba-date
              value=${item.created_on}
              display="timedate"
            ></temba-date>`
          : EMPTY;
      default:
        return super.renderCell(item, column);
    }
  }

  /** True when a featured field stores a date/time value — those
   * cells render via temba-date instead of as plain text. */
  private isDateField(fieldKey: string): boolean {
    const field = (this.featuredFields || []).find(
      (f: any) => f.key === fieldKey
    );
    const type = field?.value_type;
    return type === 'datetime' || type === 'date';
  }

  /** True when a featured field stores a location value (state /
   * district / ward) — those are serialized as a full hierarchy path
   * and we render only the leaf. */
  private isLocationField(fieldKey: string): boolean {
    const field = (this.featuredFields || []).find(
      (f: any) => f.key === fieldKey
    );
    const type = field?.value_type;
    return type === 'state' || type === 'district' || type === 'ward';
  }

  /** The last segment of a location hierarchy path, e.g.
   * "Nigeria > Yobe > Nguru > Dabule" → "Dabule". */
  private locationLeaf(path: string): string {
    const parts = path.split('>');
    return parts[parts.length - 1].trim();
  }

  private primaryUrn(item: Contact): string {
    const i = item as any;
    if (i.urn) {
      // served as {scheme, display} by the list endpoint, but tolerate
      // a plain string (e.g. the public API's urn field)
      return typeof i.urn === 'string' ? i.urn : i.urn.display || '';
    }
    if (Array.isArray(i.urns) && i.urns.length > 0) {
      const u = i.urns[0];
      return typeof u === 'string'
        ? u.split(':')[1] || u
        : u?.display || u?.path || '';
    }
    return '';
  }
}
