import { css, html, nothing, TemplateResult } from 'lit';
import { property } from 'lit/decorators.js';
import { CustomEventType } from '../interfaces';
import { RapidElement } from '../RapidElement';
import { InputType, TextInput } from '../form/TextInput';
import { Icon } from '../Icons';
import { getClasses, WebResponse } from '../utils';
import { Select } from '../form/select/Select';
import { FieldElement } from '../form/FieldElement';

enum Status {
  Success = 'success',
  Failure = 'failure',
  Saving = 'saving',
  Ready = 'ready'
}

export class ContactFieldEditor extends RapidElement {
  @property({ type: String })
  key: string;

  @property({ type: String })
  value: string;

  @property({ type: String })
  name: string;

  @property({ type: String })
  type: string;

  @property({ type: String })
  timezone: string;

  @property({ type: String })
  icon = navigator.clipboard ? Icon.copy : '';

  @property({ type: String })
  iconClass = '';

  @property({ type: String })
  valueIcon = '';

  @property({ type: String })
  valueIconLabel = '';

  @property({ type: String })
  status: Status = Status.Ready;

  @property({ type: Boolean })
  disabled = false;

  @property({ type: Boolean })
  searchable = true;

  @property({ type: Boolean })
  dirty = false;

  static get styles() {
    return css`
      :host {
        --transition-speed: 0ms;
        margin-bottom: 1em;
        display: block;
      }

      .wrapper {
        --disabled-opacity: 1;
        position: relative;
        --color-widget-bg: transparent;
        --color-widget-bg-focused: #fff;
        --widget-box-shadow: none;
        padding-bottom: var(--contact-field-padding-bottom, 0.6em);
        border-bottom: var(--contact-field-separator, 1px solid #ececec);
      }

      .wrapper.disabled {
        --color-widget-border: transparent;
      }

      .wrapper.mutable:hover {
      }

      .wrapper.mutable {
        --color-widget-border: rgb(235, 235, 235);
        --color-widget-bg: transparent;
        --input-cursor: pointer;

        border-bottom: none;
        margin-bottom: 0.5em;
        padding-bottom: 0em;
      }

      .mutable.success {
        --color-widget-border: rgba(var(--success-rgb), 0.6);
      }

      .mutable.failure {
        --color-widget-border: rgba(var(--error-rgb), 0.3) !important;
      }

      .mutable .dirty {
        --color-widget-border: rgb(235, 235, 235);
      }

      .wrapper {
        margin-bottom: var(--contact-field-wrapper-margin-bottom, 0.5em);
      }

      .field-label {
        display: block;
        font-size: 12px;
        font-weight: var(--w-medium);
        color: var(--text-2);
        margin: 0 0 4px 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* read-only rows set the label clearly apart from the value — the
         same quiet label treatment as .field-label on the editable rows,
         a touch smaller, over a full-color value */
      .label .name {
        color: var(--text-2);
        font-size: 11px;
        font-weight: var(--w-medium);
      }

      .disabled .name {
        margin-top: 0.25em;
        margin-left: 0.25em;
      }

      .disabled .value {
        color: var(--contact-field-value-color, var(--text-1));
        margin-left: 0.25em;
        margin-top: 0.35em;
        min-height: 1.75em;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .value-prefix {
        display: flex;
        align-items: center;
      }

      temba-textinput .value-prefix {
        margin: 0 0 0 10px;
      }

      .postfix {
        display: flex;
        align-items: stretch;
        margin-left: 1em;
      }

      .popper {
        background: rgba(0, 0, 0, 0.03);
        border-top-right-radius: var(--curvature-widget);
        border-bottom-right-radius: var(--curvature-widget);
        --icon-color: #888;
        display: flex;
        cursor: default;
        transition: all var(--transition-speed) ease-in-out;
        align-items: stretch;
        margin: -1px;
      }

      temba-icon[name='calendar'] {
        --icon-color: rgba(0, 0, 0, 0.2);
      }

      temba-icon:hover {
        --icon-color: rgba(0, 0, 0, 0.5);
      }

      temba-icon {
        cursor: pointer;
        --icon-color: rgba(0, 0, 0, 0.3);
      }

      /* set on the icon itself, since the generic icon rules above would beat an inherited color */
      .value-prefix temba-icon,
      .value-prefix temba-icon:hover {
        cursor: default;
        --icon-color: var(--contact-field-value-icon-color, var(--text-3));
      }

      temba-textinput:focus .popper,
      temba-textinput:hover .popper {
        display: flex;
      }

      .disabled temba-textinput .postfix {
        display: none;
        padding: none;
      }

      .unset temba-textinput .popper .copy,
      .unset temba-textinput .popper .search {
        display: none;
      }

      .unset temba-textinput:focus .popper .copy,
      .unset temba-textinput:hover .popper .copy,
      .unset temba-textinput:focus .popper .save,
      .unset temba-textinput:hover .popper .save {
        display: none;
      }

      /* Keep popper icons within the widget's 34px content area so
         the field height doesn't change when the search/copy buttons
         appear (i.e. when a value is set). Horizontal padding only —
         vertical sizing comes from align-items: stretch on the
         flex .input-container. Inner elements (icons, save button)
         own their own horizontal spacing via margin, so the popper
         itself doesn't add asymmetric padding (which would offset
         its contents and prevent centering). */
      .popper temba-icon {
        padding: 0 0.6em 0 0;
      }

      /* First icon gets extra left padding so it doesn't hug the
         popper's left edge — visually balances the inter-icon gap. */
      .popper temba-icon:first-of-type {
        padding-left: 0.6em;
      }

      .copy.clicked temba-icon {
        transform: scale(1.2);
      }

      temba-icon {
        transition: all 200ms ease-in-out;
      }

      temba-datepicker {
        position: relative;
      }

      .save-state {
        display: flex;
        align-items: center;
      }

      /* .save-button is the class on the <temba-button> element
         itself. Use tag+class selector and !important to outrank
         :host { align-self: stretch } from inside Button.ts. min/max
         height pin the button size so it can't grow with the parent
         line height (relevant in DatePicker, where the container
         wraps and the line is ~50px tall). */
      temba-button.save-button {
        align-self: center !important;
        height: 22px !important;
        min-height: 22px !important;
        max-height: 22px !important;
        margin: 5px 6px;
        font-size: 12px;
      }

      .dirty .copy,
      .dirty .search {
        display: none;
      }

      .saving .copy,
      .saving .search {
        display: none;
      }

      .success .copy,
      .success .search {
        display: none;
      }

      .failure .copy,
      .failure .search {
        display: none;
      }

      .popper.success {
        background: rgb(var(--success-rgb));
      }

      .popper.failure {
        background: rgb(var(--error-rgb));
      }

      .popper.success temba-icon,
      .popper.failure temba-icon {
        --icon-color: #fff !important;
      }

      .popper.dirty {
        background: rgba(0, 0, 0, 0.03);
      }

      temba-datepicker .popper {
        border-radius: 0px;
      }

      temba-datepicker .popper:first-child {
        padding: 0;
      }

      temba-datepicker .postfix {
        margin-left: 0;
      }

      temba-datepicker {
        --temba-textinput-padding: 0.8em 0.8em 0.4em 0.8em;
      }

      .saving temba-datepicker,
      .saving temba-textinput {
        pointer-events: none !important;
        cursor: default !important;
        opacity: 0.7;
      }

      temba-select {
        --color-widget-bg: white;
        /* Let the slotted prefix label escape the widget's top edge
           — same notched-border look as the textinput / datepicker. */
        --temba-select-container-overflow: visible;
      }

      temba-option {
      }
    `;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.handleInput = this.handleInput.bind(this);
    this.handleSubmit = this.handleSubmit.bind(this);
  }

