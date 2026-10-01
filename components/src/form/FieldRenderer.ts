import { html, TemplateResult } from 'lit';
import { spread } from '@open-wc/lit-helpers';
import {
  FieldConfig,
  TextFieldConfig,
  TextareaFieldConfig,
  SelectFieldConfig,
  CheckboxFieldConfig,
  MessageEditorFieldConfig,
  KeyValueFieldConfig,
  ArrayFieldConfig,
  MediaFieldConfig,
  TemplateEditorFieldConfig
} from '../flow/types';
import { Attachment } from '../interfaces';
import { DEFAULT_MEDIA_ENDPOINT } from '../utils';

/**
 * FieldRenderer provides a consistent way to render field configurations
 * into web components across different contexts (NodeEditor, ArrayEditor, etc.)
 */
export class FieldRenderer {
  /**
   * Renders a field based on its configuration
   * @param fieldName - The name of the field
   * @param config - The field configuration
   * @param value - The current value of the field
   * @param context - Additional context for rendering
   * @returns A TemplateResult for the rendered field
   */
  static renderField(
    fieldName: string,
    config: FieldConfig,
    value: any,
    context: FieldRenderContext = {}
  ): TemplateResult {
    /*const {
      errors = [],
      onChange,
      showLabel = true,
      flavor,
      extraClasses = '',
      style = ''
    } = context;*/
    switch (config.type) {
      case 'text':
        return FieldRenderer.renderTextInput(fieldName, config, value, context);

      case 'textarea':
        return FieldRenderer.renderTextarea(
          fieldName,
          config as TextareaFieldConfig,
          value,
          context
        );

      case 'select':
        return FieldRenderer.renderSelect(
          fieldName,
          config as SelectFieldConfig,
          value,
          context
        );

      case 'checkbox':
        return FieldRenderer.renderCheckbox(
          fieldName,
          config as CheckboxFieldConfig,
          value,
          context
        );

      case 'key-value':
        return FieldRenderer.renderKeyValue(
          fieldName,
          config as KeyValueFieldConfig,
          value,
          context
        );

      case 'array':
        return FieldRenderer.renderArray(
          fieldName,
          config as ArrayFieldConfig,
          value,
          context
        );

      case 'message-editor':
        return FieldRenderer.renderMessageEditor(
          fieldName,
          config as MessageEditorFieldConfig,
          value,
          context
        );

      case 'media':
        return FieldRenderer.renderMedia(
          fieldName,
          config as MediaFieldConfig,
          value,
          context
        );

      case 'template-editor':
        return FieldRenderer.renderTemplateEditor(
          fieldName,
          config as TemplateEditorFieldConfig,
          value,
          context
        );

      default:
        return html`<div>Unsupported field type: ${(config as any).type}</div>`;
    }
  }

  private static renderTextInput(
    fieldName: string,
    config: TextFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const {
      errors = [],
      onChange,
      showLabel = true,
      extraClasses,
      style
    } = context;

    // Resolve placeholder (supports static string or dynamic function)
    const placeholder =
      typeof config.placeholder === 'function'
        ? config.placeholder(context.formData || {})
        : config.placeholder || '';

    // If field supports expression evaluation, use temba-completion
    if (config.evaluated) {
      return html`<temba-rich-edit
        name="${fieldName}"
        label="${showLabel ? config.label : ''}"
        ?required="${config.required}"
        .errors="${errors}"
        .value="${value || ''}"
        placeholder="${placeholder}"
        session
        flavor="${config.flavor || 'default'}"
        .helpText="${config.helpText || ''}"
        class="${extraClasses}"
        style="${style}"
        @change="${onChange || (() => {})}"
      ></temba-rich-edit>`;
    }

    return html`<temba-textinput
      name="${fieldName}"
      label="${showLabel ? config.label : ''}"
      ?required="${config.required}"
      .errors="${errors}"
      .value="${value || ''}"
      placeholder="${placeholder}"
      .helpText="${config.helpText || ''}"
      flavor="${config.flavor || 'default'}"
      class="${extraClasses}"
      style="${style}"
      @input="${onChange || (() => {})}"
    ></temba-textinput>`;
  }

