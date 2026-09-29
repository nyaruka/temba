import { html, TemplateResult } from 'lit-html';
import { iconToPillType } from '../styles/pillVariants';
import { Action, NamedObject, FlowPosition } from '../store/flow-definition';
import { FlowIssue } from '../store/AppState';
import { CustomEventType } from '../interfaces';
import { tokenize, TokenType } from '../excellent/tokenizer';
import { TOKEN_COLORS } from '../excellent/token-styles';
import { messageParser, sessionParser } from '../excellent/helpers';
import { FormData, ValidationResult, NodeConfig, ActionConfig } from './types';
import {
  categoriesToLocalizationFormData,
  localizationFormDataToCategories
} from './nodes/shared';

/**
 * Wraps a validation check into the standard `validate` signature. The check
 * populates an `errors` object; the wrapper computes `valid` and returns the
 * ValidationResult. Eliminates the `const errors = {}; ...; return {valid, errors}`
 * boilerplate that appears in every node and action config.
 */
export function validateWith(
  check: (formData: FormData, errors: { [key: string]: string }) => void
): (formData: FormData) => ValidationResult {
  return (formData: FormData) => {
    const errors: { [key: string]: string } = {};
    check(formData, errors);
    return { valid: Object.keys(errors).length === 0, errors };
  };
}

/**
 * Validates a mixed recipients list (contacts, groups and expressions) against
 * the engine's limits: at most 100 of each kind and expressions at most 1000
 * characters. Returns an error message or null if the list is valid. The type
 * predicates mirror how fromFormData partitions the list into the action's
 * contacts / groups / legacy_vars.
 */
export function validateRecipients(recipients: any[]): string | null {
  const contacts = recipients.filter(
    (r: any) => r.type === 'contact' || (!r.type && !r.expression && r.id)
  );
  const groups = recipients.filter((r: any) => r.type === 'group');
  const expressions = recipients.filter(
    (r: any) => r.type === 'expression' || r.expression
  );

  if (contacts.length > 100) {
    return 'You can only add up to 100 contacts';
  }
  if (groups.length > 100) {
    return 'You can only add up to 100 groups';
  }
  if (expressions.length > 100) {
    return 'You can only add up to 100 expressions';
  }
  const tooLong = expressions.some((e: any) => {
    const value = e.value || e.name || e.id || '';
    return typeof value === 'string' && value.length > 1000;
  });
  if (tooLong) {
    return 'Expressions must be no more than 1000 characters';
  }
  return null;
}

/**
 * Validates template variables against the engine's limit of 10000 characters
 * per variable. Returns an error message or null if they're valid.
 */
export function validateTemplateVariables(variables: any[]): string | null {
  const tooLong = variables.some(
    (v: any) => typeof v === 'string' && v.length > 10000
  );
  if (tooLong) {
    return 'Template variables must be no more than 10000 characters';
  }
  return null;
}

function makeTextToLocalizationFormData(fields: readonly string[]) {
  return (
    action: { uuid: string },
    localization: Record<string, any>
  ): FormData => {
    const formData: FormData = { uuid: action.uuid };
    fields.forEach((field) => {
      const value = localization[field];
      formData[field] = Array.isArray(value) ? value[0] || '' : '';
    });
    return formData;
  };
}

function makeTextFromLocalizationFormData(fields: readonly string[]) {
  return (
    formData: FormData,
    action: Record<string, any>
  ): Record<string, any> => {
    const localization: Record<string, any> = {};
    fields.forEach((field) => {
      const value = formData[field];
      if (value && value.trim() !== '' && value !== action[field]) {
        localization[field] = [value];
      }
    });
    return localization;
  };
}

type ToLocalizationFn = (
  nodeOrAction: any,
  localization: Record<string, any>
) => FormData;

type FromLocalizationFn = (
  formData: FormData,
  nodeOrAction: any
) => Record<string, any>;