  public handleIconClick(evt: MouseEvent) {
    const ele = evt.target as HTMLDivElement;
    const icon = ele.getAttribute('icon-action');
    const input = this.shadowRoot.querySelector('temba-textinput') as TextInput;

    if (icon === 'copy') {
      if (navigator.clipboard) {
        this.iconClass = 'clicked';
        navigator.clipboard.writeText(input.getDisplayValue()).then(() => {
          window.setTimeout(() => {
            this.iconClass = '';
          }, 300);
        });
      }
    }

    if (icon === 'search') {
      this.fireCustomEvent(CustomEventType.ButtonClicked, {
        key: this.key,
        value: this.value
      });
    }

    evt.preventDefault();
    evt.stopPropagation();
  }

  public handleResponse(response: WebResponse, savedValue?: string) {
    if (response.status === 200) {
      this.value =
        savedValue !== undefined
          ? savedValue
          : response.json.fields?.[this.key] || '';
      // this.status = Status.Success;
      // on success lets go back to ready state for now
      this.status = Status.Ready;
      this.dirty = false;
    } else {
      this.status = Status.Failure;
      this.dirty = false;
    }
  }

  public handleSelectChange(evt: CustomEvent) {
    const select = evt.currentTarget as Select<any>;
    let value = '';

    evt.preventDefault();
    evt.stopPropagation();

    if (select.values.length > 0) {
      value = select.values[0].path;
    }

    if (value !== this.value) {
      this.dirty = true;
      this.status = Status.Saving;
      this.value = value;
      this.fireEvent('change');
    }
  }

  public handleSubmit() {
    const input = this.shadowRoot.querySelector(
      'temba-textinput, temba-datepicker'
    ) as FieldElement;

    if (input.value !== this.value) {
      this.dirty = true;
      this.status = Status.Saving;
      this.value = input.value;
      this.fireEvent('change');
    }
  }

  public handleChange(evt: Event) {
    evt.preventDefault();
    evt.stopPropagation();
  }

  public handleDateChange(evt: Event) {
    evt.preventDefault();
    evt.stopPropagation();
    this.dirty = true;
  }

  public handleInput(evt: KeyboardEvent) {
    const input = evt.currentTarget as TextInput;
    if (evt.key === 'Enter') {
      input.blur();
      this.handleSubmit();
    } else {
      if (input.value !== this.value) {
        this.dirty = true;
      }
    }
  }