  private static renderTextarea(
    fieldName: string,
    config: TextareaFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const {
      errors = [],
      onChange,
      showLabel = true,
      extraClasses,
      style
    } = context;

    const minHeightStyle = config.minHeight
      ? `--textarea-min-height: ${config.minHeight}px;`
      : '';
    const combinedStyle = `${minHeightStyle}${style}`;

    // If field supports expression evaluation, use temba-rich-edit
    if (config.evaluated) {
      return html`<temba-rich-edit
        name="${fieldName}"
        label="${showLabel ? config.label : ''}"
        ?required="${config.required}"
        .errors="${errors}"
        .value="${value || ''}"
        placeholder="${config.placeholder || ''}"
        textarea
        session
        .helpText="${config.helpText || ''}"
        class="${extraClasses}"
        style="${combinedStyle}"
        @change="${onChange || (() => {})}"
      ></temba-rich-edit>`;
    }

    return html`<temba-textinput
      name="${fieldName}"
      label="${showLabel ? config.label : ''}"
      ?required="${config.required}"
      .errors="${errors}"
      .value="${value || ''}"
      placeholder="${config.placeholder || ''}"
      textarea
      .rows="${config.rows || 3}"
      .helpText="${config.helpText || ''}"
      class="${extraClasses}"
      style="${combinedStyle}"
      @input="${onChange || (() => {})}"
    ></temba-textinput>`;
  }

  private static renderSelect(
    fieldName: string,
    config: SelectFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const {
      errors = [],
      onChange,
      showLabel = true,
      flavor,
      extraClasses,
      style,
      formData = {}
    } = context;

    const helpText =
      typeof config.helpText === 'function'
        ? config.helpText(formData)
        : config.helpText;

    // Get options - use dynamic options if available, otherwise use static options
    const optionsToRender = config.getDynamicOptions
      ? config.getDynamicOptions()
      : config.options;

    return html`<temba-select
      name="${fieldName}"
      label="${showLabel ? config.label : ''}"
      ?required="${config.required}"
      .errors="${errors}"
      .values=${value}
      ?multi="${config.multi}"
      ?searchable="${config.searchable}"
      ?tags="${config.tags}"
      ?emails="${config.emails}"
      expressions="${config.expressions || ''}"
      ?clearable="${config.clearable || false}"
      placeholder="${config.placeholder || ''}"
      maxItems="${config.maxItems || 0}"
      valueKey="${config.valueKey || 'value'}"
      nameKey="${config.nameKey || 'name'}"
      endpoint="${config.endpoint || ''}"
      queryParam="${config.queryParam || ''}"
      .helpText="${helpText || ''}"
      flavor="${flavor || config.flavor || 'small'}"
      class="${extraClasses}"
      style="${style}"
      .getName=${config.getName}
      .shouldExclude=${config.shouldExclude}
      .createArbitraryOption=${config.createArbitraryOption}
      ?allowCreate="${config.allowCreate || false}"
      @change="${onChange || (() => {})}"
    >
      ${optionsToRender?.map((option: any) => {
        if (typeof option === 'string') {
          return html`<temba-option
            name="${option}"
            value="${option}"
          ></temba-option>`;
        } else {
          return html`<temba-option ${spread(option)}></temba-option>`;
        }
      })}
    </temba-select>`;
  }

  private static renderCheckbox(
    fieldName: string,
    config: CheckboxFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const {
      errors = [],
      onChange,
      extraClasses,
      style,
      formData = {}
    } = context;

    // Handle dynamic labels
    const label =
      typeof config.label === 'function'
        ? config.label(formData)
        : config.label;

    const helpText =
      typeof config.helpText === 'function'
        ? config.helpText(formData)
        : config.helpText;

    // Build custom style including labelPadding
    const customStyle = config.labelPadding
      ? `--checkbox-padding: ${config.labelPadding}; ${style || ''}`
      : style || '';

    return html`<div class="form-field">
      <temba-checkbox
        name="${fieldName}"
        label="${label}"
        .helpText="${helpText || ''}"
        ?required="${config.required}"
        .errors="${errors}"
        ?checked="${value || false}"
        size="${config.size || 1.2}"
        animateChange="${config.animateChange || 'pulse'}"
        class="${extraClasses}"
        style="${customStyle}"
        @change="${onChange || (() => {})}"
      ></temba-checkbox>
      ${errors.length
        ? html`<div class="field-errors">${errors.join(', ')}</div>`
        : ''}
    </div>`;
  }

  private static renderKeyValue(
    fieldName: string,
    config: KeyValueFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const {
      errors = [],
      onChange,
      showLabel = true,
      extraClasses,
      style
    } = context;

    return html`<div class="form-field">
      ${showLabel ? html`<label>${config.label}</label>` : ''}
      <temba-key-value-editor
        name="${fieldName}"
        .value="${value || []}"
        .sortable="${config.sortable}"
        .keyPlaceholder="${config.keyPlaceholder || 'Key'}"
        .valuePlaceholder="${config.valuePlaceholder || 'Value'}"
        .minRows="${config.minRows || 0}"
        ?readOnlyKeys="${config.readOnlyKeys}"
        class="${extraClasses}"
        style="${style}"
        @change="${onChange || (() => {})}"
      ></temba-key-value-editor>
      ${errors.length
        ? html`<div class="field-errors">${errors.join(', ')}</div>`
        : ''}
    </div>`;
  }

