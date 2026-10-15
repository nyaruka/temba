import { html, TemplateResult } from 'lit-html';
import { css } from 'lit';
import { msg } from '@lit/localize';
import { RapidElement } from '../RapidElement';
import {
  Action,
  Category,
  FlowDefinition,
  Node
} from '../store/flow-definition';
import { AppState, fromStore, zustand } from '../store/AppState';
import { CustomEventType } from '../interfaces';
import { renderHighlightedText } from './utils';
import { Icon } from '../Icons';
import { ACTION_CONFIG, NODE_CONFIG } from './config';
import { ACTION_GROUP_METADATA, SPLIT_GROUP_METADATA } from './types';
import { getOperatorConfig } from './operators';
import { getTranslatableCategoriesForNode } from './categoryLocalization';

interface MessageEntry {
  kind: 'message';
  node: Node;
  action: Action & Record<string, any>;
  nodeIndex: number;
}

interface LocalizationGroupEntry {
  kind: 'localization-group';
  node: Node;
  rules: Array<{ uuid: string; type: string; arguments: string[] }>;
  categories: Category[];
  nodeIndex: number;
}

type TableEntry = MessageEntry | LocalizationGroupEntry;

export class MessageTable extends RapidElement {
  static get styles() {
    return css`
      :host {
        display: block;
        overflow: auto;
        flex: 1;
        background: #fff;
        font-family: var(--font-family);
      }

      .message-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }

      .message-table th {
        text-align: left;
        padding: 10px 16px;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #888;
        border-bottom: 2px solid #e8e8e8;
        background: #fff;
      }

      .message-table td {
        padding: 12px 16px;
        border-bottom: 1px solid #f0f0f0;
        vertical-align: top;
        position: relative;
      }

      .message-table td.translation-td {
        padding: 8px;
        height: 1px;
      }

      .message-table tr.category-row td {
        padding: 8px 16px;
      }

      .message-table tr.category-row td.translation-td {
        padding: 8px;
      }

      .message-table tr.localization-paired-row td {
        padding: 2px 16px 2px 26px;
      }

      .message-table
        tr.localization-paired-row:not(.localization-paired-last)
        td {
        border-bottom: none;
      }

      .message-table tr.localization-paired-row td.translation-td {
        padding: 2px 8px;
      }

      .message-table tr.localization-paired-first td,
      .message-table tr.localization-paired-first td.translation-td {
        padding-top: 12px;
      }

      .message-table tr.localization-paired-last td,
      .message-table tr.localization-paired-last td.translation-td {
        padding-bottom: 12px;
      }

      .localization-paired-row td:first-child {
        position: relative;
      }

      .localization-paired-row td:first-child::before {
        content: '';
        position: absolute;
        left: 10px;
        top: 0;
        bottom: 0;
        width: 4px;
        background: var(--node-rail-color, #d1d5db);
      }

      .localization-paired-first td:first-child::before {
        top: 8px;
      }

      .localization-paired-last td:first-child::before {
        bottom: 8px;
      }

      .localization-paired-row .message-cell::before {
        display: none;
      }

      .localization-paired-row td.translation-td {
        height: 1px;
      }

      .localization-paired-row .translation-cell {
        height: 100%;
        display: flex;
        align-items: stretch;
      }

      .localization-paired-row .category-translation-item {
        display: flex;
        align-items: center;
        flex: 1;
      }

      .message-table td.rail-td {
        padding: 8px 8px 8px 20px;
        height: 1px;
      }

      .message-table td.rail-td::before {
        content: '';
        position: absolute;
        left: 10px;
        top: 8px;
        bottom: 8px;
        width: 4px;
        background: var(--node-rail-color, #d1d5db);
      }

      .message-cell {
        cursor: pointer;
        border-radius: 6px;
        padding: 12px 12px;
        min-height: 100%;
        box-sizing: border-box;
        transition: background 0.15s;
        word-wrap: break-word;
        line-height: 1.5;
        font-size: 14px;
        color: #333;
      }

      .message-cell:hover {
        background: #f5f8ff;
      }

      .category-stack {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .category-stack-original {
        padding-left: 14px;
      }

      .category-item {
        display: flex;
        align-items: center;
        width: 100%;
        box-sizing: border-box;
        border-radius: 6px;
        padding: 10px 12px;
        font-size: 14px;
        line-height: 1.5;
      }

      .category-original-item {
        color: #334155;
        background: #f7f9fc;
      }

      .rule-operator {
        font-size: 11px;
        color: #999;
        margin-right: 4px;
      }

      .category-translation-item {
        width: 100%;
        box-sizing: border-box;
        border-radius: 6px;
        padding: 10px 12px;
        font-size: 14px;
        line-height: 1.5;
        color: #333;
        background: transparent;
      }

      .category-translation-item.missing {
        color: #bbb;
        font-style: italic;
        background: #fafafa;
      }

      .translation-cell {
        cursor: pointer;
        border-radius: 6px;
        padding: 10px 12px;
        min-height: 100%;
        box-sizing: border-box;
        transition: background 0.15s;
        word-wrap: break-word;
        line-height: 1.5;
        font-size: 14px;
        height: 100%;
      }

      .translation-cell:hover {
        background: #f5f8ff;
      }

      .translation-cell.category-translation-cell {
        padding: 0;
        border-radius: 0;
        background: transparent;
      }

      .message-cell.category-message-cell {
        margin: 0 -6px;
        padding: 0;
        border-radius: 0;
        background: transparent;
      }

      .translation-cell.category-translation-cell:hover {
        background: transparent;
      }

      .message-cell.category-message-cell:hover {
        background: transparent;
      }

      .message-cell.category-message-cell .category-original-item {
        transition: background 0.15s;
      }

      .message-cell.category-message-cell:hover .category-original-item {
        background: #f0f4f9;
      }

      .translation-cell.category-translation-cell .category-translation-item {
        transition: background 0.15s;
      }

      .translation-cell.category-translation-cell:hover
        .category-translation-item {
        background: #f5f8ff;
      }

      .translation-cell.category-translation-cell:hover
        .category-translation-item.missing {
        color: #9bb8df;
      }

      .translation-cell.has-translation {
        color: #333;
      }

      .translation-cell.missing-translation {
        color: #bbb;
        font-style: italic;
        background: #fafafa;
      }

      .translation-cell.missing-translation:hover {
        background: #f5f8ff;
        color: #9bb8df;
      }

      .quick-replies {
        margin-top: 0.5em;
        display: flex;
        flex-wrap: wrap;
      }

      .quick-replies.standalone {
        margin-top: 0;
      }

      .quick-reply {
        border: 1px solid rgb(60, 146, 221);
        border-radius: 18px;
        padding: 2px 6px;
        font-size: 11px;
        color: rgb(60, 146, 221);
        margin: 0.15em;
        background: #fff;
      }

      .attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 0.5em;
      }

      .attachments.standalone {
        margin-top: 0;
      }

      .attachment-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        background: #fafafa;
      }

      .attachment-icon temba-icon {
        --icon-size: 18px;
        --icon-color: #888;
      }

      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 1;
        color: #999;
        font-size: 14px;
        padding: 60px 20px;
        text-align: center;
      }
    `;
  }

