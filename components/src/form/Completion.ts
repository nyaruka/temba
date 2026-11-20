import { TemplateResult, css, html } from 'lit';
import { property } from 'lit/decorators.js';
import { ifDefined } from 'lit-html/directives/if-defined.js';
import { TextInput } from './TextInput';
import {
  renderCompletionOption,
  updateInputElementWithCompletion,
  executeCompletionQuery
} from '../excellent/helpers';

import { FieldElement } from './FieldElement';
import { CompletionOption, Position } from '../interfaces';
import { styleMap } from 'lit-html/directives/style-map.js';
import { msg } from '@lit/localize';

/**
 * Completion is a text input that handles excellent completion options in a popup
 */
export class Completion extends FieldElement {
  static get styles() {
    return css`
      ${super.styles}
      :host {
        display: block;
      }

      temba-options {
        --widget-box-shadow-focused: 0 0 4px rgba(0, 0, 0, 0.15);
        --color-focus: #e6e6e6;
      }

      .comp-container {
        position: relative;
        height: 100%;
      }

      #anchor {
        /* background: rgba(132, 40, 158, .1); */
        position: absolute;
        visibility: hidden;
        width: 250px;
        height: 20px;
      }

      .fn-marker {
        font-weight: bold;
        font-size: 42px;
      }

      .option-slot {
        background: #fff;
      }

      .current-fn {
        padding: 10px;
        margin: 5px;
        background: var(--color-primary-light);
        color: rgba(0, 0, 0, 0.5);
        border-radius: var(--curvature-widget);
        font-size: 90%;
      }

      .footer {
        padding: 5px 10px;
        background: var(--color-primary-light);
        color: rgba(0, 0, 0, 0.5);
        font-size: 80%;
        border-bottom-left-radius: var(--curvature-widget);
        border-bottom-right-radius: var(--curvature-widget);
      }

      code {
        padding: 1px 5px;
        border-radius: var(--curvature);
      }
    `;
  }

  @property({ type: Number })
  maxLength: number;

  @property({ type: Boolean })
  session: boolean;

  @property({ type: Boolean })
  submitOnEnter = false;

  @property({ type: Object })
  anchorPosition: Position = { left: 0, top: 0 };

  @property({ attribute: false })
  currentFunction: CompletionOption;

  @property({ type: String })
  placeholder = '';

  textInputElement: TextInput;

  anchorElement: HTMLDivElement;

  @property({ type: Array })
  options: any[] = [];

  @property({ type: String })
  name = '';

  @property({ type: Boolean })
  textarea: boolean;

  @property({ type: Boolean })
  gsm: boolean;

  @property({ type: Boolean })
  disableCompletion: boolean;

  @property({ type: String })
  counter: string;

  @property({ type: Boolean })
  autogrow = false;

  @property({ type: Number })
  minHeight: number;

  private query: string;

  public firstUpdated() {
    this.textInputElement = this.shadowRoot.querySelector(
      'temba-textinput'
    ) as TextInput;
    this.anchorElement = this.shadowRoot.querySelector('#anchor');
  }

  private handleKeyUp(evt: KeyboardEvent) {
    if (this.disableCompletion) {
      // if we have options, ignore keys that are meant for them
      if (this.options && this.options.length > 0) {
        if (evt.key === 'ArrowUp' || evt.key === 'ArrowDown') {
          return;
        }

        if (evt.ctrlKey) {
          if (evt.key === 'n' || evt.key === 'p') {
            return;
          }
        }

        if (
          evt.key === 'Enter' ||
          evt.key === 'Escape' ||
          evt.key === 'Tab' ||
          evt.key.startsWith('Control')
        ) {
          evt.stopPropagation();
          evt.preventDefault();
          return;
        }

        this.executeQuery(evt.currentTarget as TextInput);
      }
    }
  }

  public hasVisibleOptions() {
    return this.options.length > 0;
  }

  private executeQuery(ele: TextInput) {
    if (this.disableCompletion) {
      return;
    }

    if (!ele.inputElement) {
      return;
    }

    const result = executeCompletionQuery(ele.inputElement, this.session);

    this.query = result.query;
    this.options = result.options;
    this.anchorPosition = result.anchorPosition;
    this.currentFunction = result.currentFunction;
  }

  private handleClick(evt: MouseEvent) {
    this.executeQuery(evt.currentTarget as TextInput);
  }

  private handleInput(evt: KeyboardEvent) {
    const ele = evt.currentTarget as TextInput;
    this.executeQuery(ele);
    this.value = ele.inputElement.value;
    this.fireEvent('change');
  }

  private handleOptionCanceled() {
    // delay in case we are actively selecting
    window.setTimeout(() => {
      this.options = [];
      this.query = '';
    }, 100);
  }

  private handleOptionSelection(evt: CustomEvent) {
    const option = evt.detail.selected as CompletionOption;
    const tabbed = evt.detail.tabbed;

    updateInputElementWithCompletion(
      this.query,
      this.textInputElement.inputElement,
      option
    );
    this.query = '';
    this.options = [];

    if (tabbed) {
      this.executeQuery(this.textInputElement);
    }
  }

  public getTextInput(): TextInput {
    return this.textInputElement;
  }

  public click() {
    super.click();
    const input = this.shadowRoot.querySelector('temba-textinput') as TextInput;
    if (input) {
      input.click();
    }
  }

  public focus() {
    super.focus();
    const input = this.shadowRoot.querySelector('temba-textinput') as TextInput;
    if (input) {
      input.focus();
    }
  }

  protected renderWidget(): TemplateResult {
    const anchorStyles = this.anchorPosition
      ? {
          top: `${this.anchorPosition.top}px`,
          left: `${this.anchorPosition.left}px`
        }
      : {};

    const visible = this.options && this.options.length > 0;

    return html`
      <div class="comp-container">
        <div id="anchor" style=${styleMap(anchorStyles)}></div>
        <temba-textinput
          name=${this.name}
          placeholder=${this.placeholder}
          gsm=${this.gsm}
          counter=${ifDefined(this.counter)}
          @keyup=${this.handleKeyUp}
          @click=${this.handleClick}
          @input=${this.handleInput}
          @blur=${this.handleOptionCanceled}
          maxlength="${ifDefined(this.maxLength)}"
          .value=${this.value}
          ?autogrow=${this.autogrow}
          ?textarea=${this.textarea}
          ?submitOnEnter=${this.submitOnEnter}
          style=${this.minHeight
            ? `--textarea-min-height: ${this.minHeight}px`
            : ''}
        >
        </temba-textinput>
        <temba-options
          @temba-selection=${this.handleOptionSelection}
          @temba-canceled=${this.handleOptionCanceled}
          .renderOption=${renderCompletionOption}
          .anchorTo=${this.anchorElement}
          .options=${this.options}
          ?visible=${visible}
        >
          ${this.currentFunction
            ? html`
                <div class="current-fn">
                  ${renderCompletionOption(this.currentFunction, true)}
                </div>
              `
            : null}
          <div class="footer" style="${!visible ? 'display:none' : null}">
            ${msg('Tab to complete, enter to select')}
          </div>
        </temba-options>
      </div>
    `;
  }

  public render(): TemplateResult {
    return this.renderField();
  }
}