/**
 * Returns the `toLocalizationFormData` impl for a node or action config. Uses
 * the explicit impl if the config provides one; otherwise infers from the
 * `localizable` shape: `'categories'` → category helper, `string[]` → text
 * factory. Returns undefined if the config isn't localizable.
 */
export function resolveToLocalizationFormData(
  config: NodeConfig | ActionConfig
): ToLocalizationFn | undefined {
  if (config.toLocalizationFormData) {
    return config.toLocalizationFormData as ToLocalizationFn;
  }
  if (config.localizable === 'categories') {
    return categoriesToLocalizationFormData;
  }
  if (Array.isArray(config.localizable)) {
    return makeTextToLocalizationFormData(config.localizable);
  }
  return undefined;
}

/**
 * Mirror of resolveToLocalizationFormData for `fromLocalizationFormData`.
 */
export function resolveFromLocalizationFormData(
  config: NodeConfig | ActionConfig
): FromLocalizationFn | undefined {
  if (config.fromLocalizationFormData) {
    return config.fromLocalizationFormData as FromLocalizationFn;
  }
  if (config.localizable === 'categories') {
    return localizationFormDataToCategories;
  }
  if (Array.isArray(config.localizable)) {
    return makeTextFromLocalizationFormData(config.localizable);
  }
  return undefined;
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/**
 * Returns true if the mouse event is a right-click or equivalent:
 * - button !== 0 (actual right-click or middle-click on any platform)
 * - ctrl+click on macOS (emulates right-click / context menu)
 */
export function isRightClick(event: MouseEvent): boolean {
  if (event.button !== 0) return true;
  if (IS_MAC && event.ctrlKey) return true;
  return false;
}

export function formatIssueMessage(issue: FlowIssue): string {
  if (issue.dependency) {
    const name = issue.dependency.name || issue.dependency.key;
    return `Cannot find a ${issue.dependency.type} for ${name}`;
  }
  return issue.description;
}

const GRID_SIZE = 20;

export function snapToGrid(value: number): number {
  const snapped = Math.round(value / GRID_SIZE) * GRID_SIZE;
  return Math.max(snapped, 0);
}

const MONO =
  "font-family:SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;font-size:0.95em";

const TOKEN_STYLES: Record<string, string> = {
  [TokenType.ExpressionPrefix]: `color:${TOKEN_COLORS.expression};font-weight:600;${MONO}`,
  [TokenType.Identifier]: `color:${TOKEN_COLORS.expression};${MONO}`,
  [TokenType.FunctionName]: `color:${TOKEN_COLORS.fn};font-weight:900;${MONO}`,
  [TokenType.StringLiteral]: `color:${TOKEN_COLORS.string};${MONO}`,
  [TokenType.NumberLiteral]: `color:${TOKEN_COLORS.number};${MONO}`,
  [TokenType.Keyword]: `color:${TOKEN_COLORS.keyword};${MONO}`,
  [TokenType.Operator]: `color:${TOKEN_COLORS.operator};${MONO}`,
  [TokenType.ContextRef]: `color:${TOKEN_COLORS.expression};${MONO}`,
  [TokenType.Separator]: `color:${TOKEN_COLORS.operator};${MONO}`,
  [TokenType.Arrow]: `color:${TOKEN_COLORS.operator};${MONO}`,
  [TokenType.Bracket]: `color:${TOKEN_COLORS.operator};${MONO}`,
  [TokenType.Paren]: `color:${TOKEN_COLORS.paren};${MONO}`,
  [TokenType.Whitespace]: MONO
};

const LLM_ICON_MAP: [RegExp, string][] = [
  [/claude|anthropic/i, 'anthropic'],
  [/gpt|openai|o1|o3|o4/i, 'openai'],
  [/gemini|google/i, 'gemini'],
  [/azure|microsoft/i, 'azure'],
  [/deepseek/i, 'deepseek']
];

export const getLlmIcon = (name: string): string | null => {
  if (!name) return null;
  for (const [pattern, icon] of LLM_ICON_MAP) {
    if (pattern.test(name)) return icon;
  }
  return null;
};

/**
 * Tokenizes text containing Excellent expressions and returns highlighted
 * lit-html templates with inline styles, suitable for rendering on the canvas.
 */
export const renderHighlightedText = (
  text: string,
  session = false
): TemplateResult => {
  const parser = session ? sessionParser : messageParser;
  const tokens = tokenize(text || '', parser);

  // Group consecutive expression tokens so we can wrap them in a single
  // span with hyphens:none (plain text keeps hyphens:auto from container).
  const groups: { isExpr: boolean; tokens: typeof tokens }[] = [];
  for (const token of tokens) {
    const isExpr = !!TOKEN_STYLES[token.type];
    const last = groups[groups.length - 1];
    if (last && last.isExpr === isExpr) {
      last.tokens.push(token);
    } else {
      groups.push({ isExpr, tokens: [token] });
    }
  }

  const renderToken = (token: (typeof tokens)[0]) => {
    const style = TOKEN_STYLES[token.type];
    if (!style) {
      const parts = token.text.split('\n');
      return html`${parts.map(
        (part, i) => html`${i > 0 ? html`<br />` : null}${part}`
      )}`;
    }
    const parts = token.text.split('\n');
    return html`${parts.map(
      (part, i) =>
        html`${i > 0 ? html`<br />` : null}${part
          ? html`<span style="${style}">${part}</span>`
          : null}`
    )}`;
  };

  return html`${groups.map((group) => {
    const content = html`${group.tokens.map(renderToken)}`;
    return group.isExpr
      ? html`<span style="hyphens:none">${content}</span>`
      : content;
  })}`;
};

/**
 * Renders content clamped to a maximum number of lines with ellipsis.
 * Hovering shows the full text in a tooltip.
 */
export const renderClamped = (
  content: TemplateResult | string,
  titleText: string,
  maxLines: number = 3
) => {
  return html`<div
    style="display: -webkit-box; -webkit-line-clamp: ${maxLines}; -webkit-box-orient: vertical; overflow: hidden; word-wrap: break-word; overflow-wrap: break-word; hyphens: auto;"
    title="${titleText}"
  >
    ${content}
  </div>`;
};

const ATTACHMENT_ICONS: Record<string, string> = {
  image: 'attachment_image',
  audio: 'attachment_audio',
  video: 'attachment_video'
};

/**
 * Renders a message's attachments as a compact row of type icons so they're
 * visible on the canvas. Attachments are `content-type:url` for uploads or
 * `type:expression` for runtime attachments; hovering shows the URL or expression.
 */
export const renderAttachments = (attachments: string[] = []) => {
  if (attachments.length === 0) {
    return null;
  }

  return html`<div class="cn-attachments">
    ${attachments.map((attachment) => {
      const idx = attachment.indexOf(':');
      const contentType = idx > 0 ? attachment.substring(0, idx) : '';
      const value = idx > 0 ? attachment.substring(idx + 1) : attachment;
      const icon =
        ATTACHMENT_ICONS[contentType.split('/')[0]] || 'attachment_document';

      return html`<div class="cn-attachment" title="${value}">
        <temba-icon name="${icon}" size="0.9"></temba-icon>
      </div>`;
    })}
  </div>`;
};

/**
 * Inline margin for stacked pills — the previous implementation used
 * `class="mr-1 mb-1"` (Tailwind utility classes), but this package
 * doesn't ship Tailwind, so the classes resolved to no-ops in any host
 * page that didn't already include it. Inline style is predictable
 * across hosts.
 */
const PILL_MARGIN_STYLE = 'margin: 0 4px 4px 0;';

/**
 * Renders a single line item with optional icon.
 * Content can be plain text or a TemplateResult (e.g. highlighted text).
 */
export const renderLineItem = (
  name: string,
  icon?: string,
  content?: TemplateResult
) => {
  const pillType = iconToPillType(icon);
  return html`<temba-label
    icon=${icon || ''}
    type=${pillType || 'neutral'}
    style=${PILL_MARGIN_STYLE}
    title="${name}"
    >${content || name}</temba-label
  >`;
};

/**
 * Renders a list of named objects with optional icon, showing up to 3 items
 * with a "+X more" indicator if there are more items
 */
export const renderNamedObjects = (assets: NamedObject[], icon?: string) => {
  return renderStringList(
    assets.map((asset) => asset.name),
    icon
  );
};

/**
 * Renders a list of strings with optional icon, showing up to 3 items
 * with a "+X more" indicator if there are more items.
 * When session is provided, expression strings (starting with @) are highlighted.
 */
export const renderStringList = (
  items: string[],
  icon?: string,
  session?: boolean
) => {
  const itemElements = [];
  const maxDisplay = 3;

  // Show up to 3 items, or all 4 if exactly 4 items
  const displayCount =
    items.length === 4 ? 4 : Math.min(maxDisplay, items.length);

  for (let i = 0; i < displayCount; i++) {
    const item = items[i];
    const highlighted =
      session !== undefined && item.startsWith('@')
        ? renderHighlightedText(item, session)
        : undefined;
    itemElements.push(renderLineItem(item, icon, highlighted));
  }

  // Add "+X more" if there are more than 3 items (and not exactly 4)
  if (items.length > maxDisplay && items.length !== 4) {
    const remainingCount = items.length - maxDisplay;
    itemElements.push(
      html`<temba-label type="neutral" style=${PILL_MARGIN_STYLE}
        >+${remainingCount} more</temba-label
      >`
    );
  }
  return itemElements;
};

export interface MixedListItem {
  name: string;
  icon: string;
  content?: TemplateResult;
  uuid?: string;
  eventType?: CustomEventType;
}

/**
 * Renders a mixed list of items, each with its own icon, showing up to 3 items
 * with a "+X more" indicator if there are more items.
 * Items with uuid and eventType are rendered as clickable links.
 */
export const renderMixedList = (items: MixedListItem[]) => {
  const itemElements = [];
  const maxDisplay = 3;

  const displayCount =
    items.length === 4 ? 4 : Math.min(maxDisplay, items.length);

  for (let i = 0; i < displayCount; i++) {
    const item = items[i];
    if (item.uuid && item.eventType) {
      itemElements.push(
        renderLinkedObject(
          { uuid: item.uuid, name: item.name },
          item.eventType,
          item.icon
        )
      );
    } else {
      itemElements.push(renderLineItem(item.name, item.icon, item.content));
    }
  }

  if (items.length > maxDisplay && items.length !== 4) {
    const remainingCount = items.length - maxDisplay;
    itemElements.push(
      html`<temba-label type="neutral" style=${PILL_MARGIN_STYLE}
        >+${remainingCount} more</temba-label
      >`
    );
  }
  return itemElements;
};

/**
 * Renders a named object as a clickable DS pill that fires a custom event
 */
const renderLinkedObject = (
  obj: NamedObject,
  eventType: CustomEventType,
  icon?: string
) => {
  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const editor = target.closest('temba-flow-editor') as any;
    if (editor) {
      editor.fireCustomEvent(eventType, {
        uuid: obj.uuid,
        name: obj.name,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey
      });
    }
  };

  const pillType = iconToPillType(icon);
  return html`<temba-label
    class="linked-pill"
    icon=${icon || ''}
    type=${pillType || 'neutral'}
    clickable
    style=${PILL_MARGIN_STYLE}
    title="${obj.name}"
    @click=${handleClick}
    >${obj.name}</temba-label
  >`;
};

