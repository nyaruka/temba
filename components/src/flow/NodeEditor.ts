import { html, TemplateResult, css, PropertyValues } from 'lit';
import { msg, str } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { Node, NodeUI, Action, FlowDefinition } from '../store/flow-definition';
import {
  ValidationResult,
  NodeConfig,
  NODE_CONFIG,
  ACTION_CONFIG,
  FieldConfig,
  ActionConfig
} from './config';
import {
  LayoutItem,
  RowLayoutConfig,
  GroupLayoutConfig,
  AccordionLayoutConfig,
  ExtrasLayoutConfig,
  ExtrasSection,
  FormData,
  ACTION_GROUP_METADATA,
  SPLIT_GROUP_METADATA
} from './types';
import { CustomEventType } from '../interfaces';
import { ButtonType, Dialog } from '../layout/Dialog';
import { formatCount, generateUUID } from '../utils';
import {
  formatIssueMessage,
  resolveToLocalizationFormData,
  resolveFromLocalizationFormData
} from './utils';
import { getTranslatableCategoriesForNode } from './categoryLocalization';
import { collectReservedCategoryErrors } from './categoryUtils';
import { FieldRenderer } from '../form/FieldRenderer';
import { parseSentence } from './sentences';
import { getDefaultResultName } from './nodes/shared';
import { renderMarkdownInline } from '../markdown';
import {
  AppState,
  FlowInfo,
  FlowIssue,
  fromStore,
  zustand
} from '../store/AppState';
import { getLanguageName } from '../languages';

const isEmptyFormValue = (value: any): boolean =>
  value === null ||
  value === undefined ||
  value === false ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

// the empty value for a field, judged by the shape of its current value
const emptyFormValue = (value: any): any => {
  if (Array.isArray(value)) return [];
  if (typeof value === 'boolean') return false;
  if (typeof value === 'string') return '';
  return null;
};

export class NodeEditor extends RapidElement {
  static get styles() {
    return css`
      .node-editor-form {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 15px;
        min-width: 400px;

        --color-bubble-bg: rgba(var(--primary-rgb), 0.7);
        --color-bubble-border: rgba(0, 0, 0, 0.2);
        --color-bubble-text: #fff;
      }

      .form-field {
        display: flex;
        flex-direction: column;
      }

      .form-field label {
      }

      .field-errors {
        color: var(--color-error, tomato);
        font-size: 12px;
        margin-left: 5px;
        margin-top: 15px;
      }

      .issue-warning {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--color-error, tomato);
        font-size: 13px;
        cursor: pointer;
      }

      .issue-warning:hover .issue-text {
        text-decoration: underline;
      }

      .form-actions {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        margin-top: 20px;
      }

      .action-section {
        border: 1px solid #e0e0e0;
        border-radius: 4px;
        padding: 15px;
        margin: 10px 0;
      }

      .action-section h3 {
        margin: 0 0 10px 0;
        color: #333;
        font-size: 14px;
        font-weight: 600;
      }

      .router-section {
        border: 1px solid #e0e0e0;
        border-radius: 4px;
        padding: 15px;
        margin: 10px 0;
      }

      .router-section h3 {
        margin: 0 0 10px 0;
        color: #333;
        font-size: 14px;
        font-weight: 600;
      }

      .form-row {
        display: grid;
        gap: 1rem;
        align-items: center;
      }

      .form-row-wrapper {
        display: flex;
        flex-direction: column;
      }

      .form-row-label {
        margin-bottom: 5px;
        margin-left: 4px;
        display: block;
        font-weight: 400;
        font-size: var(--label-size);
        letter-spacing: 0.05em;
        line-height: normal;
        color: var(--color-label, #777);
      }

      .form-row-inline-label {
        font-size: 20px;
        font-weight: 300;
        color: #ccc;
        min-width: 20px;
        text-align: center;
        display: flex;
        align-items: center;
        justify-content: center;
        user-select: none;
      }

      .form-row-help {
        font-size: 12px;
        color: #666;
        margin-top: 6px;
      }

      .form-text {
        color: #666;
        font-size: 13px;
      }

      .form-group {
        border: 1px solid #e0e0e0;
        border-radius: 6px;
        overflow: hidden;
      }

      .form-group.no-border {
        border: none;
      }

      .form-group.no-border > .form-group-header {
        background: none;
        border-bottom: none;
        padding-left: 11px; /* 1px border + 10px padding to align with bordered groups */
      }

      .form-group.no-border > .form-group-header:hover {
        background: none;
      }

      .form-group.no-border > .form-group-content {
        padding-left: 0;
        padding-right: 0;
      }

      .form-group.has-errors {
        border-color: var(--color-error, tomato);
      }

      .form-group.has-bubble {
        border-width: 2px;
        border-color: rgba(var(--primary-rgb), 0.5);
      }

      .form-group-header {
        background: #f8f9fa;
        padding: 8px 10px;
        border-bottom: 1px solid #e0e0e0;

        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        user-select: none;
      }

      .form-group.has-bubble .form-group-header {
        background: rgba(var(--primary-rgb), 0.1);
      }

      .collapsed .form-group-header {
        border: none;
      }

      .form-group-header:hover {
        background: rgba(0, 0, 0, 0.05);
      }

      .form-group-header.collapsible:hover {
        background: #f1f3f4;
      }

      .form-group-info {
        flex: 1;
      }

      .form-group-title {
        font-weight: 500;
        color: var(--color-label, #777);
        font-size: 14px;
        display: flex;
        align-items: center;
      }

      .form-group-help {
        font-size: 12px;
        color: #666;
        margin-top: 2px;
      }

      .form-group-toggle {
        color: #666;
        transition: transform 0.3s ease;
        display: flex;
        align-items: center;
      }

      .form-group-toggle.collapsed {
        transform: rotate(-90deg);
      }

      .form-group-content {
        padding: var(--group-content-padding, 6px);
        display: flex;
        flex-direction: column;
        gap: 15px;
        overflow: hidden;
        transition: all 0.2s ease-in-out;

        opacity: 1;
      }

      .form-group-content.collapsed {
        max-height: 0;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        opacity: 0;
      }

      .group-toggle-icon {
        color: #666;
        transition:
          transform 0.3s ease,
          opacity 0.3s ease;
        cursor: pointer;
        transform: rotate(0deg);
        opacity: 1;
      }

      .group-toggle-icon.faded {
        opacity: 0;
      }

      .group-toggle-icon.expanded {
        transform: rotate(90deg);
      }

      .group-toggle-icon.collapsed {
        transform: rotate(0deg);
      }

      .group-toggle-icon:hover {
        color: #333;
      }

      .group-error-icon {
        color: var(--color-error, tomato);
        margin-right: 8px;
      }

      .group-count-bubble {
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 600;
        padding: 4px;
        min-width: 12px;
        min-height: 12px;
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        line-height: 0px;
        opacity: 1;
        transition: opacity 0.3s ease;
        background: var(--color-bubble-bg, #fff);
        border: 1px solid var(--color-bubble-border, #777);
        color: var(--color-bubble-text, #000);
      }

      .group-count-bubble.hidden {
        opacity: 0;
        pointer-events: none;
      }

      .group-checkmark-icon {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        opacity: 1;
        transition: opacity 0.3s ease;
        border-radius: 50%;
        color: var(--color-bubble-text, #000);
        background: var(--color-bubble-bg, #fff);
        border: 1px solid var(--color-bubble-border, #777);
        padding: 0.2em;
      }

      .group-checkmark-icon.hidden {
        opacity: 0;
        pointer-events: none;
      }

      .group-toggle-container {
        position: relative;
        display: flex;
        align-items: center;
      }

      /* Accordion styles are now in temba-accordion-section component */

      .gutter-fields {
        display: flex;
        flex-direction: column;
        gap: 10px;
        align-items: flex-start;
      }

      .gutter-fields .form-row {
        margin: 0;
      }

      .gutter-fields temba-checkbox {
        align-self: flex-start;
      }

      .gutter-fields temba-select {
        min-width: 150px;
      }

      .extras {
        display: flex;
        flex-direction: column;
        gap: 15px;
      }

      .extra-section {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .extra-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .extra-label {
        font-weight: var(--w-medium, 500);
        font-size: 12.5px;
        color: var(--color-label);
      }

      .extra-remove {
        display: flex;
        align-items: center;
        border: none;
        background: transparent;
        padding: 3px;
        border-radius: 6px;
        cursor: pointer;
        color: var(--text-3, #7b8593);
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      /* the remove button only appears while hovering its section (or
         focusing it), and always on devices that can't hover */
      .extra-section:hover .extra-remove,
      .extra-remove:focus-visible {
        opacity: 1;
      }

      @media (hover: none) {
        .extra-remove {
          opacity: 1;
        }
      }

      .extra-remove:hover {
        background: rgba(0, 0, 0, 0.05);
        color: var(--text-1, #1a1f26);
      }

      .extra-remove:focus-visible,
      .extra-chip:focus-visible {
        outline: none;
        box-shadow: var(--widget-box-shadow-focused);
      }

      .extra-items {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      /* a section that reads as one line, on its own strip with its × at the end */
      /* padded enough that a widget's focus ring stays inside the strip */
      .extra-line {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px 6px 14px;
        border-radius: 10px;
        background: var(--bg, #f6f7f9);
        --checkbox-hover-bg: rgba(0, 0, 0, 0.05);
      }

      /* neighboring strips sit closer together than other extras */
      .extra-section.sentence + .extra-section.sentence {
        margin-top: -9px;
      }

      /* inline flow rather than flex, so long translations wrap like text */
      .extra-sentence {
        flex-grow: 1;
        font-size: 13px;
        line-height: 32px;
        color: var(--text-2, #4d5664);
      }

      .extra-sentence b {
        font-weight: var(--w-medium, 500);
        color: var(--text-1, #1a1f26);
      }

      .extra-sentence .inline-field {
        display: inline-block;
        vertical-align: middle;
        margin: 0 2px;
        line-height: normal;
      }

      .extra-sentence .inline-text {
        width: 180px;
      }

      .extra-sentence .inline-select {
        width: 150px;
      }

      .extra-sentence .inline-checkbox .form-field {
        display: inline-block;
      }

      .extra-sentence .inline-checkbox temba-checkbox {
        --checkbox-padding: 5px 6px;
        --checkbox-label-font-size: 13px;
        --checkbox-align: center;
        --checkbox-background: transparent;
      }

      .extra-errors {
        font-size: 12px;
        color: var(--color-error, tomato);
      }

      .extra-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .extra-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 11px 4px 8px;
        border: 1px dashed var(--border-strong, #d2d6dc);
        border-radius: 999px;
        background: transparent;
        font-family: inherit;
        font-size: 12.5px;
        color: var(--text-2, #4d5664);
        cursor: pointer;
        transition:
          border-color 0.15s ease,
          background 0.15s ease,
          color 0.15s ease;
      }

      .extra-chip:hover {
        border-color: var(--focus, rgb(var(--primary-rgb)));
        background: var(--focus-50, rgba(var(--primary-rgb), 0.08));
        color: var(--focus-700, var(--text-1, #1a1f26));
      }

      .optional-field-link {
        margin: 10px 0;
      }

      .optional-field-link a {
        color: var(--color-link-primary, #0066cc);
        text-decoration: none;
        font-size: 13px;
        cursor: pointer;
      }

      .optional-field-link a:hover {
        text-decoration: underline;
      }

      .original-value {
        background: #fff8dc;
        padding: 10px;
        border-radius: 4px;
        font-size: 13px;
        color: #666;
      }

      .original-value-content {
        color: #333;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .category-localization-table {
        width: 100%;
        display: flex;
        flex-direction: column;
      }

      .category-localization-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        align-items: center;
        padding: 4px 0;
      }

      .original-name {
        font-size: 13px;
        color: #333;
        padding: 10px 12px;
        background: #fff8dc;
        border-radius: var(--curvature);
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 38px;
        box-sizing: border-box;
      }

      .localized-name temba-textinput {
        width: 100%;
      }

      .localization-section-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #aaa;
        padding: 10px 0 2px;
      }

      .localization-section-label:first-child {
        padding-top: 0;
      }

      .rule-operator {
        font-size: 11px;
        color: #b8a060;
        margin-right: 4px;
      }
    `;
  }

