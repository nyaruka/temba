import { TemplateResult } from 'lit-html';
import type { Action, Node, NodeUI } from '../store/flow-definition';

export interface ValidationResult {
  valid: boolean;
  errors: { [key: string]: string };
}

/**
 * Flow types - defines the type of flow being edited
 */
export const FlowTypes = {
  MESSAGE: 'message',
  VOICE: 'voice',
  BACKGROUND: 'background'
} as const;

export type FlowType = (typeof FlowTypes)[keyof typeof FlowTypes];

/**
 * Shortcut entry shown in the canvas context menu. The `type` is the
 * action or node type to open the editor with when selected.
 */
export interface ContextMenuShortcut {
  type: string;
  name: string;
  icon: string;
}

/**
 * Per-flow-type context menu shortcuts.
 */
export const CONTEXT_MENU_SHORTCUTS: Record<FlowType, ContextMenuShortcut[]> = {
  [FlowTypes.MESSAGE]: [
    { type: 'send_msg', name: 'Send Message', icon: 'send' },
    { type: 'wait_for_response', name: 'Wait for Response', icon: 'message' }
  ],
  [FlowTypes.VOICE]: [
    { type: 'say_msg', name: 'Say Message', icon: 'recording' },
    { type: 'wait_for_menu', name: 'Wait for Menu', icon: 'dots-grid' }
  ],
  [FlowTypes.BACKGROUND]: [
    { type: 'set_contact_field', name: 'Update Contact', icon: 'contact' }
  ]
};

/**
 * Features - defines the features available in the account
 */
export const Features = {
  AI: 'ai',
  AIRTIME: 'airtime',
  LOCATIONS: 'locations'
} as const;

export type Feature = (typeof Features)[keyof typeof Features];

// Component attribute interfaces - these define what's allowed for each component type
export interface TextInputAttributes {
  type?: 'text' | 'email' | 'number' | 'url' | 'tel';
  placeholder?: string;
  clearable?: boolean;
  maxlength?: number;
  gsm?: boolean;
  autogrow?: boolean;
  textarea?: boolean;
  submitOnEnter?: boolean;
}

export interface CompletionAttributes {
  placeholder?: string;
  clearable?: boolean;
  maxlength?: number;
  gsm?: boolean;
  autogrow?: boolean;
  textarea?: boolean;
  expressions?: string;
  counter?: string;
  minHeight?: number;
}

export interface SelectAttributes {
  placeholder?: string;
  multi?: boolean;
  searchable?: boolean;
  tags?: boolean;
  emails?: boolean;
  clearable?: boolean;
  endpoint?: string;
  valueKey?: string;
  nameKey?: string;
  queryParam?: string;
  maxItems?: number;
  maxItemsText?: string;
  expressions?: string;
  options?: Array<{ name: string; value: any }>;
  sorted?: boolean;
  allowCreate?: boolean;
  jsonValue?: boolean;
  spaceSelect?: boolean;
  infoText?: string;
}

export interface CheckboxAttributes {
  label?: string;
  size?: number;
  disabled?: boolean;
  animateChange?: string;
}

export interface SliderAttributes {
  min?: number;
  max?: number;
  range?: boolean;
}

export interface FormData extends Record<string, any> {}

export interface FormConfig {
  form?: Record<string, FieldConfig>;
  layout?: LayoutItem[];
  gutter?: LayoutItem[];
  sanitize?: (formData: FormData) => void;
  validate?: (formData: FormData) => ValidationResult;

  // Async hook to resolve additional data after form initialization.
  // Called once when the form opens. Useful for fetching metadata (e.g. parent_refs)
  // that isn't available from the node data alone.
  resolveFormData?: (formData: FormData) => Promise<FormData>;
}

