/* eslint-disable @typescript-eslint/no-empty-function */
import { PropertyValues, TemplateResult, html, css } from 'lit';
import { property, state } from 'lit/decorators.js';
import {
  getUrl,
  getClasses,
  fetchResults,
  WebResponse,
  postJSON
} from '../../utils';
import '../../display/Options';
import '../../list/SortableList';
import { EventHandler } from '../../RapidElement';
import { FieldElement } from '../../form/FieldElement';

import { lru } from 'tiny-lru';
import { CompletionOption, CustomEventType, Position } from '../../interfaces';
import {
  renderCompletionOption,
  updateInputElementWithCompletion,
  executeCompletionQuery,
  sessionParser,
  messageParser
} from '../../excellent/helpers';
import { tokenize } from '../../excellent/tokenizer';
import {
  getCaretOffset,
  getCaretEndOffset,
  setCaretRange,
  getTextFromEditableDiv
} from '../../excellent/caret-utils';
import {
  EXPRESSION_TOKENS,
  getTokenClass,
  tokenCss
} from '../../excellent/token-styles';
import { Store } from '../../store/Store';
import {
  pillVariants,
  PILL_TYPES,
  PILL_TYPE_ICONS
} from '../../styles/pillVariants';
import { StyleInfo, styleMap } from 'lit-html/directives/style-map.js';
import { Icon } from '../../Icons';
import { msg } from '@lit/localize';

const LOOK_AHEAD = 20;

export interface SelectOption {
  name: string;
  value?: string;
  expression?: boolean;
  selected?: boolean;
  arbitrary?: boolean;
  /**
   * Pill variant for this option. Lets a single select hold mixed types
   * (e.g. Omnibox: groups + contacts) and color each chip correctly.
   * Falls back to the widget's resolved pill type — see `Select.getPillType`.
   */
  type?: string;
}

/**
 * Endpoint URL → pill variant. Each pattern is anchored on a path
 * terminator (`/`, `.json`, `?`, end-of-string) so it can't match
 * substrings like `/groupsearch` or `/contact/group/<uuid>/`. Adding a
 * new entry here is the only change needed to make a new endpoint
 * auto-color its chips. (PILL_TYPES / PILL_TYPE_ICONS live in
 * src/styles/pillVariants.ts — the single source of truth shared with
 * Label / flow utils.)
 */
const ENDPOINT_PILL_TYPES: { pattern: RegExp; type: string }[] = [
  { pattern: /\/groups(\.json|\/|\?|$)/, type: 'group' },
  { pattern: /\/contacts(\.json|\/|\?|$)/, type: 'contact' },
  { pattern: /\/labels(\.json|\/|\?|$)/, type: 'label' },
  { pattern: /\/flows(\.json|\/|\?|$)/, type: 'flow' },
  { pattern: /\/fields(\.json|\/|\?|$)/, type: 'field' },
  { pattern: /\/topics(\.json|\/|\?|$)/, type: 'topic' }
];

export class Select<T extends SelectOption> extends FieldElement {
  private hiddenInputs: HTMLInputElement[] = [];

