import { TemplateResult, html, css, unsafeCSS } from 'lit';
import { property } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { renderMarkdownInline } from '../markdown';
import { designTokens } from '../styles/designTokens';

// Shared with labels drawn outside a FieldElement's shadow root as an inline style
export const fieldLabelStyle =
  'margin-bottom: 6px; display: block; font-weight: var(--w-medium); font-size: 12.5px; line-height: normal; color: var(--color-label);';

/**
 * FieldElement is a base class for form components that provides built-in
 * field wrapper functionality, eliminating the need for manual temba-field embedding.
 *
 * Components extending this class only need to implement renderWidget() with their
 * specific widget content, and the field wrapper (label, errors, help text) is
 * automatically handled.
 */
export abstract class FieldElement extends RapidElement {
  @property({ type: String })
  name = '';

  @property({ type: String, attribute: 'help_text' })
  helpText: string;

  @property({ type: Boolean, attribute: 'widget_only' })
  widgetOnly: boolean;

  @property({ type: Array })
  errors: string[];

  // Use @property with custom getter/setter to handle both attribute and programmatic access
  private _value: any = '';

  @property({ type: String })
  public get value() {
    return this._value;
  }

  public set value(value) {
    this._value = value;
  }

  @property({ attribute: false })
  inputRoot: HTMLElement = this;

  @property({ type: Boolean })
  disabled = false;

  static formAssociated = true;

  protected internals: ElementInternals;

  @property({ type: Boolean })
  hideErrors = false;

  @property({ type: Boolean, attribute: 'hide_label' })
  hideLabel: boolean;

  @property({ type: String })
  label: string;

  constructor() {
    super();
    this.internals = this.attachInternals();
  }

  static get styles() {
    return css`
      ${designTokens}

      :host {
        font-family: var(--font-family);
      }

      label {
        ${unsafeCSS(fieldLabelStyle)}
      }

      .help-text {
        font-size: 12px;
        line-height: normal;
        color: var(--color-text-help);
        margin-top: 6px;
        opacity: 1;
      }

      .alert-error {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        z-index: 1000;
        background: white;
        border: 1px solid var(--color-error);
        color: var(--color-error);
        padding: 8px 12px;
        margin: 2px 0 0 0;
        border-radius: var(--curvature);
        box-shadow:
          0 4px 6px -1px rgba(0, 0, 0, 0.1),
          0 2px 4px -1px rgba(0, 0, 0, 0.06);
        font-size: 0.85em;
        line-height: 1.2;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-12px);
        transition:
          opacity 0.2s ease-in-out,
          visibility 0.2s ease-in-out,
          transform 0.2s ease-in-out;
      }

      .field:hover .alert-error {
        opacity: 1;
        visibility: visible;
        transform: translateY(2px);
      }

      /* Hide error popup when widget is focused */
      .field:focus-within .alert-error {
        opacity: 0;
        visibility: hidden;
        transform: translateY(-4px);
      }

      .field.has-error {
        position: relative;
        /* Set CSS custom properties that form components can use */
        --color-widget-border: var(--color-error);
        --widget-box-shadow-focused: var(
          --widget-box-shadow-focused-error,
          0 0 0 3px rgba(255, 99, 71, 0.3)
        );
        --color-focus: var(--color-error);
      }

      .field.has-error .widget {
        border-radius: var(--curvature-widget);
        position: relative;
      }

      /* Force error styling with higher specificity */
      :host(.has-error) .field.has-error .widget .input-container,
      :host(.has-error) .field.has-error .widget .select-container,
      :host(.has-error) .field.has-error .widget .comp-container,
      :host(.has-error) .field.has-error .widget .checkbox-container,
      :host(.has-error) .field.has-error .widget .container,
      :host(.has-error) .field.has-error .widget .range-container,
      .field.has-error .widget .input-container,
      .field.has-error .widget .select-container,
      .field.has-error .widget .comp-container,
      .field.has-error .widget .checkbox-container,
      .field.has-error .widget .container,
      .field.has-error .widget .range-container {
        border-color: var(--color-error) !important;
      }

      /* When error field is focused, use error-colored focus ring */
      :host(.has-error) .field.has-error .widget .input-container:focus-within,
      :host(.has-error) .field.has-error .widget .select-container:focus-within,
      :host(.has-error) .field.has-error .widget .select-container.focused,
      :host(.has-error) .field.has-error .widget .comp-container:focus-within,
      :host(.has-error)
        .field.has-error
        .widget
        .checkbox-container:focus-within,
      :host(.has-error) .field.has-error .widget .container:focus-within,
      :host(.has-error) .field.has-error .widget .range-container:focus-within,
      .field.has-error .widget .input-container:focus-within,
      .field.has-error .widget .select-container:focus-within,
      .field.has-error .widget .select-container.focused,
      .field.has-error .widget .comp-container:focus-within,
      .field.has-error .widget .checkbox-container:focus-within,
      .field.has-error .widget .container:focus-within,
      .field.has-error .widget .range-container:focus-within {
        border-color: var(--color-error) !important;
        box-shadow: var(
          --widget-box-shadow-focused-error,
          0 0 0 3px rgba(255, 99, 71, 0.3)
        ) !important;
      }

      .alert-error p {
        margin: 0;
        padding: 0;
      }

      .disabled {
        opacity: var(--disabled-opacity) !important;
        pointer-events: none !important;
      }
    `;
  }