export interface NodeConfig extends FormConfig {
  type: string;
  name?: string;
  subtitle?: string; // a short line under the name in the editor dialog's header
  aliases?: string[]; // alternate type names for backwards compatibility (won't show in selector)
  group?: ActionGroup | SplitGroup; // Nodes can use either when showAsAction is true
  dialogSize?: 'small' | 'medium' | 'large' | 'xlarge';
  action?: ActionConfig;
  showAsAction?: boolean; // if true, show in action dialog instead of splits (default: false - nodes show in splits)
  hideFromSplits?: boolean; // if true, don't show in split dialog (e.g. promoted to context menu)
  flowTypes?: FlowType[]; // which flow types this node is available for (defaults to all if not specified)
  features?: Feature[]; // which features are required for this node (all must be present)
  router?: {
    type: 'switch' | 'random';
    defaultCategory?: string;
    operand?: string;
    configurable?: boolean; // can the rules be configured in the UI
    rules?: {
      type:
        | 'has_number_between'
        | 'has_number_eq'
        | 'has_only_text'
        | 'has_string'
        | 'has_value'
        | 'has_not_value'
        | 'has_text';
      arguments: string[];
      categoryName: string;
    }[];
  };

  toFormData?: (node: Node, nodeUI?: any) => FormData;
  fromFormData?: (formData: FormData, originalNode: Node) => Node;
  toUIConfig?: (formData: FormData) => Record<string, any>;
  render?: (node: Node, nodeUI?: any) => TemplateResult;
  renderTitle?: (node: Node, nodeUI?: NodeUI) => TemplateResult;

  // Localization support for router categories
  localizable?: 'categories'; // Only categories are localizable for routers
  // Categories that should not be translated. 'all' means all system categories
  // are non-translatable (except Other/No Response). A string[] lists specific names.
  nonTranslatableCategories?: 'all' | string[];
  toLocalizationFormData?: (
    node: Node,
    localization: Record<string, any>
  ) => FormData;
  fromLocalizationFormData?: (
    formData: FormData,
    node: Node
  ) => Record<string, any>;
}

// New field configuration system for generic form generation
export interface BaseFieldConfig {
  label?: string | ((formData: Record<string, any>) => string);
  required?: boolean;
  evaluated?: boolean;
  dependsOn?: string[];
  computeValue?: (
    values: Record<string, any>,
    currentValue: any,
    originalValues?: Record<string, any>
  ) => any;

  // Validation properties
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  helpText?: string | ((formData: Record<string, any>) => string);

  // Layout properties
  maxWidth?: string;
  width?: string;

  // Conditional rendering
  conditions?: {
    visible?: (formData: Record<string, any>) => boolean;
    disabled?: (formData: Record<string, any>) => boolean;
  };

  // Optional field with reveal link
  // When set, the field is hidden by default and a link with this text is shown
  // Clicking the link reveals the field permanently (can't be hidden again)
  optionalLink?: string;
}

export interface TextFieldConfig extends BaseFieldConfig {
  type: 'text';
  placeholder?: string | ((formData: Record<string, any>) => string);
  flavor?: 'xsmall' | 'small' | 'large';
}

export interface TextareaFieldConfig extends BaseFieldConfig {
  type: 'textarea';
  placeholder?: string;
  rows?: number;
  minHeight?: number;
}

export interface SelectFieldConfig extends BaseFieldConfig {
  type: 'select';
  options?: string[] | { value: string; name: string }[];
  multi?: boolean;
  clearable?: boolean;
  searchable?: boolean;
  tags?: boolean;
  placeholder?: string;
  maxItems?: number;
  valueKey?: string;
  nameKey?: string;
  endpoint?: string;
  queryParam?: string;
  emails?: boolean;
  expressions?: string;
  getName?: (item: any) => string;
  flavor?: 'xsmall' | 'small' | 'large';
  createArbitraryOption?: (input: string, options: any[]) => any;
  allowCreate?: boolean;
  getDynamicOptions?: () => Array<{ value: string; name: string }>;
  shouldExclude?: (option: any) => boolean;
}

export interface KeyValueFieldConfig extends BaseFieldConfig {
  type: 'key-value';
  sortable?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  minRows?: number;
  readOnlyKeys?: boolean;
  maxItems?: number;
  keyMaxLength?: number;
  valueMaxLength?: number;
}

export interface ArrayFieldConfig extends BaseFieldConfig {
  type: 'array';
  itemConfig: Record<string, FieldConfig>;
  sortable?: boolean;
  minItems?: number;
  maxItems?: number;
  itemLabel?: string;
  maintainEmptyItem?: boolean;
  onItemChange?: (
    itemIndex: number,
    field: string,
    value: any,
    allItems: any[]
  ) => any[];
  isEmptyItem?: (item: any) => boolean;
  createEmptyItem?: (items: any[]) => any;
}