  @fromStore(zustand, (state: AppState) => state.flowDefinition)
  private definition!: FlowDefinition;

  @fromStore(zustand, (state: AppState) => state.languageCode)
  private languageCode!: string;

  @fromStore(zustand, (state: AppState) => state.isTranslating)
  private isTranslating!: boolean;

  private getEntries(): TableEntry[] {
    if (!this.definition?.nodes) return [];

    const entries: TableEntry[] = [];
    let nodeIndex = 0;

    for (const node of this.definition.nodes) {
      nodeIndex++;
      for (const action of node.actions || []) {
        const actionConfig = ACTION_CONFIG[action.type];
        if (
          action.type === 'send_msg' ||
          (actionConfig?.localizable && actionConfig.localizable.length > 0)
        ) {
          entries.push({
            kind: 'message',
            node,
            action,
            nodeIndex
          });
        }
      }

      if (!this.isTranslating) continue;

      const nodeUI = this.definition?._ui?.nodes?.[node.uuid];
      const nodeType = nodeUI?.type;

      // Collect rules that have localized values or are flagged for localization
      const langLocalization =
        this.definition?.localization?.[this.languageCode] || {};
      let rules: Array<{ uuid: string; type: string; arguments: string[] }> =
        [];
      if (node.router?.cases?.length) {
        const hasLocalizeRules = nodeUI?.config?.localizeRules;
        rules = node.router.cases
          .filter((c) => c.arguments?.length > 0 && c.arguments.some((a) => a))
          .filter(
            (c) =>
              hasLocalizeRules ||
              langLocalization[c.uuid]?.arguments?.some((a: string) => a)
          )
          .map((c) => ({
            uuid: c.uuid,
            type: c.type,
            arguments: [...c.arguments]
          }));
      }

      // Collect categories that have localized values or are flagged for localization
      let categories: Category[] = [];
      if (
        nodeType &&
        NODE_CONFIG[nodeType]?.localizable === 'categories' &&
        node.router?.categories?.length
      ) {
        const hasLocalizeCategories = nodeUI?.config?.localizeCategories;
        const translatableCategories = getTranslatableCategoriesForNode(
          nodeType,
          node.router.categories
        );
        if (hasLocalizeCategories) {
          categories = translatableCategories;
        } else {
          categories = translatableCategories.filter((cat) =>
            langLocalization[cat.uuid]?.name?.some((n: string) => n)
          );
        }
      }

      if (rules.length > 0 || categories.length > 0) {
        entries.push({
          kind: 'localization-group',
          node,
          rules,
          categories,
          nodeIndex
        });
      }
    }

    return entries;
  }