  static get styles() {
    return css`
      ${super.styles}
      ${pillVariants}

      :host {
        --transition-speed: 0;
        font-family: var(--font-family);
        transition: all ease-in-out var(--transition-speed);
        display: inline;
        line-height: normal;
        outline: none;
        position: relative;
        --icon-color: var(--color-text-dark-secondary);
      }

      temba-options {
        --temba-options-font-size: var(--temba-select-selected-font-size);
        --icon-color: var(--color-text-dark);
        --color-options-bg: #fff;
        /* Keep the popup neutral when the parent field is in an
           error state — FieldElement's .has-error sets
           --color-widget-border / --color-focus to red, which would
           otherwise cascade into the popup. The popup itself uses
           --focus-muted / --focus-halo (error-immune) for its
           outline; here we only reset the widget-border alias. */
        --color-widget-border: var(--border-strong);
      }

      :host:focus {
        outline: none;
      }

      #anchor {
        position: absolute;
        visibility: hidden;
        width: 250px;
        height: 25px;
      }

      input:focus {
        outline: none;
        box-shadow: none;
        cursor: text;
      }

      .wrapper-bg {
        background: var(--select-wrapper-bg, var(--surface));
        box-shadow: var(--select-wrapper-shadow, none);
        border-radius: var(--curvature-widget);
      }

      .select-container {
        display: flex;
        flex-direction: row;
        flex-wrap: nowrap;
        align-items: center;
        border: 1px solid var(--color-widget-border);
        transition:
          border-color 120ms ease-in-out,
          box-shadow 120ms ease-in-out;
        cursor: pointer;
        border-radius: var(--curvature-widget);
        background: var(--color-widget-bg);
        box-shadow: var(--widget-box-shadow);
        position: relative;
        min-height: var(--temba-select-min-height, 34px);
        max-height: var(--temba-select-max-height, none);
        /* Default clip so chevron / chip overflow doesn't escape the
           widget. Embedded-label use cases (e.g. ContactFieldEditor's
           location selects) override this to visible so the slotted
           prefix label can extend above the top border. */
        overflow: var(--temba-select-container-overflow, hidden);
      }

      temba-icon.select-open:hover,
      .clear-button:hover {
        --icon-color: var(--color-text-dark);
      }

      .select-container:focus {
        outline: none;
      }

      .select-container.multi {
        /* background: var(--color-widget-bg); */
      }

      /* Focus border + halo are global DS tokens — change them once
         in designTokens.ts and every form widget follows. The
         per-component tokens still exist so embedded use cases (e.g.
         WorkspaceSelect inside TembaMenu) can opt out by setting them
         to transparent/none on their own :host. */
      .select-container.focused {
        background: var(--color-widget-bg-focused);
        border-color: var(--temba-select-focus-border, var(--color-focus));
        box-shadow: var(
          --temba-select-focus-halo,
          var(--widget-box-shadow-focused)
        );
      }

      .left-side {
        flex: 1;
        overflow: var(--temba-select-container-overflow, hidden);
        display: flex;
        align-items: center;
      }

      .empty .placeholder {
        display: block;
      }

      /* layout container — padding is the single source of left/right
         offset for placeholder, selected values, and the input. Keep it
         stable across empty/focused/typing/selected states so the widget
         never reflows. */
      .selected {
        flex: 1;
        display: flex;
        flex-direction: row;
        align-items: center;
        user-select: none;
        padding: var(--temba-select-selected-padding, 0 var(--pad));
        min-width: 0;
      }

      /* Multi mode: when empty, placeholder/search input share the
         var(--pad) inset with adjacent text widgets so the cursor
         lines up. Once chips appear, tighten to 4px so the first
         pill sits flush to the left. */
      .multi .selected {
        flex-wrap: wrap;
        gap: 4px;
        padding: 4px var(--pad);
      }
      .multi:not(.empty) .selected {
        padding: 4px;
      }

      .selected .selected-item {
        display: flex;
        align-items: center;
        line-height: var(--temba-select-selected-line-height);
      }

      /* Single-mode selected text uses the widget's own colors. Multi-
         mode chips get color/icon-color/border-color from
         pillVariants (.pill-{type}) — don't set them on the shared
         base rule or they'll outrank the variant on specificity. */
      .single .selected .selected-item {
        flex: 1;
        min-width: 0;
        color: var(--color-widget-text);
        --icon-color: var(--text-2);
      }

      /* multi-mode chips — TextIt design system pills. Shape lives
         here; color variants come from pillVariants (.pill-{type}).
         overflow: hidden is needed so the pill bg clips to the rounded
         radius — but it's only set in multi mode, otherwise it would
         clip glyph descenders on single-mode selected text.
         border-color is owned by .pill-{type}; only width/style live
         here so the variant isn't outranked on specificity. */
      .multi .selected .selected-item {
        vertical-align: middle;
        align-items: center;
        flex-direction: row;
        flex-wrap: nowrap;
        /* X is on the left now; keep it snug to the chip edge (small
           left padding) and give the name side more breathing room
           (larger right padding). */
        gap: 5px;
        height: 20px;
        padding: 0 9px 0 2px;
        margin: 0;
        border-radius: 999px;
        overflow: hidden;
        font-size: 11.5px;
        font-weight: var(--w-regular);
        border-width: 1px;
        border-style: solid;
        user-select: none;
        white-space: nowrap;
        max-width: 240px;
      }

      .option-name {
        flex: 1 1 auto;
        align-self: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding: var(--temba-select-option-padding, 2px 8px);
        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* Keep the type icon perfectly round even when the chip's name
         is long enough to push the chip against its max-width. Same
         reason as the flex-shrink:0 on .multi .remove-item — the span
         next to the icon is what should clip with ellipsis. */
      .option-name > temba-icon {
        flex-shrink: 0;
      }

      .option-name > span {
        text-align: left;
      }

      /* Single-mode selected: drop the option-name's overflow:hidden
         (and its companion text-overflow:ellipsis) so glyph descenders
         on "y", "p", "g" aren't clipped. Long names still clip at
         .left-side, which has overflow:hidden of its own. Multi-mode
         chips re-establish overflow:hidden via the .multi rule below. */
      .selected-item .option-name {
        padding: 0px;
        font-size: var(--temba-select-selected-font-size);
        align-self: center;
        overflow: visible;
      }

      .multi .selected-item .option-name {
        flex: 0 1 auto;
        font-size: inherit;
        padding: 0;
        /* Let the option-name shrink inside the chip and clip its
           contents with an ellipsis when the chip hits its 240px
           max-width. Without min-width:0 the flex item refuses to
           shrink below its content size, defeating the overflow. */
        min-width: 0;
        overflow: hidden;
      }

      /* The renderOptionDefault wraps the name in a <span>. That's the
         actual text node that needs the ellipsis chrome — the parent
         option-name is a flex row (icon + name) so the ellipsis lives
         on the name span only, leaving the icon untouched. */
      .multi .selected-item .option-name > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .multi .selected .selected-item.focused {
        background: var(--accent-600);
        color: white;
        border-color: var(--accent-600);
        --icon-color: white;
      }

      .multi .selected-item.sortable {
        cursor: move;
      }

      .multi .selected-item.dragging {
        opacity: 0.5;
      }

      .multi temba-sortable-list {
        margin: 0 !important;
        flex-grow: 1;
      }

      /* chip remove button — DS pill-x. Lives on the LEFT of the chip
         so successive deletions can be done with the cursor parked at
         the same screen position (each removal pulls the next chip
         leftward into the same spot). Has its own tinted background
         (currentColor-mixed so it follows the pill variant) so the X
         reads as a distinct hit target and the rest of the chip is
         visually balanced. */
      .multi .remove-item {
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        /* Pin the X to a perfect 16×16 circle even when the chip's
           content is wide enough to bump the chip against its
           max-width (240px) — without flex-shrink:0 the row's flex
           layout squeezes the X horizontally before clipping the
           name. */
        flex-shrink: 0;
        padding: 0;
        margin: 0;
        border: 0;
        border-radius: 999px;
        /* Neutral wash first for browsers without color-mix(); the
           currentColor-tinted version below needs the @supports gate
           because currentColor keeps the declaration valid until
           computed-value time. */
        background: rgba(0, 0, 0, 0.12);
        color: inherit;
        opacity: 0.8;
        --icon-color: currentColor;
      }
      .multi .remove-item:hover {
        opacity: 1;
        background: rgba(0, 0, 0, 0.22);
      }

      @supports (color: color-mix(in srgb, red, red)) {
        .multi .remove-item {
          background: color-mix(in oklab, currentColor 25%, transparent);
        }
        .multi .remove-item:hover {
          background: color-mix(in oklab, currentColor 45%, transparent);
        }
      }

      input {
        font-size: var(--temba-select-selected-font-size);
        width: 0px;
        cursor: pointer;
        background: none;
        resize: none;
        border: none !important;
        visibility: visible;
        line-height: inherit !important;
        height: var(--search-input-height) !important;
        margin: 0px !important;
        padding: 0px !important;
        box-shadow: none !important;
        font-family: var(--font-family);
        caret-color: var(--input-caret);
      }

      .input-wrapper:focus-within {
        min-width: 1px;
        display: flex;
      }

      .input-wrapper {
        min-width: 1px;
        display: none;
        pointer-events: none;
      }

      .multi .input-wrapper {
        min-width: 50px;
        flex: 1 0 auto;
        align-self: center;
      }

      .input-wrapper:focus-within .placeholder {
        display: none;
      }

      input:focus {
        box-shadow: none !important;
        flex-grow: 1;
      }

      .searchable.single.search-input .input-wrapper {
        flex-grow: 1;
        min-width: 1px !important;
      }

      .searchable.single.search-input .selected .selected-item {
        display: none;
      }

      .searchable input {
        visibility: visible;
        cursor: pointer;
        background: none;
        color: var(--color-text);
        resize: none;
        box-shadow: none !important;
        border: none;
        caret-color: var(--input-caret);
      }

      .searchable input:focus {
        box-shadow: none !important;
      }

      .input-wrapper .searchbox {
      }

      .searchbox {
        border: 0px;
      }

      /* Expression-highlighting contenteditable input */
      .searchbox.expression-input {
        outline: none;
        white-space: pre;
        overflow: hidden;
        min-width: 1px;
        background: none;
        color: var(--color-text);
        caret-color: var(--input-caret);
        font-family: var(--font-family);
        font-size: inherit;
        line-height: inherit;
        padding: 0;
      }

      .searchbox.expression-input:empty::before {
        content: '';
      }

      ${tokenCss}

      .placeholder {
        font-size: var(--temba-select-selected-font-size);
        font-weight: var(--w-regular);
        color: var(--color-placeholder);
        display: none;
        line-height: var(--temba-select-selected-line-height);
        pointer-events: none;
      }

      .empty .placeholder {
        display: block;
      }

      .multi .placeholder {
        display: block;
        align-self: center;
      }

      .footer {
        padding: 5px 10px;
        background: var(--color-primary-light);
        color: rgba(0, 0, 0, 0.5);
        font-size: 80%;
        border-bottom-left-radius: var(--curvature-widget);
        border-bottom-right-radius: var(--curvature-widget);
      }

      .small {
        /* Match TextInput's small flavor (6px 8px) so a select sitting
           next to a text field in the same form has its value text
           horizontally aligned with the field's text. */
        --temba-select-selected-padding: 6px 8px;
        --temba-select-selected-line-height: 12px;
        --temba-select-selected-font-size: 14px;
        --temba-select-min-height: 2.28em;
      }

      .xsmall {
        /* Match RichEditor's xsmall (6px 8px padding, 13px font,
           line-height: normal, no min-height floor) so a rule editor
           row of [operator select | rich-edit argument | category
           textinput] renders all three widgets at the same height.
           The rich-edit argument has no 34px --input-h floor, so the
           select drops that floor here too — TextInput's xsmall makes
           the same opt-out via --temba-textinput-min-height: 0. */
        --temba-select-selected-padding: 6px 8px;
        --temba-select-selected-line-height: 1.2;
        --temba-select-selected-font-size: 13px;
        --temba-select-min-height: 0em;
      }

      .info-text {
        opacity: 1;
        transition:
          padding-top var(--transition-speed) ease-in-out,
          padding-bottom var(--transition-speed) ease-in-out;
        margin-bottom: 16px;
        padding: 0.5em 1em;
        border-radius: var(--curvature);
        font-size: 0.9em;
        color: rgba(0, 0, 0, 0.5);
        position: relative;
      }

      .info-text.focused {
        opacity: 1;
      }

      .info-text.hide {
        opacity: 0;
        max-height: 0;
        margin-bottom: 0px;
        pointer-events: none;
        padding: 0px;
      }

      .enter-hint {
        position: fixed;
        z-index: 10000;
        font-size: 0.75em;
        color: rgba(0, 0, 0, 0.4);
        white-space: nowrap;
        pointer-events: none;
        background: rgba(255, 255, 255, 0.7);
        backdrop-filter: blur(4px);
        padding: 4px 10px;
        border-radius: 2px;
      }
    `;
  }

  @property({ type: Object })
  inputStyle: StyleInfo = {};

  @property({ type: Boolean })
  multi = false;

  @property({ type: Boolean })
  searchOnFocus = false;

  @property({ type: String })
  placeholder = '';

  @property()
  name = '';

  @property()
  endpoint: string;

  @property({ type: Boolean })
  allowCreate: boolean = false;

  @property({ type: String })
  nameKey = 'name';

  @property({ type: String })
  valueKey = 'value';

  @property({ type: Number })
  maxItems = 0;

  @property({ type: String })
  maxItemsText: string = 'Maximum items reached';

  @property({ attribute: false })
  currentFunction: CompletionOption;

  @property({ type: String })
  queryParam: string = null;

  @property({ type: String })
  input = '';

  @property({ type: Array })
  visibleOptions: any[] = [];

  @property({ type: Array })
  completionOptions: CompletionOption[] = [];

  @property({ type: Number })
  quietMillis = 0;

  @property({ type: Boolean })
  fetching: boolean;

  @property({ type: Boolean })
  resolving: boolean;

  @property({ type: Boolean })
  searchable = false;

  @property({ type: String })
  expressions: string;

  @property({ type: Boolean })
  cache = true;

  @property({ type: String })
  cacheKey = '';

  @property({ type: Boolean })
  focused = false;

  @property({ type: Boolean })
  disabled = false;

  @state()
  attemptedOpen = false;

  @property({ attribute: false })
  selectedIndex = -1;

  @property({ type: Number })
  cursorIndex: number;

  anchorElement: HTMLElement;

  anchorExpressions: HTMLElement;

  @property({ type: Object })
  anchorPosition: Position = { left: 0, top: 0 };

  @property({ type: Boolean })
  tags = false;