/**
 * Renders a list of linked objects, showing up to 3 items
 * with a "+X more" indicator if there are more items
 */
const renderLinkedObjects = (
  objects: NamedObject[],
  eventType: CustomEventType,
  icon?: string
) => {
  const itemElements = [];
  const maxDisplay = 3;

  const displayCount =
    objects.length === 4 ? 4 : Math.min(maxDisplay, objects.length);

  for (let i = 0; i < displayCount; i++) {
    itemElements.push(renderLinkedObject(objects[i], eventType, icon));
  }

  if (objects.length > maxDisplay && objects.length !== 4) {
    const remainingCount = objects.length - maxDisplay;
    itemElements.push(
      html`<temba-label type="neutral" style=${PILL_MARGIN_STYLE}
        >+${remainingCount} more</temba-label
      >`
    );
  }
  return itemElements;
};

/**
 * Renders a list of flows as clickable links, showing up to 3 items
 * with a "+X more" indicator if there are more items
 */
export const renderFlowLinks = (flows: NamedObject[], icon?: string) => {
  return renderLinkedObjects(flows, CustomEventType.FlowClicked, icon);
};

/**
 * Renders a list of groups as clickable links, showing up to 3 items
 * with a "+X more" indicator if there are more items
 */
export const renderGroupLinks = (groups: NamedObject[], icon?: string) => {
  return renderLinkedObjects(groups, CustomEventType.GroupClicked, icon);
};