  @property({ type: Object })
  action?: Action;

  @property({ type: Object })
  node?: Node;

  @property({ type: Object })
  nodeUI?: NodeUI;

  @property({ attribute: false })
  dialogOrigin?: { x: number; y: number };

  @property({ type: Boolean })
  isOpen: boolean = false;

  @state()
  private formData: FormData = {};

  @state()
  private originalFormData: FormData = {};

  // snapshot of getComparableFormData(), refreshed on any non-user mutation
  // (init, async resolve) — the baseline for detecting unsaved edits when
  // dismissing via escape
  private pristineFormData = '';

  @state()
  private errors: { [key: string]: string } = {};

  @state()
  private groupCollapseState: { [key: string]: boolean } = {};

  @state()
  private groupHoverState: { [key: string]: boolean } = {};

  @state()
  private revealedOptionalFields: Set<string> = new Set();

  // labels of extras sections that were added and haven't been removed
  @state()
  private revealedExtras: Set<string> = new Set();

  @fromStore(zustand, (state: AppState) => state.languageCode)
  private languageCode!: string;

  @fromStore(zustand, (state: AppState) => state.isTranslating)
  private _isTranslating!: boolean;

  @property({ type: Boolean, attribute: 'force-base' })
  forceBase = false;

  private get isTranslating(): boolean {
    return this.forceBase ? false : this._isTranslating;
  }

  @fromStore(zustand, (state: AppState) => state.flowDefinition)
  private flowDefinition!: FlowDefinition;

  @fromStore(zustand, (state: AppState) => state.flowInfo)
  private flowInfo!: FlowInfo;

  @fromStore(zustand, (state: AppState) => state.issuesByNode)
  private issuesByNode!: Map<string, FlowIssue[]>;

  @fromStore(zustand, (state: AppState) => state.issuesByAction)
  private issuesByAction!: Map<string, FlowIssue[]>;

  private boundHandleEscape = this.handleEscapeKey.bind(this);
  private boundSwallowEscapeUp = this.swallowEscapeUp.bind(this);