  @property({ type: Boolean })
  emails = false;

  @property({ type: Boolean, attribute: 'space_select' })
  spaceSelect: boolean;

  @property({ type: Boolean })
  jsonValue: boolean;

  @property({ type: Boolean })
  hideErrors: boolean;

  @property({ type: Boolean })
  clearable: boolean;

  @property({ type: Boolean })
  sorted: boolean;

  @property({ type: String })
  flavor = 'default';

  /**
   * Explicit pill variant for selected-value chips (one of: neutral,
   * flow, group, field, label, keyword, contact). When unset, the
   * variant is resolved automatically — see `getPillType`. Set this
   * only to override the auto-resolution.
   */
  @property({ type: String, attribute: 'pill_type' })
  pillType?: string;

  @property({ type: String, attribute: 'info_text' })
  infoText = '';

  // Override the setter to ensure values is always an array
  @property({ type: Array })
  set values(newValues: any) {
    this._values = Array.isArray(newValues) ? newValues : [];
    this.requestUpdate('values');
  }

  get values(): T[] {
    return this._values || [];
  }

  private _values: T[] = [];

  @property({ type: Object })
  selection: any;

  @property({ attribute: false })
  getName: (option: any) => string = (option: any) => {
    return option[this.nameKey || 'name'];
  };

  @property({ attribute: false })
  isMatch: (option: any, q: string) => boolean = this.isMatchDefault;

  @property({ attribute: false })
  getValue: (option: any) => string = (option: any) =>
    option[this.valueKey || 'value'] || option.id;

  @property({ type: Number, attribute: 'option-width' })
  optionWidth: number;

  @property({ type: Number, attribute: 'option-min-width' })
  optionMinWidth: number;

  @property({ type: Boolean, attribute: 'anchor-right' })
  anchorRight: boolean;

  @property({ attribute: false })
  shouldExclude: (option: any) => boolean;

  @property({ attribute: false })
  sortFunction: (a: any, b: any) => number = null;

  @property({ attribute: false })
  renderOption: (option: any, selected: boolean) => TemplateResult;

  @property({ attribute: false })
  renderOptionName: (option: any, selected: boolean) => TemplateResult;

  @property({ attribute: false })
  renderOptionDetail: (option: any, selected: boolean) => TemplateResult = () =>
    html``;

  @property({ attribute: false })
  renderSelectedItem: (option: any) => TemplateResult =
    this.renderSelectedItemDefault;

  @property({ attribute: false })
  createArbitraryOption: (input: string, options: any[]) => any =
    this.createArbitraryOptionDefault;

  @property({ attribute: false })
  getOptions: (response: WebResponse) => any[] = this.getOptionsDefault;

  @property({ attribute: false })
  prepareOptions: (options: any[]) => any[] = this.prepareOptionsDefault;

  @property({ attribute: false })
  isComplete: (newestOptions: any[], response: WebResponse) => boolean =
    this.isCompleteDefault;

  @property({ type: Array, attribute: 'options' })
  private staticOptions: any[] = [];

  @property({ type: Boolean })
  allowAnchor: boolean = true;

  @property({ type: String })
  draggingId: string;

  private alphaSort = (a: any, b: any) => {
    // by default, all endpoint values are sorted by name
    if (this.endpoint) {
      return this.getNameInternal(a).localeCompare(this.getNameInternal(b));
    }
    return 0;
  };

  private lastQuery: number;

  private complete: boolean;
  private page: number;
  private next: string = null;
  private query: string;

  private lruCache = lru(20, 60000);

  constructor() {
    super();
    this.renderOptionDefault = this.renderOptionDefault.bind(this);
    this.renderSelectedItemDefault = this.renderSelectedItemDefault.bind(this);
    this.prepareOptionsDefault = this.prepareOptionsDefault.bind(this);
    this.isMatchDefault = this.isMatchDefault.bind(this);
    this.handleOrderChanged = this.handleOrderChanged.bind(this);
    this.createArbitraryOption = this.createArbitraryOptionDefault.bind(this);
  }

  public prepareOptionsDefault(options: T[]): T[] {
    return options;
  }

  public isMatchDefault(option: T, q: string) {
    const name = this.getNameInternal(option) || '';
    return name.toLowerCase().indexOf(q) > -1;
  }

  public handleSlotChange() {
    if (this.staticOptions && this.staticOptions.length === 0) {
      for (const child of this.children) {
        if (child.tagName === 'TEMBA-OPTION') {
          const option: any = {};
          for (const attribute of child.attributes) {
            option[attribute.name] = attribute.value;
          }

          if (option) {
            let selected = false;

            // if the option is marked as selected then accept it
            if (option['selected'] !== undefined) {
              delete option['selected'];
              selected = true;
            }

            // the option value might also match the widget value
            const selectValue = this.value || this.getAttribute('value');
            if (selectValue) {
              const optionValue = this.getValue(option);
              if (optionValue == selectValue) {
                selected = true;
              }
            }

            this.staticOptions.push(option);
            if (selected) {
              if (this.isMultiMode) {
                this.addValue(option);
              } else {
                this.setValues([option]);
              }
            }
          }
        }
      }
    }

    if (this.searchable && this.staticOptions.length === 0) {
      this.quietMillis = 200;
    }
  }

  private checkSelectedOption() {
    // see if we need fetch to select an option
    if (
      this.value &&
      this.values.length == 0 &&
      this.staticOptions.length == 0 &&
      this.endpoint
    ) {
      const value = this.value;
      this.resolving = true;

      fetchResults(this.endpoint).then((results: any) => {
        if (results && results.length > 0) {
          if (value) {
            // if we started with a value, see if we can find it in the results
            const existing = results.find((option) => {
              return this.getValue(option) === value;
            });
            if (existing) {
              this.resolving = false;
              this.fetching = false;
              this.setValues([existing]);
              return;
            }
          }

          this.setValues([results[0]]);
          this.resolving = false;
        }
      });
    } else if (this.staticOptions.length > 0) {
      if (this.getAttribute('multi') !== null) {
        this.addValue(this.staticOptions[0]);
      } else {
        if (this.getAttribute('value')) {
          this.setSelectedValue(this.getAttribute('value'));
        } else {
          this.setValues([this.staticOptions[0]]);
        }
      }
    }
  }

  public firstUpdated(changedProperties: any) {
    super.firstUpdated(changedProperties);
    this.anchorElement = this.shadowRoot.querySelector('.select-container');
    this.anchorExpressions = this.shadowRoot.querySelector('#anchor');
    this.shadowRoot.addEventListener(
      'slotchange',
      this.handleSlotChange.bind(this)
    );
    // Capture-phase pointerdown anywhere within the options popup so
    // we can mark "user is interacting" before any focus shift fires.
    // Used by handleBlur to keep the dropdown open while the user
    // drags the native scrollbar.
    const optionsEl = this.shadowRoot.querySelector('temba-options');
    if (optionsEl) {
      optionsEl.addEventListener(
        'pointerdown',
        this.handleOptionsPointerDown,
        true
      );
    }
  }

  public willUpdate(changes: PropertyValues) {
    if (changes.has('createArbitraryOption')) {
      if (!this.createArbitraryOption) {
        this.createArbitraryOption =
          this.createArbitraryOptionDefault.bind(this);
      }
    }

    // single non-clearable selects default to the first option if we don't
    // have a placeholder (for multi and clearable selects an empty selection
    // is a valid state the user must be able to get back to)
    if (
      !this.isMultiMode &&
      !this.clearable &&
      this.values.length === 0 &&
      !this.placeholder &&
      this.staticOptions.length > 0
    ) {
      const oldValues = this._values;
      this._values = [this.staticOptions[0]];
      this.requestUpdate('values', oldValues);
    }

    if (changes.has('sorted')) {
      this.sortFunction = this.sorted ? this.alphaSort : null;
    }

    // sync value → values for static options
    if (changes.has('value')) {
      if (this.value && !this.values.length) {
        if (this.staticOptions.length > 0) {
          const existing = this.staticOptions.find((option) => {
            return this.getValue(option) === this.value;
          });
          if (existing) {
            this._values = [existing];
            this.requestUpdate('values');
          }
        } else {
          this.checkSelectedOption();
        }
      }
    }

    // pre-sync value/selection from values to prevent warnings
    // when updateInputs() sets them again in updated()
    if (changes.has('values')) {
      if (this.values.length === 0) {
        this.value = null;
      } else {
        const name = this.getAttribute('name');
        if (name && !this.isMultiMode && this.values.length === 1) {
          this.selection = this.values[0];
          this.value = this.serializeValue(this.values[0]);
        }
      }
    }

    super.willUpdate(changes);
  }

  private measureInputTextWidth(searchbox: HTMLElement): number {
    if (this.useExpressionInput) {
      return searchbox.scrollWidth;
    }
    // Create a measuring span that inherits the searchbox's font styles
    const span = document.createElement('span');
    const style = getComputedStyle(searchbox);
    span.style.font = style.font;
    span.style.letterSpacing = style.letterSpacing;
    span.style.visibility = 'hidden';
    span.style.position = 'absolute';
    span.style.whiteSpace = 'pre';
    span.textContent = this.input;
    this.shadowRoot.appendChild(span);
    const width = span.offsetWidth;
    span.remove();
    return width;
  }