/**
 * Renders a list of contacts as clickable links, showing up to 3 items
 * with a "+X more" indicator if there are more items
 */
export const renderContactLinks = (contacts: NamedObject[], icon?: string) => {
  return renderLinkedObjects(contacts, CustomEventType.ContactClicked, icon);
};

export interface Scheme {
  scheme: string;
  name: string;
  path: string;
  excludeFromSplit?: boolean;
}

export const SCHEMES: Scheme[] = [
  {
    scheme: 'tel',
    name: 'SMS',
    path: 'Phone Number'
  },
  {
    scheme: 'whatsapp',
    name: 'WhatsApp',
    path: 'WhatsApp Number'
  },
  {
    scheme: 'facebook',
    name: 'Facebook',
    path: 'Facebook ID'
  },
  {
    scheme: 'instagram',
    name: 'Instagram',
    path: 'Instagram ID'
  },
  {
    scheme: 'twitterid',
    name: 'Twitter',
    path: 'Twitter ID',
    excludeFromSplit: true
  },
  {
    scheme: 'telegram',
    name: 'Telegram',
    path: 'Telegram ID'
  },
  {
    scheme: 'viber',
    name: 'Viber',
    path: 'Viber ID'
  },
  {
    scheme: 'line',
    name: 'Line',
    path: 'Line ID'
  },
  {
    scheme: 'wechat',
    name: 'WeChat',
    path: 'WeChat ID'
  },
  {
    scheme: 'fcm',
    name: 'Firebase',
    path: 'Firebase ID'
  },
  {
    scheme: 'jiochat',
    name: 'JioChat',
    path: 'JioChat ID'
  },
  {
    scheme: 'freshchat',
    name: 'Freshchat',
    path: 'Freshchat ID'
  },
  {
    scheme: 'mailto',
    name: 'Email',
    path: 'Email Address',
    excludeFromSplit: true
  },
  {
    scheme: 'twitter',
    name: 'Twitter',
    path: 'Twitter Handle',
    excludeFromSplit: true
  },
  {
    scheme: 'vk',
    name: 'VK',
    path: 'VK ID'
  },
  {
    scheme: 'discord',
    name: 'Discord',
    path: 'Discord ID'
  },
  {
    scheme: 'webchat',
    name: 'Webchat',
    path: 'Webchat ID',
    excludeFromSplit: true
  },
  {
    scheme: 'rocketchat',
    name: 'RocketChat',
    path: 'RocketChat ID'
  },
  {
    scheme: 'ext',
    name: 'External',
    path: 'External ID'
  }
];