  private getInputType(type: string): string {
    if (type === 'numeric') {
      return InputType.Number;
    }
    return InputType.Text;
  }

  private renderDateField(state: TemplateResult) {
    return html`
      <label id="field-label" class="field-label">${this.name}</label>
      <temba-datepicker
        aria-labelledby="field-label"
        timezone=${this.timezone}
        value="${this.value ? this.value : ''}"
        @change=${this.handleDateChange}
        ?disabled=${this.disabled}
        time
      >
        <div class="postfix" slot="postfix">
          <div class="popper ${this.status}  ${this.dirty ? 'dirty' : ''}">
            ${state}
          </div>
        </div>
      </temba-datepicker>
    `;
  }

  private renderValueIcon(slot?: string): TemplateResult {
    if (!this.valueIcon) return null;
    return html`<temba-tip
      class="value-prefix"
      text=${this.valueIconLabel}
      position="top"
      slot=${slot || nothing}
    >
      <temba-icon
        name=${this.valueIcon}
        aria-label=${this.valueIconLabel}
      ></temba-icon>
    </temba-tip>`;
  }

  private renderTextField(state: TemplateResult) {
    return html`
      <label id="field-label" class="field-label">${this.name}</label>
      <temba-textinput
        aria-labelledby="field-label"
        class="${this.status} ${this.dirty ? 'dirty' : ''}"
        value="${this.value ? this.value : ''}"
        @keyup=${this.handleInput}
        @change=${this.handleChange}
        type=${this.getInputType(this.type)}
        ?disabled=${this.disabled}
      >
        ${this.renderValueIcon('prefix')}
        <div class="postfix">
          <div
            class="popper ${this.iconClass} ${this.status}  ${this.dirty
              ? 'dirty'
              : ''}"
            @click=${this.handleIconClick}
          >
            ${state}
            ${this.searchable
              ? html`<temba-icon
                  class="search"
                  icon-action="search"
                  name="${Icon.search}"
                  animateclick="pulse"
                ></temba-icon>`
              : null}
            <temba-icon
              class="copy"
              icon-action="copy"
              name="${this.icon}"
              animatechange="spin"
              animateclick="pulse"
            ></temba-icon>
          </div>
        </div>
      </temba-textinput>
    `;
  }

  private getOptions(response: WebResponse) {
    return response.json[0].children;
  }

  private renderSelectedLocation(option: any) {
    if (!option) {
      return null;
    }

    return html`
      <div
        class="selected-location"
        style="display:flex;margin-top:1em;margin-left:0.1em"
      >
        <span>${option['path']}</span>
      </div>
    `;
  }

  public renderLocationField(level: string = 'state') {
    return html`
      <label id="field-label" class="field-label">${this.name}</label>
      <temba-select
        aria-labelledby="field-label"
        endpoint="/api/internal/locations.json?level=${level}"
        nameKey="path"
        valueKey="path"
        @change=${this.handleSelectChange}
        .resnderSelectedItem=${this.renderSelectedLocation}
        placeholder="Select a ${level}"
        queryParam="query"
        searchable
        clearable
        values=${this.value
          ? JSON.stringify([{ path: this.value, osm_id: this.value }])
          : '[]'}
      >
      </temba-select>
    `;
  }

  public render(): TemplateResult {
    if (this.disabled) {
      return html`<div
        class=${this.status +
        ' ' +
        getClasses({
          wrapper: true,
          set: !!this.value,
          unset: !this.value,
          disabled: this.disabled,
          mutable: !this.disabled,
          dirty: this.dirty
        })}
      >
        <div class="label"><div class="name">${this.name}</div></div>
        <div class="value">
          ${this.renderValueIcon()}
          ${this.type === 'datetime'
            ? this.value
              ? html`<temba-date
                  value=${this.value}
                  display="datetime"
                ></temba-date>`
              : null
            : this.value}
        </div>
      </div>`;
    }

    const state = html`<div class="save-state">
      ${this.dirty
        ? html`<temba-button
            class="save-button"
            name="Save"
            small
            @click=${this.handleSubmit}
          ></temba-button>`
        : html` ${this.status === Status.Saving
            ? html`<temba-icon
                spin
                name="${Icon.progress_spinner}"
              ></temba-icon>`
            : null}
          ${this.status === Status.Success && !this.dirty
            ? html`<temba-icon name="${Icon.success}"></temba-icon>`
            : null}
          ${this.status === Status.Failure
            ? html`<temba-tip text="Failed to save changes, try again later."
                ><temba-icon name="${Icon.alert_warning}"></temba-icon
              ></temba-tip>`
            : null}`}
    </div>`;

    return html`
      <div
        class=${this.status +
        ' ' +
        getClasses({
          wrapper: true,
          set: !!this.value,
          unset: !this.value,
          disabled: this.disabled,
          mutable: !this.disabled,
          dirty: this.dirty
        })}
      >
        ${this.type === 'datetime'
          ? this.renderDateField(state)
          : this.type === 'state' ||
              this.type === 'district' ||
              this.type === 'ward'
            ? this.renderLocationField(this.type)
            : this.renderTextField(state)}
      </div>
    `;
  }
}
