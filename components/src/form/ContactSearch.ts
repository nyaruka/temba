import { TemplateResult, html, css, PropertyValueMap } from 'lit';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { property } from 'lit/decorators.js';
import {
  formatCount,
  getClasses,
  postJSON,
  stopEvent,
  WebResponse
} from '../utils';
import { TextInput } from './TextInput';
import '../display/Alert';
import { Contact, CustomEventType } from '../interfaces';
import { FieldElement } from './FieldElement';
import { Checkbox } from './Checkbox';
import { msg } from '@lit/localize';
import { OmniOption } from './select/Omnibox';
import { Select } from './select/Select';

const QUEIT_MILLIS = 2000;

interface SummaryResponse {
  total: number;
  sample: Contact[];
  query: string;
  fields: { [uuid: string]: { label: string; type: string } };
  error?: string;
  warnings: string[];
  blockers: string[];
}

export class ContactSearch extends FieldElement {
  static get styles() {
    return css`
      :host {
        color: var(--color-text);
      }

      .urn {
        width: 120px;
      }

      .name {
        width: 160px;
      }

      .date {
        text-align: right;
      }

      .field-header {
        font-size: 80%;
        color: var(--color-text-dark);
      }

      .field-header.date {
        text-align: right;
      }

      .more {
        font-size: 90%;
        padding-top: 5px;
        padding-right: 3px;
        text-align: right;
        width: 100px;
        vertical-align: top;
      }

      table {
        width: 100%;
      }

      .contact td {
        border-bottom: 1px solid var(--color-borders);
        padding: 5px 3px;
      }

      .table-footer td {
        padding: 10px 3px;
      }

      .query-replaced,
      .count-replaced {
        display: inline-block;
        background: var(--color-primary-light);
        color: var(--color-text-dark);
        padding: 3px 6px;
        border-radius: var(--curvature);
        font-size: 85%;
        margin: 0px 3px;
      }

      temba-loading {
        transform: scale(0);
        max-width: 0;
        opacity: 0;
        transition: transform 200ms ease-in-out;
      }

      .fetching temba-loading {
        transform: scale(1);
        max-width: 500px;
        opacity: 1;
        display: block;
      }

      .error {
        margin-top: 10px;
      }

      .match-count {
        padding: 4px;
        margin-top: 6px;
      }

      .linked {
        color: var(--color-link-primary);
        text-decoration: none;
        cursor: pointer;
      }

      .header td {
        border-bottom: 0px solid var(--color-borders);
        padding: 5px 3px;
      }

      .expanded .header td {
        border-bottom: 2px solid var(--color-borders);
      }

      td.field-header,
      tr.table-footer,
      tr.contact {
        display: none;
      }

      .expanded td.field-header {
        display: table-cell;
      }

      .expanded tr.contact,
      .expanded tr.table-footer {
        display: table-row;
      }

      .query {
        display: var(--contact-search-query-display);
        margin-bottom: 10px;
      }

      .results {
        display: none;
      }

      .summary {
        min-height: 2.2em;
        display: flex;
        flex-grow: 1;
        align-items: center;
      }

      .summary .result-count {
        flex-grow: 1;
      }

      .results.empty {
        display: none !important;
      }

      .results.initialized {
        display: flex;
        align-items: center;
        margin-top: 0.5em;
        margin-left: 0.6em;
      }

      .advanced-icon {
        cursor: pointer;
        margin-right: 0.5em;
      }

      .query .advanced-icon {
        margin-top: 1em;
        margin-right: 1em;
      }

      .advanced-icon:hover {
        --icon-color: var(--color-link-primary-hover) !important;
      }

      .query {
        --textarea-height: 5em;
      }

      #recipients {
        margin-bottom: 1em;
        display: block;
      }

      temba-alert {
        margin: 1em 0;
      }

      temba-select[name='not_seen_since_days'] {
        margin-bottom: 1em;
        display: block;
      }

      .activity-select {
        display: flex;
        align-items: center;
        padding: var(--checkbox-padding, 10px);
        border-radius: var(--curvature);
        cursor: pointer;
      }

      .activity-select:hover {
        background: #f9f9f9;
      }

      .small-select {
        --temba-select-selected-padding: 0px 0.5em;
        --temba-select-selected-line-height: 1em;
        --temba-select-selected-font-size: 1em;
        --search-input-height: 0px !important;
        --temba-select-min-height: 1.8em;
        min-width: 100px;
      }

      .filters {
        padding: 1em;
        border: 1px solid var(--color-borders);
        border-radius: var(--curvature);
      }

      .interrupt-confirm {
        display: flex;
        align-items: center;
        margin-top: 0.5em;
        margin-left: 0.6em;
        cursor: pointer;
      }

      .tickets-note {
        display: flex;
        align-items: center;
        margin-top: 0.5em;
        color: var(--color-text-help);
        --icon-color: var(--color-text-help);
      }

      .tickets-note temba-icon {
        margin-right: 0.5em;
      }
    `;
  }

