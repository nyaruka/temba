import { css, html, PropertyValues, TemplateResult } from 'lit';
import { msg, str } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { Icon } from '../Icons';
import { Contact, CustomEventType, Group, URN } from '../interfaces';
import { getLanguageName } from '../languages';
import { capitalize, WebResponse } from '../utils';
import { Select } from '../form/select/Select';
import { TextInput } from '../form/TextInput';
import { ContactFieldEditor } from './ContactFieldEditor';
import { ContactStoreElement, getDestinationURN } from './ContactStoreElement';
import { Events } from '../events/eventRenderers';

interface Option {
  name: string;
  value: string;
}

// resolved lazily so the option names pick up the active locale
const getStatusOptions = (): Option[] => [
  { value: 'active', name: msg('Active') },
  { value: 'blocked', name: msg('Blocked') },
  { value: 'stopped', name: msg('Stopped') },
  { value: 'archived', name: msg('Archived') }
];

export class ContactDetails extends ContactStoreElement {
  // the contact state we render - live changes to any of these reach us
  // through the central watcher
  protected watchTypes = [
    Events.CONTACT_NAME_CHANGED,
    Events.CONTACT_EMAIL_CHANGED,
    Events.CONTACT_URNS_CHANGED,
    Events.CONTACT_LANGUAGE_CHANGED,
    Events.CONTACT_STATUS_CHANGED,
    Events.CONTACT_GROUPS_CHANGED
  ];

  @property({ type: Boolean })
  editable = false;

  @property({ type: Boolean })
  anon = false;

  @property({ type: Array })
  schemes: Option[] = [];

  @state()
  private newScheme = '';

  @state()
  private newUrn = '';

  @state()
  private urnDialogOpen = false;

  @state()
  private draftUrns: URN[] = [];

  @state()
  private saving = new Set<string>();

  @state()
  private failed = new Set<string>();

  private saveGeneration = 0;

  private saveGenerations = new Map<string, number>();

  private fieldSaveGenerations = new Map<string, number>();

  private groupsSave: Promise<WebResponse> | null = null;

