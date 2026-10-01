import { msg } from '@lit/localize';
import { property } from 'lit/decorators.js';
import {
  FlowDefinition,
  Node,
  Action,
  SendMsg,
  SetRunResult,
  SetContactField,
  SetContactName,
  SendEmail,
  SendBroadcast,
  EnterFlow,
  StartSession,
  CallWebhook,
  CallResthook,
  CallClassifier,
  CallLLM,
  OpenTicket,
  AddToGroup,
  RemoveFromGroup,
  SetContactChannel,
  SetContactLanguage,
  SetContactStatus,
  AddContactUrn,
  AddInputLabels,
  RequestOptin,
  SayMsg,
  PlayAudio,
  NodeUI
} from '../store/flow-definition';
import { ACTION_CONFIG, NODE_CONFIG } from './config';
import {
  ACTION_GROUP_METADATA,
  SPLIT_GROUP_METADATA,
  ActionConfig,
  NodeConfig
} from './types';
import { localizeAction } from './utils';
import { getTranslatableCategoriesForNode } from './categoryLocalization';
import { ModalSearchResult, SearchModal } from '../layout/SearchModal';

// Sticky note badge colors: border matches the sticky's border, fill is 25% lighter
const STICKY_BADGE_COLORS: Record<
  string,
  { border: string; fill: string; text: string }
> = {
  yellow: { border: '#facc15', fill: '#fcd94d', text: '#713f12' },
  blue: { border: '#3b82f6', fill: '#6ca1f8', text: '#fff' },
  pink: { border: '#ec4899', fill: '#f17ab7', text: '#fff' },
  green: { border: '#10b981', fill: '#48ca9d', text: '#fff' },
  gray: { border: '#6b7280', fill: '#8f949f', text: '#fff' }
};

export interface SearchResult extends ModalSearchResult {
  nodeUuid: string;
  // For actions: the action object; for nodes (splits): null
  action: Action | null;
  // For sticky notes: which field matched ('title' or 'body')
  stickyField?: 'title' | 'body';
}

type SearchScope = 'flow' | 'table';

/**
 * Extract searchable text from an action.
 * Returns an array of text strings to search through.
 */
function getActionSearchTexts(action: Action): string[] {
  const texts: string[] = [];
  switch (action.type) {
    case 'send_msg': {
      const a = action as SendMsg;
      if (a.text) texts.push(a.text);
      if (a.quick_replies) texts.push(...a.quick_replies);
      if (a.template?.name) texts.push(a.template.name);
      break;
    }
    case 'send_email': {
      const a = action as SendEmail;
      if (a.subject) texts.push(a.subject);
      if (a.body) texts.push(a.body);
      if (a.addresses) texts.push(...a.addresses);
      break;
    }
    case 'send_broadcast': {
      const a = action as SendBroadcast;
      if (a.text) texts.push(a.text);
      if (a.groups) texts.push(...a.groups.map((g) => g.name));
      if (a.contacts) texts.push(...a.contacts.map((c) => c.name));
      if (a.template?.name) texts.push(a.template.name);
      break;
    }
    case 'say_msg': {
      const a = action as SayMsg;
      if (a.text) texts.push(a.text);
      break;
    }
    case 'play_audio': {
      const a = action as PlayAudio;
      if (a.audio_url) texts.push(a.audio_url);
      break;
    }
    case 'set_contact_name': {
      const a = action as SetContactName;
      if (a.name) texts.push(a.name);
      break;
    }
    case 'set_contact_field': {
      const a = action as SetContactField;
      if (a.field?.name) texts.push(a.field.name);
      if (a.value) texts.push(a.value);
      break;
    }
    case 'set_contact_language': {
      const a = action as SetContactLanguage;
      if (a.language) texts.push(a.language);
      break;
    }
    case 'set_contact_status': {
      const a = action as SetContactStatus;
      if (a.status) texts.push(a.status);
      break;
    }
    case 'set_contact_channel': {
      const a = action as SetContactChannel;
      if (a.channel?.name) texts.push(a.channel.name);
      break;
    }
    case 'add_contact_urn': {
      const a = action as AddContactUrn;
      if (a.path) texts.push(a.path);
      break;
    }
    case 'add_contact_groups': {
      const a = action as AddToGroup;
      if (a.groups) texts.push(...a.groups.map((g) => g.name));
      break;
    }
    case 'remove_contact_groups': {
      const a = action as RemoveFromGroup;
      if (a.groups) texts.push(...a.groups.map((g) => g.name));
      break;
    }
    case 'add_input_labels': {
      const a = action as AddInputLabels;
      if (a.labels) texts.push(...a.labels.map((l) => l.name));
      break;
    }
    case 'set_run_result': {
      const a = action as SetRunResult;
      if (a.name) texts.push(a.name);
      if (a.value) texts.push(a.value);
      if (a.category) texts.push(a.category);
      break;
    }
    case 'enter_flow': {
      const a = action as EnterFlow;
      if (a.flow?.name) texts.push(a.flow.name);
      break;
    }
    case 'start_session': {
      const a = action as StartSession;
      if (a.flow?.name) texts.push(a.flow.name);
      if (a.groups) texts.push(...a.groups.map((g) => g.name));
      if (a.contacts) texts.push(...a.contacts.map((c) => c.name));
      break;
    }
    case 'request_optin': {
      const a = action as RequestOptin;
      if (a.optin?.name) texts.push(a.optin.name);
      break;
    }
    case 'call_webhook': {
      const a = action as CallWebhook;
      if (a.url) texts.push(a.url);
      if (a.body) texts.push(a.body);
      break;
    }
    case 'call_resthook': {
      const a = action as CallResthook;
      if (a.resthook) texts.push(a.resthook);
      break;
    }
    case 'call_llm': {
      const a = action as CallLLM;
      if (a.llm?.name) texts.push(a.llm.name);
      if (a.instructions) texts.push(a.instructions);
      if (a.input) texts.push(a.input);
      break;
    }
    case 'call_classifier': {
      const a = action as CallClassifier;
      if (a.model?.name) texts.push(a.model.name);
      if (a.input) texts.push(a.input);
      a.options?.forEach((o) => {
        if (o.description) texts.push(o.description);
      });
      break;
    }
    case 'open_ticket': {
      const a = action as OpenTicket;
      if (a.topic?.name) texts.push(a.topic.name);
      if (a.subject) texts.push(a.subject);
      if (a.body) texts.push(a.body);
      if (a.assignee?.name) texts.push(a.assignee.name);
      break;
    }
  }
  return texts;
}