  public focusSearchResult(nodeUuid: string, actionUuid: string | null): void {
    const rows = Array.from(
      this.renderRoot.querySelectorAll('tr[data-node-uuid]')
    ) as HTMLTableRowElement[];
    if (!rows.length) {
      return;
    }

    let target = actionUuid
      ? rows.find(
          (row) =>
            row.dataset.nodeUuid === nodeUuid &&
            row.dataset.actionUuid === actionUuid
        )
      : rows.find(
          (row) =>
            row.dataset.nodeUuid === nodeUuid &&
            row.dataset.entryKind === 'category-group'
        );

    if (!target) {
      target = rows.find((row) => row.dataset.nodeUuid === nodeUuid);
    }

    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  private getTranslatedText(actionUuid: string): string | null {
    if (!this.isTranslating || !this.languageCode) return null;

    const localization =
      this.definition?.localization?.[this.languageCode]?.[actionUuid];
    if (localization?.text && Array.isArray(localization.text)) {
      return localization.text[0] || null;
    }
    return null;
  }

  private getTranslatedQuickReplies(actionUuid: string): string[] {
    if (!this.isTranslating || !this.languageCode) return [];

    const localization =
      this.definition?.localization?.[this.languageCode]?.[actionUuid];
    if (!Array.isArray(localization?.quick_replies)) {
      return [];
    }

    return localization.quick_replies
      .map((reply: unknown) => (typeof reply === 'string' ? reply.trim() : ''))
      .filter((reply: string) => reply.length > 0);
  }

  private stripLeadingLineBreaks(text: string): string {
    return text.replace(/^(?:\r?\n)+/, '');
  }

  private getTranslatedCategoryName(categoryUuid: string): string | null {
    if (!this.isTranslating || !this.languageCode) return null;

    const localization =
      this.definition?.localization?.[this.languageCode]?.[categoryUuid];
    if (!localization?.name) {
      return null;
    }
    if (Array.isArray(localization.name)) {
      return localization.name[0] || null;
    }
    return typeof localization.name === 'string' ? localization.name : null;
  }

  private static ATTACHMENT_ICONS: Record<string, string> = {
    image: Icon.attachment_image,
    audio: Icon.attachment_audio,
    video: Icon.attachment_video,
    application: Icon.attachment_document
  };

  private getTranslatedField(actionUuid: string, field: string): string | null {
    if (!this.isTranslating || !this.languageCode) return null;
    const localization =
      this.definition?.localization?.[this.languageCode]?.[actionUuid];
    if (localization?.[field] && Array.isArray(localization[field])) {
      return localization[field][0] || null;
    }
    return null;
  }

  private getTranslatedArrayField(actionUuid: string, field: string): string[] {
    if (!this.isTranslating || !this.languageCode) return [];
    const localization =
      this.definition?.localization?.[this.languageCode]?.[actionUuid];
    if (Array.isArray(localization?.[field])) {
      return localization[field];
    }
    return [];
  }

  private hasAnyTranslation(entry: MessageEntry): boolean {
    const config = ACTION_CONFIG[entry.action.type];
    if (!config?.localizable) return false;
    const localization =
      this.definition?.localization?.[this.languageCode]?.[entry.action.uuid];
    if (!localization) return false;
    return config.localizable.some((key) => {
      const val = localization[key];
      if (Array.isArray(val)) {
        return val.some((v: any) => typeof v === 'string' && v.trim());
      }
      return false;
    });
  }

  /**
   * Whether an action should render as paired rows (one per localizable field).
   * Used for actions with multiple text fields like send_email.
   */
  private usesPairedRows(action: Action): boolean {
    const config = ACTION_CONFIG[action.type];
    if (!config?.localizable) return false;
    // Count string-type localizable fields (exclude arrays like attachments, quick_replies)
    const textFields = config.localizable.filter((key) => {
      const fieldConfig = config.form?.[key];
      return (
        fieldConfig &&
        (fieldConfig.type === 'text' || fieldConfig.type === 'textarea')
      );
    });
    return textFields.length > 1;
  }

  /**
   * Get the localizable text fields for paired-row rendering.
   */
  private getPairedFields(action: Action & Record<string, any>): Array<{
    key: string;
    label: string;
    original: string;
    translated: string | null;
  }> {
    const config = ACTION_CONFIG[action.type];
    if (!config?.localizable || !config.form) return [];
    return config.localizable
      .filter((key) => {
        const fieldConfig = config.form?.[key];
        return (
          fieldConfig &&
          (fieldConfig.type === 'text' || fieldConfig.type === 'textarea')
        );
      })
      .map((key) => {
        const fieldConfig = config.form![key];
        const label =
          typeof fieldConfig.label === 'string' ? fieldConfig.label : key;
        return {
          key,
          label,
          original: action[key] || '',
          translated: this.getTranslatedField(action.uuid, key)
        };
      });
  }

  private renderAttachments(attachments: string[]): TemplateResult {
    if (!attachments || attachments.length === 0) return html``;
    return html`<div class="attachments">
      ${attachments.map((att) => {
        const colonIdx = att.indexOf(':');
        if (colonIdx < 0) return html``;
        const contentType = att.substring(0, colonIdx);
        const baseType = contentType.split('/')[0];
        const iconName =
          MessageTable.ATTACHMENT_ICONS[baseType] || Icon.attachment;
        return html`<div class="attachment-icon">
          <temba-icon name="${iconName}"></temba-icon>
        </div>`;
      })}
    </div>`;
  }

  private renderOriginalContent(entry: MessageEntry): TemplateResult {
    const action = entry.action;
    const config = ACTION_CONFIG[action.type];
    const localizable = config?.localizable || [];

    const parts: TemplateResult[] = [];

    // Render all localizable text fields
    if (config?.form) {
      for (const key of localizable) {
        const fc = config.form[key];
        if (
          fc &&
          (fc.type === 'text' ||
            fc.type === 'textarea' ||
            fc.type === 'message-editor')
        ) {
          const text = action[key] || '';
          if (text) {
            parts.push(
              renderHighlightedText(this.stripLeadingLineBreaks(text), true)
            );
          }
        }
      }
    }

    // Quick replies (send_msg)
    const quickReplies: string[] = action.quick_replies || [];
    if (quickReplies.length > 0) {
      parts.push(
        html`<div
          class="quick-replies ${parts.length === 0 ? 'standalone' : ''}"
        >
          ${quickReplies.map(
            (reply) => html`<div class="quick-reply">${reply}</div>`
          )}
        </div>`
      );
    }

    // Attachments
    const attachments: string[] = action.attachments || [];
    if (attachments.length > 0) {
      parts.push(this.renderAttachments(attachments));
    }

    if (parts.length === 0) {
      return html`<span style="color: #bbb; font-style: italic;"
        >${msg('Empty')}</span
      >`;
    }

    return html`${parts}`;
  }

  private renderTranslatedContent(entry: MessageEntry): TemplateResult {
    const action = entry.action;
    const config = ACTION_CONFIG[action.type];
    const localizable = config?.localizable || [];

    const parts: TemplateResult[] = [];

    // Translated text fields
    if (config?.form) {
      for (const key of localizable) {
        const fc = config.form[key];
        if (
          fc &&
          (fc.type === 'text' ||
            fc.type === 'textarea' ||
            fc.type === 'message-editor')
        ) {
          const translatedText = this.getTranslatedField(action.uuid, key);
          if (typeof translatedText === 'string') {
            parts.push(
              renderHighlightedText(
                this.stripLeadingLineBreaks(translatedText),
                true
              )
            );
          }
        }
      }
    }

    // Translated quick replies
    const translatedQuickReplies = this.getTranslatedQuickReplies(action.uuid);
    if (translatedQuickReplies.length > 0) {
      parts.push(
        html`<div
          class="quick-replies ${parts.length === 0 ? 'standalone' : ''}"
        >
          ${translatedQuickReplies.map(
            (reply) => html`<div class="quick-reply">${reply}</div>`
          )}
        </div>`
      );
    }

    // Translated attachments
    const translatedAttachments = this.getTranslatedArrayField(
      action.uuid,
      'attachments'
    );
    if (translatedAttachments.length > 0) {
      parts.push(this.renderAttachments(translatedAttachments));
    }

    if (parts.length === 0) {
      return html`${msg('No translation')}`;
    }

    return html`${parts}`;
  }

  private handleBaseTextClick(entry: MessageEntry): void {
    this.fireCustomEvent(CustomEventType.ActionEditRequested, {
      action: entry.action,
      nodeUuid: entry.node.uuid,
      forceBase: true
    });
  }

  private handleTranslationClick(entry: MessageEntry): void {
    this.fireCustomEvent(CustomEventType.ActionEditRequested, {
      action: entry.action,
      nodeUuid: entry.node.uuid
    });
  }

  private handleBaseGroupClick(entry: LocalizationGroupEntry): void {
    const nodeUI = this.definition?._ui?.nodes?.[entry.node.uuid];
    if (!nodeUI) {
      return;
    }

    this.fireCustomEvent(CustomEventType.NodeEditRequested, {
      node: entry.node,
      nodeUI,
      forceBase: true
    });
  }

  private handleGroupTranslationClick(entry: LocalizationGroupEntry): void {
    const nodeUI = this.definition?._ui?.nodes?.[entry.node.uuid];
    if (!nodeUI) {
      return;
    }

    this.fireCustomEvent(CustomEventType.NodeEditRequested, {
      node: entry.node,
      nodeUI
    });
  }

  private getGroupTranslations(entry: LocalizationGroupEntry): Array<{
    original: string;
    translated: string | null;
    isRule: boolean;
    operatorName?: string;
  }> {
    const ruleItems = entry.rules.map((c) => {
      const original = c.arguments.join(', ');
      const operatorName = getOperatorConfig(c.type)?.name || c.type;
      const localization =
        this.definition?.localization?.[this.languageCode]?.[c.uuid];
      const translated = Array.isArray(localization?.arguments)
        ? localization.arguments.join(', ')
        : null;
      return { original, translated, isRule: true, operatorName };
    });

    const categoryItems = entry.categories.map((category) => ({
      original: category.name,
      translated: this.getTranslatedCategoryName(category.uuid),
      isRule: false
    }));

    return [...ruleItems, ...categoryItems];
  }

  private getEntryRailColor(entry: TableEntry): string {
    if (entry.kind === 'message') {
      const actionConfig = ACTION_CONFIG[entry.action.type];
      const actionGroup = actionConfig?.group;
      return actionGroup
        ? ACTION_GROUP_METADATA[actionGroup]?.color || '#cbd5e1'
        : '#cbd5e1';
    }

    const nodeType = this.definition?._ui?.nodes?.[entry.node.uuid]?.type;
    if (!nodeType) {
      return '#cbd5e1';
    }

    const nodeConfig = NODE_CONFIG[nodeType];
    const nodeGroup = nodeConfig?.group;
    if (!nodeGroup) {
      return '#cbd5e1';
    }

    return (
      ACTION_GROUP_METADATA[nodeGroup]?.color ||
      SPLIT_GROUP_METADATA[nodeGroup]?.color ||
      '#cbd5e1'
    );
  }

  private renderPairedRows(
    items: Array<{
      original: TemplateResult;
      translated: TemplateResult | null;
    }>,
    entry: TableEntry,
    handleBaseClick: () => void,
    handleTranslationClick: () => void,
    showTranslation: boolean
  ): TemplateResult {
    return html`
      ${items.map(
        (item, idx) => html`
          <tr
            class="category-row localization-paired-row ${idx === 0
              ? 'localization-paired-first'
              : ''} ${idx === items.length - 1
              ? 'localization-paired-last'
              : ''}"
            style=${`--node-rail-color: ${this.getEntryRailColor(entry)};`}
            data-node-uuid=${entry.node.uuid}
            data-entry-kind=${entry.kind}
            data-action-uuid=${entry.kind === 'message'
              ? entry.action.uuid
              : ''}
          >
            <td>
              <div
                class="message-cell category-message-cell"
                @click=${handleBaseClick}
                title=${msg('Click to edit')}
              >
                <div class="category-item category-original-item">
                  <span>${item.original}</span>
                </div>
              </div>
            </td>
            ${showTranslation
              ? html`<td class="translation-td">
                  <div
                    class="translation-cell category-translation-cell"
                    @click=${handleTranslationClick}
                    title=${msg('Click to edit translation')}
                  >
                    <div
                      class="category-item category-translation-item ${item.translated !==
                      null
                        ? ''
                        : 'missing'}"
                    >
                      <span
                        >${item.translated !== null
                          ? item.translated
                          : msg('No translation')}</span
                      >
                    </div>
                  </div>
                </td>`
              : ''}
          </tr>
        `
      )}
    `;
  }