  static get styles() {
    return css`
      .wrapper {
        padding-top: 0;
      }

      .row {
        padding-bottom: 0.6em;
        border-bottom: 1px solid #ececec;
        margin-bottom: 1em;
      }

      .row .label {
        color: var(--text-2);
        font-size: 11px;
        font-weight: var(--w-medium);
        margin: 0 0 4px 2px;
      }

      .row .value {
        margin-left: 0.25em;
        margin-top: 0.35em;
        min-height: 1.75em;
        display: flex;
        flex-wrap: wrap;
        gap: 0.4em;
      }

      .editable-row {
        position: relative;
        margin-bottom: 1em;
      }

      .editable-row > label {
        display: block;
        color: var(--text-2);
        font-size: 12px;
        font-weight: var(--w-medium);
        margin: 0 0 4px 2px;
      }

      .editable-row temba-select {
        display: block;
        --color-widget-bg: white;
      }

      .editable-row.saving {
        pointer-events: none;
        opacity: 0.7;
      }

      .editable-row.failed {
        --color-widget-border: rgba(var(--error-rgb), 0.5);
      }

      .error {
        position: absolute;
        right: 8px;
        top: 29px;
        z-index: 1;
        --icon-color: rgb(var(--error-rgb));
      }

      .dynamic-groups {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4em;
        margin: 0.5em 0 0 0.25em;
      }

      .urn-display {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: start;
        margin-bottom: 14px;
      }

      .urn-display.editable {
        grid-template-columns: minmax(0, 1fr) auto 24px;
      }

      .urn-display temba-contact-field {
        --contact-field-separator: none;
        --contact-field-padding-bottom: 0;
        --contact-field-wrapper-margin-bottom: 0;
        margin-bottom: 0;
      }

      .urn-display.only-unsendable {
        border-left: 3px solid rgba(var(--error-rgb), 0.65);
        background: rgba(var(--error-rgb), 0.05);
        padding: 6px 8px 6px 10px;
      }

      .urn-display.only-unsendable temba-contact-field {
        --contact-field-value-icon-color: rgb(var(--error-rgb));
      }

      temba-contact-field.email.verified {
        --contact-field-value-icon-color: rgb(var(--success-rgb));
      }

      .urn-more-count {
        display: flex;
        align-items: center;
        align-self: center;
        height: 24px;
        margin-top: 22px;
        color: var(--text-2);
        font-size: 12px;
        white-space: nowrap;
      }

      .urn-edit-icon {
        display: flex;
        width: 24px;
        height: 24px;
        margin-top: 22px;
        justify-self: center;
        cursor: pointer;
        --icon-color: var(--text-2);
      }

      .urn-edit-icon:hover,
      .urn-edit-icon:focus-visible {
        --icon-color: var(--text-1);
      }

      .urn-sendability {
        display: flex;
        align-items: center;
        justify-content: center;
        --icon-color: var(--text-3);
      }

      temba-textinput .urn-sendability {
        margin: 0 8px 0 10px;
      }

      .urn-delete-action {
        display: flex;
        align-items: center;
        margin: 0 10px 0 4px;
      }

      .urn-delete-icon {
        display: flex;
        cursor: pointer;
        --icon-color: var(--text-2);
      }

      .urn-delete-icon:hover,
      .urn-delete-icon:focus-visible {
        --icon-color: rgb(var(--error-rgb));
      }

      .urn-dialog {
        display: grid;
        gap: 20px;
        padding: 24px;
        width: 100%;
        box-sizing: border-box;
      }

      .urn-list {
        display: block;
        width: 100%;
      }

      .urn-row {
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr);
        gap: 10px;
        align-items: center;
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
      }

      .urn-row temba-textinput {
        display: block;
        width: 100%;
        min-width: 0;
      }

      .drag-slot {
        align-self: end;
        display: flex;
        align-items: center;
        justify-content: center;
        height: calc(var(--input-h, 34px) + 2px);
        box-sizing: border-box;
      }

      .drag-handle {
        cursor: grab;
        --icon-color: var(--text-2);
      }

      .drag-handle:active {
        cursor: grabbing;
      }

      .add-urn-fields {
        display: grid;
        grid-template-columns: minmax(120px, 0.8fr) minmax(160px, 1.2fr) 72px;
        gap: 8px;
        align-items: end;
        margin-left: 28px;
        padding-top: 16px;
        border-top: 1px solid var(--border-light, #ececec);
      }

      .add-urn-fields label {
        display: block;
        color: var(--text-2);
        font-size: 12px;
        font-weight: var(--w-medium);
        margin: 0 0 4px 2px;
      }

      .add-urn-fields temba-select,
      .add-urn-fields temba-textinput {
        display: block;
        width: 100%;
        min-width: 0;
      }

      .add-urn-button {
        min-height: var(--input-h, 34px);
        display: flex;
        align-items: center;
        justify-content: flex-end;
      }

      .add-urn-button temba-button {
        --button-height: calc(var(--input-h, 34px) + 2px);
      }

      .add-urn-error {
        grid-column: 1 / -1;
        color: rgb(var(--error-rgb));
        font-size: 12px;
      }

      @media (max-width: 480px) {
        .add-urn-fields {
          grid-template-columns: 1fr;
          margin-left: 28px;
        }
      }

      temba-contact-field.last-field {
        --contact-field-separator: none;
        margin-bottom: 0;
      }
    `;
  }

  private getSchemeName(scheme: string): string {
    return (
      this.schemes.find((option) => option.value === scheme)?.name ||
      capitalize(scheme as any)
    );
  }

  private getManualGroups(): Group[] {
    return this.data.groups.filter((group: Group) => !group.is_dynamic);
  }

  private getDynamicGroups(): Group[] {
    return this.data.groups.filter((group: Group) => group.is_dynamic);
  }

  private getLanguageOptions(): Option[] {
    const codes = [...(this.store.getWorkspace()?.languages || [])];
    if (this.data.language && !codes.includes(this.data.language)) {
      codes.unshift(this.data.language);
    }
    return [
      { value: 'none', name: msg('No Preference') },
      ...codes.map((code) => ({ value: code, name: getLanguageName(code) }))
    ];
  }

  private setSaveState(key: string, status: 'saving' | 'failed' | 'ready') {
    const saving = new Set(this.saving);
    const failed = new Set(this.failed);
    saving.delete(key);
    failed.delete(key);
    if (status === 'saving') saving.add(key);
    if (status === 'failed') failed.add(key);
    this.saving = saving;
    this.failed = failed;
  }