  @property({ type: Boolean })
  in_a_flow: boolean;

  // recipients are locked, e.g. starting a specific contact from their read page -
  // no recipient editing, filters or query editing
  @property({ type: Boolean })
  fixed: boolean;

  // name of the flow the fixed contact is currently in, if any
  @property({ type: String, attribute: 'current_flow' })
  currentFlow: string;

  // whether the user has explicitly confirmed interrupting the current flow
  @property({ type: Boolean })
  interruptConfirmed = false;

  // contacts with open tickets won't be started, which is a fixed rule rather than a filter
  @property({ type: Boolean })
  excludes_tickets: boolean;

  @property({ type: Boolean })
  started_previously: boolean;

  @property({ type: Boolean })
  not_seen_since_days: boolean;

  @property({ type: Boolean })
  fetching: boolean;

  @property({ type: Boolean })
  expanded: boolean;

  @property({ type: String })
  endpoint: string;

  @property({ type: String })
  placeholder = '';

  @property({ type: String })
  name = '';

  @property({ type: String })
  query = '';

  @property({ type: Number })
  inactiveThreshold = 1000;

  @property({ type: Number })
  inactiveDays = 90;

  @property({ type: Object, attribute: false })
  summary: SummaryResponse;

  @property({ type: Object, attribute: false })
  flow: any;

  @property({ type: Array })
  recipients: OmniOption[] = [];

  @property({ type: Boolean })
  advanced = false;

  @property({ type: String })
  refreshKey = '0';

  public refresh(): void {
    if (this.advanced || this.recipients.length > 0) {
      this.refreshKey = 'requested_' + new Date().getTime();
    } else {
      this.summary = null;
      this.fetching = false;
      this.requestUpdate();
      this.fireCustomEvent(CustomEventType.ContentChanged, { reset: true });
    }
  }

  @property({ type: Object })
  public exclusions = {};

  private lastQuery: number;
  private initialized = false;

  public firstUpdated(
    changes: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.firstUpdated(changes);

    // set the form value immediately if we have pre-existing data (e.g. editing)
    if (this.query || this.recipients.length > 0) {
      this.setValue({
        advanced: this.advanced,
        query: this.query,
        exclusions: this.exclusions,
        recipients: this.recipients
      });
    }
  }

  protected willUpdate(changedProperties: Map<string, any>) {
    super.willUpdate(changedProperties);

    // reconcile the in_a_flow exclusion; outside of fixed mode it is user-controlled
    // via the filter checkbox, so we only ever clear it when the option goes away
    if (
      changedProperties.has('in_a_flow') ||
      changedProperties.has('interruptConfirmed') ||
      changedProperties.has('fixed') ||
      changedProperties.has('currentFlow')
    ) {
      if (!this.in_a_flow) {
        delete this.exclusions['in_a_flow'];
      } else if (this.fixed && this.currentFlow) {
        // a fixed contact already in a flow stays excluded until interruption is confirmed
        if (this.interruptConfirmed) {
          delete this.exclusions['in_a_flow'];
        } else {
          this.exclusions['in_a_flow'] = true;
        }
      }
    }
  }