export interface CheckboxFieldConfig extends BaseFieldConfig {
  type: 'checkbox';
  size?: number;
  animateChange?: string;
  labelPadding?: string;
}

export interface MessageEditorFieldConfig extends BaseFieldConfig {
  type: 'message-editor';
  placeholder?: string;
  minHeight?: number;
  maxAttachments?: number;
  accept?: string;
  endpoint?: string;
  counter?: string;
  gsm?: boolean;
  autogrow?: boolean;
  disableCompletion?: boolean;
}

export interface MediaFieldConfig extends BaseFieldConfig {
  type: 'media';
  accept?: string; // MIME filter, e.g. 'audio/*'
  endpoint?: string; // upload endpoint, defaults to DEFAULT_MEDIA_ENDPOINT
}

export interface TemplateEditorFieldConfig extends BaseFieldConfig {
  type: 'template-editor';
  endpoint?: string; // endpoint for fetching templates
}

export type FieldConfig =
  | TextFieldConfig
  | TextareaFieldConfig
  | SelectFieldConfig
  | KeyValueFieldConfig
  | ArrayFieldConfig
  | CheckboxFieldConfig
  | MessageEditorFieldConfig
  | MediaFieldConfig
  | TemplateEditorFieldConfig;

// Layout configurations for better form organization
// Recursive layout system - any layout item can contain other layout items

export interface FieldItemConfig {
  type: 'field';
  field: string; // field name to render
}

export interface RowLayoutConfig {
  type: 'row';
  items: LayoutItem[]; // can contain fields, groups, or other rows
  gap?: string; // CSS gap value, defaults to '1rem'
  label?: string; // optional label for the entire row
  helpText?: string; // optional help text for the entire row
  inlineLabels?: Record<string, string>; // map of field name to inline label text
  marginBottom?: string; // CSS margin-bottom for spacing below the row
}

export interface GroupLayoutConfig {
  type: 'group';
  label: string;
  icon?: string; // optional icon name to display before the label
  items: LayoutItem[]; // can contain fields, rows, or other groups
  collapsible?: boolean;
  collapsed?: boolean | ((formData: FormData) => boolean); // initial state if collapsible - can be a function
  helpText?: string;
  contentPadding?: string; // CSS padding for group content area
  gap?: string; // CSS gap between items (default: '15px')
  bordered?: boolean; // whether to show border around the group (default: true)
  reveal?: boolean; // one-way expand: once clicked, header disappears and items show directly
  getGroupValueCount?: (formData: FormData) => number | boolean; // optional function to get count for bubble display
}

export interface SpacerLayoutConfig {
  type: 'spacer';
}

export interface TextLayoutConfig {
  type: 'text';
  text: string;
}

export interface AccordionSection {
  label: string;
  icon?: string;
  items: LayoutItem[];
  collapsed?: boolean | ((formData: FormData) => boolean);
  getValueCount?: (formData: FormData) => number | boolean;
  getSummary?: (formData: FormData) => string; // short description of the value, shown in the section's row
  emptySummary?: string; // shown instead of the summary when there's no value (default: 'None')
  localizable?: boolean;
}

export interface AccordionLayoutConfig {
  type: 'accordion';
  sections: AccordionSection[];
  multi?: boolean; // allow multiple sections open at once (default: true)
}

/**
 * An optional part of a form. It's shown when it has a value (or an error),
 * otherwise it's offered as an "add" chip that reveals it.
 */
export interface ExtrasSection {
  label: string;
  items: LayoutItem[];
  // the label of the chip that adds the section (default: the section's label)
  chip?: string;
  // renders the section as a line of text instead of a heading over its fields, e.g.
  // () => msg("If there's no reply after {duration} go to **No Response**"). Each {token}
  // becomes its field and **text** is bold, so the string has no markup to translate.
  sentence?: () => string;
  // which field each {token} in the sentence stands for (default: the token is the field name)
  tokens?: Record<string, string>;
  // whether the section has a value worth showing (default: any of its fields is non-empty)
  hasValue?: (formData: FormData) => boolean;
  // the values to set when the section is added from its chip
  onAdd?: (formData: FormData) => FormData;
  // the values to set when the section is removed (default: its fields are emptied)
  onRemove?: (formData: FormData) => FormData;
  removable?: boolean; // whether the section can be removed once shown (default: true)
  localizable?: boolean;
}