  private static renderArray(
    fieldName: string,
    config: ArrayFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const {
      errors = [],
      onChange,
      showLabel = true,
      extraClasses,
      style
    } = context;

    return html`<div class="form-field">
      ${config.helpText
        ? html`<div style="color: #666; font-size: 13px; margin-bottom: 14px;">
            ${config.helpText}
          </div>`
        : ''}
      <temba-array-editor
        name="${fieldName}"
        .label="${showLabel ? config.label : ''}"
        .value="${value || []}"
        .itemConfig="${config.itemConfig}"
        .sortable="${config.sortable}"
        .itemLabel="${config.itemLabel || 'Item'}"
        .minItems="${config.minItems || 0}"
        .maxItems="${config.maxItems || 0}"
        ?maintainEmptyItem="${config.maintainEmptyItem !== false}"
        .onItemChange="${config.onItemChange}"
        .isEmptyItemFn="${config.isEmptyItem}"
        .createEmptyItemFn="${config.createEmptyItem}"
        class="${extraClasses}"
        style="${style}"
        @change="${onChange || (() => {})}"
      ></temba-array-editor>
      ${errors.length
        ? html`<div class="field-errors">${errors.join(', ')}</div>`
        : ''}
    </div>`;
  }

  private static urlToAttachments(url: string): Attachment[] {
    if (!url || !url.trim()) return [];
    const filename = url.split('/').pop() || 'recording';
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const contentTypes: Record<string, string> = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4'
    };
    return [
      {
        uuid: '',
        content_type: contentTypes[ext] || 'audio/mpeg',
        url,
        filename,
        size: 0,
        error: ''
      }
    ];
  }

  private static renderMedia(
    fieldName: string,
    config: MediaFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const { onChange, showLabel = true } = context;
    const endpoint = config.endpoint || DEFAULT_MEDIA_ENDPOINT;
    const attachments = FieldRenderer.urlToAttachments(value);

    return html`
      <div>
        ${showLabel && config.label
          ? html`<label
              style="margin-bottom: 5px; margin-left: 4px; display: block; font-weight: 400; font-size: var(--label-size); letter-spacing: 0.05em; line-height: normal; color: var(--color-label, #777);"
              >${config.label}</label
            >`
          : ''}
        <temba-media-picker
          name="${fieldName}"
          accept="${config.accept || ''}"
          endpoint="${endpoint}"
          max="1"
          .attachments="${attachments}"
          @change="${onChange || (() => {})}"
        ></temba-media-picker>
      </div>
    `;
  }

  private static renderMessageEditor(
    fieldName: string,
    config: MessageEditorFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const {
      errors = [],
      onChange,
      showLabel = true,
      extraClasses,
      style,
      additionalData = {}
    } = context;

    return html`<temba-message-editor
      name="${fieldName}"
      label="${showLabel ? config.label : ''}"
      ?required="${config.required}"
      .errors="${errors}"
      .value="${value || ''}"
      .attachments="${additionalData.attachments || []}"
      placeholder="${config.placeholder || ''}"
      .helpText="${config.helpText || ''}"
      ?autogrow="${config.autogrow}"
      ?gsm="${config.gsm}"
      ?disableCompletion="${config.disableCompletion}"
      session
      counter="${config.counter || ''}"
      accept="${config.accept || ''}"
      endpoint="${config.endpoint || ''}"
      max-attachments="${config.maxAttachments || 3}"
      minHeight="${config.minHeight || 92}"
      class="${extraClasses}"
      style="${style}"
      @change="${onChange || (() => {})}"
    ></temba-message-editor>`;
  }

  private static renderTemplateEditor(
    _fieldName: string,
    config: TemplateEditorFieldConfig,
    value: any,
    context: FieldRenderContext
  ): TemplateResult {
    const { onChange, additionalData = {} } = context;
    const templateUuid = value?.uuid || '';
    const variables = JSON.stringify(additionalData.template_variables || []);

    return html`<temba-template-editor
      url="${config.endpoint || '/api/internal/templates.json'}"
      template="${templateUuid}"
      variables="${variables}"
      session
      @temba-context-changed="${onChange || (() => {})}"
      @temba-content-changed="${onChange || (() => {})}"
    ></temba-template-editor>`;
  }
}

export interface FieldRenderContext {
  /** Array of error messages for the field */
  errors?: string[];
  /** Change event handler */
  onChange?: (event: Event) => void;
  /** Whether to show the field label */
  showLabel?: boolean;
  /** Flavor for components that support it (like temba-select) */
  flavor?: string;
  /** Additional CSS classes to apply */
  extraClasses?: string;
  /** Additional CSS styles to apply */
  style?: string;
  /** Additional data needed for specific field types */
  additionalData?: Record<string, any>;
  /** Form data for dynamic field configurations */
  formData?: Record<string, any>;
}