  private finishSave(
    contactId: string,
    key: string,
    generation: number,
    status: 'failed' | 'ready'
  ) {
    if (
      this.contact !== contactId ||
      this.saveGenerations.get(key) !== generation
    ) {
      return;
    }
    this.saveGenerations.delete(key);
    this.setSaveState(key, status);
  }

  private async save(key: string, payload: any): Promise<WebResponse> {
    const contactId = this.contact;
    if (
      !contactId ||
      !this.data ||
      this.data.uuid !== contactId ||
      this.url !== `${this.endpoint}${contactId}`
    ) {
      return { status: 409, json: {}, headers: new Headers() };
    }

    const contactUuid = this.data.uuid;
    const generation = ++this.saveGeneration;
    const fields = Object.keys(payload);
    this.saveGenerations.set(key, generation);
    fields.forEach((field) => this.fieldSaveGenerations.set(field, generation));
    this.setSaveState(key, 'saving');
    try {
      const response = await this.store.postJSON(
        `${this.writeEndpoint}${contactUuid}`,
        payload
      );
      if (response.status !== 200) {
        fields.forEach((field) => {
          if (this.fieldSaveGenerations.get(field) === generation) {
            this.fieldSaveGenerations.delete(field);
          }
        });
        this.finishSave(contactId, key, generation, 'failed');
        return response;
      }
      if (
        this.contact === contactId &&
        this.data?.uuid === contactId &&
        this.url === `${this.endpoint}${contactId}`
      ) {
        const updated = { ...this.data };
        let hasUpdates = false;
        fields.forEach((field) => {
          if (this.fieldSaveGenerations.get(field) === generation) {
            if (response.json[field] !== undefined) {
              updated[field] = response.json[field];
              hasUpdates = true;
            }
            this.fieldSaveGenerations.delete(field);
          }
        });
        if (hasUpdates) {
          this.setContact(updated, contactId);
        }
      }
      this.finishSave(contactId, key, generation, 'ready');
      return response;
    } catch (error) {
      fields.forEach((field) => {
        if (this.fieldSaveGenerations.get(field) === generation) {
          this.fieldSaveGenerations.delete(field);
        }
      });
      this.finishSave(contactId, key, generation, 'failed');
      return { status: 500, json: {}, headers: new Headers() };
    }
  }

  /**
   * A watcher delivery carries server state from before the writes we still
   * have in flight, so keep our own value for anything mid-save - the save
   * itself applies the server's version when it lands.
   */
  protected mergeWatchedContact(contact: Contact, previous: Contact): Contact {
    if (!previous || this.fieldSaveGenerations.size === 0) {
      return contact;
    }

    const merged = { ...contact };
    this.fieldSaveGenerations.forEach((generation, field) => {
      if (field in previous) {
        const value = previous[field];
        merged[field] = Array.isArray(value) ? [...value] : value;
      }
    });
    return merged;
  }

  public willUpdate(changed: PropertyValues): void {
    if (changed.has('contact') || changed.has('endpoint')) {
      const url = this.contact ? `${this.endpoint}${this.contact}` : null;
      if (url !== this.url) {
        this.data = null;
      }
      this.saveGeneration++;
      this.saveGenerations.clear();
      this.fieldSaveGenerations.clear();
      this.groupsSave = null;
      this.saving.clear();
      this.failed.clear();
      this.urnDialogOpen = false;
      this.draftUrns = [];
      this.newScheme = '';
      this.newUrn = '';
    }
    super.willUpdate(changed);
  }

  public async handleTextChanged(event: Event) {
    const field = event.currentTarget as ContactFieldEditor;
    const value = field.value;
    const response = await this.save(field.key, {
      [field.key]: field.key === 'name' && !value ? null : value
    });
    field.handleResponse(
      response,
      response.status === 200 ? response.json[field.key] || '' : value
    );
  }

  public handleDraftUrnChanged(event: Event, index: number) {
    this.draftUrns[index].path = (event.currentTarget as TextInput).value;
  }

  public handleNewSchemeChanged(event: Event) {
    const select = event.currentTarget as Select<Option>;
    this.newScheme = select.values[0]?.value || '';
  }

  public handleNewUrnChanged(event: Event) {
    this.newUrn = (event.currentTarget as TextInput).value;
  }

