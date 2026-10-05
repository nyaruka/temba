import { TemplateResult, css, html } from 'lit';
import { property } from 'lit/decorators.js';
import { FieldElement } from './FieldElement';
import { CompletionOption, CustomEventType, Position } from '../interfaces';
import { tokenize, TokenType } from '../excellent/tokenizer';
import {
  messageParser,
  sessionParser,
  renderCompletionOption,
  executeCompletionQuery,
  updateInputElementWithCompletion
} from '../excellent/helpers';
import { getStore } from '../store/Store';
import { styleMap } from 'lit-html/directives/style-map.js';
import { msg } from '@lit/localize';
import {
  getCaretOffset,
  getCaretEndOffset,
  getSelectionRange,
  setCaretOffset,
  setCaretRange,
  getTextFromEditableDiv
} from '../excellent/caret-utils';
import {
  EXPRESSION_TOKENS,
  getTokenClass,
  tokenCss
} from '../excellent/token-styles';

// Token type → CSS class mapping and caret utilities are now shared modules.
// See ../excellent/token-styles.ts and ../excellent/caret-utils.ts

// ---------------------------------------------------------------------------
// RichEditor component
// ---------------------------------------------------------------------------

export class RichEditor extends FieldElement {
  static get styles() {
    return css`
      ${super.styles}

      :host {
        display: block;
        min-width: 0;
        contain: inline-size;
      }

      .comp-container {
        position: relative;
        height: 100%;
      }

      #anchor {
        position: absolute;
        visibility: hidden;
        width: 250px;
        height: 20px;
      }

      .input-container {
        border-radius: var(--curvature-widget);
        background: var(--color-widget-bg);
        border: 1px solid var(--color-widget-border);
        transition: all ease-in-out var(--transition-speed);
        box-shadow: var(--widget-box-shadow);
      }

      .input-container.xsmall {
        --temba-textinput-padding: 6px 8px;
        --temba-textinput-font-size: 13px;
      }

      .input-container.small {
        --temba-textinput-padding: 6px 8px;
        --temba-textinput-font-size: 14px;
      }

      .input-container:focus-within {
        border-color: var(--color-focus);
        background: var(--color-widget-bg-focused);
        box-shadow: var(--widget-box-shadow-focused);
      }

      .highlight-editor {
        padding: var(--temba-textinput-padding);
        border: none;
        margin: 0;
        background: transparent;
        color: var(--color-widget-text);
        font-family: var(--font-family);
        font-size: var(--temba-textinput-font-size);
        line-height: normal;
        width: 100%;
        box-sizing: border-box;
        outline: none;
        white-space: pre-wrap;
        word-break: break-word;
        overflow-y: auto;
        min-height: var(--textarea-min-height, 100px);
        resize: none;
        position: relative;
      }

      :host(:not([textarea])) {
        min-width: 0;
      }

      :host(:not([textarea])) .highlight-editor {
        white-space: pre;
        overflow-x: auto;
        overflow-y: hidden;
        min-height: 0;
        scrollbar-width: none;
      }

      :host(:not([textarea])) .highlight-editor::-webkit-scrollbar {
        display: none;
      }

      .highlight-editor:empty::before {
        content: attr(data-placeholder);
        color: var(--color-placeholder, #999);
        pointer-events: none;
        /* Take the placeholder out of flow so the caret sits at offset 0
           visually, not after the placeholder text (Firefox honors flow
           strictly here while Chrome happens to overlay the caret). */
        position: absolute;
        inset: 0;
        padding: inherit;
      }

      /* Token styles (shared) */
      ${tokenCss}

      /* Completion popup styles */
      temba-options {
        --widget-box-shadow-focused: 0 0 4px rgba(0, 0, 0, 0.15);
        --color-focus: #e6e6e6;
      }

      .current-fn {
        padding: 10px;
        margin: 5px;
        background: var(--color-primary-light);
        color: rgba(0, 0, 0, 0.5);
        border-radius: var(--curvature-widget);
        font-size: 90%;
        max-width: 216px;
        overflow: hidden;
        word-wrap: break-word;
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

  // -- Properties matching Completion's API --

  @property({ type: String })
  placeholder = '';

  @property({ type: Boolean })
  textarea: boolean;

  @property({ type: Boolean })
  autogrow = false;

  @property({ type: Boolean })
  gsm: boolean;

  @property({ type: String })
  counter: string;

  @property({ type: Number })
  maxLength: number;

  @property({ type: String })
  flavor = 'default';

  @property({ type: Boolean })
  session: boolean;

  @property({ type: Boolean })
  submitOnEnter = false;

  @property({ type: Boolean })
  disableCompletion: boolean;

  @property({ type: Number })
  minHeight: number;

  // -- Completion state --

  @property({ type: Array })
  options: any[] = [];

  @property({ type: Object })
  anchorPosition: Position = { left: 0, top: 0 };

  @property({ attribute: false })
  currentFunction: CompletionOption;

  // -- Internal state --

  private editableDiv: HTMLDivElement;
  private anchorElement: HTMLDivElement;
  private hiddenElement: HTMLInputElement;
  private query: string;
  private _skipRender = false;
  private _composing = false;

  // Undo/redo: native browser undo doesn't work because syntax highlighting
  // replaces innerHTML on every input, destroying the browser's undo history.
  private undoStack: { value: string; caret: number }[] = [];
  private redoStack: { value: string; caret: number }[] = [];

  // -- Lifecycle --

  public firstUpdated() {
    this.editableDiv = this.shadowRoot.querySelector('.highlight-editor');
    this.anchorElement = this.shadowRoot.querySelector('#anchor');

    // Create hidden input for form serialization
    this.hiddenElement = document.createElement('input');
    this.hiddenElement.setAttribute('type', 'hidden');
    this.hiddenElement.setAttribute('name', this.getAttribute('name') || '');
    this.hiddenElement.setAttribute('value', this.getAttribute('value') || '');
    this.appendChild(this.hiddenElement);

    // Patch the contenteditable div with HTMLInputElement-like API
    this.patchEditableAsInput();

    // Initial render
    if (this.value) {
      this.renderHighlightedContent(this.value);
    }
  }

  public updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has('value')) {
      if (this.hiddenElement) {
        this.hiddenElement.setAttribute('value', this.value || '');
      }

      if (this._skipRender) {
        this._skipRender = false;
      } else if (this.editableDiv) {
        this.renderHighlightedContent(this.value || '');
      }
    }
  }

  // -- HTMLInputElement adapter --

  private patchEditableAsInput(): void {
    const div = this.editableDiv as any;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;

    Object.defineProperty(div, 'value', {
      get() {
        return host.value || '';
      },
      set(val: string) {
        host._skipRender = true;
        host.value = val;
        host.renderHighlightedContent(val);
      },
      configurable: true
    });

    Object.defineProperty(div, 'selectionStart', {
      get() {
        return getCaretOffset(div);
      },
      configurable: true
    });

    Object.defineProperty(div, 'selectionEnd', {
      get() {
        return getCaretEndOffset(div);
      },
      configurable: true
    });

    div.setSelectionRange = (start: number, end: number) => {
      setCaretRange(div, start, end);
    };
  }

  // -- Highlighted content rendering --

  public renderHighlightedContent(text: string): void {
    const div = this.editableDiv;
    if (!div) return;

    if (this.disableCompletion) {
      div.textContent = text || '';
      if (text && text.endsWith('\n')) {
        const br = document.createElement('br');
        br.setAttribute('data-sentinel', '');
        div.appendChild(br);
      }
      return;
    }

    const parser = this.session ? sessionParser : messageParser;
    const tokens = tokenize(text || '', parser);

    // Build set of valid function names for validation
    const validFunctions = new Set<string>();
    try {
      const store = getStore();
      if (store) {
        for (const fn of store.getFunctions()) {
          const name = fn.signature?.substring(0, fn.signature.indexOf('('));
          if (name) validFunctions.add(name.toLowerCase());
        }
      }
    } catch {
      // Store may not have getFunctions in some contexts
    }

    // Clear
    div.textContent = '';

    for (const token of tokens) {
      const cls = getTokenClass(token);
      const isMono = EXPRESSION_TOKENS.has(token.type);

      // Check if function name is invalid
      const isInvalidFn =
        token.type === TokenType.FunctionName &&
        validFunctions.size > 0 &&
        !validFunctions.has(token.text.toLowerCase());

      // Split token text on newlines; newlines become styled spans with \n
      const parts = token.text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          const nlSpan = document.createElement('span');
          nlSpan.className = 'tok-newline';
          nlSpan.textContent = '\n';
          div.appendChild(nlSpan);
        }
        if (parts[i].length > 0) {
          const span = document.createElement('span');
          span.textContent = parts[i];
          let className = isMono ? `${cls} tok-mono` : cls;
          if (isInvalidFn) className += ' tok-fn-invalid';
          span.className = className;
          if (isMono) span.setAttribute('spellcheck', 'false');
          div.appendChild(span);
        }
      }
    }

    // Ensure there's at least an empty text node for cursor placement
    if (!text || text === '') {
      div.appendChild(document.createTextNode(''));
    } else if (text.endsWith('\n')) {
      // A trailing "\n" text node is collapsed by Firefox in contenteditable,
      // making the empty final line invisible. A sentinel <br> forces the
      // line break to render. The data-sentinel attribute distinguishes it
      // from browser-inserted <br>s (which represent real newlines and must
      // be preserved by the caret/text utilities).
      const br = document.createElement('br');
      br.setAttribute('data-sentinel', '');
      div.appendChild(br);
    }
  }

  // -- Event handlers --

  /**
   * Primary input handler. The browser has already modified the DOM;
   * we read the text back, re-render with highlighting, and restore the cursor.
   */
  private handleInput(): void {
    if (this.disabled || this._composing) return;

    const text = getTextFromEditableDiv(this.editableDiv);
    const currentValue = this.value || '';

    if (text === currentValue) return;

    const caretPos = getCaretOffset(this.editableDiv);

    this.undoStack.push({ value: currentValue, caret: caretPos });
    this.redoStack = [];

    this.applyValue(text, Math.min(caretPos, text.length));
  }

  private handleCompositionStart(): void {
    this._composing = true;
  }

  private handleCompositionEnd(): void {
    this._composing = false;
    this.handleInput();
  }

  /** Applies a new value, re-renders, restores caret, and fires events. */
  private applyValue(newValue: string, caretPos: number): void {
    this._skipRender = true;
    this.value = newValue;
    this.renderHighlightedContent(newValue);
    setCaretOffset(this.editableDiv, caretPos);
    this.executeQuery();
    this.fireEvent('input');
    this.fireEvent('change');
  }

  private performUndo(): void {
    if (this.undoStack.length > 0) {
      const caret = getCaretOffset(this.editableDiv);
      this.redoStack.push({ value: this.value || '', caret });
      const state = this.undoStack.pop();
      this.applyValue(state.value, state.caret);
    }
  }

  private performRedo(): void {
    if (this.redoStack.length > 0) {
      const caret = getCaretOffset(this.editableDiv);
      this.undoStack.push({ value: this.value || '', caret });
      const state = this.redoStack.pop();
      this.applyValue(state.value, state.caret);
    }
  }

  // Handles undo/redo from Edit menu and context menu
  private handleBeforeInput(e: InputEvent): void {
    if (e.inputType === 'historyUndo') {
      e.preventDefault();
      this.performUndo();
    } else if (e.inputType === 'historyRedo') {
      e.preventDefault();
      this.performRedo();
    }
  }

  private handleKeydown(e: KeyboardEvent): void {
    // On macOS, Cmd is the undo/redo modifier; leave Ctrl alone so Cocoa
    // text bindings like Ctrl+K (kill) and Ctrl+Y (yank) keep working.
    const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    const mod = isMac ? e.metaKey : e.ctrlKey;

    // Undo/redo via keyboard: preventDefault here suppresses the subsequent
    // beforeinput event, avoiding double-handling
    if (mod && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      this.performUndo();
      return;
    }
    if (mod && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
      e.preventDefault();
      this.performRedo();
      return;
    }

    // Enter
    if (e.key === 'Enter') {
      // If completion popup is visible, let temba-options handle the selection
      if (this.hasVisibleOptions()) {
        e.preventDefault();
        return;
      }

      if (this.submitOnEnter || !this.textarea) {
        e.preventDefault();
        const modax = this.closest('temba-modax') as any;
        if (modax) {
          modax.submit();
        } else {
          this.fireCustomEvent(CustomEventType.Submitted);
        }
        return;
      }

      // Insert newline via string manipulation to avoid browser div-wrapping
      e.preventDefault();
      const selStart = getCaretOffset(this.editableDiv);
      const selEnd = getCaretEndOffset(this.editableDiv);
      const current = this.value || '';

      this.undoStack.push({ value: current, caret: selStart });
      this.redoStack = [];

      const newValue =
        current.substring(0, selStart) + '\n' + current.substring(selEnd);
      this.applyValue(newValue, selStart + 1);
    }
  }

  private handleKeyUp(evt: KeyboardEvent): void {
    if (this.disableCompletion) return;

    // If we have options, ignore keys that are meant for them
    if (this.options && this.options.length > 0) {
      if (evt.key === 'ArrowUp' || evt.key === 'ArrowDown') {
        return;
      }
      if (evt.ctrlKey && (evt.key === 'n' || evt.key === 'p')) {
        return;
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
    }

    this.executeQuery();
  }

  private handlePaste(e: ClipboardEvent): void {
    e.preventDefault();
    const pastedText = e.clipboardData?.getData('text/plain') || '';
    const selStart = getCaretOffset(this.editableDiv);
    const selEnd = getCaretEndOffset(this.editableDiv);
    const current = this.value || '';

    this.undoStack.push({ value: current, caret: selStart });
    this.redoStack = [];

    const newValue =
      current.substring(0, selStart) + pastedText + current.substring(selEnd);

    this.applyValue(newValue, selStart + pastedText.length);
  }

  private handleClick(): void {
    this.executeQuery();
  }

  private handleBlur(): void {
    this.handleOptionCanceled();
  }

  // -- Completion integration --

  private executeQuery(): void {
    if (this.disableCompletion) return;
    if (!this.editableDiv) return;

    const result = executeCompletionQuery(
      this.editableDiv as unknown as HTMLInputElement,
      this.session
    );

    if (result) {
      this.query = result.query;
      this.options = result.options;
      this.anchorPosition = result.anchorPosition;
      this.currentFunction = result.currentFunction;
    }
  }

  private handleOptionSelection(evt: CustomEvent): void {
    const option = evt.detail.selected as CompletionOption;
    const tabbed = evt.detail.tabbed;
    const currentValue = this.value || '';
    const caretPos = getCaretOffset(this.editableDiv);

    // Mirror typing/paste behavior: completion insertion should be undoable
    // back to the exact pre-completion editor state.
    this.undoStack.push({ value: currentValue, caret: caretPos });
    this.redoStack = [];

    updateInputElementWithCompletion(
      this.query,
      this.editableDiv as unknown as HTMLInputElement,
      option
    );

    // Sync value from the patched div and notify consumers
    this.value = (this.editableDiv as any).value;
    this.query = '';
    this.options = [];
    this.fireEvent('input');
    this.fireEvent('change');

    if (tabbed) {
      this.executeQuery();
    }
  }

  private handleOptionCanceled(): void {
    window.setTimeout(() => {
      this.options = [];
      this.query = '';
    }, 100);
  }

  // -- Consumer compatibility API --

  public getTextInput(): any {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    return {
      get inputElement() {
        return host.editableDiv;
      },
      get value() {
        return host.value;
      },
      updateValue(val: string) {
        host._skipRender = true;
        host.value = val;
        host.renderHighlightedContent(val);
      }
    };
  }

  public get inputElement(): HTMLDivElement {
    return this.editableDiv;
  }

  public getText(): string {
    return this.value || '';
  }

  public getCaretPosition(): number {
    if (!this.editableDiv) return 0;
    return getCaretOffset(this.editableDiv);
  }

  public getCaretScreenPosition(): { top: number; left: number } | null {
    if (!this.editableDiv) return null;
    const selected = getSelectionRange(this.editableDiv);
    if (!selected) return null;
    const range = document.createRange();
    range.setStart(selected.startContainer, selected.startOffset);
    const rect = range.getBoundingClientRect();
    if (rect.top === 0 && rect.left === 0) return null;
    return { top: rect.bottom, left: rect.left };
  }

  public insertTextAt(text: string, position: number): number {
    const current = this.value || '';
    const newValue =
      current.substring(0, position) + text + current.substring(position);
    const newCaret = position + text.length;
    this.applyValue(newValue, newCaret);
    return newCaret;
  }

  public hasVisibleOptions(): boolean {
    return this.options.length > 0;
  }

  public focus(): void {
    super.focus();
    if (this.editableDiv) {
      this.editableDiv.focus();
    }
  }

  public click(): void {
    super.click();
    if (this.editableDiv) {
      this.editableDiv.click();
    }
  }

  // -- Template --

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
        <div
          class="input-container ${this.flavor !== 'default'
            ? this.flavor
            : ''}"
          style=${this.minHeight
            ? `--textarea-min-height: ${this.minHeight}px`
            : ''}
        >
          <div
            class="highlight-editor"
            contenteditable="true"
            spellcheck="true"
            data-placeholder=${this.placeholder}
            @input=${this.handleInput}
            @beforeinput=${this.handleBeforeInput}
            @compositionstart=${this.handleCompositionStart}
            @compositionend=${this.handleCompositionEnd}
            @keydown=${this.handleKeydown}
            @keyup=${this.handleKeyUp}
            @click=${this.handleClick}
            @paste=${this.handlePaste}
            @blur=${this.handleBlur}
          ></div>
        </div>
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