  public updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has('recipients')) {
      this.handleRecipientsChanged();
    }

    if (
      (changedProperties.has('query') && this.advanced) ||
      (changedProperties.has('refreshKey') && this.refreshKey !== '0')
    ) {
      this.summary = null;
      // this.errors = [];
      this.fireCustomEvent(CustomEventType.ContentChanged, { reset: true });
      if (this.lastQuery) {
        window.clearTimeout(this.lastQuery);
        this.fetching = false;
      }

      if (this.query.trim().length > 0 || this.recipients.length > 0) {
        this.fetching = true;
        this.lastQuery = window.setTimeout(() => {
          this.fetchSummary();
        }, QUEIT_MILLIS);
      }
    }
  }

  public fetchSummary(): any {
    if (this.endpoint) {
      const group_uuids = this.recipients
        .filter((value: OmniOption) => value.type === 'group')
        .map((value: OmniOption) => value.id);

      const contact_uuids = this.recipients
        .filter((value: OmniOption) => value.type === 'contact')
        .map((value: OmniOption) => value.id);

      postJSON(this.endpoint, {
        include: this.advanced
          ? { query: this.query }
          : { contact_uuids, group_uuids },

        exclude: this.exclusions
      }).then((response: WebResponse) => {
        this.fetching = false;
        this.initialized = true;
        if (this.recipients.length == 0 && !this.advanced) {
          return;
        }
        if (response.status === 200) {
          this.summary = response.json as SummaryResponse;
          if (!this.advanced) {
            this.query = this.summary.query;
          }
          this.setValue({
            advanced: this.advanced,
            query: this.query,
            exclusions: this.exclusions,
            recipients: this.recipients
          });

          if (this.summary.error) {
            this.errors = [this.summary.error];
          } else {
            this.errors = [];
          }
          this.requestUpdate('errors');
          this.fireCustomEvent(CustomEventType.ContentChanged, this.summary);
        } else {
          this.summary = response.json as SummaryResponse;
          if (this.summary.error) {
            this.errors = [this.summary.error];
          }
          this.requestUpdate('errors');
          this.fireCustomEvent(CustomEventType.ContentChanged, this.summary);
        }
      });
    }
  }

  private handleAdvancedToggle(evt: MouseEvent) {
    stopEvent(evt);
    this.recipients = [];
    this.exclusions = {};
    if (this.advanced) {
      this.query = '';
      this.value = null;
    }
    this.advanced = !this.advanced;

    this.setValue({
      advanced: this.advanced,
      query: this.query,
      exclusions: this.exclusions,
      recipients: this.recipients
    });
  }

  private handleQueryChange(evt: KeyboardEvent) {
    const input = evt.target as TextInput;
    this.query = input.inputElement.value;
  }

  private handleRecipientsChanged() {
    if (!this.endpoint) {
      return;
    }

    if (this.recipients && (this.refreshKey !== '0' || this.initialized)) {
      this.refresh();
    } else {
      this.initialized = true;
    }
  }

  private handleActivityLevelChanged(evt: any) {
    const select = evt.target as Select<any>;
    const option = select.values[0];
    if (option) {
      if (this.exclusions['not_seen_since_days']) {
        this.exclusions['not_seen_since_days'] = parseInt(option.value);
        this.refresh();
      }
    }
  }

  private handleActivityLabelClicked(evt: any) {
    if (
      evt.target &&
      evt.target.tagName !== 'TEMBA-CHECKBOX' &&
      evt.target.tagName !== 'TEMBA-SELECT' &&
      !evt.target.disabled
    ) {
      const checkbox = evt.currentTarget.querySelector('temba-checkbox');
      checkbox.checked = !checkbox.checked;
    }
  }

  private async handleInterruptChanged(evt: any) {
    const checkbox = evt.target as Checkbox;
    this.interruptConfirmed = checkbox.checked;

    // wait for willUpdate() to reconcile our exclusions
    await this.updateComplete;

    this.setValue({
      advanced: this.advanced,
      query: this.query,
      exclusions: this.exclusions,
      recipients: this.recipients
    });

    // we already know whether our fixed contacts will be included so no need to re-run
    // the search - just let the modal know, counting contacts only since a group entry
    // doesn't tell us its membership size
    const contactCount = this.recipients.filter(
      (value: OmniOption) => value.type === 'contact'
    ).length;
    this.fireCustomEvent(CustomEventType.ContentChanged, {
      ...(this.summary || {}),
      total: this.interruptConfirmed ? contactCount : 0
    });
  }

  private handleExclusionChanged(evt: any) {
    if (evt.target.tagName === 'TEMBA-CHECKBOX') {
      const ex = JSON.stringify(this.exclusions);
      const checkbox = evt.target as Checkbox;
      let value = checkbox.checked as any;

      // if we check the activity box, look inside the select for the value
      if (checkbox.name === 'not_seen_since_days' && value) {
        const select = checkbox.parentElement.querySelector(
          'temba-select'
        ) as Select<any>;
        if (select.values[0]) {
          value = parseInt(select.values[0].value);
        } else {
          value = this.exclusions[checkbox.name];
        }
      }

      if (!value) {
        delete this.exclusions[checkbox.name];
      } else {
        this.exclusions[checkbox.name] = value;
      }

      if (ex !== JSON.stringify(this.exclusions) && this.endpoint) {
        this.refresh();
      }
    }
  }

  public renderWidget(): TemplateResult {
    let summary: TemplateResult;
    if (this.summary && !this.fixed) {
      if (!this.summary.error) {
        const count = this.summary.total || 0;

        summary = html`
          <div class="result-count">
            Found
            <a
              class="linked"
              target="_"
              href="/contact/?search=${encodeURIComponent(this.summary.query)}"
            >
              ${formatCount(count)}
            </a>
            contact${count !== 1 ? 's' : ''}
          </div>
          <temba-button
            class="edit"
            name="edit"
            secondary
            small
            @click=${this.handleAdvancedToggle}
          >
            <div slot="name">
              <div style="display: flex; align-items: center;">
                ${this.advanced
                  ? html` <temba-icon
                        name="reset"
                        style="margin-right:0.5em"
                      ></temba-icon>
                      Start Over`
                  : html` <temba-icon
                        name="edit"
                        style="margin-right:0.5em"
                      ></temba-icon>
                      Edit Query`}
              </div>
            </div>
          </temba-button>
        `;
      }
    }

    const notSeenSinceDays = this.exclusions['not_seen_since_days'];
    let blockers = null;

    if (
      this.summary &&
      this.summary.blockers &&
      this.summary.blockers.length > 0
    ) {
      blockers = html`${this.summary.blockers.map(
        (error) =>
          html`<temba-alert level="error">${unsafeHTML(error)}</temba-alert>`
      )}`;
    }

    const interruptConfirm =
      this.fixed && this.currentFlow && this.in_a_flow && !this.fetching
        ? html`<div
            class="interrupt-confirm"
            @click=${this.handleActivityLabelClicked}
          >
            <temba-checkbox
              name="interrupt"
              ?checked=${this.interruptConfirmed}
              @change=${this.handleInterruptChanged}
            ></temba-checkbox>
            <div>
              ${this.flow && this.flow.name === this.currentFlow
                ? html`${msg("It's okay to restart")}
                    <b>${this.currentFlow}</b> ${msg('from the beginning')}`
                : html`${msg("It's okay to interrupt")}
                    <b>${this.currentFlow}</b> ${msg('and start this one')}`}
            </div>
          </div>`
        : null;

    return html`
      ${
        this.fixed
          ? null
          : this.advanced
            ? html`<div class="query">
                <temba-textinput
                  .helpText=${this.helpText}
                  .widgetOnly=${this.widgetOnly}
                  .errors=${this.errors}
                  name=${this.name}
                  .inputRoot=${this}
                  @input=${this.handleQueryChange}
                  placeholder=${this.placeholder}
                  .value=${this.query}
                  textarea
                  autogrow
                >
                </temba-textinput>
              </div>`
            : html`<temba-omnibox
                  placeholder="Search for contacts or groups"
                  widget_only=""
                  groups=""
                  contacts=""
                  label="Recipients"
                  help_text="The contacts to send the message to."
                  .errors=${this.errors}
                  id="recipients"
                  name="recipients"
                  .values=${this.recipients}
                  endpoint="/contact/omnibox/?"
                  @change=${this.handleRecipientsChanged}
                >
                </temba-omnibox>

                ${this.not_seen_since_days ||
                this.in_a_flow ||
                this.started_previously
                  ? html`
                      <div class="filters">
                        <div
                          style="display:flex;font-size:1em;margin-bottom:0.5em"
                        >
                          <temba-icon size="1" name="filter"></temba-icon>
                          <div style="margin-left:0.5em">
                            Only include contacts who...
                          </div>
                        </div>
                        ${this.in_a_flow
                          ? html`<temba-checkbox
                              name="in_a_flow"
                              label="${msg('Are not currently in a flow')}"
                              ?checked=${this.exclusions['in_a_flow']}
                              @change=${this.handleExclusionChanged}
                            ></temba-checkbox>`
                          : null}
                        ${this.not_seen_since_days
                          ? html`
                              <div
                                class="activity-select"
                                @click=${this.handleActivityLabelClicked}
                              >
                                <temba-checkbox
                                  style="display:inline;"
                                  name="not_seen_since_days"
                                  ?checked=${notSeenSinceDays}
                                  @change=${this.handleExclusionChanged}
                                >
                                </temba-checkbox>

                                <div>
                                  ${msg('Have sent a message in the last')}
                                </div>

                                <temba-select
                                  style="margin-left:0.5em"
                                  class="small-select"
                                  @change=${this.handleActivityLevelChanged}
                                  ?disabled=${!notSeenSinceDays}
                                >
                                  <temba-option
                                    name="90 days"
                                    value="90"
                                    ?selected=${notSeenSinceDays === 90}
                                  ></temba-option>
                                  <temba-option
                                    name="180 days"
                                    value="180"
                                    ?selected=${notSeenSinceDays === 180}
                                  ></temba-option>
                                  <temba-option
                                    name="Year"
                                    value="365"
                                    ?selected=${notSeenSinceDays === 365}
                                  ></temba-option>
                                </temba-select>
                                <div></div>
                              </div>
                            `
                          : null}
                        ${this.started_previously
                          ? html`<temba-checkbox
                              name="started_previously"
                              label="${msg(
                                'Have not started this flow in the last 90 days'
                              )}"
                              ?checked=${this.exclusions['started_previously']}
                              @change=${this.handleExclusionChanged}
                            ></temba-checkbox>`
                          : null}
                      </div>
                    `
                  : null} `
      }
              </div>
      ${
        this.excludes_tickets && !this.fixed
          ? html`<div class="tickets-note">
              <temba-icon name="tickets"></temba-icon>
              <div>
                ${msg(
                  'Contacts with an open ticket are not included. Close their ticket first if you need to start them in a flow.'
                )}
              </div>
            </div>`
          : null
      }
      ${interruptConfirm}
      ${
        this.fixed
          ? html`<div
              class="results ${getClasses({
                fetching: this.fetching,
                initialized: this.fetching,
                empty: !this.fetching
              })}"
            >
              <temba-loading units="6" size="8"></temba-loading>
            </div>`
          : html`<div
              class="results ${getClasses({
                fetching: this.fetching,
                initialized: this.initialized || this.fetching,
                empty:
                  ((this.summary && this.summary.error) || !this.summary) &&
                  !this.fetching
              })}"
            >
              <temba-loading units="6" size="8"></temba-loading>
              <div class="summary ${this.expanded ? 'expanded' : ''}">
                ${summary}
              </div>
            </div>`
      }
      ${blockers}
      ${
        !blockers && this.summary && this.summary.warnings
          ? this.summary.warnings.map(
              (warning) =>
                html`<temba-alert level="warning"
                  >${unsafeHTML(warning)}</temba-alert
                >`
            )
          : ``
      }


    `;
  }
}