  public showUrnDialog() {
    this.newScheme = this.newScheme || this.schemes[0]?.value || '';
    this.newUrn = '';
    this.draftUrns = this.data.urns.map((urn) => ({ ...urn }));
    this.setSaveState('urn-dialog', 'ready');
    this.urnDialogOpen = true;
  }

  public hideUrnDialog() {
    this.urnDialogOpen = false;
    this.newUrn = '';
    this.draftUrns = [];
    this.setSaveState('urn-dialog', 'ready');
  }

  public handleAddUrn() {
    const scheme = this.newScheme || this.schemes[0]?.value;
    const path = this.newUrn.trim();
    if (!scheme || !path) return;

    this.draftUrns = [...this.draftUrns, { scheme, path }];
    this.newUrn = '';
  }

  public async handleUrnDialogButton(event: CustomEvent) {
    event.stopImmediatePropagation();
    if (event.detail?.button?.primary) {
      const response = await this.save('urn-dialog', {
        urns: this.draftUrns
          .filter((urn) => urn.path.trim())
          .map((urn) => `${urn.scheme}:${urn.path.trim()}`)
      });
      if (response.status === 200) {
        this.hideUrnDialog();
      }
    } else {
      this.hideUrnDialog();
    }
  }

  public handleUrnOrderChanged(event: CustomEvent) {
    event.stopPropagation();
    const [fromIndex, toIndex] = event.detail.swap;
    const urns = [...this.draftUrns];
    const moved = urns.splice(fromIndex, 1)[0];
    urns.splice(toIndex, 0, moved);
    this.draftUrns = urns;
  }

  public handleUrnOrderKeyDown(event: KeyboardEvent, index: number) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    const toIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (toIndex < 0 || toIndex >= this.draftUrns.length) return;