function getTableSearchTexts(action: Action): string[] {
  const texts: string[] = [];
  const config = ACTION_CONFIG[action.type];
  if (!config?.localizable) return texts;
  const a = action as Record<string, any>;
  for (const key of config.localizable) {
    const val = a[key];
    if (typeof val === 'string' && val.trim()) {
      texts.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.trim()) {
          texts.push(item);
        }
      }
    }
  }
  return texts;
}

/**
 * Get searchable text from node-level data (router operand, categories, result name, etc.)
 */
function getNodeSearchTexts(
  node: Node,
  nodeUI: NodeUI,
  langLocalization?: Record<string, Record<string, any>>
): string[] {
  const texts: string[] = [];

  // Router operand
  if (node.router?.operand) {
    texts.push(node.router.operand);
  }

  // Result name
  if (node.router?.result_name) {
    texts.push(node.router.result_name);
  }

  // Category names (localized if available)
  if (node.router?.categories) {
    for (const cat of node.router.categories) {
      if (cat.name && cat.name !== 'Other' && cat.name !== 'All Responses') {
        texts.push(localizeCategoryName(cat.uuid, cat.name, langLocalization));
      }
    }
  }

  // Case arguments (rule values like keywords, numbers, etc.)
  if (node.router?.cases) {
    for (const c of node.router.cases) {
      if (c.arguments) {
        for (const arg of c.arguments) {
          if (arg) texts.push(arg);
        }
      }
    }
  }

  // Config-level name (e.g. for split_by_contact_field with custom title)
  if (nodeUI?.config?.operand?.name) {
    texts.push(nodeUI.config.operand.name);
  }

  return texts;
}

function getColor(
  actionConfig: ActionConfig | undefined,
  nodeConfig: NodeConfig | undefined
): string {
  if (actionConfig?.group) {
    return ACTION_GROUP_METADATA[actionConfig.group]?.color || '#aaaaaa';
  }
  if (nodeConfig?.group) {
    return (
      ACTION_GROUP_METADATA[nodeConfig.group as any]?.color ||
      SPLIT_GROUP_METADATA[nodeConfig.group as any]?.color ||
      '#aaaaaa'
    );
  }
  return '#aaaaaa';
}

function getTypeName(
  actionConfig: ActionConfig | undefined,
  nodeConfig: NodeConfig | undefined
): string {
  if (actionConfig?.name) return actionConfig.name;
  if (nodeConfig?.name) return nodeConfig.name;
  return msg('Unknown');
}