/**
 * Represents the bounding box of a node on the canvas
 */
export interface NodeBounds {
  uuid: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Minimum vertical spacing between nodes (in pixels)
 */
const MIN_NODE_SPACING = 30;

/**
 * Small buffer to avoid floating point precision issues in overlap detection (in pixels)
 * This prevents false positives when nodes are exactly adjacent (e.g., bottom of one node
 * at exactly the same position as top of another)
 */
const OVERLAP_BUFFER = 10;

/**
 * Gets the bounding box for a node from the DOM
 *
 * @param nodeUuid - The UUID of the node
 * @param position - The current position of the node
 * @param element - Optional pre-fetched DOM element (recommended for performance when checking multiple nodes)
 * @returns NodeBounds object or null if element not found
 *
 * Note: When element is not provided, performs a DOM query which may impact performance
 * during bulk collision detection. Consider fetching elements beforehand when possible.
 */
export const getNodeBounds = (
  nodeUuid: string,
  position: FlowPosition,
  element?: HTMLElement
): NodeBounds | null => {
  // If element is provided, use it; otherwise try to find it in DOM
  const nodeElement =
    element || (document.querySelector(`[id="${nodeUuid}"]`) as HTMLElement);

  if (!nodeElement) {
    return null;
  }

  // Use offsetWidth/offsetHeight instead of getBoundingClientRect() so
  // dimensions are in CSS-layout space and unaffected by ancestor transforms (zoom).
  const width = nodeElement.offsetWidth;
  const height = nodeElement.offsetHeight;

  return {
    uuid: nodeUuid,
    left: position.left,
    top: position.top,
    right: position.left + width,
    bottom: position.top + height,
    width,
    height
  };
};

/**
 * Checks if two node bounding boxes overlap
 */
export const nodesOverlap = (
  bounds1: NodeBounds,
  bounds2: NodeBounds
): boolean => {
  // Use a small buffer to avoid floating point precision issues
  const buffer = OVERLAP_BUFFER;

  return !(
    bounds1.right <= bounds2.left - buffer ||
    bounds1.left >= bounds2.right + buffer ||
    bounds1.bottom <= bounds2.top - buffer ||
    bounds1.top >= bounds2.bottom + buffer
  );
};

/**
 * Detects all collisions between a node and other nodes
 */
export const detectCollisions = (
  targetBounds: NodeBounds,
  allBounds: NodeBounds[]
): NodeBounds[] => {
  return allBounds.filter(
    (bounds) =>
      bounds.uuid !== targetBounds.uuid && nodesOverlap(targetBounds, bounds)
  );
};

type Direction = 'down' | 'up' | 'right' | 'left';

const DIRECTIONS: Direction[] = ['down', 'up', 'right', 'left'];

/**
 * Creates a new NodeBounds at a different position
 */
const makeBoundsAt = (
  original: NodeBounds,
  left: number,
  top: number
): NodeBounds => ({
  ...original,
  left,
  top,
  right: left + original.width,
  bottom: top + original.height
});

/**
 * Computes the minimum position needed to clear all fixed nodes in a given direction.
 * Returns null if the direction is not viable (e.g., would require negative coordinates
 * and still overlap).
 */
const computeDirectionalClearance = (
  collider: NodeBounds,
  fixedNodes: NodeBounds[],
  direction: Direction
): { left: number; top: number } | null => {
  switch (direction) {
    case 'down': {
      const maxBottom = Math.max(...fixedNodes.map((f) => f.bottom));
      const newTop = snapToGrid(maxBottom + MIN_NODE_SPACING);
      return { left: collider.left, top: newTop };
    }
    case 'up': {
      const minTop = Math.min(...fixedNodes.map((f) => f.top));
      const newTop = snapToGrid(minTop - collider.height - MIN_NODE_SPACING);
      if (newTop < 0) return { left: collider.left, top: 0 };
      return { left: collider.left, top: newTop };
    }
    case 'right': {
      const maxRight = Math.max(...fixedNodes.map((f) => f.right));
      const newLeft = snapToGrid(maxRight + MIN_NODE_SPACING);
      return { left: newLeft, top: collider.top };
    }
    case 'left': {
      const minLeft = Math.min(...fixedNodes.map((f) => f.left));
      const newLeft = snapToGrid(minLeft - collider.width - MIN_NODE_SPACING);
      if (newLeft < 0) return { left: 0, top: collider.top };
      return { left: newLeft, top: collider.top };
    }
  }
};

/**
 * Calculates new positions to resolve all collisions using multi-directional reflow.
 *
 * Sacred nodes (the ones just dropped/created) keep their positions. All other
 * colliding nodes are moved in whichever direction requires the least displacement
 * and causes the fewest cascading collisions.
 */
export const calculateReflowPositions = (
  sacredNodeUuids: string[],
  allBounds: NodeBounds[]
): Map<string, FlowPosition> => {
  const newPositions = new Map<string, FlowPosition>();
  const sacredSet = new Set(sacredNodeUuids);

  // Mutable map of current bounds, updated as collisions are resolved
  const currentBounds = new Map<string, NodeBounds>();
  for (const b of allBounds) {
    currentBounds.set(b.uuid, { ...b });
  }

  // A sacred node yields to an existing node at the top of the canvas when
  // the sacred wasn't dropped above it. The existing node keeps its top
  // position and the sacred node moves below instead.
  for (const sacredUuid of [...sacredSet]) {
    const sacred = currentBounds.get(sacredUuid);
    if (!sacred) continue;

    for (const [uuid, bounds] of currentBounds) {
      if (uuid === sacredUuid || sacredSet.has(uuid)) continue;
      if (!nodesOverlap(sacred, bounds)) continue;

      if (sacred.top > bounds.top && bounds.top < MIN_NODE_SPACING) {
        sacredSet.delete(sacredUuid);
        sacredSet.add(uuid);
        break;
      }
    }
  }

  // Seed the queue with non-sacred nodes that overlap any sacred node
  const queue: string[] = [];
  const inQueue = new Set<string>();

  for (const sacredUuid of sacredSet) {
    const sacred = currentBounds.get(sacredUuid);
    if (!sacred) continue;
    for (const [uuid, bounds] of currentBounds) {
      if (sacredSet.has(uuid) || inQueue.has(uuid)) continue;
      if (nodesOverlap(sacred, bounds)) {
        queue.push(uuid);
        inQueue.add(uuid);
      }
    }
  }

  const resolved = new Set<string>();
  let iterations = 0;
  const maxIterations = 200;

  while (queue.length > 0 && iterations < maxIterations) {
    iterations++;
    const uuid = queue.shift()!;

    if (resolved.has(uuid)) continue;

    const collider = currentBounds.get(uuid)!;

    // Find all fixed nodes (sacred + already-resolved) that overlap this node
    const fixedOverlaps: NodeBounds[] = [];
    for (const [otherUuid, otherBounds] of currentBounds) {
      if (otherUuid === uuid) continue;
      if (sacredSet.has(otherUuid) || resolved.has(otherUuid)) {
        if (nodesOverlap(collider, otherBounds)) {
          fixedOverlaps.push(otherBounds);
        }
      }
    }

    if (fixedOverlaps.length === 0) continue;

    // Determine direction constraints and axis bias from sacred node overlaps
    const sacredOverlaps = fixedOverlaps.filter((f) => sacredSet.has(f.uuid));
    const allowedDirections: Direction[] = [...DIRECTIONS];
    let axisBias: 'vertical' | 'horizontal' | null = null;

    if (sacredOverlaps.length > 0) {
      // Rule 1: don't move a lower node above the sacred node
      // Rule 2: don't move a right-of node to the left of the sacred node
      for (const sacred of sacredOverlaps) {
        if (collider.top > sacred.top) {
          const idx = allowedDirections.indexOf('up');
          if (idx !== -1) allowedDirections.splice(idx, 1);
        }
        if (collider.left > sacred.left) {
          const idx = allowedDirections.indexOf('left');
          if (idx !== -1) allowedDirections.splice(idx, 1);
        }
      }

      // Rule 3: bias direction based on overlap shape
      let totalOverlapWidth = 0;
      let totalOverlapHeight = 0;
      for (const sacred of sacredOverlaps) {
        totalOverlapWidth +=
          Math.min(collider.right, sacred.right) -
          Math.max(collider.left, sacred.left);
        totalOverlapHeight +=
          Math.min(collider.bottom, sacred.bottom) -
          Math.max(collider.top, sacred.top);
      }
      if (totalOverlapWidth > totalOverlapHeight) {
        axisBias = 'vertical'; // wide overlap = nodes stacked = prefer up/down
      } else if (totalOverlapHeight > totalOverlapWidth) {
        axisBias = 'horizontal'; // tall overlap = nodes side-by-side = prefer left/right
      }
    }

    // Try each allowed direction, pick the one with least disruption
    let bestPos: { left: number; top: number } | null = null;
    let bestScore = Infinity;

    for (const dir of allowedDirections) {
      const candidate = computeDirectionalClearance(
        collider,
        fixedOverlaps,
        dir
      );
      if (!candidate) continue;

      const candidateBounds = makeBoundsAt(
        collider,
        candidate.left,
        candidate.top
      );

      // Verify no overlap with any sacred or resolved node
      let stillOverlaps = false;
      let cascadeCount = 0;
      for (const [otherUuid, otherBounds] of currentBounds) {
        if (otherUuid === uuid) continue;
        if (!nodesOverlap(candidateBounds, otherBounds)) continue;

        if (sacredSet.has(otherUuid) || resolved.has(otherUuid)) {
          stillOverlaps = true;
          break;
        }
        cascadeCount++;
      }
      if (stillOverlaps) continue;

      const distance =
        Math.abs(candidate.left - collider.left) +
        Math.abs(candidate.top - collider.top);

      // When colliding with sacred nodes, use axis bias scoring;
      // for cascading collisions (no sacred overlap), use original scoring
      let score: number;
      if (sacredOverlaps.length > 0) {
        const isVerticalDir = dir === 'up' || dir === 'down';
        const axisMatch =
          axisBias === null ||
          (axisBias === 'vertical' && isVerticalDir) ||
          (axisBias === 'horizontal' && !isVerticalDir);
        const axisPenalty = axisMatch ? 0 : 5000;
        score = cascadeCount * 2000 + axisPenalty + distance;
      } else {
        score = cascadeCount * 10000 + distance;
      }

      if (score < bestScore) {
        bestScore = score;
        bestPos = candidate;
      }
    }

    if (bestPos) {
      newPositions.set(uuid, { left: bestPos.left, top: bestPos.top });
      const newBounds = makeBoundsAt(collider, bestPos.left, bestPos.top);
      currentBounds.set(uuid, newBounds);
      resolved.add(uuid);

      // Enqueue any new cascading collisions
      for (const [otherUuid, otherBounds] of currentBounds) {
        if (otherUuid === uuid) continue;
        if (sacredSet.has(otherUuid) || resolved.has(otherUuid)) continue;
        if (inQueue.has(otherUuid)) continue;
        if (nodesOverlap(newBounds, otherBounds)) {
          queue.push(otherUuid);
          inQueue.add(otherUuid);
        }
      }
    }
  }

  return newPositions;
};

/**
 * Apply localization overrides to an action, falling back to the base value
 * for any field that has no localized entry.
 *
 * @param action       The base-language action.
 * @param localization The per-field localization record for this action's UUID
 *                     (i.e. `definition.localization[lang][action.uuid]`), or
 *                     undefined if no localization exists.
 * @returns A shallow copy with localized values merged in, or the original
 *          action if there is nothing to merge.
 */
export function localizeAction(
  action: Action,
  localization: Record<string, any> | undefined
): Action {
  if (!localization) return action;
  const localized = { ...action };
  for (const field of Object.keys(localization)) {
    const val = localization[field];
    if (Array.isArray(val) && val.length > 0) {
      if (Array.isArray((action as any)[field])) {
        (localized as any)[field] = val;
      } else {
        (localized as any)[field] = val[0];
      }
    }
  }
  return localized;
}