    event.preventDefault();
    event.stopPropagation();
    const urns = [...this.draftUrns];
    const moved = urns.splice(index, 1)[0];
    urns.splice(toIndex, 0, moved);
    this.draftUrns = urns;
    void this.updateComplete.then(() => {
      (
        this.shadowRoot.querySelector(
          `#urn-${toIndex} .drag-handle`
        ) as HTMLElement
      )?.focus();
    });
  }

  public handleDeleteUrn(event: Event, index: number) {
    event.preventDefault();
    event.stopPropagation();
    this.draftUrns = this.draftUrns.filter((_, urnIndex) => urnIndex !== index);
  }

  public handleDeleteUrnKeyDown(event: KeyboardEvent, index: number) {
    if (event.key === 'Enter' || event.key === ' ') {
      this.handleDeleteUrn(event, index);
    }
  }

  public handleUrnEditKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.showUrnDialog();
    }
  }

  private prepareUrnGhost = (ghost: HTMLElement) => {
    ghost.style.setProperty('display', 'grid', 'important');
    ghost.style.setProperty(
      'grid-template-columns',
      '18px minmax(0, 1fr)',
      'important'
    );
    ghost.style.setProperty('column-gap', '10px', 'important');
    ghost.style.setProperty('align-items', 'center', 'important');

    const dragSlot = ghost.querySelector('.drag-slot') as HTMLElement;
    if (dragSlot) {
      dragSlot.style.setProperty('display', 'flex', 'important');
      dragSlot.style.setProperty('align-items', 'center', 'important');
      dragSlot.style.setProperty('justify-content', 'center', 'important');
      dragSlot.style.setProperty('align-self', 'end', 'important');
      dragSlot.style.setProperty(
        'height',
        'calc(var(--input-h, 34px) + 2px)',
        'important'
      );
      dragSlot.style.setProperty('box-sizing', 'border-box', 'important');
    }
  };

  public handleSearch(event: CustomEvent) {
    event.stopPropagation();
    this.fireCustomEvent(CustomEventType.ButtonClicked, event.detail);
  }

  public async handleGroupsChanged(event: Event) {
    const select = event.currentTarget as Select<any>;
    const groupsSave = this.save('groups', {
      groups: select.values.map((group) => group.uuid)
    });
    this.groupsSave = groupsSave;
    try {
      await groupsSave;
    } finally {
      if (this.groupsSave === groupsSave) {
        this.groupsSave = null;
      }
    }
  }

  public async handleLanguageChanged(event: Event) {
    const select = event.currentTarget as Select<Option>;
    await this.save('language', {
      language:
        !select.values[0]?.value || select.values[0].value === 'none'
          ? null
          : select.values[0].value
    });
  }

  public async handleStatusChanged(event: Event) {
    const select = event.currentTarget as Select<Option>;
    const status = select.values[0]?.value;
    const contactId = this.contact;
    if (this.groupsSave) {
      await this.groupsSave;
    }
    if (this.contact !== contactId || this.data?.uuid !== contactId) return;
    if (!status || status === this.data.status) return;

    const payload: any = { status };
    if (this.data.status === 'active') {
      // Leaving active normally clears group membership. Include the current
      // manual groups so an inline status edit preserves that membership.
      payload.groups = this.getManualGroups().map((group) => group.uuid);
    }
    await this.save('status', payload);
  }

  private renderFailure(key: string): TemplateResult {
    return this.failed.has(key)
      ? html`<temba-tip class="error" text=${msg('Failed to save changes.')}>
          <temba-icon name=${Icon.alert_warning}></temba-icon>
        </temba-tip>`
      : null;
  }

  private renderEditableSelect(
    key: string,
    label: string,
    options: Option[],
    value: string,
    handler: (event: Event) => void
  ): TemplateResult {
    return html`<div
      class="editable-row ${this.saving.has(key)
        ? 'saving'
        : ''} ${this.failed.has(key) ? 'failed' : ''}"
    >
      <label>${label}</label>
      ${this.renderFailure(key)}
      <temba-select
        valueKey="value"
        .values=${options.filter((option) => option.value === (value || ''))}
        @change=${handler}
      >
        ${options.map(
          (option) =>
            html`<temba-option
              name=${option.name}
              value=${option.value}
            ></temba-option>`
        )}
      </temba-select>
    </div>`;
  }

  private renderDynamicGroups(editable: boolean): TemplateResult {
    const groups = this.getDynamicGroups();
    if (!groups.length) return null;
    return html`<div class="smart-groups ${editable ? 'editable-row' : 'row'}">
      ${editable
        ? html`<label>${msg('Smart Groups')}</label>`
        : html`<div class="label">${msg('Smart Groups')}</div>`}
      <div class=${editable ? 'dynamic-groups' : 'value'}>
        ${groups.map(
          (group) =>
            html`<temba-label
              onclick="goto(event)"
              href="/contact/group/${group.uuid}/"
              icon=${Icon.group_smart}
              type="group"
              clickable
            >
              ${group.name}
            </temba-label>`
        )}
      </div>
    </div>`;
  }

  private renderDisplayedUrn(
    urn: URN | undefined,
    className = ''
  ): TemplateResult {
    const unsendable = urn?.channel === null;
    return html`<temba-contact-field
      class=${className}
      name=${urn ? this.getSchemeName(urn.scheme) : msg('URN')}
      value=${urn ? urn.display || urn.path : msg('No URNs')}
      valueIcon=${unsendable ? Icon.contact_stopped : ''}
      valueIconLabel=${unsendable
        ? msg('Not sendable: no channel available')
        : ''}
      disabled
    ></temba-contact-field>`;
  }

  private renderUrnSendability(urn: URN): TemplateResult {
    if (urn.channel !== null) return null;
    const label = msg('Not sendable: no channel available');
    return html`<temba-tip
      class="urn-sendability unsendable"
      text=${label}
      position="top"
      slot="prefix"
    >
      <temba-icon name=${Icon.contact_stopped} aria-label=${label}></temba-icon>
    </temba-tip>`;
  }

  private renderUrnDialog(): TemplateResult {
    const selectedScheme = this.newScheme || this.schemes[0]?.value || '';
    return html`<temba-dialog
      header=${msg('Edit URNs')}
      size="medium"
      primaryButtonName=${msg('Save')}
      cancelButtonName=${msg('Cancel')}
      .open=${this.urnDialogOpen}
      ?disabled=${this.saving.has('urn-dialog')}
      ?submitting=${this.saving.has('urn-dialog')}
      @temba-button-clicked=${this.handleUrnDialogButton}
    >
      <div class="urn-dialog">
        <temba-sortable-list
          class="urn-list"
          dragHandle="drag-handle"
          gap="12px"
          .prepareGhost=${this.prepareUrnGhost}
          @temba-order-changed=${this.handleUrnOrderChanged}
        >
          ${this.draftUrns.map((urn, index) => {
            return html`
              <div
                id="urn-${index}"
                class="urn-row sortable ${this.draftUrns.length > 1
                  ? ''
                  : 'single'}"
              >
                <div class="drag-slot">
                  ${this.draftUrns.length > 1
                    ? html`<temba-icon
                        class="drag-handle"
                        name=${Icon.drag}
                        title=${msg('Drag to reorder')}
                        aria-label=${msg(
                          str`Reorder ${this.getSchemeName(
                            urn.scheme
                          )} URN. Use the up and down arrow keys to move it.`
                        )}
                        role="button"
                        tabindex="0"
                        @keydown=${(event: KeyboardEvent) =>
                          this.handleUrnOrderKeyDown(event, index)}
                      ></temba-icon>`
                    : null}
                </div>
                <temba-textinput
                  class="urn-input"
                  name="urn-${index}"
                  label=${this.getSchemeName(urn.scheme)}
                  .value=${urn.path}
                  @input=${(event: Event) =>
                    this.handleDraftUrnChanged(event, index)}
                  @change=${(event: Event) =>
                    this.handleDraftUrnChanged(event, index)}
                >
                  ${this.renderUrnSendability(urn)}
                  <temba-tip
                    class="urn-delete-action"
                    text=${msg('Delete URN')}
                    position="top"
                  >
                    <temba-icon
                      class="urn-delete-icon"
                      name=${Icon.delete}
                      aria-label=${msg('Delete URN')}
                      role="button"
                      tabindex="0"
                      @click=${(event: Event) =>
                        this.handleDeleteUrn(event, index)}
                      @keydown=${(event: KeyboardEvent) =>
                        this.handleDeleteUrnKeyDown(event, index)}
                    ></temba-icon>
                  </temba-tip>
                </temba-textinput>
              </div>
            `;
          })}
        </temba-sortable-list>
        ${this.failed.has('urn-dialog')
          ? html`<div class="add-urn-error">
              ${msg('Failed to save URNs. Check the addresses and try again.')}
            </div>`
          : null}
        ${this.schemes.length
          ? html`<div class="add-urn-fields">
              <div>
                <label>${msg('URN Type')}</label>
                <temba-select
                  valueKey="value"
                  .values=${this.schemes.filter(
                    (option) => option.value === selectedScheme
                  )}
                  @change=${this.handleNewSchemeChanged}
                >
                  ${this.schemes.map(
                    (option) =>
                      html`<temba-option
                        name=${option.name}
                        value=${option.value}
                      ></temba-option>`
                  )}
                </temba-select>
              </div>
              <temba-textinput
                name="urn"
                label=${msg('Address')}
                .value=${this.newUrn}
                @input=${this.handleNewUrnChanged}
              ></temba-textinput>
              <div class="add-urn-button">
                <temba-button
                  name=${msg('Add')}
                  icon=${Icon.add}
                  light
                  ?disabled=${!this.newUrn.trim()}
                  @click=${this.handleAddUrn}
                ></temba-button>
              </div>
            </div>`
          : null}
      </div>
    </temba-dialog>`;
  }

  private renderPrimaryUrn(editable: boolean): TemplateResult {
    if (this.anon || (!editable && this.data.urns.length === 0)) return null;
    const additional = Math.max(0, this.data.urns.length - 1);
    const displayedUrn = getDestinationURN(this.data) || this.data.urns[0];
    const noUrns = this.data.urns.length === 0;
    const onlyUnsendable =
      this.data.urns.length === 1 && this.data.urns[0].channel === null;
    return html`<div
        class="urn-display primary-urn ${editable
          ? 'editable'
          : ''} ${onlyUnsendable ? 'only-unsendable' : ''}"
        aria-label=${noUrns
          ? msg('This contact has no URNs')
          : onlyUnsendable
            ? msg('This contact has no sendable URNs')
            : msg('Contact URN')}
      >
        ${this.renderDisplayedUrn(displayedUrn, 'primary-urn')}
        ${editable && additional
          ? html`<span
              class="urn-more-count"
              aria-label=${msg(str`${additional} additional URNs`)}
              >${msg(str`+${additional} more`)}</span
            >`
          : null}
        ${editable
          ? html`<temba-icon
              class="urn-edit-icon"
              name=${Icon.edit}
              title=${msg('Edit URNs')}
              aria-label=${msg('Edit URNs')}
              role="button"
              tabindex="0"
              @click=${this.showUrnDialog}
              @keydown=${this.handleUrnEditKeyDown}
            ></temba-icon>`
          : null}
      </div>
      ${editable ? this.renderUrnDialog() : null}`;
  }

  private renderEmail(editable: boolean): TemplateResult {
    if (this.anon || (!editable && !this.data.email)) return null;
    const verified = !!this.data.email_verified_on;
    return html`<temba-contact-field
      class="email ${verified ? 'verified' : ''}"
      key="email"
      name=${msg('Email')}
      value=${this.data.email || ''}
      valueIcon=${verified ? Icon.contact_verified : ''}
      valueIconLabel=${verified ? msg('Verified') : ''}
      ?disabled=${!editable}
      @change=${this.handleTextChanged}
      @temba-button-clicked=${this.handleSearch}
    ></temba-contact-field>`;
  }

  private renderEditable(): TemplateResult {
    const manualGroups = this.getManualGroups();
    return html`
      ${this.renderPrimaryUrn(true)}
      <temba-contact-field
        key="name"
        name=${msg('Name')}
        value=${this.data.name || ''}
        @change=${this.handleTextChanged}
        @temba-button-clicked=${this.handleSearch}
      ></temba-contact-field>
      ${this.renderEmail(true)}
      ${this.anon && this.data.ref
        ? html`<temba-contact-field
            name=${msg('Ref')}
            value=${this.data.ref}
            disabled
          ></temba-contact-field>`
        : null}
      ${this.data.status === 'active'
        ? html`<div
            class="editable-row ${this.saving.has('groups')
              ? 'saving'
              : ''} ${this.failed.has('groups') ? 'failed' : ''}"
          >
            <label>${msg('Groups')}</label>
            ${this.renderFailure('groups')}
            <temba-select
              endpoint="/api/v2/groups.json?manual_only=1"
              valueKey="uuid"
              .values=${manualGroups}
              @change=${this.handleGroupsChanged}
              searchable
              clearable
              multi
            ></temba-select>
          </div>`
        : null}
      ${this.renderDynamicGroups(true)}
      ${this.renderEditableSelect(
        'status',
        msg('Status'),
        getStatusOptions(),
        this.data.status,
        this.handleStatusChanged
      )}
      ${this.renderEditableSelect(
        'language',
        msg('Language'),
        this.getLanguageOptions(),
        this.data.language || 'none',
        this.handleLanguageChanged
      )}
    `;
  }

  private renderReadonly(): TemplateResult {
    const lang = getLanguageName(this.data.language);
    const manualGroups = this.getManualGroups();
    return html`
      ${this.renderPrimaryUrn(false)} ${this.renderEmail(false)}
      ${manualGroups.length
        ? html`<div class="row">
            <div class="label">${msg('Groups')}</div>
            <div class="value">
              ${manualGroups.map(
                (group) =>
                  html`<temba-label
                    onclick="goto(event)"
                    href="/contact/group/${group.uuid}/"
                    icon=${group.is_dynamic ? Icon.group_smart : Icon.group}
                    type="group"
                    clickable
                  >
                    ${group.name}
                  </temba-label>`
              )}
            </div>
          </div>`
        : null}
      ${this.renderDynamicGroups(false)}
      ${this.data.ref
        ? html`<temba-contact-field
            name=${msg('Ref')}
            value=${this.data.ref}
            disabled
          ></temba-contact-field>`
        : null}
      <temba-contact-field
        name=${msg('Status')}
        value=${getStatusOptions().find(
          (option) => option.value === this.data.status
        )?.name || capitalize(this.data.status)}
        disabled
      ></temba-contact-field>
      ${lang
        ? html`<temba-contact-field
            name=${msg('Language')}
            value=${lang}
            disabled
          ></temba-contact-field>`
        : null}
    `;
  }

  public render(): TemplateResult {
    if (!this.data) return super.render();

    return html`<div class="wrapper">
      ${this.editable ? this.renderEditable() : this.renderReadonly()}
      <temba-contact-field
        name=${msg('Created')}
        value=${this.data.created_on}
        type="datetime"
        disabled
      ></temba-contact-field>
      <temba-contact-field
        class="last-field"
        name=${msg('Last Seen')}
        value=${this.data.last_seen_on}
        type="datetime"
        disabled
      ></temba-contact-field>
    </div>`;
  }
}