/**
 * Build the display fields for a result that matched on its type name
 * (e.g. "email" matching a "Send Email" action). Shows the first content
 * text as an unhighlighted preview when available, otherwise highlights
 * the match within the type name itself. Returns null if the type name
 * doesn't match the query.
 */
function makeTypeNameResult(
  typeName: string,
  query: string,
  contentTexts: string[]
): Pick<SearchResult, 'fullText' | 'matchStart' | 'matchLength'> | null {
  const idx = typeName.toLowerCase().indexOf(query);
  if (idx === -1) {
    return null;
  }
  const preview = contentTexts.find((t) => t.trim());
  if (preview) {
    return { fullText: preview, matchStart: 0, matchLength: 0 };
  }
  return { fullText: typeName, matchStart: idx, matchLength: query.length };
}

/**
 * Get the localized name for a category, falling back to the original name.
 */
function localizeCategoryName(
  categoryUuid: string,
  originalName: string,
  langLocalization: Record<string, Record<string, any>> | undefined
): string {
  const catLoc = langLocalization?.[categoryUuid];
  if (catLoc?.name && Array.isArray(catLoc.name) && catLoc.name[0]) {
    return catLoc.name[0];
  }
  return originalName;
}

export class FlowSearch extends SearchModal<SearchResult> {
  @property({ attribute: false })
  definition: FlowDefinition | null = null;

  @property({ type: String })
  languageCode: string = '';

  @property({ type: String })
  scope: SearchScope = 'flow';

  @property({ type: Boolean })
  includeCategories = false;

  protected getSearchLabel(): string {
    return this.scope === 'table'
      ? msg('Search this table')
      : msg('Search this flow');
  }

  protected performSearch(rawQuery: string): SearchResult[] {
    if (!this.definition) {
      return [];
    }

    const query = rawQuery.toLowerCase();

    // Get the localization map for the active language (if translating)
    const isTranslating =
      this.languageCode && this.languageCode !== this.definition.language;
    const langLocalization = isTranslating
      ? this.definition.localization?.[this.languageCode]
      : undefined;

    if (this.scope === 'table') {
      return this.performTableSearch(query, langLocalization);
    }

    return this.performFlowSearch(query, langLocalization);
  }

  private performFlowSearch(
    query: string,
    langLocalization: Record<string, Record<string, any>> | undefined
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (const node of this.definition.nodes) {
      const nodeUI = this.definition._ui?.nodes[node.uuid];
      const nodeType = nodeUI?.type || 'execute_actions';

      if (nodeType === 'execute_actions') {
        // For action-set nodes, search each action individually
        if (node.actions) {
          for (const action of node.actions) {
            const actionConfig = ACTION_CONFIG[action.type];
            const typeName = getTypeName(actionConfig, undefined);
            const searchAction = localizeAction(
              action,
              langLocalization?.[action.uuid]
            );
            const texts = getActionSearchTexts(searchAction);
            let matched = false;
            for (const text of texts) {
              const lowerText = text.toLowerCase();
              const idx = lowerText.indexOf(query);
              if (idx !== -1) {
                results.push({
                  nodeUuid: node.uuid,
                  action,
                  typeName,
                  color: getColor(actionConfig, undefined),
                  fullText: text,
                  matchStart: idx,
                  matchLength: query.length
                });
                matched = true;
                break; // One match per action is enough
              }
            }

            // Fall back to matching the action type name (e.g. "email"
            // matches all "Send Email" actions)
            if (!matched) {
              const typeMatch = makeTypeNameResult(typeName, query, texts);
              if (typeMatch) {
                results.push({
                  nodeUuid: node.uuid,
                  action,
                  typeName,
                  color: getColor(actionConfig, undefined),
                  ...typeMatch
                });
              }
            }
          }
        }
      } else {
        // For split/wait nodes, search node-level text and embedded actions together
        const nodeConfig = NODE_CONFIG[nodeType];
        const nodeTexts = getNodeSearchTexts(node, nodeUI, langLocalization);

        // Include searchable text from embedded actions (e.g. call_webhook in split_by_webhook)
        if (node.actions) {
          for (const action of node.actions) {
            const searchAction = localizeAction(
              action,
              langLocalization?.[action.uuid]
            );
            nodeTexts.push(...getActionSearchTexts(searchAction));
          }
        }

        const typeName = getTypeName(undefined, nodeConfig);
        let matched = false;
        for (const text of nodeTexts) {
          const lowerText = text.toLowerCase();
          const idx = lowerText.indexOf(query);
          if (idx !== -1) {
            results.push({
              nodeUuid: node.uuid,
              action: null,
              typeName,
              color: getColor(undefined, nodeConfig),
              fullText: text,
              matchStart: idx,
              matchLength: query.length
            });
            matched = true;
            break; // One match per node is enough
          }
        }

        // Fall back to matching the node type name (e.g. "wait" matches
        // all "Wait for Response" nodes)
        if (!matched) {
          const typeMatch = makeTypeNameResult(typeName, query, nodeTexts);
          if (typeMatch) {
            results.push({
              nodeUuid: node.uuid,
              action: null,
              typeName,
              color: getColor(undefined, nodeConfig),
              ...typeMatch
            });
          }
        }
      }
    }

    // Also search sticky notes
    const stickies = this.definition._ui?.stickies || {};
    for (const [uuid, sticky] of Object.entries(stickies)) {
      const fields: { text: string; field: 'title' | 'body' }[] = [];
      if (sticky.title) fields.push({ text: sticky.title, field: 'title' });
      if (sticky.body) fields.push({ text: sticky.body, field: 'body' });
      for (const { text, field } of fields) {
        const lowerText = text.toLowerCase();
        const idx = lowerText.indexOf(query);
        if (idx !== -1) {
          const colors =
            STICKY_BADGE_COLORS[sticky.color] || STICKY_BADGE_COLORS.yellow;
          results.push({
            nodeUuid: uuid,
            action: null,
            typeName: msg('Sticky Note'),
            color: colors.fill,
            borderColor: colors.border,
            textColor: colors.text,
            fullText: text,
            matchStart: idx,
            matchLength: query.length,
            stickyField: field
          });
          break;
        }
      }
    }

    return results;
  }