  private hintRepositionHandler: (() => void) | null = null;

  private addHintRepositionListeners() {
    if (this.hintRepositionHandler) return;
    this.hintRepositionHandler = () => this.updateEnterHintPosition();
    window.addEventListener('scroll', this.hintRepositionHandler, {
      capture: true,
      passive: true
    });
    window.addEventListener('resize', this.hintRepositionHandler);
  }

  private removeHintRepositionListeners() {
    if (!this.hintRepositionHandler) return;
    window.removeEventListener('scroll', this.hintRepositionHandler, {
      capture: true
    });
    window.removeEventListener('resize', this.hintRepositionHandler);
    this.hintRepositionHandler = null;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeHintRepositionListeners();
    this.detachPointerReleaseHandler();
  }

  private updateEnterHintPosition() {
    const hint = this.shadowRoot.querySelector('.enter-hint') as HTMLElement;
    if (!hint) {
      this.removeHintRepositionListeners();
      return;
    }
    const searchbox = this.shadowRoot.querySelector(
      '.searchbox'
    ) as HTMLElement;
    if (!searchbox) return;

    this.addHintRepositionListeners();

    const searchboxRect = searchbox.getBoundingClientRect();
    const textWidth = this.measureInputTextWidth(searchbox);

    hint.style.left = `${searchboxRect.left + textWidth + 4}px`;
    hint.style.top = `${searchboxRect.top + (searchboxRect.height - hint.offsetHeight) / 2}px`;
  }

  private updateInputWrapperWidth() {
    if (!this.isMultiMode) return;
    const wrapper = this.shadowRoot.querySelector(
      '.input-wrapper'
    ) as HTMLElement;
    if (!wrapper) return;
    const searchbox = this.shadowRoot.querySelector(
      '.searchbox'
    ) as HTMLElement;
    if (!searchbox) return;

    if (this.input) {
      const textWidth = this.measureInputTextWidth(searchbox);
      // Add some breathing room for the caret and padding
      wrapper.style.minWidth = `${textWidth + 20}px`;
    } else {
      wrapper.style.minWidth = '';
    }
  }

  public updated(changes: Map<string, any>) {
    super.updated(changes);

    if (changes.has('input') || changes.has('focused')) {
      this.updateEnterHintPosition();
      this.updateInputWrapperWidth();
    }

    // Re-acquire anchor for expression completions (may not exist on first
    // render in multi mode since the input is only shown when focused)
    if (this.expressions && !this.anchorExpressions) {
      const anchor = this.shadowRoot.querySelector('#anchor') as HTMLElement;
      if (anchor) {
        this.anchorExpressions = anchor;
      }
    }

    // Patch the contenteditable expression input if it exists
    if (this.useExpressionInput) {
      const div = this.shadowRoot.querySelector(
        '.expression-input'
      ) as HTMLElement;
      if (div) {
        this.patchEditableAsInput(div);
        // Sync contenteditable content when input is changed programmatically
        // (e.g., cleared after adding a value). User-driven input is handled
        // synchronously in handleInput.
        if (changes.has('input')) {
          const currentText = getTextFromEditableDiv(div);
          if (currentText !== this.input) {
            this.renderExpressionHighlight(div, this.input);
          }
        }
      }
    }

    if (changes.has('values')) {
      this.updateInputs();
      if (this.hasChanges(changes.get('values'))) {
        this.fireEvent('change');
      }
    }

    // if our cache key changes, clear it out
    if (changes.has('cacheKey')) {
      this.lruCache.clear();
    }

    if (
      changes.has('input') &&
      !changes.has('values') &&
      !changes.has('options') &&
      this.focused
    ) {
      if (this.lastQuery) {
        window.clearTimeout(this.lastQuery);
      }

      this.lastQuery = window.setTimeout(() => {
        if (
          this.expressions &&
          this.input.indexOf('@') > -1 &&
          (!(this.emails || this.tags) ||
            this.input.trimStart().startsWith('@'))
        ) {
          this.fetchExpressions();
        } else {
          if (this.completionOptions.length > 0) {
            this.completionOptions = [];
          }
          if (!(this.emails || this.tags)) {
            this.fetchOptions(this.input);
          }
        }
      }, this.quietMillis);
    }

    if (this.endpoint && changes.has('fetching')) {
      if (!this.fetching && !this.isPastFetchThreshold()) {
        this.fireCustomEvent(CustomEventType.FetchComplete);
      }
    }

    // if our cursor changed, lets make sure our scrollbox is showing it
    if (
      (changes.has('cursorIndex') || changes.has('visibleOptions')) &&
      this.endpoint &&
      !this.fetching
    ) {
      if (this.isPastFetchThreshold()) {
        if (this.next) {
          this.fetchOptions(null, null, this.next);
        } else {
          this.fetchOptions(this.query, this.page + 1);
        }
      }
    }
  }

  private hasChanges(prev: T[]): boolean {
    // This will compare values to see if there is a change
    // Note: make sure value is populated or valueKey is set

    if (prev === undefined) {
      return false;
    }

    let prevValues = undefined;
    if (prev !== undefined) {
      prevValues = (prev || [])
        .map((option: T) => {
          return this.getValue(option);
        })
        .join(',');
    }

    const newValues = (this.values || [])
      .map((option: T) => {
        return option.arbitrary || this.getValue(option);
      })
      .join(',');

    return prevValues !== newValues;
  }

  public setSelectedValue(value: string) {
    if (this.staticOptions.length > 0) {
      const existing = this.staticOptions.find((option) => {
        return this.getValue(option) === value;
      });

      if (existing) {
        this.setValues([existing]);
      }
    } else {
      this.checkSelectedOption();
    }
  }

  private updateInputs(): void {
    for (let ele = null; (ele = this.hiddenInputs.pop()); ) {
      ele.remove();
    }

    if (this.values.length === 0) {
      this.value = null;
    } else {
      const name = this.getAttribute('name');

      if (name) {
        if (!this.isMultiMode && this.values.length === 1) {
          this.selection = this.values[0];
          this.value = this.serializeValue(this.values[0]);

          // Ensure FormElement internals are updated
          if (this.internals) {
            this.internals.setFormValue(this.value);
          }
        } else {
          if (this.inputRoot.parentElement) {
            this.values.forEach((value) => {
              const ele = document.createElement('input');
              ele.setAttribute('type', 'hidden');
              ele.setAttribute('name', name);
              ele.setAttribute('value', this.serializeValue(value));
              this.hiddenInputs.push(ele);
              this.inputRoot.parentElement.appendChild(ele);
            });
          }
        }
      }
    }
  }

  private setSelectedOption(option: any) {
    if (this.isMultiMode) {
      this.addValue(option);
    } else {
      this.setValues([option]);
    }

    if (!this.isMultiMode || !this.searchable) {
      this.blur();
      this.focused = false;
    }

    this.visibleOptions = [];
    this.attemptedOpen = false;
    this.input = '';
    this.next = null;
    this.complete = true;
    this.selectedIndex = -1;
  }

  private isPastFetchThreshold() {
    return (
      (this.visibleOptions.length > 0 || this.next) &&
      !this.complete &&
      (this.cursorIndex || 0) > this.visibleOptions.length - LOOK_AHEAD
    );
  }

  public handleOptionSelection(event: CustomEvent) {
    if (
      this.isMultiMode &&
      this.maxItems > 0 &&
      this.values.length >= this.maxItems
    ) {
      this.infoText = this.maxItemsText;
      return;
    } else {
      this.infoText = '';
    }

    const selected = event.detail.selected;

    // check if we should post it
    if (selected.arbitrary && this.allowCreate && this.endpoint) {
      this.resolving = true;
      postJSON(this.endpoint, selected).then((response) => {
        if (response.status >= 200 && response.status < 300) {
          this.setSelectedOption(response.json);
          this.lruCache = lru(20, 60000);
          this.errors = [];
        } else {
          this.setSelectedOption(selected);
          setTimeout(() => {
            this.errors = [
              'There was an error creating "' +
                this.getNameInternal(selected) +
                '"'
            ];
          }, 0);
          this.blur();
        }
        this.resolving = false;
      });
    } else {
      this.setSelectedOption(selected);
      this.errors = [];
    }
  }

  private handleExpressionSelection(evt: CustomEvent) {
    const option = evt.detail.selected as CompletionOption;
    const tabbed = evt.detail.tabbed;

    const ele = this.shadowRoot.querySelector('.searchbox') as HTMLInputElement;
    const textBefore = this.input;
    updateInputElementWithCompletion(this.query, ele, option);

    this.query = '';
    this.completionOptions = [];

    // If the completion didn't change the text, just hide the popup
    if (this.input === textBefore) {
      return;
    }

    if (tabbed) {
      this.fetchExpressions();
    } else if (this.emails || this.tags) {
      // In emails/tags mode, just complete the text — user presses Enter again to add
      this.fetchExpressions();
    } else if (this.input.indexOf('(') === -1) {
      this.addInputAsValue();
    }
  }