  updated(changedProperties: Map<string, any>): void {
    super.updated(changedProperties);

    if (changedProperties.has('value')) {
      this.internals.setFormValue(this.value);
    }

    if (
      changedProperties.has('errors') ||
      changedProperties.has('hideErrors')
    ) {
      const hasErrors =
        !this.hideErrors && this.errors && this.errors.length > 0;
      this.classList.toggle('has-error', hasErrors);
    }
  }

  get form() {
    return this.internals.form;
  }

  public setValue(value: any) {
    this.value = this.serializeValue(value);
  }

  public getDeserializedValue(): any {
    if (!this.value || this.value === '') {
      return null;
    }
    return JSON.parse(this.value);
  }

  public serializeValue(value: any): string {
    return JSON.stringify(value);
  }

  /**
   * Abstract method that components must implement to render their specific widget content.
   * This replaces the need to manually embed temba-field.
   */
  protected abstract renderWidget(): TemplateResult;

  /**
   * Renders the complete field including label, widget, errors, and help text.
   * Components can override this for custom layouts, but typically should just implement renderWidget().
   */
  protected renderField(): TemplateResult {
    const hasErrors = !this.hideErrors && this.errors && this.errors.length > 0;
    const errors = hasErrors
      ? this.errors.map((error: string) => {
          return html`
            <div class="alert-error">${renderMarkdownInline(error)}</div>
          `;
        })
      : [];

    if (this.widgetOnly) {
      return html`
        <div class="${this.disabled ? 'disabled' : ''}">
          ${this.renderWidget()}
        </div>
        ${errors}
      `;
    }

    return html`
      <div
        class="field ${this.disabled ? 'disabled' : ''} ${hasErrors
          ? 'has-error'
          : ''}"
      >
        ${!!this.name && !this.hideLabel && !!this.label
          ? html`
              <label class="control-label" for="${this.name}"
                >${this.label}</label
              >
            `
          : null}
        <div class="widget">${this.renderWidget()} ${errors}</div>
        ${this.helpText && this.helpText !== 'None'
          ? html`
              <div class="help-text">
                ${renderMarkdownInline(this.helpText)}
              </div>
            `
          : null}
      </div>
    `;
  }

  /**
   * Main render method that automatically provides field wrapper functionality.
   * Components extending FieldElement should not override this unless they need custom field layouts.
   */
  public render(): TemplateResult {
    return this.renderField();
  }
}