  private performTableSearch(
    query: string,
    langLocalization: Record<string, Record<string, any>> | undefined
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (const node of this.definition.nodes) {
      const nodeUI = this.definition._ui?.nodes[node.uuid];
      const nodeType = nodeUI?.type || 'execute_actions';

      // Message table rows: one row per action with localizable fields
      if (node.actions) {
        for (const action of node.actions) {
          const actionConfig = ACTION_CONFIG[action.type];
          if (
            action.type !== 'send_msg' &&
            (!actionConfig?.localizable ||
              actionConfig.localizable.length === 0)
          ) {
            continue;
          }

          // Search both original and localized texts, but only add one result per action
          const originalTexts = getTableSearchTexts(action);
          const localizedAction = localizeAction(
            action,
            langLocalization?.[action.uuid]
          );
          const localizedTexts = getTableSearchTexts(localizedAction);

          // Deduplicate: combine both, originals first
          const allTexts: string[] = [];
          const seen = new Set<string>();
          for (const text of [...originalTexts, ...localizedTexts]) {
            if (!seen.has(text)) {
              seen.add(text);
              allTexts.push(text);
            }
          }

          let found = false;
          for (const text of allTexts) {
            const idx = text.toLowerCase().indexOf(query);
            if (idx !== -1) {
              results.push({
                nodeUuid: node.uuid,
                action,
                typeName: getTypeName(actionConfig, undefined),
                color: getColor(actionConfig, undefined),
                fullText: text,
                matchStart: idx,
                matchLength: query.length
              });
              found = true;
              break;
            }
          }
          if (found) continue;
        }
      }

      // Message table category rows: one grouped row per node when enabled.
      if (
        this.includeCategories &&
        node.router?.categories?.length &&
        NODE_CONFIG[nodeType]?.localizable === 'categories'
      ) {
        const categories = getTranslatableCategoriesForNode(
          nodeType,
          node.router.categories
        );
        if (!categories.length) {
          continue;
        }

        const nodeConfig = NODE_CONFIG[nodeType];
        const categoryTexts = categories.map((cat) =>
          localizeCategoryName(cat.uuid, cat.name, langLocalization)
        );

        for (const text of categoryTexts) {
          const idx = text.toLowerCase().indexOf(query);
          if (idx !== -1) {
            results.push({
              nodeUuid: node.uuid,
              action: null,
              typeName: getTypeName(undefined, nodeConfig),
              color: getColor(undefined, nodeConfig),
              fullText: text,
              matchStart: idx,
              matchLength: query.length
            });
            break;
          }
        }
      }
    }

    return results;
  }
}
