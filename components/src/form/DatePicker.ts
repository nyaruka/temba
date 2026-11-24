import { TemplateResult, html, css, PropertyValues } from 'lit';
import { property } from 'lit/decorators.js';
import { FieldElement } from './FieldElement';
import { getClasses } from '../utils';
import { DateTime } from 'luxon';

export class DatePicker extends FieldElement {
  static get styles() {
    return css`
      ${super.styles}
      :host {
        display: block;
      }

      input {
        width: inherit;
      }

      .container {
        border-radius: var(--curvature);
        border: 1px solid var(--color-widget-border);
        background: var(--color-widget-bg);
        display: flex;
        cursor: pointer;
        box-shadow: var(--widget-box-shadow);
        flex-wrap: wrap;
        overflow: hidden;
      }

      .input-wrapper {
        padding: var(--temba-textinput-padding);
        flex-grow: 999;
      }

      .tz {
        margin-left: 0.5em;
        font-size: 0.8em;
        flex-direction: column;
        align-self: stretch;
        color: #888;
        display: flex;
        align-items: flex-start;
        flex-direction: column;
        padding: 0em 1em;
        font-weight: 400;
        cursor: pointer;
        margin: auto 0;
      }

      .tz .label {
        font-size: 0.8em;
        color: #aaa;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .tz .zone {
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .tz-wrapper {
        background: var(--sunken);
        display: flex;
        flex-direction: row;
        align-items: center;
        padding: 0.4em 0em;
        flex-grow: 1;
      }

      .container:focus-within {
        border-color: var(--color-focus);
        background: var(--color-widget-bg-focused);
        box-shadow: var(--widget-box-shadow-focused);
      }

      input {
        color: var(--color-widget-text);
        border: 0px;
        font-family: var(--font-family);
        outline: none;
        width: 100%;
        font-size: 13px;
        padding: 0px;
        margin: 0px;
        line-height: 1em;
      }

      input.unset {
        color: #ddd;
      }

      input.unset:focus {
        color: var(--color-widget-text);
      }

      input:focus {
        outline: none;
      }

      .disabled ::-webkit-calendar-picker-indicator {
        display: none;
      }

      .disabled .tz-wrapper {
        border-radius: var(--curvature);
      }

      ::-webkit-calendar-picker-indicator {
        background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="15" viewBox="0 0 24 24"><path fill="%23bbbbbb" d="M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z"/></svg>');
        cursor: pointer;
        margin: 0;
        padding: 0;
      }

      ::-webkit-calendar-picker-indicator:hover {
        background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="15" viewBox="0 0 24 24"><path fill="%23777777" d="M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z"/></svg>');
        cursor: pointer;
        margin: 0;
        padding: 0;
      }
    `;
  }

  @property({ type: String })
  timezone = '';

  @property({ type: String })
  timezoneFriendly = '';

  @property({ type: Object })
  datetime = null;

  @property({ type: Boolean })
  time = false;

  @property({ type: String })
  min = '';

  @property({ type: String })
  max = '';

  /** we just return the value since it should be a string */
  public serializeValue(value: any): string {
    return value;
  }

  public constructor() {
    super();
  }

  public willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('value') && !this.hasUpdated) {
      // default to the local browser zone
      if (this.time) {
        this.timezone =
          this.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
        this.timezoneFriendly = this.timezone
          .replace('_', ' ')
          .replace('/', ', ');

        if (this.value) {
          // we fire a change event on blur
          let datetime = DateTime.fromSQL(this.value).setZone(this.timezone);
          // if we can't read it as a sql stamp, try iso
          if (datetime.invalid) {
            datetime = DateTime.fromISO(this.value).setZone(this.timezone);
          }
          this.datetime = datetime;
          this.value = this.datetime.toUTC().toISO();
        }
      } else {
        this.datetime = DateTime.fromSQL(this.value);
        this.value = this.datetime.toISODate();
      }
    }

    if (changed.has('timezone') && this.hasUpdated && this.time) {
      this.timezone =
        this.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      this.timezoneFriendly = this.timezone
        .replace('_', ' ')
        .replace('/', ', ');

      // force re-render since the displayed value depends on timezone
      if (this.datetime) {
        this.datetime = this.datetime.setZone(this.timezone);
        this.value = this.datetime.toUTC().toISO();
      }
    }
  }

  public handleChange(event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.time) {
      this.datetime = DateTime.fromISO(event.target.value, {
        zone: this.timezone
      });
      this.value = this.datetime.toUTC().toISO();
    } else {
      this.value = event.target.value;
    }
    this.fireEvent('change');
  }

  public handleClicked() {
    this.shadowRoot.querySelector('input').focus();
  }

  protected renderWidget(): TemplateResult {
    const classes = getClasses({ unset: !this.value });

    let dateWidgetValue = null;
    if (this.time && this.datetime && !this.datetime.invalid) {
      dateWidgetValue = this.datetime.toFormat("yyyy-LL-dd'T'HH:mm");
    } else if (!this.time) {
      dateWidgetValue = this.value;
    }

    return html`
      <div class="container" @click=${this.handleClicked}>
        <slot name="prefix"></slot>
        <div class="input-wrapper">
          <input
            class=${classes}
            name=${this.label}
            value=${dateWidgetValue}
            type="${this.time ? 'datetime-local' : 'date'}"
            @change=${this.handleChange}
            min=${this.min || undefined}
            max=${this.max || undefined}
          />
        </div>
        ${this.time
          ? html`
              <div class="tz-wrapper">
                <div class="tz">
                  <div class="label">Time Zone</div>
                  <div class="zone">${this.timezoneFriendly}</div>
                </div>
              </div>
            `
          : null}
        <slot name="postfix"></slot>
      </div>
    `;
  }
}