  public render(): TemplateResult {
    const entries = this.getEntries();

    if (entries.length === 0) {
      return html`<div class="empty-state">
        ${msg('No messages or localizable content in this flow.')}
      </div>`;
    }

    const showTranslation = this.isTranslating;

    return html`
      <table class="message-table">
        <thead>
          <tr>
            <th>
              ${showTranslation ? msg('Original Text') : msg('Message Text')}
            </th>
            ${showTranslation ? html`<th>${msg('Translation')}</th>` : ''}
          </tr>
        </thead>
        <tbody>
          ${entries.map((entry) => {
            const isGroupEntry = entry.kind === 'localization-group';

            const handleBaseClick = () => {
              if (entry.kind === 'message') this.handleBaseTextClick(entry);
              else if (isGroupEntry) this.handleBaseGroupClick(entry);
            };
            const handleTranslationClickFn = () => {
              if (entry.kind === 'message') this.handleTranslationClick(entry);
              else if (isGroupEntry) this.handleGroupTranslationClick(entry);
            };

            // Localization group entries (rules/categories) - always paired rows
            if (isGroupEntry && showTranslation) {
              const groupTranslations = this.getGroupTranslations(entry);
              const items = groupTranslations.map((item) => ({
                original: html`${item.isRule && item.operatorName
                  ? html`<span class="rule-operator"
                      >${item.operatorName}</span
                    > `
                  : ''}${renderHighlightedText(item.original, true)}`,
                translated:
                  item.translated !== null
                    ? html`${item.isRule && item.operatorName
                        ? html`<span class="rule-operator"
                            >${item.operatorName}</span
                          > `
                        : ''}${renderHighlightedText(item.translated, true)}`
                    : null
              }));
              return this.renderPairedRows(
                items,
                entry,
                handleBaseClick,
                handleTranslationClickFn,
                showTranslation
              );
            }

            // Multi-field actions (e.g. send_email with subject + body) - paired rows
            if (entry.kind === 'message' && this.usesPairedRows(entry.action)) {
              const fields = this.getPairedFields(entry.action);
              const items = fields.map((f) => ({
                original: html`${f.original
                  ? renderHighlightedText(
                      this.stripLeadingLineBreaks(f.original),
                      true
                    )
                  : html`<span style="color: #bbb; font-style: italic;"
                      >${msg('Empty')}</span
                    >`}`,
                translated:
                  f.translated !== null
                    ? html`${renderHighlightedText(
                        this.stripLeadingLineBreaks(f.translated),
                        true
                      )}`
                    : null
              }));
              return this.renderPairedRows(
                items,
                entry,
                handleBaseClick,
                handleTranslationClickFn,
                showTranslation
              );
            }

            // Single-row entries (send_msg, send_broadcast, etc.)
            const hasTranslation =
              entry.kind === 'message' &&
              showTranslation &&
              this.hasAnyTranslation(entry);
            const translationCellClass = `translation-cell ${
              hasTranslation ? 'has-translation' : 'missing-translation'
            }`;

            return html`
              <tr
                style=${`--node-rail-color: ${this.getEntryRailColor(entry)};`}
                data-node-uuid=${entry.node.uuid}
                data-entry-kind=${entry.kind}
                data-action-uuid=${entry.kind === 'message'
                  ? entry.action.uuid
                  : ''}
              >
                <td class="rail-td">
                  <div
                    class="message-cell"
                    @click=${handleBaseClick}
                    title=${msg('Click to edit')}
                  >
                    ${entry.kind === 'message'
                      ? this.renderOriginalContent(entry)
                      : isGroupEntry
                        ? html`
                            <div class="category-stack category-stack-original">
                              ${entry.rules.map(
                                (c) => html`
                                  <div
                                    class="category-item category-original-item"
                                  >
                                    <span
                                      ><span class="rule-operator"
                                        >${getOperatorConfig(c.type)?.name ||
                                        c.type}</span
                                      >
                                      ${renderHighlightedText(
                                        c.arguments.join(', '),
                                        true
                                      )}</span
                                    >
                                  </div>
                                `
                              )}
                              ${entry.categories.map(
                                (category) => html`
                                  <div
                                    class="category-item category-original-item"
                                  >
                                    <span
                                      >${renderHighlightedText(
                                        category.name,
                                        true
                                      )}</span
                                    >
                                  </div>
                                `
                              )}
                            </div>
                          `
                        : ''}
                  </div>
                </td>
                ${showTranslation
                  ? html`<td class="translation-td">
                      <div
                        class=${translationCellClass}
                        @click=${handleTranslationClickFn}
                        title=${msg('Click to edit translation')}
                      >
                        ${entry.kind === 'message'
                          ? this.renderTranslatedContent(entry)
                          : msg('No translation')}
                      </div>
                    </td>`
                  : ''}
              </tr>
            `;
          })}
        </tbody>
      </table>
    `;
  }
}