  protected getNameInternal: (option: T) => string = (option: T) => {
    return this.getName
      ? this.getName(option)
      : option[this.nameKey || 'name'] || '';
  };

  private getOptionsDefault(response: WebResponse): any[] {
    return response.json['results'];
  }

  private isCompleteDefault(
    newestOptions: any[],
    response: WebResponse
  ): boolean {
    const json = response.json;
    return !json['more'] && !json['next'];
  }

  public handleRemoveSelection(selectionToRemove: any): void {
    this.removeValue(selectionToRemove);
    this.visibleOptions = [];
    this.errors = [];

    // if we allow create, double check our values
    if (this.allowCreate) {
      const arbitrary = this.values.find((v) => v.arbitrary);
      if (arbitrary) {
        setTimeout(() => {
          this.errors = [
            'There was an error creating "' +
              this.getNameInternal(arbitrary) +
              '"'
          ];
        }, 0);
      }
    }
  }

  private createArbitraryOptionDefault(input: string, _options: any[]): any {
    if (this.expressions && input && this.isValidExpression(input)) {
      return { name: input, value: input, expression: true };
    }
    if (this.emails && input && this.isValidEmail(input)) {
      return { name: input, value: input };
    }
    if (this.tags && input) {
      return { name: input, value: input };
    }
    return null;
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private isDuplicateValue(input: string): boolean {
    const val = input.trim().toLowerCase();
    return this.values.some(
      (v: any) => (v.value || v.name || '').toLowerCase() === val
    );
  }

  /**
   * Resolves the design-system pill variant for a chip.
   *
   * Resolution order, most-specific to least:
   *   1. option.type        — set by the data (Omnibox-style mixed types)
   *   2. this.pillType      — explicit override from the consumer
   *   3. tags mode          — keyword (mono) chips
   *   4. endpoint inference — see ENDPOINT_PILL_TYPES
   *   5. fallback           — neutral
   *
   * Add new endpoint mappings to ENDPOINT_PILL_TYPES rather than
   * branching here, so the rule stays declarative.
   */
  protected getPillType(option: any): string {
    // option.type wins, but only if it names a pill variant. Domain
    // codes (Flow.flow_type, etc.) reuse the same field name and must
    // fall through to endpoint inference rather than become a class.
    if (option && option.type && PILL_TYPES.has(option.type)) {
      return option.type;
    }
    if (this.pillType) {
      return this.pillType;
    }
    if (this.tags) {
      return 'keyword';
    }
    if (this.endpoint) {
      for (const m of ENDPOINT_PILL_TYPES) {
        if (m.pattern.test(this.endpoint)) {
          return m.type;
        }
      }
    }
    return 'neutral';
  }

  /**
   * Whether the current input text would be accepted as a value on Enter.
   * Used for both grey text styling and Enter key gating.
   */
  private isAcceptableInput(input: string): boolean {
    if (!input || this.isDuplicateValue(input)) return false;
    const isExpression = this.expressions && input.trimStart().startsWith('@');
    if (isExpression) {
      return this.isValidExpression(input);
    }
    if (this.emails) {
      return this.isValidEmail(input.trim());
    }
    if (this.tags) {
      return input.trim().length > 0;
    }
    if (this.expressions) {
      return false;
    }
    return true;
  }

  private looksLikeExpression(input: string): boolean {
    return /^@[a-zA-Z_(]/.test(input.trim());
  }

  private isValidExpression(input: string): boolean {
    if (!this.looksLikeExpression(input)) return false;
    const parser =
      this.expressions === 'session' ? sessionParser : messageParser;
    const expressions = parser.findExpressions(input.trim());
    if (expressions.length === 0) return false;
    // Identifier expressions (e.g. @contact.email) are always valid.
    // Parenthesized expressions (e.g. @(upper(...))) must have balanced parens.
    return expressions.every(
      (expr) => !expr.text.startsWith('@(') || expr.closed
    );
  }

  /** Whether this select uses a contenteditable div for expression highlighting. */
  private get useExpressionInput(): boolean {
    return !!(this.expressions && this.searchable);
  }

  private expressionInputPatchedElement: HTMLElement = null;

  /**
   * Patches a contenteditable div to behave like an HTMLInputElement,
   * providing .value, .selectionStart, .selectionEnd, and .setSelectionRange().
   */
  private patchEditableAsInput(div: HTMLElement): void {
    if (this.expressionInputPatchedElement === div) return;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    const anyDiv = div as any;

    Object.defineProperty(anyDiv, 'value', {
      get() {
        return getTextFromEditableDiv(div);
      },
      set(val: string) {
        host.renderExpressionHighlight(div, val);
      },
      configurable: true
    });

    Object.defineProperty(anyDiv, 'selectionStart', {
      get() {
        return getCaretOffset(div);
      },
      configurable: true
    });

    Object.defineProperty(anyDiv, 'selectionEnd', {
      get() {
        return getCaretEndOffset(div);
      },
      configurable: true
    });

    anyDiv.setSelectionRange = (start: number, end: number) => {
      setCaretRange(div, start, end);
    };

    this.expressionInputPatchedElement = div;
  }

  /**
   * Renders highlighted expression tokens into a contenteditable div.
   * Does NOT restore the caret — caller is responsible for that.
   */
  private renderExpressionHighlight(div: HTMLElement, text: string): void {
    div.textContent = '';

    // Only tokenize/highlight when input starts with @ (expression)
    // and is not a duplicate of an existing value.
    // Mid-string @ (e.g. email addresses) should render as plain text.
    if (
      text &&
      text.trimStart().startsWith('@') &&
      !this.isDuplicateValue(text)
    ) {
      const parser =
        this.expressions === 'session' ? sessionParser : messageParser;
      const tokens = tokenize(text, parser);

      for (const token of tokens) {
        const cls = getTokenClass(token);
        const isMono = EXPRESSION_TOKENS.has(token.type);

        if (token.text.length > 0) {
          const span = document.createElement('span');
          span.textContent = token.text;
          span.className = isMono ? `${cls} tok-mono` : cls;
          div.appendChild(span);
        }
      }
    } else if (text) {
      // Duplicate expressions still get monospace font, just no syntax colors
      if (text.trimStart().startsWith('@')) {
        const span = document.createElement('span');
        span.textContent = text;
        span.className = 'tok-mono';
        div.appendChild(span);
      } else {
        div.appendChild(document.createTextNode(text));
      }
    }

    // Ensure there's at least an empty text node for cursor placement
    if (!text) {
      div.appendChild(document.createTextNode(''));
    }
  }

  // Helper method to determine if this select should behave as multi-select
  // Returns true if multi is explicitly set OR if emails mode is enabled
  private get isMultiMode(): boolean {
    return this.multi || this.emails;
  }

  public open(): void {
    (
      this.shadowRoot.querySelector('.select-container') as HTMLDivElement
    ).click();
  }

  public isOpen(): boolean {
    return (
      this.visibleOptions.length > 0 || (this.attemptedOpen && this.focused)
    );
  }

  public setOptions(options: any[]): void {
    this.staticOptions = options;
  }

  private setVisibleOptions(options: any[]) {
    // if we have an exclusion filter apply it
    options = options.filter((option) => {
      // exclude unnamed
      if (!this.getNameInternal(option)) {
        return false;
      }

      if (this.shouldExclude) {
        return !this.shouldExclude(option);
      }
      return true;
    });

    if (this.input) {
      // if we are searching locally, filter for the query
      if (this.searchable && !this.queryParam) {
        const q = this.input.trim().toLowerCase();
        options = options.filter((option: any) => this.isMatch(option, q));
      }

      const arbitraryOption: any = this.createArbitraryOption(
        this.input,
        options
      );

      if (arbitraryOption) {
        // set our arbitrary flag so we never have more than one
        arbitraryOption.arbitrary = true;

        // make sure our id is not already present
        const exists = options.find(
          (option: any) =>
            this.getValue(option) === this.getValue(arbitraryOption)
        );

        if (!exists) {
          if (options.length > 0) {
            if (options[0].arbitrary) {
              options[0] = arbitraryOption;
            } else {
              options.unshift(arbitraryOption);
            }
          } else {
            options.unshift(arbitraryOption);
          }
        }
      }
    }

    // filter out any options already selected by id
    // TODO: should maybe be doing a deep equals here with option to optimize
    if (this.values.length > 0) {
      if (this.isMultiMode) {
        options = options.filter(
          (option) =>
            !this.values.find(
              (selected) => this.getValue(selected) === this.getValue(option)
            )
        );
      } else {
        // if no search, single select should set our cursor to the selected item
        if (!this.input) {
          this.cursorIndex = options.findIndex(
            (option) => this.getValue(option) === this.getValue(this.values[0])
          );
        } else {
          this.cursorIndex = 0;
        }
        this.requestUpdate('cursorIndex');
      }
    }

    if (
      this.isMultiMode &&
      this.maxItems > 0 &&
      this.values.length >= this.maxItems
    ) {
      options = [];
      this.infoText = this.maxItemsText;
    }

    // finally sort
    if (this.sortFunction) {
      options.sort(this.sortFunction);
    }

    this.visibleOptions = options;

    this.fireCustomEvent(CustomEventType.ContentChanged, {
      options: this.visibleOptions
    });
  }

  public fetchExpressions() {
    const store: Store = document.querySelector('temba-store');
    if (this.expressions && store) {
      const ele = this.shadowRoot.querySelector(
        '.searchbox'
      ) as HTMLInputElement;

      const result = executeCompletionQuery(
        ele,
        this.expressions === 'session'
      );
      this.query = result.query;
      this.completionOptions = result.options;
      this.visibleOptions = [];
      this.anchorPosition = result.anchorPosition;
      this.fireCustomEvent(CustomEventType.FetchComplete);
      return;
    }
  }

  // TODO: do we still need to support page numbers?
  public fetchOptions(query: string, page = 0, next = null) {
    this.completionOptions = [];
    if (!this.fetching) {
      this.fetching = true;

      const options: any = [...this.staticOptions];
      const q = (query || '').trim().toLowerCase();

      if (this.tags && q) {
        if (
          !options.find(
            (option: any) =>
              this.getValue(option) && this.getValue(option).toLowerCase() === q
          )
        ) {
          options.splice(0, 0, { name: query, value: query });
        }
      }

      if (this.emails && q) {
        if (
          this.isValidEmail(q) &&
          !options.find(
            (option: any) =>
              this.getValue(option) && this.getValue(option).toLowerCase() === q
          )
        ) {
          options.splice(0, 0, { name: query, value: query });
        }
      }

      if (this.endpoint) {
        let url = this.endpoint;
        if (next) {
          url = next;
        } else {
          if (query && this.queryParam) {
            if (url.indexOf('?') > -1) {
              url += '&';
            } else {
              url += '?';
            }

            url += this.queryParam + '=' + encodeURIComponent(query);
          }

          if (page) {
            if (url.indexOf('?') > -1) {
              url += '&';
            } else {
              url += '?';
            }
            url += 'page=' + page;
          }
        }

        const cache = this.lruCache.get(url);
        if (this.cache && !this.tags && !this.emails && cache) {
          if (page === 0 && !this.next) {
            this.cursorIndex = 0;
            this.setVisibleOptions([...options, ...cache.options]);
          } else {
            this.setVisibleOptions([...this.visibleOptions, ...cache.options]);
          }

          this.complete = cache.complete;
          this.next = cache.next;
          this.fetching = false;
          return;
        }

        // if we are searchable, but doing it locally, fetch all the options
        if (this.searchable && !this.queryParam) {
          fetchResults(url).then((results: any) => {
            results = this.prepareOptions(results);

            if (this.cache && !this.tags && !this.emails) {
              this.lruCache.set(url, {
                options: results,
                complete: true,
                next: null
              });

              this.complete = true;
              this.next = null;
              this.setVisibleOptions([...options, ...results]);
              this.fetching = false;
            }
          });
        } else {
          getUrl(url)
            .then((response: WebResponse) => {
              let results = this.getOptions(response).filter((option: any) => {
                return this.isMatch(option, q);
              });
              results = this.prepareOptions(results);

              this.next = null;
              const json = response.json;
              if (json['next']) {
                this.next = json['next'];
              }

              if (page === 0 && !this.next) {
                this.cursorIndex = 0;
                this.setVisibleOptions([...options, ...results]);
                this.query = query;
                this.complete = this.isComplete(this.visibleOptions, response);
              } else {
                if (results.length > 0) {
                  this.setVisibleOptions([...this.visibleOptions, ...results]);
                }
                this.complete = this.isComplete(results, response);
              }

              if (this.cache && !this.tags && !this.emails) {
                this.lruCache.set(url, {
                  options: results,
                  complete: this.complete,
                  next: this.next
                });
              }

              this.fetching = false;
              this.page = page;
            })
            .catch((reason: any) => {
              // cancelled
              this.fetching = false;
              console.error(reason);
            });
        }
      } else {
        this.fetching = false;
        this.setVisibleOptions(options);
      }
    }
  }

  private handleFocus(): void {
    if (!this.focused && this.visibleOptions.length === 0) {
      this.focused = true;
    }
  }

  // Set true while a pointer is held down inside our temba-options.
  // Native scrollbar drags shift focus off the search input, firing
  // blur, which would otherwise tear down visibleOptions. While this
  // flag is on we keep the dropdown open and re-focus the input.
  private pointerInsideOptions = false;

  // The active pointerup/pointercancel release handler, if any. We
  // stash it on the instance so disconnectedCallback can detach it as
  // a safety net — without that, a component removed mid-drag (or
  // with the pointer dragged into an ancestor iframe so the release
  // events never reach `window`) would leak the listener and pin
  // `this` for the lifetime of the page.
  private pointerReleaseHandler: ((e: Event) => void) | null = null;

  private detachPointerReleaseHandler() {
    if (!this.pointerReleaseHandler) return;
    window.removeEventListener('pointerup', this.pointerReleaseHandler, true);
    window.removeEventListener(
      'pointercancel',
      this.pointerReleaseHandler,
      true
    );
    this.pointerReleaseHandler = null;
  }

  private handleOptionsPointerDown = () => {
    this.pointerInsideOptions = true;
    // Replace any in-flight handler so we never accumulate listeners.
    this.detachPointerReleaseHandler();
    const release = () => {
      // small delay so a focus-shift triggered by the click lands
      // before we re-allow blur-driven closure.
      setTimeout(() => {
        this.pointerInsideOptions = false;
      }, 0);
      this.detachPointerReleaseHandler();
    };
    this.pointerReleaseHandler = release;
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
  };

  private handleBlur() {
    // defer to avoid scheduling an update during the current cycle;
    // blur can fire synchronously during the lit-html render when DOM changes
    setTimeout(() => {
      if (this.pointerInsideOptions) {
        // user is interacting with the options popup (e.g. dragging
        // its scrollbar) — keep the dropdown open and re-focus the input.
        const input = this.shadowRoot?.querySelector(
          '.searchbox'
        ) as HTMLElement | null;
        input?.focus();
        return;
      }

      this.focused = false;
      this.attemptedOpen = false;
      if (this.visibleOptions.length > 0) {
        this.input = '';
        this.next = null;
        this.complete = true;
        this.visibleOptions = [];
        this.cursorIndex = 0;
      }
      if (this.emails || this.tags) {
        this.input = '';
        this.completionOptions = [];
      }

      if (
        this.isMultiMode &&
        this.maxItems > 0 &&
        this.values.length >= this.maxItems
      ) {
        this.infoText = '';
      }
    }, 0);
  }

  private handleClick(): void {
    this.selectedIndex = -1;
    this.requestUpdate('input');
  }

  private addInputAsValue() {
    const ele = this.shadowRoot.querySelector('.searchbox') as HTMLInputElement;
    const expression = {
      name: ele.value,
      value: ele.value,
      expression: true
    };

    if (this.isMultiMode) {
      if (
        !this.values.find((option: T) => {
          return (
            option.expression &&
            option.value &&
            expression.value &&
            option.value.toLowerCase().trim() ==
              expression.value.toLowerCase().trim()
          );
        })
      ) {
        this.addValue(expression);
      }
    } else {
      this.setValues([expression]);
    }

    this.input = '';
    if (!this.isMultiMode) {
      this.blur();
    }
  }

  private handleBeforeInput(evt: InputEvent) {
    // Android virtual keyboards often don't fire keydown with key='Enter'.
    // Instead they fire beforeinput with inputType 'insertLineBreak' or
    // 'insertParagraph'. Prevent those from inserting newlines in the
    // contenteditable expression input, and then handle acceptable input
    // the same as Enter for tags/emails/expressions.
    if (
      evt.inputType === 'insertLineBreak' ||
      evt.inputType === 'insertParagraph'
    ) {
      if (this.useExpressionInput) {
        evt.preventDefault();
      }

      if (
        this.completionOptions.length === 0 &&
        (this.emails || this.tags || this.expressions) &&
        this.isAcceptableInput(this.input)
      ) {
        evt.preventDefault();
        this.addInputAsValue();
      }
    }
  }

  private handleKeyDown(evt: KeyboardEvent) {
    // Prevent Enter from inserting newlines in contenteditable
    if (evt.key === 'Enter' && this.useExpressionInput) {
      evt.preventDefault();
    }

    // In email mode, treat comma like Enter (but not inside expressions)
    if (
      evt.key === ',' &&
      this.emails &&
      !this.looksLikeExpression(this.input)
    ) {
      evt.preventDefault();
      if (this.isAcceptableInput(this.input)) {
        this.addInputAsValue();
      }
      return;
    }

    // if Enter is pressed with acceptable input (email, tag, or expression), add it
    if (
      evt.key === 'Enter' &&
      this.completionOptions.length === 0 &&
      (this.emails || this.tags || this.expressions) &&
      this.isAcceptableInput(this.input)
    ) {
      evt.preventDefault();
      this.addInputAsValue();
      return;
    }

    // see if we should open our options on a key event
    if (
      evt.key === 'Enter' ||
      evt.key === 'ArrowDown' ||
      (evt.key === 'n' && evt.ctrlKey)
    ) {
      if (
        this.visibleOptions.length === 0 &&
        this.completionOptions.length === 0 &&
        !this.input
      ) {
        this.attemptedOpen = true;
        this.requestUpdate('input');
        return;
      }
    }

    // focus our last item on delete
    if (this.isMultiMode && evt.key === 'Backspace' && !this.input) {
      if (this.visibleOptions.length > 0) {
        this.visibleOptions = [];
        return;
      }

      if (this.selectedIndex === -1) {
        // First backspace: highlight the last item
        this.selectedIndex = this.values.length - 1;
        this.visibleOptions = [];
      } else {
        // Second backspace: delete the highlighted item
        this.popValue();
        this.selectedIndex = -1;
      }
    } else {
      this.selectedIndex = -1;
    }
  }

  public getStaticOptions() {
    return this.staticOptions;
  }

  private handleInput(evt: Event) {
    const ele = evt.currentTarget as HTMLElement;

    if (this.useExpressionInput) {
      // Extract plain text and caret before modifying DOM
      const text = getTextFromEditableDiv(ele);
      const caretPos = getCaretOffset(ele);
      this.input = text;
      // Re-render with highlighting and restore caret synchronously
      this.renderExpressionHighlight(ele, text);
      try {
        setCaretRange(ele, caretPos, caretPos);
      } catch {
        // Caret restore may fail if text is empty
      }
    } else {
      this.input = (ele as HTMLInputElement).value;
    }
  }

  private handleCancel() {
    this.visibleOptions = [];
    this.attemptedOpen = false;
  }

  private handleCursorChanged(event: CustomEvent) {
    this.cursorIndex = event.detail.index;
  }

  /** Returns the searchbox element, whether it's an input or contenteditable div. */
  private getSearchboxElement(): HTMLElement | null {
    return this.shadowRoot.querySelector('.searchbox');
  }

  /** Checks if the event target is the expression contenteditable input. */
  private isExpressionInputTarget(target: EventTarget): boolean {
    return (
      target instanceof HTMLElement &&
      target.classList.contains('expression-input')
    );
  }

  private handleContainerClick(event: MouseEvent) {
    if (this.disabled) {
      // prevent opening dropdown right after drag-and-drop
      event.stopPropagation();
      event.preventDefault();
      return;
    }

    this.focused = true;
    const targetTag = (event.target as any).tagName;
    if (targetTag !== 'INPUT' && !this.isExpressionInputTarget(event.target)) {
      const input = this.getSearchboxElement();
      if (input) {
        input.click();
        input.focus();
        return;
      }

      // Check if dropdown is currently open (either with options or showing "No options")
      if (this.isOpen()) {
        this.visibleOptions = [];
        this.attemptedOpen = false;
      } else {
        this.attemptedOpen = true;
        this.requestUpdate('input');
        // Also trigger an immediate update to show empty dropdown
        this.requestUpdate();
      }
    }
  }

  public getEventHandlers(): EventHandler[] {
    return [
      { event: CustomEventType.Canceled, method: this.handleCancel },
      {
        event: CustomEventType.CursorChanged,
        method: this.handleCursorChanged
      },
      { event: 'blur', method: this.handleBlur },
      { event: 'focus', method: this.handleFocus }
    ];
  }

  private handleArrowClick(event: MouseEvent): void {
    if (this.disabled) {
      return;
    }
    if (this.isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      this.blur();
    }
  }

  private renderHighlightedName(option: T): TemplateResult | string {
    const name = this.getNameInternal(option);
    if (this.expressions && name.startsWith('@')) {
      const parser =
        this.expressions === 'session' ? sessionParser : messageParser;
      const tokens = tokenize(name, parser);
      return html`${tokens.map((token) => {
        const cls = getTokenClass(token);
        const isMono = EXPRESSION_TOKENS.has(token.type);
        return html`<span class="${isMono ? `${cls} tok-mono` : cls}"
          >${token.text}</span
        >`;
      })}`;
    }
    return name;
  }

  public renderOptionDefault(option: T): TemplateResult {
    if (!option) {
      return null;
    }

    // Icon resolution, most-specific to least:
    //   1. option.icon — explicit per-row override
    //   2. option.type's default icon — when the data layer marks the
    //      row's pill variant (Omnibox-style mixed types)
    //   3. the widget's resolved pill type — endpoint inference for
    //      sources that return plain rows (e.g. /api/v2/groups.json)
    // The fall-through to (3) is what lets `Add to Group` / `Remove
    // from Group` chips show the group icon even though the API rows
    // don't carry a `type` field.
    const optType = (option as any).type;
    const icon =
      (option as any).icon ||
      (optType && PILL_TYPE_ICONS[optType]) ||
      PILL_TYPE_ICONS[this.getPillType(option)] ||
      undefined;
    // Inline flex on the wrapper itself so layout works in both shadow
    // roots — Select's (chip rendering) and temba-options' (dropdown
    // rendering). Otherwise the dropdown would fall back to inline flow
    // and stack the icon above the name.
    return html`
      <div
        class="option-name"
        style="display:flex; align-items:center; gap:6px;"
      >
        ${icon ? html`<temba-icon name="${icon}"></temba-icon>` : null}<span
          >${this.renderHighlightedName(option)}</span
        >
      </div>
    `;
  }

  public renderSelectedItemDefault(option: T): TemplateResult {
    const renderFn = this.renderOption || this.renderOptionDefault;
    return renderFn(option, true);
  }

  public serializeValue(value: any): string {
    // static options just use their value
    if (
      !this.jsonValue &&
      (this.staticOptions.length > 0 || this.isMultiMode)
    ) {
      return value.value;
    }

    return super.serializeValue(value);
  }

  public setSelection(value: string): void {
    for (const option of this.staticOptions) {
      if (this.getValue(option) === value) {
        if (this.values.length === 0 || this.values[0].value != '' + value) {
          this.setValues([option]);
        }
        return;
      }
    }
  }

  private handleClear(evt: MouseEvent): void {
    evt.preventDefault();
    evt.stopPropagation();
    this.setValues([]);
    if (this.visibleOptions.length > 0) {
      this.visibleOptions = [];
      this.requestUpdate();
    }

    this.fireCustomEvent(CustomEventType.Selection, {
      selected: null
    });
  }

  public setValues(values: any[]) {
    const oldValues = this.values;
    this.values.splice(0, this.values.length, ...values);
    this.requestUpdate('values', oldValues);
    this.updateInputs();
    this.fireEvent('change');
  }

  public addValue(value: any) {
    const oldValues = [...this.values];
    this.values.push(value);
    this.requestUpdate('values', oldValues);
    this.updateInputs();
    this.fireEvent('change');
  }

  public removeValue(valueToRemove: any) {
    const oldValues = [...this.values];
    const idx = this.values.indexOf(valueToRemove);

    if (idx > -1) {
      this.values.splice(idx, 1);

      // Also remove the 'selected' attribute from the corresponding temba-option element
      const valueToMatch = this.getValue(valueToRemove);
      for (const child of this.children) {
        if (child.tagName === 'TEMBA-OPTION') {
          const childValue = child.getAttribute('value');
          if (childValue === valueToMatch) {
            child.removeAttribute('selected');
            break;
          }
        }
      }
    }
    this.requestUpdate('values', oldValues);
    this.infoText = '';
    this.updateInputs();
    this.fireEvent('change');
  }

  public popValue() {
    const oldValues = [...this.values];
    this.values.pop();
    this.requestUpdate('values', oldValues);
    this.infoText = '';
    this.updateInputs();
    this.fireEvent('change');
  }

  public clear() {
    const oldValues = this.values;
    this.values.splice(0, this.values.length);
    this.requestUpdate('values', oldValues);
    this.updateInputs();
    this.fireEvent('change');
  }

  private shouldShowEmptyMessage(): boolean {
    return (
      this.attemptedOpen &&
      this.focused &&
      this.visibleOptions.length === 0 &&
      !this.input &&
      this.staticOptions.length === 0 &&
      !this.endpoint
    );
  }

  private handleOrderChanged(event: CustomEvent): void {
    const detail = event.detail;

    // Handle new swap-based format
    if (detail.swap && Array.isArray(detail.swap) && detail.swap.length === 2) {
      const [fromIdx, toIdx] = detail.swap;

      // Only reorder if the indexes are different and valid
      if (
        fromIdx !== toIdx &&
        fromIdx >= 0 &&
        toIdx >= 0 &&
        fromIdx < this.values.length &&
        toIdx < this.values.length
      ) {
        const oldValues = [...this.values];
        // Move the item using splice operations directly on this.values
        const movedItem = this.values.splice(fromIdx, 1)[0];
        this.values.splice(toIdx, 0, movedItem);
        this.requestUpdate('values', oldValues);
        this.updateInputs();
        this.fireEvent('change');
      }
    }
  }

  protected renderWidget(): TemplateResult {
    const placeholder = this.values.length === 0 ? this.placeholder : '';

    // Single unified placeholder - shows when empty and (not focused OR not searchable)
    const shouldShowPlaceholder =
      this.values.length === 0 && (!this.focused || !this.searchable);
    const placeholderElement = shouldShowPlaceholder
      ? html`<div class="placeholder">${placeholder}</div>`
      : null;

    const clear =
      this.clearable && this.values.length > 0 && !this.isMultiMode
        ? html`<temba-icon
            name="${Icon.select_clear}"
            size="1.1"
            class="clear-button"
            style="margin-right:6px"
            @click=${this.handleClear}
          />`
        : null;

    const classes = getClasses({
      multi: this.isMultiMode,
      single: !this.isMultiMode,
      searchable: this.searchable,
      empty: this.values.length === 0,
      options: this.visibleOptions.length > 0,
      focused: this.focused,
      'search-input': this.input.length > 0,
      'no-search-input': this.input.length === 0,
      [this.flavor]: this.flavor !== null,
      disabled: this.disabled
    });

    const anchorStyles = this.anchorPosition
      ? {
          top: `${this.anchorPosition.top || 0}px`,
          left: `${this.anchorPosition.left - 10}px`
        }
      : {};

    // Show grey text when input would not be accepted
    const inputGrey =
      this.input &&
      (this.emails || this.tags) &&
      !this.isAcceptableInput(this.input);

    const inputStyles: StyleInfo = {
      ...this.inputStyle,
      ...(inputGrey ? { color: '#ccc' } : {})
    };

    const showEnterHint =
      (this.emails || this.tags) &&
      this.focused &&
      this.input &&
      this.isAcceptableInput(this.input);

    const input = this.searchable
      ? html`
          <div
            class="input-wrapper"
            style="${this.focused ? 'display:flex;' : ''}"
          >
            ${this.useExpressionInput
              ? html`<div
                  class="searchbox expression-input"
                  contenteditable="true"
                  spellcheck="false"
                  style=${styleMap(inputStyles)}
                  @input=${this.handleInput}
                  @beforeinput=${this.handleBeforeInput}
                  @keydown=${this.handleKeyDown}
                  @click=${this.handleClick}
                ></div>`
              : html`<input
                  class="searchbox"
                  style=${styleMap(inputStyles)}
                  @input=${this.handleInput}
                  @beforeinput=${this.handleBeforeInput}
                  @keydown=${this.handleKeyDown}
                  @click=${this.handleClick}
                  type="text"
                  .value=${this.input}
                />`}
            <div id="anchor" style=${styleMap(anchorStyles)}></div>
          </div>
        `
      : null;

    const renderRemove = (selected: any) => html`
      <div
        class="remove-item"
        @click=${(evt: MouseEvent) => {
          evt.preventDefault();
          evt.stopPropagation();
          this.handleRemoveSelection(selected);
        }}
      >
        <temba-icon name="${Icon.delete_small}" size="1"></temba-icon>
      </div>
    `;

    // pill-{type} colors are only applied in multi mode (chip rendering).
    // In single mode the selected value sits inside the input box and
    // shouldn't have a fill — otherwise the variant bg bleeds across
    // the whole input row.
    const chipClass = (option: any, index: number, sortable: boolean) => {
      const variant = this.isMultiMode
        ? `pill-${this.getPillType(option)}`
        : '';
      return `${sortable ? 'sortable ' : ''}selected-item ${variant} ${
        index === this.selectedIndex ? 'focused' : ''
      } ${this.draggingId === `selected-${index}` ? 'dragging' : ''}`;
    };

    const multiItems =
      this.isMultiMode &&
      (this.emails || this.tags || this.values.length > 1) &&
      (this.values.length > 0 || this.focused)
        ? html`
            <temba-sortable-list
              horizontal
              gap="4px"
              .prepareGhost=${(ghost: HTMLElement) => {
                // The chip rendered width can be a few px wider than
                // its actual content (subpixel rounding, max-width
                // cap, etc.). When SortableList pins the ghost root
                // to `rect.width`, that extra shows up as a stray
                // gap on the right of the dragged chip. Size the
                // ghost to its content instead so it looks identical
                // to the source chip the user grabbed.
                ghost.style.width = 'max-content';
                ghost.style.minWidth = '0';
              }}
              @temba-order-changed=${this.handleOrderChanged}
            >
              ${this.values.map(
                (selected: any, index: number) => html`
                  <div
                    class=${chipClass(selected, index, true)}
                    id="selected-${index}"
                  >
                    ${renderRemove(selected)}
                    ${this.renderSelectedItem(selected)}
                  </div>
                `
              )}
              ${input}
            </temba-sortable-list>
          `
        : null;

    const singleItems = !multiItems
      ? html`${this.values.map(
          (selected: any, index: number) => html`
            <div class=${chipClass(selected, index, false)}>
              ${this.isMultiMode ? renderRemove(selected) : null}
              ${!this.input || this.isMultiMode
                ? this.renderSelectedItem(selected)
                : null}
            </div>
          `
        )}
        ${this.isMultiMode && this.searchable && this.focused ? input : null}`
      : null;

    const items = html`${!this.isMultiMode && !this.resolving ? input : null}
    ${multiItems}${singleItems} ${placeholderElement}`;

    return html`
        <slot></slot>
        <div class="wrapper-bg">
        
        <div
          tabindex="0"
          class="select-container ${classes}"
          @click=${this.handleContainerClick}
        > 
          <div class="left-side">
          <slot name="prefix"></slot>
            <div class="selected">
              ${
                this.resolving
                  ? html`<temba-loading
                      style="margin-left:1em"
                    ></temba-loading>`
                  : items
              }
              
            </div>

          </div>

          ${clear}

          <slot name="right">${
            this.fetching
              ? html`<temba-loading
                  style="position:absolute;background:rgba(255,255,255,0.7);padding:2px;border-radius:var(--curvature);right:25px"
                ></temba-loading>`
              : null
          }</slot>
          ${
            !this.tags &&
            !this.emails &&
            !(this.clearable && this.values.length > 0 && !this.isMultiMode)
              ? html`<div
                  class="right-side arrow"
                  style="display:block;margin-right:5px"
                  @click=${this.handleArrowClick}
                >
                  <temba-icon
                    size="1.5"
                    name="${Icon.select_open}"
                    class="select-open ${this.visibleOptions.length > 0
                      ? 'open'
                      : ''}"
                  ></temba-icon>
                </div>`
              : null
          }
          </div>

        <div class="info-text ${!this.infoText ? 'hide' : ''} ${
          this.focused ? 'focused' : ''
        }">${this.infoText}</div></div></div>

    
    <temba-options
    @temba-selection=${this.handleOptionSelection}
    .cursorIndex=${this.cursorIndex}
    .renderOptionDetail=${this.renderOptionDetail}
    .renderOptionName=${this.renderOptionName}
    .renderOption=${this.renderOption || this.renderOptionDefault}
    .anchorTo=${this.allowAnchor ? this.anchorElement : null}
    .options=${this.visibleOptions}
    .spaceSelect=${this.spaceSelect}
    .nameKey=${this.nameKey}
    .getName=${this.getNameInternal}
    ?static-width=${this.optionWidth}
    .minWidth=${this.optionMinWidth || 0}
    ?anchor-right=${this.anchorRight}
    ?visible=${this.visibleOptions.length > 0 || this.shouldShowEmptyMessage()}
    ?showEmptyMessage=${this.shouldShowEmptyMessage()}
    ></temba-options>

    <temba-options
    @temba-selection=${this.handleExpressionSelection}
    @temba-canceled=${() => {}}
    .anchorTo=${this.allowAnchor ? this.anchorExpressions : null}
    .options=${this.completionOptions}
    .renderOption=${renderCompletionOption}
    ?visible=${this.completionOptions.length > 0}
    >
      ${
        this.currentFunction
          ? html`
              <div class="current-fn">
                ${renderCompletionOption(this.currentFunction, true)}
              </div>
            `
          : null
      }
      ${
        this.completionOptions.length > 0
          ? html`<div class="footer">
              ${msg('Tab to complete, enter to select')}
            </div>`
          : null
      }
    </temba-options>
    ${
      showEnterHint
        ? html`<div class="enter-hint">
            <span style="position:relative;top:3px">↵</span> ${msg('to add')}
          </div>`
        : null
    }
    `;
  }

  public render(): TemplateResult {
    return this.renderField();
  }
}
