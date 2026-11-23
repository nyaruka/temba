import { css, html, PropertyValues, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { property } from 'lit/decorators.js';
import { Checkbox } from '../form/Checkbox';
import { Select } from '../form/select/Select';
import { capitalize } from '../utils';
import { TembaList } from './TembaList';

const FLOW_COLOR = 'rgb(223, 65, 159)';

export class RunList extends TembaList {
  @property({ type: String })
  flow: string;

  @property({ type: Object, attribute: false })
  results: any[];

  @property({ type: Boolean })
  responses = true;

  @property({ type: Object })
  resultPreview: any;

  @property({ type: Object })
  selectedRun: any;

  private resultKeys = {};

  static get styles() {
    return css`
      :host {
        overflow-y: auto !important;
        --contact-name-font-size: 1em;
      }

      @media only screen and (max-height: 768px) {
        temba-options {
          max-height: 20vh;
        }
      }

      temba-options {
        display: block;
        width: 100%;
        flex-grow: 1;
      }
    `;
  }

  public firstUpdated(changedProperties: Map<string, any>) {
    super.firstUpdated(changedProperties);
  }

  public willUpdate(changedProperties: PropertyValues): void {
    if (changedProperties.has('responses') || changedProperties.has('flow')) {
      if (this.flow) {
        this.endpoint = `/api/v2/runs.json?flow=${this.flow}${
          this.responses ? '&responded=1' : ''
        }`;
      }
    }

    if (changedProperties.has('resultPreview')) {
      this.createRenderOption();
    }

    // pre-sync selectedRun so handleSelected() in updated() won't trigger a warning
    if (changedProperties.has('cursorIndex')) {
      if (this.cursorIndex > -1) {
        this.selectedRun = this.items[this.cursorIndex];
      }
    }

    super.willUpdate(changedProperties);
  }

  public updated(changedProperties: Map<string, any>): void {
    super.updated(changedProperties);

    if (changedProperties.has('results')) {
      if (this.results) {
        const select = this.shadowRoot.querySelector(
          'temba-select'
        ) as Select<any>;
        select.setOptions(this.results);
        this.resultKeys = this.results.reduce(
          (current, result) => ({ ...current, [result.key]: result }),
          {}
        );
      }
    }
  }

  public renderResultPreview(run: any) {
    if (this.resultPreview) {
      const runResult = run.values[this.resultPreview.key];
      if (runResult) {
        if (this.resultPreview.categories.length > 1) {
          if (runResult.category) {
            return runResult.category;
          }
        } else {
          return runResult.value;
        }
      }
    }
    return null;
  }

  public getIcon(run: any): TemplateResult {
    let icon = null;
    if (run.exit_type == 'completed') {
      icon = html`<temba-icon
        name="check"
        style="--icon-color:#666;margin-left:0.5em"
      />`;
    } else if (run.exit_type == 'interrupted') {
      icon = html`<temba-icon
        name="x-octagon"
        style="--icon-color:${FLOW_COLOR};margin-left:0.5em"
      />`;
    } else if (run.exit_type == 'expired') {
      icon = html`<temba-icon
        name="clock"
        style="--icon-color:${FLOW_COLOR};margin-left:0.5em"
      />`;
    } else if (!run.exit_type) {
      if (run.responded) {
        icon = html`<temba-icon
          name="activity"
          style="--icon-color:var(--color-primary-dark);margin-left:0.5em"
        />`;
      } else {
        icon = html`<temba-icon
          name="hourglass"
          style="--icon-color:var(--color-primary-dark);margin-left:0.5em"
        />`;
      }
    }
    return icon;
  }

  public createRenderOption() {
    this.renderOption = (run: any): TemplateResult => {
      let statusStyle = '';

      if (!run.exited_on) {
        statusStyle = 'font-weight:400;';
      }

      if (!run.responded) {
        statusStyle += '';
      }

      return html`
        <div class="row" style="${statusStyle}display:flex;align-items:center">
          <div
            style="width:16em;white-space:nowrap;overflow: hidden; text-overflow: ellipsis;"
          >
            <temba-contact-name
              name=${run.contact?.name || run.contact?.ref || ''}
              urn=${run.contact?.urn || ''}
              icon-size="15"
            />
          </div>

          <div
            style="margin: 0em 1em;flex:1;white-space:nowrap; overflow:hidden; text-overflow: ellipsis;"
          >
            ${this.renderResultPreview(run)}
          </div>

          <div style="flex-shrink:1">
            <temba-date value="${run.modified_on}" display="duration" />
          </div>
          ${this.getIcon(run)}
        </div>
      `;
    };
  }

  public getRefreshEndpoint() {
    if (this.items.length > 0) {
      const modifiedOn = this.items[0].modified_on;
      const separator = this.endpoint.includes('?') ? '&' : '?';
      return this.endpoint + separator + 'after=' + modifiedOn;
    }
    return this.endpoint;
  }

  public toggleResponded() {
    this.responses = (
      this.shadowRoot.querySelector('#responded') as Checkbox
    ).checked;
  }

  public handleColumnChanged(event: any) {
    if (event.target.values.length > 0) {
      this.resultPreview = event.target.values[0];
    } else {
      this.resultPreview = null;
    }
  }

  public handleSelected(selected: any) {
    this.selectedRun = selected;
  }

  public getListStyle(): string {
    return '';
  }

  public renderHeader(): TemplateResult {
    return html`
      <div style="display:flex;width:100%;margin-bottom: 1em;">
        <div style="flex-grow:1">
          ${this.results
            ? html`
                <temba-select
                  clearable
                  placeholder="Result Preview"
                  valueKey="key"
                  @change=${this.handleColumnChanged}
                  style="z-index: 10;"
                ></temba-select>
              `
            : null}
        </div>
        <div style="margin-left:1em;">
          <temba-checkbox
            id="responded"
            label="Responses Only"
            checked="true"
            @click=${this.toggleResponded}
          />
        </div>
      </div>
      <div
        style="
        font-size:0.8em;
        color:rgba(0,0,0,.4);
        text-align:right;
        background:#f9f9f9;
        border: 1px solid var(--color-widget-border);
        margin-bottom:-0.5em; 
        padding-bottom: 0.6em;
        padding-top: 0.3em;
        padding-right: 4.5em;
        border-top-right-radius: var(--curvature);
        border-top-left-radius: var(--curvature)
    "
      >
        Last Updated
      </div>
    `;
  }

  public renderFooter(): TemplateResult {
    if (!this.selectedRun || !this.resultKeys) {
      return null;
    }

    const resultKeys = Object.keys(this.selectedRun.values || {});

    return html` <div
      style="margin-top: 1.5em; margin-bottom:0.5em;flex-grow:1;border-radius:var(--curvature); border: 1px solid var(--color-widget-border);"
    >
      <div style="display:flex;flex-direction:column;">
        <div
          style="font-size:1.5em;background:#f9f9f9;padding:.75em;padding-top:.35em;display:flex;align-items:center;border-top-right-radius:var(--curvature);border-top-left-radius:var(--curvature)"
        >
          <div>
            <temba-contact-name
              style="cursor:pointer"
              name=${this.selectedRun.contact?.name ||
              this.selectedRun.contact?.ref ||
              ''}
              urn=${this.selectedRun.contact?.urn || ''}
              onclick="goto(event, this)"
              href="/contact/read/${this.selectedRun.contact?.uuid || ''}/"
            ></temba-contact-name>
            <div
              style="display:flex;margin-left:-0.2em;margin-top:0.25em;font-size: 0.65em"
            >
              ${this.selectedRun.exit_type
                ? html`
                    <div style="margin-left:2em;flex-grow:1;display:flex">
                      ${this.getIcon(this.selectedRun)}
                      <div style="margin-left:0.5em">
                        ${capitalize(this.selectedRun.exit_type)}&nbsp;
                      </div>
                      <temba-date
                        value="${this.selectedRun.exited_on}"
                        compare="${this.selectedRun.created_on}"
                        display="duration"
                      />
                    </div>
                  `
                : html`${this.getIcon(this.selectedRun)}
                    <div style="margin-left:1.5em;flex-grow:1;display:flex">
                      <div>Started&nbsp;</div>
                      <temba-date
                        value="${this.selectedRun.created_on}"
                        display="duration"
                      ></temba-date>
                    </div>`}
            </div>
          </div>
          <div style="flex-grow:1"></div>
          <div style="display:flex;flex-direction: column">
            <div style="font-size:0.75em">
              ${this.selectedRun.created_on
                ? new Date(this.selectedRun.created_on).toLocaleString()
                : ''}
            </div>
            <div
              style="font-size:0.6em;align-self:flex-end;color:#888;line-height:0.75em"
            >
              Started
            </div>
          </div>
        </div>

        ${resultKeys.length > 0
          ? html`
              <div style="padding:1em;">
                <div
                  style="display:flex;font-size:1.2em;position:relative;right:0px"
                >
                  <div style="flex-grow:1"></div>
                </div>

                <table width="100%">
                  <tr>
                    <th style="text-align:left" width="25%">
                      ${msg('Result')}
                    </th>
                    <th style="text-align:left" width="25%">
                      ${msg('Category')}
                    </th>
                    <th style="text-align:left">${msg('Value')}</th>
                  </tr>

                  ${Object.keys(this.selectedRun.values).map((key: string) => {
                    const result = this.selectedRun.values[key];
                    const meta = this.resultKeys[key];

                    // if our result is no longer represented in the flow, skip it
                    if (meta) {
                      return html`<tr>
                        <td>${result.name}</td>
                        <td>
                          ${meta.categories.length > 1 ? result.category : '--'}
                        </td>
                        <td>${result.value}</td>
                      </tr>`;
                    }
                    return null;
                  })}
                </table>
              </div>
            `
          : null}
      </div>
    </div>`;
  }

  constructor() {
    super();
    this.reverseRefresh = false;
    this.valueKey = 'uuid';
    this.hideShadow = true;
    this.createRenderOption();
  }
}