export interface ExtrasLayoutConfig {
  type: 'extras';
  sections: ExtrasSection[];
}

export type LayoutItem =
  | FieldItemConfig
  | RowLayoutConfig
  | GroupLayoutConfig
  | AccordionLayoutConfig
  | ExtrasLayoutConfig
  | SpacerLayoutConfig
  | TextLayoutConfig
  | string; // string is shorthand for field

/**
 * Action group constants - single source of truth for action categorization
 * Use as const for compile-time type checking
 */
export const ACTION_GROUPS = {
  send: 'send',
  contacts: 'contacts',
  save: 'save',
  services: 'services',
  broadcast: 'broadcast',
  trigger: 'trigger'
} as const;

/**
 * Split group constants - single source of truth for split categorization
 * Use as const for compile-time type checking
 */
export const SPLIT_GROUPS = {
  wait: 'wait',
  split: 'split'
} as const;

// Extract types from const objects for compile-time checking
export type ActionGroup = (typeof ACTION_GROUPS)[keyof typeof ACTION_GROUPS];
export type SplitGroup = (typeof SPLIT_GROUPS)[keyof typeof SPLIT_GROUPS];

/**
 * Metadata for group display
 */
export interface GroupMetadata {
  color: string;
  title: string;
  description: string;
}

/**
 * Action group metadata - defines display properties for each action group
 * Order in this object determines display order in action selector (top to bottom)
 */
export const ACTION_GROUP_METADATA: Record<ActionGroup, GroupMetadata> = {
  [ACTION_GROUPS.send]: {
    color: '#3498db',
    title: 'Send',
    description: 'Actions that send messages or content to contacts'
  },
  [ACTION_GROUPS.contacts]: {
    color: '#01c1af',
    title: 'Contact',
    description: 'Actions that update contact information'
  },
  [ACTION_GROUPS.save]: {
    color: '#1a777c',
    title: 'Save',
    description: 'Actions that save or store data'
  },
  [ACTION_GROUPS.services]: {
    color: '#f79035ff',
    title: 'Services',
    description: 'Call external services and APIs'
  },
  [ACTION_GROUPS.broadcast]: {
    color: '#8e5ea7',
    title: 'Other People',
    description: 'Actions that apply to others instead of the contact'
  },
  [ACTION_GROUPS.trigger]: {
    color: '#df419f',
    title: 'Trigger',
    description: 'Actions that trigger other behavior'
  }
};

/**
 * Split group metadata - defines display properties for each split group
 * Order in this object determines display order in split selector (top to bottom)
 */
export const SPLIT_GROUP_METADATA: Record<SplitGroup, GroupMetadata> = {
  [SPLIT_GROUPS.wait]: {
    color: '#4d7dad',
    title: 'Wait',
    description: 'Wait for user and split on their response'
  },
  [SPLIT_GROUPS.split]: {
    color: '#aaaaaa',
    title: 'Split',
    description: 'Split the flow based on conditions'
  }
};

export interface ActionConfig extends FormConfig {
  name: string;
  subtitle?: string; // a short line under the name in the editor dialog's header
  aliases?: string[]; // alternate type names for backwards compatibility (won't show in selector)
  group: ActionGroup;
  dialogSize?: 'small' | 'medium' | 'large' | 'xlarge';
  evaluated?: string[];
  hideFromActions?: boolean; // if true, don't show in action dialog (default: false - actions show in actions)
  flowTypes?: FlowType[]; // which flow types this action is available for (defaults to all if not specified)
  features?: Feature[]; // which features are required for this action (all must be present)
  render?: (node: any, action: any) => TemplateResult;

  form?: Record<string, FieldConfig>;
  layout?: LayoutItem[]; // optional layout configuration - array of layout items
  gutter?: LayoutItem[]; // fields to render in the dialog gutter (left side of buttons)

  toFormData?: (action: Action) => FormData;
  fromFormData?: (formData: FormData) => Action;

  // Localization support
  localizable?: string[]; // array of field names that can be localized
  toLocalizationFormData?: (
    action: Action,
    localization: Record<string, any>
  ) => FormData;
  fromLocalizationFormData?: (
    formData: FormData,
    action: Action
  ) => Record<string, any>;
}