  connectedCallback(): void {
    super.connectedCallback();
    this.initializeFormData();
    document.addEventListener('keydown', this.boundHandleEscape);
    document.addEventListener('keyup', this.boundSwallowEscapeUp, true);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.boundHandleEscape);
    document.removeEventListener('keyup', this.boundSwallowEscapeUp, true);
  }

  private handleEscapeKey(event: KeyboardEvent): void {
    // already on the way out
    if (this.closing) {
      return;
    }
    if (event.key === 'Escape' && this.isOpen) {
      const path = event.composedPath();

      // an escape aimed at an open select dropdown just closes the dropdown
      if (
        path.some(
          (el) =>
            el instanceof Element &&
            el.tagName === 'TEMBA-SELECT' &&
            (el as any).isOpen?.()
        )
      ) {
        return;
      }

      if (!this.ownsEscape(path)) {
        return;
      }

      if (
        this.hasUnsavedChanges() &&
        !window.confirm(Dialog.UNSAVED_CHANGES_MESSAGE)
      ) {
        return;
      }
      this.handleCancel();
    }
  }

  // an escape routed through a dialog other than our own (e.g. a nested
  // dialog or modax opened from a field) belongs to that dialog; an escape
  // with no dialog in its path (canvas or body focus) is ours to handle
  private ownsEscape(path: EventTarget[]): boolean {
    for (const el of path) {
      if (el instanceof Element && el.tagName === 'TEMBA-DIALOG') {
        return el === this.shadowRoot?.querySelector('temba-dialog');
      }
    }
    return true;
  }

  // temba-dialog handles escape itself on KEYUP reaching its container, which
  // would prompt a second time after the keydown handler above has already
  // asked (or dismiss unprompted if its keyup ever arrived first). While the
  // editor is open, escape within our own dialog is owned entirely by the
  // keydown handler, so stop those keyups before the dialog sees them —
  // but leave escapes belonging to a dialog layered above us alone.
  private swallowEscapeUp(event: KeyboardEvent): void {
    if (
      event.key === 'Escape' &&
      this.isOpen &&
      this.ownsEscape(event.composedPath())
    ) {
      event.stopPropagation();
    }
  }

  private hasUnsavedChanges(): boolean {
    return this.getComparableFormData() !== this.pristineFormData;
  }

  // JSON of formData with array-editor scaffolding filtered out: array editors
  // seed a blank row (carrying field defaults, e.g. an attachment type) into
  // form data on first render, which must not count as a user edit
  private getComparableFormData(): string {
    const form = this.getConfig()?.form;
    const comparable = { ...this.formData };

    if (form) {
      Object.entries(form).forEach(([fieldName, fieldConfig]) => {
        const value = comparable[fieldName];
        if (fieldConfig.type === 'array' && Array.isArray(value)) {
          // same emptiness semantics as ArrayEditor.isEmptyItem
          const isEmpty =
            fieldConfig.isEmptyItem ||
            ((item: any) => {
              const values = Object.values(item || {});
              return (
                values.length === 0 ||
                values.every((v) => v === undefined || v === null || v === '')
              );
            });
          comparable[fieldName] = value.filter((item: any) => !isEmpty(item));
        }
      });
    }

    return JSON.stringify(comparable);
  }

  willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    if (
      changedProperties.has('node') ||
      changedProperties.has('action') ||
      changedProperties.has('nodeUI')
    ) {
      // For action editing, we only need the action
      if (this.action && (!this.node || !this.nodeUI)) {
        this.isOpen = true;
        this.initializeFormData();
        this.errors = {};
      }
      // For node editing, we need both node and nodeUI
      else if (this.node && this.nodeUI) {
        this.isOpen = true;
        this.initializeFormData();
        this.errors = {};
      }
      // If we don't have the required data, close the dialog
      else if (!this.action && (!this.node || !this.nodeUI)) {
        this.isOpen = false;
      }
    }
  }

  updated(changedProperties: Map<string | number | symbol, unknown>): void {
    super.updated(changedProperties);
    if (
      changedProperties.has('node') ||
      changedProperties.has('action') ||
      changedProperties.has('nodeUI')
    ) {
      // For action editing, we only need the action
      if (this.action && (!this.node || !this.nodeUI)) {
        this.resolveFormData();
      }
      // For node editing, we need both node and nodeUI
      else if (this.node && this.nodeUI) {
        this.resolveFormData();
      }
    }
  }

  private initializeFormData(): void {
    this.groupCollapseState = {};
    this.revealedExtras = new Set();
    const nodeConfig = this.getNodeConfig();

    // Temporary: terminal nodes defer to action configs, same as execute_actions
    if (
      (!nodeConfig ||
        nodeConfig.type === 'execute_actions' ||
        nodeConfig.type === 'terminal') &&
      this.action
    ) {
      // Action editing mode - use action config
      const actionConfig = ACTION_CONFIG[this.action.type];

      // Check if we're in localization mode
      const actionToLocalization = actionConfig
        ? resolveToLocalizationFormData(actionConfig)
        : undefined;
      if (this.isTranslating && actionToLocalization) {
        // Get localized values for this action
        const localization =
          this.flowDefinition?.localization?.[this.languageCode]?.[
            this.action.uuid
          ] || {};

        this.formData = actionToLocalization(this.action, localization);
      } else if (actionConfig?.toFormData) {
        this.formData = actionConfig.toFormData(this.action);
      } else {
        this.formData = { ...this.action };
      }

      // Convert Record objects to array format for key-value editors
      this.processFormDataForEditing();

      // Store a copy of the original form data for computed field comparisons
      this.originalFormData = JSON.parse(JSON.stringify(this.formData));
    } else if (this.node) {
      // Node editing mode - use node config
      const nodeConfig = this.getNodeConfig();

      // Check if we're in localization mode for a node with localizable categories
      const nodeToLocalization = nodeConfig
        ? resolveToLocalizationFormData(nodeConfig)
        : undefined;
      if (
        this.isTranslating &&
        nodeConfig?.localizable === 'categories' &&
        nodeToLocalization
      ) {
        // Get localized values for this node's categories
        const localization =
          this.flowDefinition?.localization?.[this.languageCode] || {};

        this.formData = nodeToLocalization(this.node, localization);

        const translatableCategoryUuids = new Set(
          getTranslatableCategoriesForNode(
            this.nodeUI?.type,
            this.node.router?.categories
          ).map((category) => category.uuid)
        );

        // Filter categories to translatable ones
        if (
          this.formData.categories &&
          typeof this.formData.categories === 'object' &&
          !Array.isArray(this.formData.categories)
        ) {
          this.formData = {
            ...this.formData,
            categories: Object.fromEntries(
              Object.entries(this.formData.categories).filter(
                ([categoryUuid]) => translatableCategoryUuids.has(categoryUuid)
              )
            )
          };
        }

        // Determine visibility based on per-node config or existing values
        const nodeConfig2 = this.nodeUI?.config || {};
        const showCategories =
          nodeConfig2.localizeCategories ||
          (this.formData.categories &&
            Object.values(this.formData.categories).some(
              (c: any) => c.localizedName
            ));
        const showRules =
          nodeConfig2.localizeRules ||
          (this.formData.rules &&
            Object.values(this.formData.rules).some((r: any) =>
              r.localizedArguments?.some((a: string) => a)
            ));

        // Remove sections that shouldn't be shown
        if (!showCategories) {
          delete this.formData.categories;
        }
        if (!showRules) {
          delete this.formData.rules;
        }
      } else if (nodeConfig?.toFormData) {
        this.formData = nodeConfig.toFormData(this.node, this.nodeUI);
      } else {
        this.formData = { ...this.node };
      }

      // For new wait_for_response nodes, default the result name
      if (
        this.nodeUI?.type === 'wait_for_response' &&
        !this.formData.result_name &&
        this.flowInfo?.results &&
        !this.flowDefinition?._ui?.nodes?.[this.node.uuid]
      ) {
        this.formData.result_name = getDefaultResultName();
        this.formData._isNew = true;
      }

      // Convert Record objects to array format for key-value editors
      this.processFormDataForEditing();

      // Store a copy of the original form data for computed field comparisons
      this.originalFormData = JSON.parse(JSON.stringify(this.formData));
    }

    // enforce immutability of formData
    Object.keys(this.formData).forEach((key) => {
      const value = this.formData[key];
      if (Array.isArray(value)) {
        this.formData[key] = [...value];
      } else if (value && typeof value === 'object') {
        // If it's an object, ensure we don't mutate the original
        this.formData[key] = { ...value };
      }
    });

    // fresh form, so nothing to warn about discarding yet
    this.pristineFormData = this.getComparableFormData();
  }

  private async resolveFormData(): Promise<void> {
    const config = this.getConfig();
    if (!config?.resolveFormData) return;

    const input = this.formData;
    try {
      const resolved = await config.resolveFormData(input);

      // if the user edited while the resolve was in flight, applying the
      // stale result would overwrite their edit — and rebasing the baseline
      // below would then mask the loss as a clean form
      if (this.formData !== input) return;

      if (resolved && resolved !== this.formData) {
        this.formData = resolved;
        this.processFormDataForEditing();

        // Run computed fields for all dependencies that may have changed
        const form = config.form;
        if (form) {
          Object.entries(form).forEach(([fieldName, fieldConfig]) => {
            if (fieldConfig.dependsOn && fieldConfig.computeValue) {
              const computedValue = fieldConfig.computeValue(
                this.formData,
                this.formData[fieldName],
                this.originalFormData
              );
              this.formData = {
                ...this.formData,
                [fieldName]: computedValue
              };
            }
          });
        }

        // resolving isn't a user edit; rebase the unsaved-changes baseline
        this.pristineFormData = this.getComparableFormData();

        this.requestUpdate();
      }
    } catch (error) {
      // Resolve failures are non-fatal; form still works with initial data
    }
  }

  private processFormDataForEditing(): void {
    const processed = { ...this.formData };

    // Convert Record objects to key-value arrays for key-value editors
    Object.keys(processed).forEach((key) => {
      const value = processed[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        // Check if this field should be a key-value editor
        const isKeyValueField = this.isKeyValueField(key);
        if (isKeyValueField) {
          // Convert Record to array format
          processed[key] = Object.entries(value).map(([k, v]) => ({
            key: k,
            value: v
          }));
        }
      }
    });

    // Convert select fields to array format
    const config = this.getConfig();
    if (config?.form) {
      this.processSelectFields(processed, config.form);
    }

    this.formData = processed;
  }

  private processSelectFields(data: any, formConfig: any): void {
    Object.entries(formConfig).forEach(
      ([fieldName, fieldConfig]: [string, any]) => {
        const value = data[fieldName];

        // Handle top-level select fields
        if (fieldConfig.type === 'select' && value) {
          data[fieldName] = this.convertToSelectArray(value);
        }

        // Handle select fields within array items
        if (
          fieldConfig.type === 'array' &&
          Array.isArray(value) &&
          fieldConfig.itemConfig
        ) {
          value.forEach((item: any) => {
            this.processSelectFields(item, fieldConfig.itemConfig);
          });
        }
      }
    );
  }

  private convertToSelectArray(value: any): any[] {
    if (Array.isArray(value)) {
      return value.map((v) =>
        typeof v === 'string' ? { name: v, value: v } : v
      );
    } else if (typeof value === 'string') {
      return [{ name: value, value: value }];
    } else {
      return [value];
    }
  }

  private isKeyValueField(fieldName: string): boolean {
    // Check if this field is configured as a key-value type
    const config = this.getConfig();
    const fields = config?.form;
    return fields?.[fieldName]?.type === 'key-value';
  }

  private getConfig(): ActionConfig | NodeConfig | null {
    // If we have a node and nodeUI, check if we should use node config
    if (this.node && this.nodeUI) {
      const nodeConfig = this.getNodeConfig();

      // Temporary: terminal nodes defer to action configs for editing, same as execute_actions
      // For execute_actions/terminal nodes, defer to action editing if an action is selected
      if (
        (this.nodeUI.type === 'execute_actions' ||
          this.nodeUI.type === ('terminal' as any)) &&
        this.action
      ) {
        return ACTION_CONFIG[this.action.type] || null;
      }

      // For all other nodes with a config, use the node config
      if (nodeConfig) {
        return nodeConfig;
      }
    }

    // Fall back to action config if no node config or for pure action editing
    if (this.action) {
      return ACTION_CONFIG[this.action.type] || null;
    }

    return null;
  }

  private getNodeConfig(): NodeConfig | null {
    if (!this.nodeUI) return null;
    // Get node config based on the nodeUI's type
    return this.nodeUI.type ? NODE_CONFIG[this.nodeUI.type] : null;
  }

  private getHeaderColor(): string {
    const config = this.getConfig();
    return config?.group
      ? ACTION_GROUP_METADATA[config.group]?.color ||
          SPLIT_GROUP_METADATA[config.group]?.color
      : '#aaaaaa';
  }

  // set while the dialog plays its exit, before the editor goes away
  private closing = false;

  // whether the close in progress came from saving
  private saving = false;

  /**
   * Saving or cancelling makes the flow editor remove us, so the events that
   * signal it wait for the dialog to play its exit first.
   */
  public fireCustomEvent(type: CustomEventType, detail: any = {}): any {
    const closes =
      type === CustomEventType.NodeSaved ||
      type === CustomEventType.ActionSaved ||
      type === CustomEventType.NodeEditCancelled;
    if (!closes) {
      return super.fireCustomEvent(type, detail);
    }
    if (this.closing) {
      return;
    }

    const dialog = this.shadowRoot?.querySelector('temba-dialog') as Dialog;
    if (!dialog || !dialog.canAnimateExit()) {
      this.saving = false;
      return super.fireCustomEvent(type, detail);
    }

    this.closing = true;
    dialog.exit(this.saving ? 'submit' : 'cancel').then(() => {
      this.closing = false;
      this.saving = false;
      super.fireCustomEvent(type, detail);
    });
  }

  private handleDialogButtonClick(event: CustomEvent): void {
    if (this.closing) {
      return;
    }
    const button = event.detail.detail;

    if (button.type === ButtonType.PRIMARY) {
      this.handleSave();
    } else if (button.type === ButtonType.SECONDARY) {
      this.handleCancel();
    }
  }

  private handleSave(): void {
    if (this.closing) {
      return;
    }
    this.saving = true;

    // Process form data first
    const processedFormData = this.processFormDataForSave();

    // Skip validation if we're in localization mode
    // (localization only deals with translating text, not changing structure)
    if (!this.isTranslating) {
      // Validate the form
      const validation = this.validateForm();
      if (!validation.valid) {
        this.saving = false;
        this.errors = validation.errors;

        // Expand any groups that contain validation errors
        this.expandGroupsWithErrors(validation.errors);

        return;
      }
    }

    // Check if we're in localization mode
    if (this.isTranslating) {
      // Handle action localization
      if (this.action) {
        const actionConfig = ACTION_CONFIG[this.action.type];

        const actionFromLocalization = actionConfig
          ? resolveFromLocalizationFormData(actionConfig)
          : undefined;
        if (actionFromLocalization) {
          // Save to localization structure
          const localizationData = actionFromLocalization(
            processedFormData,
            this.action
          );

          // Update the flow definition's localization
          this.updateLocalization(
            this.languageCode,
            this.action.uuid,
            localizationData
          );

          // Close the dialog
          this.fireCustomEvent(CustomEventType.NodeEditCancelled, {});
          return;
        }
      }

      // Handle node localization (for router categories and rules)
      if (this.node) {
        const nodeConfig = this.getNodeConfig();

        const nodeFromLocalization = nodeConfig
          ? resolveFromLocalizationFormData(nodeConfig)
          : undefined;
        if (nodeConfig?.localizable === 'categories' && nodeFromLocalization) {
          const localizationData = nodeFromLocalization(
            processedFormData,
            this.node
          );

          const languageLocalization =
            this.flowDefinition?.localization?.[this.languageCode] || {};

          // Save category localizations
          const categories = getTranslatableCategoriesForNode(
            this.nodeUI?.type,
            this.node?.router?.categories
          );

          categories.forEach((category) => {
            const categoryUuid = category.uuid;
            const nextLocalization = localizationData[categoryUuid];

            if (nextLocalization) {
              this.updateLocalization(
                this.languageCode,
                categoryUuid,
                nextLocalization
              );
            } else if (languageLocalization[categoryUuid]) {
              this.updateLocalization(this.languageCode, categoryUuid, {});
            }
          });

          // Save rule localizations
          const cases = this.node.router?.cases || [];
          cases.forEach((c) => {
            const nextLocalization = localizationData[c.uuid];
            if (nextLocalization) {
              this.updateLocalization(
                this.languageCode,
                c.uuid,
                nextLocalization
              );
            } else if (languageLocalization[c.uuid]) {
              this.updateLocalization(this.languageCode, c.uuid, {});
            }
          });

          // Close the dialog
          this.fireCustomEvent(CustomEventType.NodeEditCancelled, {});
          return;
        }
      }
    }

    // Determine whether to use node or action saving based on context
    // If we have a node with a router, always use node saving (even if action is set)
    // because router configuration is handled at the node level
    if (this.node && this.node.router) {
      // Node editing mode with router - use formDataToNode
      const updatedNode = this.formDataToNode(processedFormData);

      // Eagerly update flowInfo results so subsequent node creation
      // sees the new result name before the server round-trip
      this.updateFlowInfoResult(updatedNode);

      // Generate UI config if the node config provides a toUIConfig function
      const nodeConfig = this.getNodeConfig();
      const uiConfig = nodeConfig?.toUIConfig
        ? nodeConfig.toUIConfig(processedFormData)
        : undefined;

      this.fireCustomEvent(CustomEventType.NodeSaved, {
        node: updatedNode,
        uiConfig
      });
    } else if (this.action) {
      // Pure action editing mode (no router)
      const updatedAction = this.formDataToAction(processedFormData);
      this.fireCustomEvent(CustomEventType.ActionSaved, {
        action: updatedAction
      });
    } else if (this.node) {
      // Node editing mode without router
      const updatedNode = this.formDataToNode(processedFormData);

      // Generate UI config if the node config provides a toUIConfig function
      const nodeConfig = this.getNodeConfig();
      const uiConfig = nodeConfig?.toUIConfig
        ? nodeConfig.toUIConfig(processedFormData)
        : undefined;

      this.fireCustomEvent(CustomEventType.NodeSaved, {
        node: updatedNode,
        uiConfig
      });
    }
  }

  // Updates flowInfo.results eagerly so that new nodes created before the
  // server responds with updated info will see the result name and avoid
  // generating a duplicate default name.
  private updateFlowInfoResult(node: Node): void {
    if (!this.flowInfo?.results) return;

    const state = zustand.getState();

    // Remove any existing entry for this node
    const filtered = this.flowInfo.results.filter(
      (r) => !r.node_uuids.includes(node.uuid)
    );

    // Add new entry only if result_name is set
    const resultName = node.router?.result_name;
    if (resultName) {
      const categories = (node.router?.categories || []).map((c) => c.name);
      filtered.push({
        key: resultName.toLowerCase().replace(/\s+/g, '_'),
        name: resultName,
        categories,
        node_uuids: [node.uuid]
      });
    }

    state.setFlowInfo({ ...this.flowInfo, results: filtered });
  }

  private updateLocalization(
    languageCode: string,
    actionUuid: string,
    localizationData: Record<string, any>
  ): void {
    // Use the store method to properly update localization with immer
    zustand
      .getState()
      .updateLocalization(languageCode, actionUuid, localizationData);
  }

  private processFormDataForSave(): FormData {
    const processed = { ...this.formData };

    // Convert key-value arrays to Records
    Object.keys(processed).forEach((key) => {
      const value = processed[key];
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        typeof value[0] === 'object' &&
        'key' in value[0] &&
        'value' in value[0]
      ) {
        // This is a key-value array, convert to Record
        const record: Record<string, string> = {};
        value.forEach(({ key: k, value: v }) => {
          if (k.trim() !== '' || v.trim() !== '') {
            record[k] = v;
          }
        });
        processed[key] = record;
      } else if (Array.isArray(value) && value.length === 0) {
        // Empty key-value array should become empty object
        const isKeyValueField = this.isKeyValueField(key);
        if (isKeyValueField) {
          processed[key] = {};
        }
      }
    });

    return processed;
  }

  private handleCancel(): void {
    this.fireCustomEvent(CustomEventType.NodeEditCancelled, {});
  }

  private validateForm(): ValidationResult {
    const errors: { [key: string]: string } = {};
    const config = this.getConfig();

    if (config) {
      // Check if new field configuration system is available
      if (config.form) {
        Object.entries(config.form).forEach(([fieldName, fieldConfig]) => {
          const value = this.formData[fieldName];
          if (fieldConfig.type === 'select' && fieldConfig.allowCreate) {
            // check our values to see if any have arbitrary set
            let selected = this.formData[fieldName];
            selected = Array.isArray(selected)
              ? selected.find((v: any) => v.arbitrary)
              : null;

            if (selected && selected.arbitrary) {
              errors[fieldName] = msg(
                str`There was an error creating "${selected.name}"`
              );
            }
          }

          // Check required fields (skip in localization mode since all fields are optional).
          // A whitespace-only string counts as empty here - otherwise it slips past this
          // check and is emitted (e.g. trimmed to "") into the definition, which the backend
          // then rejects (e.g. a dial wait with an empty phone).
          if (
            !this.isTranslating &&
            (fieldConfig as any).required &&
            (!value ||
              (typeof value === 'string' && value.trim() === '') ||
              (Array.isArray(value) && value.length === 0))
          ) {
            errors[fieldName] = msg(
              str`${(fieldConfig as any).label || fieldName} is required.`
            );
          }

          // Check minLength for text fields
          if (
            typeof value === 'string' &&
            (fieldConfig as any).minLength &&
            value.length < (fieldConfig as any).minLength
          ) {
            errors[fieldName] = msg(
              str`${(fieldConfig as any).label || fieldName} must be at least ${
                (fieldConfig as any).minLength
              } characters`
            );
          }

          // Check maxLength for text fields, as well as for the values of select/tag
          // items (e.g. result names, quick replies) which are stored as arrays of
          // option objects (or plain strings) rather than a single string. Without the
          // array/object handling, an over-long value here is emitted into the definition
          // and rejected by the backend (goflow caps result names at 64 and quick replies
          // at 1000 chars).
          const itemLength = (item: any): number => {
            if (typeof item === 'string') return item.length;
            if (item && typeof item === 'object') {
              const text = item.value ?? item.name;
              return typeof text === 'string' ? text.length : 0;
            }
            return 0;
          };

          const maxLength = (fieldConfig as any).maxLength;
          if (maxLength) {
            const exceedsMax = Array.isArray(value)
              ? value.some((item) => itemLength(item) > maxLength)
              : itemLength(value) > maxLength;

            if (exceedsMax) {
              errors[fieldName] = msg(
                str`${
                  (fieldConfig as any).label || fieldName
                } must be no more than ${maxLength} characters`
              );
            }
          }

          // Check maxLength declared on array item sub-fields (e.g. rule categories,
          // case arguments) - these live in itemConfig which the top-level check
          // above doesn't reach, so without this an over-long value is emitted into
          // the definition and rejected by the backend.
          if (
            fieldConfig.type === 'array' &&
            fieldConfig.itemConfig &&
            Array.isArray(value)
          ) {
            Object.entries(fieldConfig.itemConfig).forEach(
              ([subFieldName, subFieldConfig]) => {
                const subMaxLength = (subFieldConfig as any).maxLength;
                if (!subMaxLength || errors[fieldName]) {
                  return;
                }
                const exceeds = value.some((item: any) => {
                  // skip sub-fields hidden for this item (e.g. a rule value for
                  // an operator that takes no operands) - they aren't emitted
                  const visible = (subFieldConfig as any).conditions?.visible;
                  if (visible && !visible(item)) {
                    return false;
                  }
                  // measure like the top-level check so option-object values
                  // (e.g. a select or tag input inside an array) are covered
                  const subValue = item?.[subFieldName];
                  return Array.isArray(subValue)
                    ? subValue.some((sub) => itemLength(sub) > subMaxLength)
                    : itemLength(subValue) > subMaxLength;
                });
                if (exceeds) {
                  errors[fieldName] = msg(
                    str`${
                      (subFieldConfig as any).label || subFieldName
                    } must be no more than ${subMaxLength} characters`
                  );
                }
              }
            );
          }

          // Check key-value fields against their declared limits (e.g. goflow caps
          // webhook headers at 100 entries, names at 100 chars and values at 1000).
          if (fieldConfig.type === 'key-value' && Array.isArray(value)) {
            const rows = value.filter(
              (item: any) =>
                ((item?.key || '') as string).trim() !== '' ||
                ((item?.value || '') as string).trim() !== ''
            );
            const label = (fieldConfig as any).label || fieldName;
            if (fieldConfig.maxItems && rows.length > fieldConfig.maxItems) {
              errors[fieldName] = msg(
                str`${label} can have no more than ${fieldConfig.maxItems} entries`
              );
            } else if (
              fieldConfig.keyMaxLength &&
              rows.some(
                (item: any) =>
                  (item.key || '').length > fieldConfig.keyMaxLength
              )
            ) {
              errors[fieldName] = msg(
                str`${
                  fieldConfig.keyPlaceholder || msg('Key')
                } must be no more than ${fieldConfig.keyMaxLength} characters`
              );
            } else if (
              fieldConfig.valueMaxLength &&
              rows.some(
                (item: any) =>
                  (item.value || '').length > fieldConfig.valueMaxLength
              )
            ) {
              errors[fieldName] = msg(
                str`${
                  fieldConfig.valuePlaceholder || msg('Value')
                } must be no more than ${fieldConfig.valueMaxLength} characters`
              );
            }
          }
        });
      }

      // Universal validation for category arrays to check for reserved names
      this.validateCategoryNames(errors);

      // Run custom validation if available
      if (config.validate) {
        if (config.sanitize) {
          config.sanitize(this.formData);
        }

        let customValidation;
        if (this.action) {
          customValidation = config.validate({
            ...this.action,
            ...this.formData
          });
        } else {
          customValidation = config.validate(this.formData);
        }
        Object.assign(errors, customValidation.errors);
      }
    }

    // Validate key-value fields for unique keys
    this.validateKeyValueUniqueness(errors);

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  }

  private validateKeyValueUniqueness(errors: { [key: string]: string }): void {
    // The individual key-value editors will show validation errors on duplicate keys and empty keys with values
    // We just need to prevent form submission when there are validation issues
    Object.entries(this.formData).forEach(([fieldName, value]) => {
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        typeof value[0] === 'object' &&
        'key' in value[0] &&
        'value' in value[0]
      ) {
        // This is a key-value array
        let hasValidationErrors = false;

        // Check for empty keys with values
        value.forEach(({ key, value: itemValue }: any) => {
          if (key.trim() === '' && itemValue.trim() !== '') {
            hasValidationErrors = true;
          }
        });

        // Check for duplicate keys (only non-empty ones)
        const keys = value
          .filter(({ key }: any) => key.trim() !== '') // Only check non-empty keys
          .map(({ key }: any) => key.trim());

        const uniqueKeys = new Set(keys);

        if (keys.length !== uniqueKeys.size) {
          hasValidationErrors = true;
        }

        if (hasValidationErrors) {
          errors[fieldName] = msg(
            'Please resolve validation errors to continue'
          );
        }
      }
    });
  }

  private validateCategoryNames(errors: { [key: string]: string }): void {
    Object.assign(errors, collectReservedCategoryErrors(this.formData));
  }

  private formDataToNode(formData: FormData = this.formData): Node {
    if (!this.node) throw new Error('No node to update');
    let updatedNode: Node = { ...this.node };

    // Check if node config has fromFormData - if so, it handles the entire transformation
    const nodeConfig = this.getNodeConfig();
    const nodeHasFromFormData = nodeConfig?.fromFormData !== undefined;

    // Handle actions using action config transformations if available
    // Skip this if the node has its own fromFormData (which handles actions itself)
    if (
      !nodeHasFromFormData &&
      this.node.actions &&
      this.node.actions.length > 0
    ) {
      updatedNode.actions = this.node.actions.map((action) => {
        // If we're editing a specific action, only transform that one
        if (this.action && action.uuid === this.action.uuid) {
          const actionConfig = ACTION_CONFIG[action.type];
          if (actionConfig?.fromFormData) {
            // Use action-specific form data transformation
            return actionConfig.fromFormData(formData);
          } else {
            // Default transformation - merge form data with original action
            return { ...action, ...formData };
          }
        } else {
          // Keep other actions unchanged
          return action;
        }
      });
    }

    // Handle router configuration using node config
    if (nodeHasFromFormData) {
      // Use node-specific form data transformation
      // When a node has fromFormData, it's responsible for creating the entire
      // node structure including actions and router (regardless of whether router exists yet)
      updatedNode = nodeConfig.fromFormData!(formData, updatedNode);
    } else if (this.node.router) {
      // Default router handling when no nodeConfig.fromFormData
      updatedNode.router = { ...this.node.router };

      // Apply form data to router fields if they exist
      if (formData.result_name !== undefined) {
        updatedNode.router.result_name = formData.result_name;
      }

      // Handle preconfigured rules from node config
      if (nodeConfig?.router?.rules) {
        // Build a complete new set of categories and exits based on node config
        const existingCategories = updatedNode.router.categories || [];
        const existingExits = updatedNode.exits || [];

        const newCategories: any[] = [];
        const newExits: any[] = [];

        // Group rules by category name to handle multiple rules pointing to the same category
        const categoryNameToRules = new Map<
          string,
          typeof nodeConfig.router.rules
        >();
        nodeConfig.router.rules.forEach((rule) => {
          if (!categoryNameToRules.has(rule.categoryName)) {
            categoryNameToRules.set(rule.categoryName, []);
          }
          categoryNameToRules.get(rule.categoryName)!.push(rule);
        });

        // Create categories for all unique category names
        categoryNameToRules.forEach((rules, categoryName) => {
          // Check if category already exists to preserve its UUID and exit_uuid
          const existingCategory = existingCategories.find(
            (cat) => cat.name === categoryName
          );

          if (existingCategory) {
            // Preserve existing category and its associated exit
            newCategories.push(existingCategory);
            const associatedExit = existingExits.find(
              (exit) => exit.uuid === existingCategory.exit_uuid
            );
            if (associatedExit) {
              newExits.push(associatedExit);
            }
          } else {
            // Create new category and exit
            const categoryUuid = generateUUID();
            const exitUuid = generateUUID();

            newCategories.push({
              uuid: categoryUuid,
              name: categoryName,
              exit_uuid: exitUuid
            });

            newExits.push({
              uuid: exitUuid,
              destination_uuid: null
            });
          }
        });

        // Add default category if specified
        if (nodeConfig.router.defaultCategory) {
          // Check if default category already exists in our new list
          const existingDefault = newCategories.find(
            (cat) => cat.name === nodeConfig.router.defaultCategory
          );

          if (!existingDefault) {
            // Check if it exists in the original categories
            const originalDefault = existingCategories.find(
              (cat) => cat.name === nodeConfig.router.defaultCategory
            );

            if (originalDefault) {
              // Preserve existing default category and its exit
              newCategories.push(originalDefault);
              const associatedExit = existingExits.find(
                (exit) => exit.uuid === originalDefault.exit_uuid
              );
              if (associatedExit) {
                newExits.push(associatedExit);
              }
            } else {
              // Create new default category and exit
              const categoryUuid = generateUUID();
              const exitUuid = generateUUID();

              newCategories.push({
                uuid: categoryUuid,
                name: nodeConfig.router.defaultCategory,
                exit_uuid: exitUuid
              });

              newExits.push({
                uuid: exitUuid,
                destination_uuid: null
              });
            }
          }
        }

        // Replace the entire categories and exits lists with our complete new sets
        updatedNode.router.categories = newCategories;
        updatedNode.exits = newExits;
      }
    } else {
      // If no router, just apply form data to node properties
      Object.keys(formData).forEach((key) => {
        if (
          key !== 'uuid' &&
          key !== 'actions' &&
          key !== 'exits' &&
          key !== 'router'
        ) {
          (updatedNode as any)[key] = formData[key];
        }
      });
    }

    return updatedNode;
  }

  private formDataToAction(formData: FormData = this.formData): Action {
    if (!this.action) throw new Error('No action to update');

    // Use action config transformation if available
    const actionConfig = ACTION_CONFIG[this.action.type];
    if (actionConfig?.fromFormData) {
      return actionConfig.fromFormData(formData);
    } else {
      // Default 1:1 mapping
      return { ...this.action, ...formData };
    }
  }

  private handleFormFieldChange(propertyName: string, event: Event): void {
    const target = event.target as any;
    let value: any;

    // Handle different component types like ActionEditor does
    if (target.tagName === 'TEMBA-CHECKBOX') {
      value = target.checked;
    } else if (target.values !== undefined) {
      value = target.values;
    } else {
      value = target.value;
    }

    this.formData = {
      ...this.formData,
      [propertyName]: value
    };

    // Clear any existing error for this field
    if (this.errors[propertyName]) {
      const newErrors = { ...this.errors };
      delete newErrors[propertyName];
      this.errors = newErrors;
    }

    // Check for computed values in dependent fields
    this.updateComputedFields(propertyName);

    // Re-evaluate group collapse states that depend on form data
    this.updateGroupCollapseStates();

    // Trigger re-render to handle conditional field visibility
    this.requestUpdate();
  }

  private updateGroupCollapseStates(): void {
    const config = this.getConfig();
    if (!config?.layout) return;

    this.updateGroupCollapseStatesRecursive(config.layout);
  }

  private updateGroupCollapseStatesRecursive(items: LayoutItem[]): void {
    items.forEach((item) => {
      if (typeof item === 'object' && item.type === 'group') {
        const { label, collapsed, collapsible } = item;

        // Only update if the group is collapsible and has a function-based collapsed property
        // Skip reveal groups that have been expanded — they are one-way
        if (collapsible && typeof collapsed === 'function') {
          if (item.reveal && this.groupCollapseState[label] === false) {
            // Reveal group was manually expanded — don't re-collapse
          } else {
            const newCollapsedState = collapsed(this.formData);

            // Only update if the state has changed to avoid unnecessary re-renders
            if (this.groupCollapseState[label] !== newCollapsedState) {
              this.groupCollapseState = {
                ...this.groupCollapseState,
                [label]: newCollapsedState
              };
            }
          }
        }

        // Recursively check nested items
        this.updateGroupCollapseStatesRecursive(item.items);
      } else if (typeof item === 'object' && item.type === 'row') {
        // Recursively check items in rows
        this.updateGroupCollapseStatesRecursive(item.items);
      } else if (typeof item === 'object' && item.type === 'accordion') {
        // Accordion sections use their collapsed function only for initial state;
        // after that, user toggles control them.
        item.sections.forEach((section) => {
          this.updateGroupCollapseStatesRecursive(section.items);
        });
      } else if (typeof item === 'object' && item.type === 'extras') {
        item.sections.forEach((section) => {
          this.updateGroupCollapseStatesRecursive(section.items);
        });
      }
    });
  }

  private updateComputedFields(changedFieldName: string): void {
    const config = this.getConfig();
    if (!config?.form) return;

    // Check all fields to see if any depend on the changed field
    Object.entries(config.form).forEach(([fieldName, fieldConfig]) => {
      if (fieldConfig.dependsOn?.includes(changedFieldName)) {
        if (fieldConfig.computeValue) {
          const currentValue = this.formData[fieldName];

          const computedValue = fieldConfig.computeValue(
            this.formData,
            currentValue,
            this.originalFormData
          );

          // Update the form data with the computed value
          this.formData = {
            ...this.formData,
            [fieldName]: computedValue
          };
        }
      }
    });
  }

  /**
   * Helper method to check if a field is visible based on its conditions
   */
  private isFieldVisible(fieldName: string, config: FieldConfig): boolean {
    if (config.conditions?.visible) {
      try {
        return config.conditions.visible(this.formData);
      } catch (error) {
        console.error(`Error checking visibility for ${fieldName}:`, error);
        // If there's an error, show the field by default
        return true;
      }
    }
    return true;
  }

  private renderNewField(
    fieldName: string,
    config: FieldConfig,
    value: any
  ): TemplateResult {
    // Check visibility condition
    if (!this.isFieldVisible(fieldName, config)) {
      return html``;
    }

    const errors = this.errors[fieldName] ? [this.errors[fieldName]] : [];

    // Build container style with maxWidth if specified
    const containerStyle = config.maxWidth
      ? `max-width: ${config.maxWidth};`
      : '';

    // Render original value if in localization mode and action has the field
    const originalValueDisplay =
      this.isTranslating && this.action && fieldName in this.action
        ? this.renderOriginalValue(fieldName, this.action[fieldName])
        : html``;

    const fieldContent = this.renderFieldContent(
      fieldName,
      config,
      value,
      errors
    );

    const content = html` ${originalValueDisplay} ${fieldContent} `;

    // Wrap in container with style if maxWidth is specified
    if (containerStyle) {
      return html`<div style="${containerStyle}">${content}</div>`;
    }

    return content;
  }

  private renderOptionalField(
    fieldName: string,
    config: FieldConfig,
    value: any
  ): TemplateResult {
    // If the field has a value or has been revealed, show it
    const hasValue = value && value.toString().trim() !== '';
    const isRevealed = this.revealedOptionalFields.has(fieldName);

    if (hasValue || isRevealed) {
      // Render the field normally
      return this.renderNewField(fieldName, config, value);
    }

    // Show the "Save as..." link
    return html`
      <div class="optional-field-link">
        <a
          @click="${(e: Event) => {
            e.preventDefault();
            this.revealOptionalField(fieldName);
          }}"
        >
          ${config.optionalLink}
        </a>
      </div>
    `;
  }

  private revealOptionalField(fieldName: string): void {
    this.revealedOptionalFields = new Set([
      ...this.revealedOptionalFields,
      fieldName
    ]);
  }

  private renderLocalizationTable(): TemplateResult {
    const rules = this.formData.rules || {};
    const ruleEntries = Object.entries(rules);
    const categories = this.formData.categories || {};
    const categoryEntries = Object.entries(categories);

    if (ruleEntries.length === 0 && categoryEntries.length === 0) {
      return html`<div>${msg('No content to localize')}</div>`;
    }

    return html`
      <div class="category-localization-table">
        ${ruleEntries.length > 0
          ? html`
              <div class="localization-section-label">${msg('Rules')}</div>
              ${ruleEntries.map(
                ([caseUuid, ruleData]: [string, any]) => html`
                  ${(ruleData.originalArguments || []).map(
                    (arg: string, i: number) =>
                      arg
                        ? html`
                            <div class="category-localization-row">
                              <div class="original-name">
                                <span class="rule-operator"
                                  >${ruleData.operatorName}</span
                                >
                                <span>${arg}</span>
                              </div>
                              <div class="localized-name">
                                <temba-textinput
                                  name="rule-${caseUuid}-${i}"
                                  placeholder=""
                                  value="${ruleData.localizedArguments?.[i] ||
                                  ''}"
                                  @change=${(e: Event) =>
                                    this.handleRuleLocalizationChange(
                                      caseUuid,
                                      i,
                                      (e.target as any).value
                                    )}
                                ></temba-textinput>
                              </div>
                            </div>
                          `
                        : ''
                  )}
                `
              )}
            `
          : ''}
        ${categoryEntries.length > 0
          ? html`
              <div class="localization-section-label">${msg('Categories')}</div>
              ${categoryEntries.map(
                ([categoryUuid, categoryData]: [string, any]) => html`
                  <div class="category-localization-row">
                    <div class="original-name">
                      ${categoryData.originalName}
                    </div>
                    <div class="localized-name">
                      <temba-textinput
                        name="${categoryUuid}"
                        placeholder=""
                        value="${categoryData.localizedName || ''}"
                        @change=${(e: Event) =>
                          this.handleCategoryLocalizationChange(
                            categoryUuid,
                            (e.target as any).value
                          )}
                      ></temba-textinput>
                    </div>
                  </div>
                `
              )}
            `
          : ''}
      </div>
    `;
  }

  private handleCategoryLocalizationChange(
    categoryUuid: string,
    value: string
  ): void {
    if (!this.formData.categories) {
      this.formData.categories = {};
    }
    if (!this.formData.categories[categoryUuid]) {
      this.formData.categories[categoryUuid] = {};
    }
    this.formData.categories[categoryUuid].localizedName = value;
    this.requestUpdate();
  }

  private handleRuleLocalizationChange(
    caseUuid: string,
    argIndex: number,
    value: string
  ): void {
    if (!this.formData.rules) {
      this.formData.rules = {};
    }
    if (!this.formData.rules[caseUuid]) {
      this.formData.rules[caseUuid] = {
        originalArguments: [],
        localizedArguments: []
      };
    }
    if (!this.formData.rules[caseUuid].localizedArguments) {
      this.formData.rules[caseUuid].localizedArguments = [];
    }
    this.formData.rules[caseUuid].localizedArguments[argIndex] = value;
    this.requestUpdate();
  }

  private renderOriginalValue(
    fieldName: string,
    originalValue: any
  ): TemplateResult {
    // Format the original value for display
    let displayValue = '';

    if (Array.isArray(originalValue)) {
      if (originalValue.length === 0) {
        return html``; // Don't show anything for empty arrays
      }
      // For arrays, join with commas
      displayValue = originalValue.join(', ');
    } else if (typeof originalValue === 'string') {
      displayValue = originalValue;
    } else if (originalValue) {
      displayValue = String(originalValue);
    }

    // Don't show if empty
    if (!displayValue || displayValue.trim() === '') {
      return html``;
    }

    return html`
      <div class="original-value">
        <div class="original-value-content">${displayValue}</div>
      </div>
    `;
  }

  private renderFieldContent(
    fieldName: string,
    config: FieldConfig,
    value: any,
    errors: string[]
  ): TemplateResult {
    // In localization mode, make all fields optional (not required)
    const fieldConfig = this.isTranslating
      ? { ...config, required: false }
      : config;

    // Use FieldRenderer for consistent field rendering
    return FieldRenderer.renderField(fieldName, fieldConfig, value, {
      errors,
      onChange: (e: Event) => {
        // Handle different change event types
        if (fieldName && config.type === 'key-value') {
          // Special handling for key-value editor
          const customEvent = e as CustomEvent;
          if (customEvent.detail) {
            this.handleNewFieldChange(fieldName, customEvent.detail.value);
          }
        } else if (fieldName && config.type === 'array') {
          // Special handling for array editor
          this.handleNewFieldChange(fieldName, (e.target as any).value);
        } else if (fieldName && config.type === 'message-editor') {
          // Special handling for message editor
          this.handleMessageEditorChange(fieldName, e);
        } else if (fieldName && config.type === 'media') {
          // Extract URL from media picker's attachment
          const picker = e.target as any;
          const url = picker.attachments?.[0]?.url || '';
          this.handleNewFieldChange(fieldName, url);
        } else if (fieldName && config.type === 'template-editor') {
          // Special handling for template editor (manages template + template_variables)
          this.handleTemplateEditorChange(fieldName, e);
        } else {
          // Default handling for most field types
          this.handleFormFieldChange(fieldName, e);
        }
      },
      showLabel: true,
      formData: this.formData,
      additionalData: {
        attachments: this.formData.attachments || [],
        template_variables: this.formData.template_variables || []
      }
    });
  }

  private handleGroupToggle(groupLabel: string): void {
    this.groupCollapseState = {
      ...this.groupCollapseState,
      [groupLabel]: !this.groupCollapseState[groupLabel]
    };
  }

  private handleGroupMouseEnter(groupLabel: string): void {
    this.groupHoverState = {
      ...this.groupHoverState,
      [groupLabel]: true
    };
  }

  private handleGroupMouseLeave(groupLabel: string): void {
    this.groupHoverState = {
      ...this.groupHoverState,
      [groupLabel]: false
    };
  }

  private expandGroupsWithErrors(errors: { [key: string]: string }): void {
    const config = this.getConfig();
    if (!config?.layout) return;

    const errorFields = new Set(Object.keys(errors));
    this.expandGroupsWithErrorsRecursive(config.layout, errorFields);
  }

  private expandGroupsWithErrorsRecursive(
    items: LayoutItem[],
    errorFields: Set<string>
  ): void {
    items.forEach((item) => {
      if (typeof item === 'object' && item.type === 'group') {
        const fieldsInGroup = this.collectFieldsFromItems(item.items);
        const groupHasErrors = fieldsInGroup.some((fieldName) =>
          errorFields.has(fieldName)
        );

        if (groupHasErrors) {
          // Expand this group
          this.groupCollapseState = {
            ...this.groupCollapseState,
            [item.label]: false
          };
        }

        // Recursively check nested items
        this.expandGroupsWithErrorsRecursive(item.items, errorFields);
      } else if (typeof item === 'object' && item.type === 'row') {
        // Recursively check items in rows
        this.expandGroupsWithErrorsRecursive(item.items, errorFields);
      } else if (typeof item === 'object' && item.type === 'accordion') {
        // Check each accordion section for errors
        item.sections.forEach((section) => {
          const fieldsInSection = this.collectFieldsFromItems(section.items);
          const sectionHasErrors = fieldsInSection.some((fieldName) =>
            errorFields.has(fieldName)
          );
          if (sectionHasErrors) {
            this.groupCollapseState = {
              ...this.groupCollapseState,
              [`accordion:${section.label}`]: false
            };
          }
          this.expandGroupsWithErrorsRecursive(section.items, errorFields);
        });
      } else if (typeof item === 'object' && item.type === 'extras') {
        // extras sections show themselves while they have errors
        item.sections.forEach((section) => {
          this.expandGroupsWithErrorsRecursive(section.items, errorFields);
        });
      }
    });
  }

  private renderLayoutItem(
    item: LayoutItem,
    config: ActionConfig | NodeConfig,
    renderedFields: Set<string>
  ): TemplateResult {
    if (typeof item === 'string') {
      // String shorthand for field
      return this.renderLayoutItem(
        { type: 'field', field: item },
        config,
        renderedFields
      );
    }

    switch (item.type) {
      case 'field':
        // In translation mode, skip fields not in the localizable list
        if (
          this.isTranslating &&
          Array.isArray((config as ActionConfig).localizable) &&
          !(config as ActionConfig).localizable!.includes(item.field)
        ) {
          renderedFields.add(item.field);
          return html``;
        }
        if (config.form![item.field] && !renderedFields.has(item.field)) {
          renderedFields.add(item.field);
          const fieldConfig = config.form![item.field] as FieldConfig;

          // Handle optional link fields
          if (fieldConfig.optionalLink) {
            return this.renderOptionalField(
              item.field,
              fieldConfig,
              this.formData[item.field]
            );
          }

          return this.renderNewField(
            item.field,
            fieldConfig,
            this.formData[item.field]
          );
        }
        return html``;

      case 'row':
        return this.renderRow(item, config, renderedFields);

      case 'group':
        return this.renderGroup(item, config, renderedFields);

      case 'accordion':
        return this.renderAccordion(item, config, renderedFields);

      case 'extras':
        return this.renderExtras(item, config, renderedFields);

      case 'spacer':
        return html``;

      case 'text':
        return html`<div class="form-text">${item.text}</div>`;

      default:
        return html``;
    }
  }

  private renderRow(
    rowConfig: RowLayoutConfig,
    config: ActionConfig | NodeConfig,
    renderedFields: Set<string>
  ): TemplateResult {
    const {
      items,
      gap = '1rem',
      label,
      helpText,
      inlineLabels,
      marginBottom
    } = rowConfig;

    // Collect all fields from this row for width calculations
    const fieldsInRow = this.collectFieldsFromItems(items);
    const validFields = fieldsInRow.filter(
      (fieldName) => config.form?.[fieldName]
    );

    // Filter for visible fields only to handle conditional visibility
    const visibleFields = validFields.filter((fieldName) => {
      const fieldConfig = config.form![fieldName];
      return this.isFieldVisible(fieldName, fieldConfig);
    });

    if (visibleFields.length === 0) {
      return html``;
    }

    // Build a map of field flex styles
    // Fields with maxWidth get flex: 0 0 {maxWidth} (fixed)
    // Fields without maxWidth get flex: 1 1 0 (grow to fill space)
    const fieldFlexStyles = new Map<string, string>();
    visibleFields.forEach((fieldName) => {
      const fieldConfig = config.form![fieldName];
      if (fieldConfig.maxWidth) {
        // Fixed width field: no grow, no shrink, basis = maxWidth
        fieldFlexStyles.set(fieldName, `flex: 0 0 ${fieldConfig.maxWidth};`);
      } else {
        // Flexible field: grow to fill remaining space
        fieldFlexStyles.set(fieldName, `flex: 1 1 0;`);
      }
    });

    const rowContent = html`
      <div
        class="form-row"
        style="display: flex; gap: ${gap};${marginBottom
          ? ` margin-bottom: ${marginBottom};`
          : ''}"
      >
        ${items.map((item) => {
          // Spacer items render as empty flex children
          if (typeof item !== 'string' && item.type === 'spacer') {
            return html`<div style="flex: 1 1 0;"></div>`;
          }

          // Get the field name from the item
          const fieldName =
            typeof item === 'string'
              ? item
              : item.type === 'field'
                ? item.field
                : null;

          // Get flex style for this field if it's a visible field
          const flexStyle =
            fieldName && fieldFlexStyles.has(fieldName)
              ? fieldFlexStyles.get(fieldName)
              : '';

          const itemContent = this.renderLayoutItem(
            item,
            config,
            renderedFields
          );

          // When inlineLabels is provided, render the label inline to the left
          const inlineLabel =
            inlineLabels && fieldName ? inlineLabels[fieldName] : null;

          // Wrap in a div with flex style if we have a flex style
          if (flexStyle) {
            // Evaluated fields use temba-rich-edit which needs min-width: 0
            // on its flex item wrapper to prevent overflow in flex rows
            const fieldConfig = fieldName ? config.form?.[fieldName] : null;
            const minWidth = fieldConfig?.evaluated ? ' min-width: 0;' : '';
            return inlineLabel
              ? html`<div
                  style="${flexStyle} display: flex; align-items: center; gap: 0.35rem;"
                >
                  <span class="form-row-inline-label">${inlineLabel}</span>
                  <div style="flex: 1 1 0; min-width: 0;">${itemContent}</div>
                </div>`
              : html`<div style="${flexStyle}${minWidth}">${itemContent}</div>`;
          }
          return itemContent;
        })}
      </div>
    `;

    // If no label or helpText, return just the row content
    if (!label && !helpText) {
      return rowContent;
    }

    // Otherwise, wrap with label on top, content, then helpText below (matching field pattern)
    return html`
      <div class="form-row-wrapper">
        ${label ? html`<label class="form-row-label">${label}</label>` : ''}
        ${rowContent}
        ${helpText
          ? html`<div class="form-row-help">
              ${renderMarkdownInline(helpText)}
            </div>`
          : ''}
      </div>
    `;
  }

  private renderGroup(
    groupConfig: GroupLayoutConfig,
    config: ActionConfig | NodeConfig,
    renderedFields: Set<string>
  ): TemplateResult {
    const {
      label,
      items,
      collapsible = false,
      collapsed = false,
      helpText,
      icon,
      contentPadding,
      gap,
      bordered = true,
      reveal = false,
      getGroupValueCount
    } = groupConfig;

    // Initialize collapse state if not set
    if (collapsible && !(label in this.groupCollapseState)) {
      // Evaluate collapsed property - can be boolean or function
      const initialCollapsed =
        typeof collapsed === 'function' ? collapsed(this.formData) : collapsed;

      this.groupCollapseState = {
        ...this.groupCollapseState,
        [label]: initialCollapsed
      };
    }

    const isCollapsed = collapsible
      ? (this.groupCollapseState[label] ??
        (typeof collapsed === 'function'
          ? collapsed(this.formData)
          : collapsed))
      : false;

    // Reveal mode: once expanded, render items directly without any group wrapper
    if (reveal && !isCollapsed) {
      return html`${items.map((item) =>
        this.renderLayoutItem(item, config, renderedFields)
      )}`;
    }

    // Check if any field in this group has errors
    const fieldsInGroup = this.collectFieldsFromItems(items);
    const groupHasErrors = fieldsInGroup.some(
      (fieldName) => this.errors[fieldName]
    );

    // Calculate count for bubble display
    let valueCount = 0;
    let showBubble = false;
    let showCheckmark = false;
    let hasValue = false;
    const isHovered = this.groupHoverState[label] ?? false;

    if (getGroupValueCount && collapsible) {
      try {
        const result = getGroupValueCount(this.formData);

        if (typeof result === 'boolean') {
          // Boolean result - show checkmark when true
          showCheckmark = result && isCollapsed && !isHovered;
          hasValue = result;
        } else if (typeof result === 'number') {
          // Numeric result - show count bubble
          valueCount = result;
          showBubble = valueCount > 0 && isCollapsed && !isHovered;
          hasValue = valueCount > 0;
        }
      } catch (error) {
        console.error(
          `Error calculating group value count for ${label}:`,
          error
        );
      }
    }

    return html`
      <div
        class="form-group ${collapsible ? 'collapsible' : ''} ${groupHasErrors
          ? 'has-errors'
          : ''} ${isCollapsed ? 'collapsed' : 'expanded'} ${hasValue
          ? 'has-bubble'
          : ''} ${!bordered ? 'no-border' : ''}"
      >
        <div
          class="form-group-header ${collapsible ? 'clickable' : ''}"
          @click=${collapsible
            ? () => this.handleGroupToggle(label)
            : undefined}
          @mouseenter=${collapsible
            ? () => this.handleGroupMouseEnter(label)
            : undefined}
          @mouseleave=${collapsible
            ? () => this.handleGroupMouseLeave(label)
            : undefined}
        >
          <div class="form-group-info">
            <div class="form-group-title">
              ${icon
                ? html`<temba-icon
                    name=${icon}
                    size="1"
                    style="margin-right:6px;color:#999;"
                  ></temba-icon>`
                : ''}${label}
            </div>
            ${helpText
              ? html`<div class="form-group-help">
                  ${renderMarkdownInline(helpText)}
                </div>`
              : ''}
          </div>
          ${groupHasErrors
            ? html`<temba-icon
                name="alert_warning"
                class="group-error-icon"
                size="1.5"
              ></temba-icon>`
            : ''}
          ${collapsible && !groupHasErrors
            ? html`<div class="group-toggle-container">
                <temba-icon
                  name="arrow_right"
                  size="1.5"
                  class="group-toggle-icon ${isCollapsed
                    ? 'collapsed'
                    : 'expanded'} ${showBubble || showCheckmark ? 'faded' : ''}"
                ></temba-icon>
                ${showCheckmark
                  ? html`<temba-icon
                      name="check"
                      size="1"
                      class="group-checkmark-icon"
                    ></temba-icon>`
                  : showBubble
                    ? html`<div
                        class="group-count-bubble ${!showBubble
                          ? 'hidden'
                          : ''}"
                      >
                        ${formatCount(valueCount)}
                      </div>`
                    : ''}
              </div>`
            : ''}
        </div>
        <div
          class="form-group-content ${isCollapsed ? 'collapsed' : 'expanded'}"
          style="${[
            contentPadding ? `--group-content-padding: ${contentPadding}` : '',
            gap ? `gap: ${gap}` : ''
          ]
            .filter(Boolean)
            .join(';')}"
        >
          ${items.map((item) =>
            this.renderLayoutItem(item, config, renderedFields)
          )}
        </div>
      </div>
    `;
  }

  private renderAccordion(
    accordionConfig: AccordionLayoutConfig,
    config: ActionConfig | NodeConfig,
    renderedFields: Set<string>
  ): TemplateResult {
    const { sections, multi = true } = accordionConfig;

    // Filter out sections where all fields are invisible
    const visibleSections = sections.filter((section) => {
      const fieldsInSection = this.collectFieldsFromItems(section.items);
      if (fieldsInSection.length === 0) return true;

      // When translating, hide sections marked as not localizable
      if (this.isTranslating && section.localizable === false) {
        // Mark fields as rendered so they don't appear at top level
        fieldsInSection.forEach((f) => renderedFields.add(f));
        return false;
      }

      return fieldsInSection.some((fieldName) => {
        const fieldConfig = config.form?.[fieldName];
        return fieldConfig ? this.isFieldVisible(fieldName, fieldConfig) : true;
      });
    });

    if (visibleSections.length === 0) {
      return html``;
    }

    return html`
      <temba-accordion
        ?multi=${multi}
        @toggle=${this.handleAccordionSectionToggle}
      >
        ${visibleSections.map((section) => {
          const {
            label,
            collapsed = true,
            getValueCount,
            getSummary
          } = section;
          const stateKey = `accordion:${label}`;

          // Initialize collapse state if not set
          if (!(stateKey in this.groupCollapseState)) {
            const initialCollapsed =
              typeof collapsed === 'function'
                ? collapsed(this.formData)
                : collapsed;
            this.groupCollapseState = {
              ...this.groupCollapseState,
              [stateKey]: initialCollapsed
            };
          }

          const isCollapsed = this.groupCollapseState[stateKey] ?? true;

          // Check for errors in this section
          const fieldsInSection = this.collectFieldsFromItems(section.items);
          const sectionHasErrors = fieldsInSection.some(
            (fieldName) => this.errors[fieldName]
          );

          // Value count / checkmark display
          let valueCount = 0;
          let isChecked = false;

          if (getValueCount) {
            try {
              const result = getValueCount(this.formData);
              if (typeof result === 'boolean') {
                isChecked = result;
              } else if (typeof result === 'number') {
                valueCount = result;
              }
            } catch (error) {
              // ignore
            }
          }

          let summary = '';
          if (getSummary) {
            try {
              summary = getSummary(this.formData) || '';
            } catch (error) {
              // ignore
            }
          }

          return html`
            <temba-accordion-section
              label=${label}
              summary=${summary}
              emptySummary=${section.emptySummary || 'None'}
              icon=${section.icon || ''}
              .count=${valueCount}
              ?checked=${isChecked}
              .collapsed=${isCollapsed}
              ?hasError=${sectionHasErrors}
            >
              ${section.items.map((item) =>
                this.renderLayoutItem(item, config, renderedFields)
              )}
            </temba-accordion-section>
          `;
        })}
      </temba-accordion>
    `;
  }

  private renderExtras(
    extrasConfig: ExtrasLayoutConfig,
    config: ActionConfig | NodeConfig,
    renderedFields: Set<string>
  ): TemplateResult {
    const sections = extrasConfig.sections.filter((section) => {
      const fieldsInSection = this.collectFieldsFromItems(section.items);

      // When translating, leave out sections marked as not localizable
      if (this.isTranslating && section.localizable === false) {
        fieldsInSection.forEach((f) => renderedFields.add(f));
        return false;
      }

      if (fieldsInSection.length === 0) return true;
      return fieldsInSection.some((fieldName) => {
        const fieldConfig = config.form?.[fieldName];
        return fieldConfig ? this.isFieldVisible(fieldName, fieldConfig) : true;
      });
    });

    const shown = sections.filter((section) => this.isExtraShown(section));
    const offered = sections.filter((section) => !shown.includes(section));

    // fields of sections that aren't shown mustn't fall through to the end of the form
    offered.forEach((section) =>
      this.collectFieldsFromItems(section.items).forEach((f) =>
        renderedFields.add(f)
      )
    );

    if (sections.length === 0) {
      return html``;
    }

    return html`
      <div class="extras">
        ${shown.map((section) =>
          this.renderExtraSection(section, config, renderedFields)
        )}
        ${offered.length > 0
          ? html`<div class="extra-chips">
              ${offered.map(
                (section) => html`
                  <button
                    type="button"
                    class="extra-chip"
                    @click=${() => this.handleExtraAdd(section)}
                  >
                    <temba-icon name="add" size="0.9"></temba-icon>
                    ${section.label}
                  </button>
                `
              )}
            </div>`
          : ''}
      </div>
    `;
  }

  private renderExtraSection(
    section: ExtrasSection,
    config: ActionConfig | NodeConfig,
    renderedFields: Set<string>
  ): TemplateResult {
    const removeButton =
      section.removable !== false
        ? html`<button
            type="button"
            class="extra-remove"
            title=${msg('Remove')}
            aria-label=${`${msg('Remove')} ${section.label}`}
            @click=${() => this.handleExtraRemove(section)}
          >
            <temba-icon name="close" size="0.9"></temba-icon>
          </button>`
        : '';

    if (section.sentence) {
      return html`
        <div class="extra-section sentence" data-extra=${section.label}>
          <div class="extra-line">
            <div class="extra-sentence">
              ${this.renderSentence(section, config, renderedFields)}
            </div>
            ${removeButton}
          </div>
          ${this.renderSectionErrors(section)}
        </div>
      `;
    }

    return html`
      <div class="extra-section" data-extra=${section.label}>
        <div class="extra-header">
          <span class="extra-label">${section.label}</span>
          ${removeButton}
        </div>
        <div class="extra-items">
          ${section.items.map((item) =>
            this.renderLayoutItem(item, config, renderedFields)
          )}
        </div>
      </div>
    `;
  }

  private renderSentence(
    section: ExtrasSection,
    config: ActionConfig | NodeConfig,
    renderedFields: Set<string>
  ): TemplateResult {
    const sectionFields = this.collectFieldsFromItems(section.items);
    const placed = new Set<string>();

    const parts = parseSentence(section.sentence()).map((part) => {
      if (part.type === 'text') {
        return part.text;
      }
      if (part.type === 'bold') {
        return html`<b>${part.text}</b>`;
      }
      const fieldName = section.tokens?.[part.name] ?? part.name;
      if (!sectionFields.includes(fieldName) || placed.has(fieldName)) {
        return '';
      }
      placed.add(fieldName);
      return this.renderInlineField(fieldName, config, renderedFields);
    });

    // a translation that lost a token still gets its field, at the end
    const missing = sectionFields.filter((fieldName) => !placed.has(fieldName));
    if (missing.length > 0) {
      console.warn(
        `Sentence for "${section.label}" is missing fields: ${missing.join(', ')}`
      );
    }

    return html`${parts}${missing.map(
      (fieldName) =>
        html` ${this.renderInlineField(fieldName, config, renderedFields)}`
    )}`;
  }

  private renderInlineField(
    fieldName: string,
    config: ActionConfig | NodeConfig,
    renderedFields: Set<string>
  ): TemplateResult {
    const fieldConfig = config.form?.[fieldName] as FieldConfig;
    renderedFields.add(fieldName);
    if (!fieldConfig || !this.isFieldVisible(fieldName, fieldConfig)) {
      return html``;
    }

    // the sentence is the field's label, its help shows on hover and errors show below it
    const helpText =
      typeof fieldConfig.helpText === 'function'
        ? fieldConfig.helpText(this.formData)
        : fieldConfig.helpText;

    return html`<span
      class="inline-field inline-${fieldConfig.type}"
      title=${helpText || ''}
      >${FieldRenderer.renderField(
        fieldName,
        {
          ...fieldConfig,
          helpText: undefined,
          flavor: 'xsmall',
          // a box sized for the sentence's smaller text
          ...(fieldConfig.type === 'checkbox' ? { size: 1 } : {})
        } as FieldConfig,
        this.formData[fieldName],
        {
          errors: [],
          onChange: (e: Event) => this.handleFormFieldChange(fieldName, e),
          showLabel: false,
          formData: this.formData
        }
      )}</span
    >`;
  }

  private renderSectionErrors(section: ExtrasSection): TemplateResult {
    const errors = this.collectFieldsFromItems(section.items)
      .map((fieldName) => this.errors[fieldName])
      .filter((error) => !!error);
    return errors.length > 0
      ? html`<div class="extra-errors">${errors.join(', ')}</div>`
      : html``;
  }

  private isExtraShown(section: ExtrasSection): boolean {
    if (this.revealedExtras.has(section.label)) {
      return true;
    }

    const fieldsInSection = this.collectFieldsFromItems(section.items);
    if (fieldsInSection.some((fieldName) => this.errors[fieldName])) {
      return true;
    }

    if (section.hasValue) {
      try {
        return section.hasValue(this.formData);
      } catch (error) {
        return false;
      }
    }

    return fieldsInSection.some(
      (fieldName) => !isEmptyFormValue(this.formData[fieldName])
    );
  }

  private handleExtraAdd(section: ExtrasSection): void {
    if (section.onAdd) {
      const values = section.onAdd(this.formData);
      this.formData = { ...this.formData, ...values };
      Object.keys(values).forEach((fieldName) =>
        this.updateComputedFields(fieldName)
      );
      this.updateGroupCollapseStates();
    }
    this.revealedExtras = new Set([...this.revealedExtras, section.label]);
  }

  private handleExtraRemove(section: ExtrasSection): void {
    const fieldsInSection = this.collectFieldsFromItems(section.items);

    const values: FormData = section.onRemove
      ? section.onRemove(this.formData)
      : Object.fromEntries(
          fieldsInSection.map((fieldName) => [
            fieldName,
            emptyFormValue(this.formData[fieldName])
          ])
        );
    this.formData = { ...this.formData, ...values };

    const errors = { ...this.errors };
    fieldsInSection.forEach((fieldName) => delete errors[fieldName]);
    this.errors = errors;

    const revealed = new Set(this.revealedExtras);
    revealed.delete(section.label);
    this.revealedExtras = revealed;

    Object.keys(values).forEach((fieldName) =>
      this.updateComputedFields(fieldName)
    );
    this.updateGroupCollapseStates();
    this.requestUpdate();
  }

  private handleAccordionSectionToggle(evt: CustomEvent): void {
    const label = evt.detail.label;
    const collapsed = evt.detail.collapsed;
    const stateKey = `accordion:${label}`;
    this.groupCollapseState = {
      ...this.groupCollapseState,
      [stateKey]: collapsed
    };
  }

  private collectFieldsFromItems(items: LayoutItem[]): string[] {
    const fields: string[] = [];

    items.forEach((item) => {
      if (typeof item === 'string') {
        fields.push(item);
      } else if (item.type === 'field') {
        fields.push(item.field);
      } else if (item.type === 'row') {
        fields.push(...this.collectFieldsFromItems(item.items));
      } else if (item.type === 'group') {
        fields.push(...this.collectFieldsFromItems(item.items));
      } else if (item.type === 'accordion' || item.type === 'extras') {
        item.sections.forEach((section) => {
          fields.push(...this.collectFieldsFromItems(section.items));
        });
      }
    });

    return fields;
  }

  private renderFieldRow(
    rowConfig: RowLayoutConfig,
    config: ActionConfig | NodeConfig
  ): TemplateResult {
    // This method is deprecated - use renderRow instead
    return this.renderRow(rowConfig, config, new Set());
  }

  private renderFieldGroup(
    groupConfig: GroupLayoutConfig,
    config: ActionConfig | NodeConfig
  ): TemplateResult {
    // This method is deprecated - use renderGroup instead
    return this.renderGroup(groupConfig, config, new Set());
  }

  private handleNewFieldChange(fieldName: string, value: any) {
    this.formData = {
      ...this.formData,
      [fieldName]: value
    };

    // Clear any existing error for this field
    if (this.errors[fieldName]) {
      const newErrors = { ...this.errors };
      delete newErrors[fieldName];
      this.errors = newErrors;
    }

    // Re-evaluate group collapse states that depend on form data
    this.updateGroupCollapseStates();

    // Trigger re-render
    this.requestUpdate();
  }
  private handleTemplateEditorChange(fieldName: string, event: Event): void {
    const customEvent = event as CustomEvent;
    const detail = customEvent.detail;

    this.formData = {
      ...this.formData,
      [fieldName]: detail.template
        ? { uuid: detail.template.uuid, name: detail.template.name }
        : null,
      template_variables: detail.variables || []
    };

    this.updateGroupCollapseStates();
    this.requestUpdate();
  }

  private handleMessageEditorChange(fieldName: string, event: Event): void {
    const target = event.target as any;

    // Update both text and attachments from the message editor
    this.formData = {
      ...this.formData,
      [fieldName]: target.value,
      attachments: target.attachments || []
    };

    // Clear any existing errors for both fields
    if (this.errors[fieldName]) {
      const newErrors = { ...this.errors };
      delete newErrors[fieldName];
      delete newErrors.attachments;
      this.errors = newErrors;
    }

    // Trigger re-render
    this.requestUpdate();
  }

  private renderFields(): TemplateResult {
    const config = this.getConfig();
    if (!config) {
      return html` <div>${msg('No configuration available')}</div> `;
    }

    // Special rendering for category/rule localization
    if (
      this.isTranslating &&
      config.localizable === 'categories' &&
      (this.formData.categories || this.formData.rules)
    ) {
      return this.renderLocalizationTable();
    }

    // Use the new fields configuration system
    if (config.form) {
      // If layout is specified, use it
      if (config.layout) {
        const renderedFields = new Set<string>();

        // Also collect fields from gutter to avoid rendering them in main form
        const gutterFields = new Set<string>();
        if (config.gutter) {
          const gutterFieldNames = this.collectFieldsFromItems(config.gutter);
          gutterFieldNames.forEach((field) => gutterFields.add(field));
        }

        return html`
          ${config.layout.map((item) =>
            this.renderLayoutItem(item, config, renderedFields)
          )}
          ${
            /* Render any fields not explicitly placed in layout or gutter */
            Object.entries(config.form).map(([fieldName, fieldConfig]) => {
              if (
                !renderedFields.has(fieldName) &&
                !gutterFields.has(fieldName)
              ) {
                // In translation mode, skip fields not in the localizable list
                if (
                  this.isTranslating &&
                  Array.isArray((config as ActionConfig).localizable) &&
                  !(config as ActionConfig).localizable!.includes(fieldName)
                ) {
                  return html``;
                }
                return this.renderNewField(
                  fieldName,
                  fieldConfig as FieldConfig,
                  this.formData[fieldName]
                );
              }
              return html``;
            })
          }
        `;
      } else {
        // Default rendering without layout
        return html`
          ${Object.entries(config.form).map(([fieldName, fieldConfig]) => {
            // In translation mode, skip fields not in the localizable list
            if (
              this.isTranslating &&
              Array.isArray((config as ActionConfig).localizable) &&
              !(config as ActionConfig).localizable!.includes(fieldName)
            ) {
              return html``;
            }
            return this.renderNewField(
              fieldName,
              fieldConfig as FieldConfig,
              this.formData[fieldName]
            );
          })}
        `;
      }
    }

    // Fallback for configs without form configuration
    if (this.action) {
      return html`
        <div>${msg('No form configuration available for this action')}</div>
      `;
    } else {
      return html`
        <div>${msg('No form configuration available for this node')}</div>
      `;
    }
  }

  private renderGutter(): TemplateResult {
    const config = this.getConfig();
    if (!config?.gutter || config.gutter.length === 0) {
      return html``;
    }

    // Don't show gutter when localizing categories
    if (this.isTranslating && config.localizable === 'categories') {
      return html``;
    }

    // Use the same layout rendering system for gutter fields
    const renderedFields = new Set<string>();

    return html`
      <div class="gutter-fields">
        ${config.gutter.map((item) =>
          this.renderLayoutItem(item, config, renderedFields)
        )}
      </div>
    `;
  }

  private renderActionSection(): TemplateResult {
    if (!this.node || this.node.actions.length === 0) {
      return html``;
    }

    const nodeConfig = this.getNodeConfig();

    // If node has an action config, defer to ActionEditor
    if (nodeConfig?.action) {
      const action = this.node.actions[0]; // Assume single action for now

      return html`
        <div class="action-section">
          <h3>${msg('Action Configuration')}</h3>
          <div class="action-preview">
            <p><strong>${msg('Type:')}</strong> ${action.type}</p>
            <p><em>${msg('Action details will be editable here')}</em></p>
          </div>
        </div>
      `;
    }

    return html``;
  }

  private renderRouterSection(): TemplateResult {
    if (!this.node?.router) {
      return html``;
    }

    const nodeConfig = this.getNodeConfig();

    return html`
      <div class="router-section">
        <h3>${msg('Router Configuration')}</h3>
        ${nodeConfig?.router
          ? this.renderRouterConfig()
          : html`<p>${msg('Basic router (no advanced configuration)')}</p>`}
      </div>
    `;
  }

  private renderRouterConfig(): TemplateResult {
    const nodeConfig = this.getNodeConfig();
    if (!nodeConfig?.router) return html``;

    // Render router configuration based on node config
    // This is where you'd render rule and category editors
    return html`
      <div class="router-config">
        <p><strong>${msg('Type:')}</strong> ${nodeConfig.router.type}</p>
        ${nodeConfig.router.rules
          ? html`
              <div class="rules-section">
                <h4>${msg('Rules')}</h4>
                <!-- Future: Render rule editor based on nodeConfig.router.rules -->
                <p><em>${msg('Rule editing will be implemented here')}</em></p>
              </div>
            `
          : ''}
      </div>
    `;
  }

  private handleIssueClick(issue: FlowIssue): void {
    this.fireCustomEvent(CustomEventType.ShowIssue, { issue });
  }

  private renderIssueWarnings(): TemplateResult | string {
    const issues: FlowIssue[] = [];

    // Check for action-level issues
    if (this.action && this.issuesByAction?.has(this.action.uuid)) {
      issues.push(...this.issuesByAction.get(this.action.uuid));
    }

    // Check for node-level issues (issues without action_uuid)
    if (this.node && this.issuesByNode?.has(this.node.uuid)) {
      issues.push(...this.issuesByNode.get(this.node.uuid));
    }

    if (issues.length === 0) return '';

    return html`
      ${issues.map(
        (issue) => html`
          <div
            class="issue-warning"
            @click=${() => this.handleIssueClick(issue)}
          >
            <temba-icon name="alert_warning" size="1.2"></temba-icon>
            <span class="issue-text">${formatIssueMessage(issue)}</span>
          </div>
        `
      )}
    `;
  }

  render(): TemplateResult {
    if (!this.isOpen) {
      return html``;
    }

    const headerColor = this.isTranslating ? '#505050' : this.getHeaderColor();
    const headerTextColor = this.isTranslating ? '#fff' : '#fff';
    const config = this.getConfig();
    const dialogSize = config?.dialogSize || 'medium'; // Default to 'large' if not specified

    const languageName = this.isTranslating
      ? getLanguageName(this.languageCode)
      : '';

    let header = config?.name || msg('Edit');
    if (this.isTranslating) {
      header = languageName ? msg(str`${languageName} - ${header}`) : header;
    }

    return html`
      <temba-dialog
        header="${header}"
        subtitle="${config?.subtitle || ''}"
        .open="${this.isOpen}"
        .originX=${this.dialogOrigin?.x ?? null}
        .originY=${this.dialogOrigin?.y ?? null}
        .checkForChanges=${() => this.hasUnsavedChanges()}
        @temba-button-clicked=${this.handleDialogButtonClick}
        primaryButtonName="${msg('Save')}"
        cancelButtonName="${msg('Cancel')}"
        style="--header-bg: ${headerColor}; --header-text: ${headerTextColor};"
        size="${dialogSize}"
      >
        <div class="node-editor-form">
          ${this.renderFields()}
          ${this.getNodeConfig()?.router?.configurable
            ? this.renderRouterSection()
            : null}
          ${this.renderIssueWarnings()}
        </div>

        <div slot="gutter">${this.renderGutter()}</div>
      </temba-dialog>
    `;
  }
}
