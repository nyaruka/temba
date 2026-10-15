import { html, css, TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { FieldConfig } from '../flow/types';
import { BaseListEditor, ListItem } from './BaseListEditor';
import { FieldRenderer } from './FieldRenderer';
import '../list/SortableList';
import { Icon } from '../Icons';

@customElement('temba-array-editor')
export class TembaArrayEditor extends BaseListEditor<ListItem> {
  @property({ type: Object })
  itemConfig: Record<string, FieldConfig> = {};

  @property({ type: String })
  itemLabel = 'Item';

  @property({ type: Function })
  onItemChange?: (
    itemIndex: number,
    field: string,
    value: any,
    allItems: any[]
  ) => any[];

  @property({ type: Function })
  isEmptyItemFn?: (item: any) => boolean;

  @property({ type: Function })
  createEmptyItemFn?: (items: any[]) => any;

  @property({ type: Boolean })
  sortable = false;

  @property({ type: Boolean })
  maintainEmptyItem = true; // Enable by default for better UX

  // Focus preservation properties
  private focusInfo: {
    itemIndex: number;
    fieldName: string;
    selectionStart?: number;
    selectionEnd?: number;
  } | null = null;

  constructor() {
    super();
    this._items = [];
  }

  // External API
  @property({ type: Array })
  get value(): any[] {
    return [...this._items];
  }

  set value(newValue: any[]) {
    this._items = newValue || [];
    this.requestUpdate();
  }

  // Implement abstract methods
  isEmptyItem(item: ListItem): boolean {
    // Use configurable function if provided
    if (this.isEmptyItemFn) {
      return this.isEmptyItemFn(item);
    }

    // Default behavior: check if all values are empty
    const values = Object.values(item);
    if (values.length === 0) {
      return true;
    }

    return values.every(
      (value) => value === undefined || value === null || value === ''
    );
  }

  // Override cleanItems to be more permissive for form data
  protected cleanItems(items: ListItem[]): any {
    // For runtime attachments, keep items that have at least one non-empty field
    return items.filter((item) => {
      const values = Object.values(item);
      return (
        values.length > 0 &&
        values.some(
          (value) => value !== undefined && value !== null && value !== ''
        )
      );
    });
  }

  // Capture focus information before update
  private captureFocus(): void {
    const activeElement = this.shadowRoot?.activeElement as HTMLElement;

    // Also try document.activeElement as a fallback
    const globalActive = document.activeElement as HTMLElement;
    let targetElement = activeElement || globalActive;

    // If active element is within this component's shadow root, use it
    if (globalActive && this.shadowRoot?.contains(globalActive)) {
      targetElement = globalActive;
    }

    if (!targetElement) {
      this.focusInfo = null;
      return;
    }

    // Find the array item container by traversing up the DOM
    let currentElement = targetElement;
    let arrayItemElement: HTMLElement | null = null;

    // Traverse up through shadow DOM boundaries
    while (currentElement) {
      if (currentElement.classList?.contains('array-item')) {
        arrayItemElement = currentElement;
        break;
      }

      // Move up to parent, or cross shadow boundaries
      if (currentElement.parentElement) {
        currentElement = currentElement.parentElement;
      } else if (
        currentElement.parentNode &&
        (currentElement.parentNode as any).host
      ) {
        // Cross shadow boundary
        currentElement = (currentElement.parentNode as any).host;
      } else {
        break;
      }
    }

    if (!arrayItemElement) {
      this.focusInfo = null;
      return;
    }

    // Find the item index by looking at the item ID
    const itemIdMatch = arrayItemElement.id?.match(/array-item-(\d+)/);
    if (!itemIdMatch) {
      this.focusInfo = null;
      return;
    }

    const itemIndex = parseInt(itemIdMatch[1], 10);

    // Determine the field name by examining the input element and its containers
    let fieldName = '';

    // First, check if it's a temba component with a name attribute
    if (targetElement.tagName?.toLowerCase().startsWith('temba-')) {
      fieldName =
        (targetElement as any).name || targetElement.getAttribute('name') || '';
    }

    // If not found, check regular HTML elements
    if (
      !fieldName &&
      targetElement.hasAttribute &&
      targetElement.hasAttribute('name')
    ) {
      fieldName = targetElement.getAttribute('name') || '';
    }

    // If still not found, look for data-field-name in parent containers
    if (!fieldName) {
      let searchElement = targetElement;
      while (searchElement && searchElement !== arrayItemElement) {
        if (
          searchElement.hasAttribute &&
          searchElement.hasAttribute('data-field-name')
        ) {
          fieldName = searchElement.getAttribute('data-field-name') || '';
          break;
        }
        searchElement = searchElement.parentElement;
      }
    }

    if (!fieldName) {
      this.focusInfo = null;
      return;
    }

    const inputForSelection = this.getSelectionElement(targetElement);
    const selectionStart = (inputForSelection as any).selectionStart;
    const selectionEnd = (inputForSelection as any).selectionEnd;

    this.focusInfo = {
      itemIndex,
      fieldName,
      selectionStart:
        selectionStart === null || selectionStart === undefined
          ? undefined
          : selectionStart,
      selectionEnd:
        selectionEnd === null || selectionEnd === undefined
          ? undefined
          : selectionEnd
    };
  }

  // Restore focus after update
  private restoreFocus(): void {
    if (!this.focusInfo) {
      return;
    }

    const { itemIndex, fieldName, selectionStart, selectionEnd } =
      this.focusInfo;

    // Find the target element by array item index
    const arrayItemId = `array-item-${itemIndex}`;
    const arrayItemElement = this.shadowRoot?.getElementById(arrayItemId);

    if (!arrayItemElement) {
      // If the exact item doesn't exist (e.g., due to reordering), try to find by field name
      const allItems = this.shadowRoot?.querySelectorAll('.array-item');
      if (allItems && allItems.length > itemIndex) {
        const fallbackItem = allItems[itemIndex];
        if (fallbackItem) {
          this.attemptFocusRestore(
            fallbackItem as HTMLElement,
            fieldName,
            selectionStart,
            selectionEnd
          );
        }
      }
      this.focusInfo = null;
      return;
    }

    this.attemptFocusRestore(
      arrayItemElement,
      fieldName,
      selectionStart,
      selectionEnd
    );
    this.focusInfo = null;
  }

  private attemptFocusRestore(
    container: HTMLElement,
    fieldName: string,
    selectionStart?: number,
    selectionEnd?: number
  ): void {
    // Look for the field container first
    const fieldContainer = container.querySelector(
      `[data-field-name="${fieldName}"]`
    );

    let targetElement: HTMLElement | null = null;

    if (fieldContainer) {
      // Look for temba components or input elements within the field container
      targetElement = fieldContainer.querySelector(
        'temba-textinput, temba-completion, temba-rich-edit, input, textarea'
      ) as HTMLElement;
    }

    // Fallback: search entire container
    if (!targetElement) {
      const selectors = [
        `temba-textinput[name="${fieldName}"]`,
        `temba-completion[name="${fieldName}"]`,
        `temba-rich-edit[name="${fieldName}"]`,
        `input[name="${fieldName}"]`,
        `textarea[name="${fieldName}"]`,
        `[name="${fieldName}"]`
      ];

      for (const selector of selectors) {
        targetElement = container.querySelector(selector) as HTMLElement;
        if (targetElement) break;
      }
    }

    if (targetElement) {
      // Use multiple animation frames to ensure DOM is fully settled
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          try {
            // Avoid resetting cursor position if the target already has focus.
            const currentlyFocused =
              this.shadowRoot?.activeElement || document.activeElement;
            const targetAlreadyFocused =
              currentlyFocused === targetElement ||
              targetElement.contains(currentlyFocused);

            if (!targetAlreadyFocused) {
              targetElement.focus();
            }

            // Restore selection if it's a text input
            if (selectionStart !== undefined && selectionEnd !== undefined) {
              // For temba components, we need to focus the actual editable node.
              const inputForSelection = this.getSelectionElement(targetElement);

              if ('setSelectionRange' in inputForSelection) {
                (inputForSelection as any).setSelectionRange(
                  selectionStart,
                  selectionEnd
                );
              }
            }
          } catch (error) {
            // Ignore focus errors - element might not be focusable
            // Focus restoration failed, silently continue
          }
        });
      });
    }
  }

  private getSelectionElement(targetElement: HTMLElement): HTMLElement {
    if (!targetElement.tagName?.toLowerCase().startsWith('temba-')) {
      return targetElement;
    }

    // Prefer the component's actual editable node and avoid hidden form mirrors.
    const editableSelector =
      'input:not([type="hidden"]), textarea, [contenteditable="true"]';

    const innerInput =
      targetElement.shadowRoot?.querySelector(editableSelector) ||
      targetElement.querySelector(editableSelector);

    return (innerInput as HTMLElement) || targetElement;
  }

  createEmptyItem(): ListItem {
    if (this.createEmptyItemFn) {
      return this.createEmptyItemFn(this._items);
    }
    return {};
  }

  protected handleFieldChange(
    itemIndex: number,
    fieldName: string,
    newValue: any
  ) {
    // Use displayItems so the empty row's pre-filled data (e.g. operator) is preserved
    const sourceItems = this.displayItems;
    let updatedItems: any[];

    if (this.onItemChange) {
      updatedItems = this.onItemChange(
        itemIndex,
        fieldName,
        newValue,
        sourceItems
      );
    } else {
      updatedItems = [...sourceItems];
      updatedItems[itemIndex] = {
        ...updatedItems[itemIndex],
        [fieldName]: newValue
      };
    }

    this.updateValue(updatedItems);
  }

  // Override Lit's update lifecycle methods for focus preservation
  protected willUpdate(changedProperties: Map<string, any>): void {
    super.willUpdate(changedProperties);

    // Capture focus before update if items are changing
    if (changedProperties.has('_items') || changedProperties.has('value')) {
      this.captureFocus();
    }
  }

  updated(changedProperties: Map<string, any>): void {
    super.updated(changedProperties);

    // Restore focus after update if items changed
    if (changedProperties.has('_items') || changedProperties.has('value')) {
      this.restoreFocus();
    }
  }

  private handleOrderChanged(event: CustomEvent): void {
    const detail = event.detail;

    // Handle swap-based logic from SortableList
    if (detail.swap && Array.isArray(detail.swap) && detail.swap.length === 2) {
      const [fromIdx, toIdx] = detail.swap;

      // Only reorder if the indexes are different and valid
      if (
        fromIdx !== toIdx &&
        fromIdx >= 0 &&
        toIdx >= 0 &&
        fromIdx < this._items.length &&
        toIdx < this._items.length
      ) {
        const updatedItems = [...this._items];
        // Move the item using splice operations
        const movedItem = updatedItems.splice(fromIdx, 1)[0];
        updatedItems.splice(toIdx, 0, movedItem);
        this.updateValue(updatedItems);
      }
    }
  }

  renderWidget(): TemplateResult {
    const items = this.displayItems;

    const itemsContent = items.map((item, index) => {
      const renderedItem = this.renderItem(item, index);

      if (this.sortable && !this.isEmptyItem(item)) {
        // Wrap non-empty items with sortable class and unique ID for drag-and-drop
        return html`
          <div class="sortable" id="array-item-${index}">${renderedItem}</div>
        `;
      } else {
        // Non-sortable items or empty items don't get the sortable wrapper
        return renderedItem;
      }
    });

    if (this.sortable) {
      return html`
        <div class=${this.getContainerClass()}>
          <temba-sortable-list
            dragHandle="drag-handle"
            gap="0.4em"
            @temba-order-changed=${this.handleOrderChanged}
            style="display: grid; grid-template-columns: 1fr; gap: 8px;"
          >
            ${itemsContent}
          </temba-sortable-list>
          ${this.shouldShowAddButton() ? this.renderAddButton() : ''}
        </div>
      `;
    } else {
      // Non-sortable rendering (original behavior)
      return html`
        <div class=${this.getContainerClass()}>
          <div
            class="list-items"
            style="display: grid; grid-template-columns: 1fr; gap: 8px;"
          >
            ${itemsContent}
          </div>
          ${this.shouldShowAddButton() ? this.renderAddButton() : ''}
        </div>
      `;
    }
  }

  private computeFieldValue(
    item: ListItem,
    fieldName: string,
    config: FieldConfig
  ): any {
    const currentValue = item[fieldName];

    if (config.computeValue) {
      return config.computeValue(item, currentValue);
    }

    // For select fields, ensure we return the right type
    /*if (config.type === 'select') {
      console.log('computeFieldValue select', currentValue, config);
      const selectConfig = config as SelectFieldConfig;
      if (currentValue === undefined || currentValue === null) {
        return selectConfig.multi ? [] : '';
      }
    }*/

    return currentValue;
  }

  private renderArrayField(
    item: ListItem,
    itemIndex: number,
    fieldName: string,
    config: FieldConfig
  ): TemplateResult {
    // rows are compact unless their fields ask otherwise
    config = { flavor: 'xsmall', ...config } as FieldConfig;
    const flavor = (config as any).flavor;

    const computedValue = this.computeFieldValue(item, fieldName, config);

    // Build container style with width/maxWidth if specified
    let containerStyle = '';
    if (config.width) {
      containerStyle = `width: ${config.width};`;
    } else if (config.maxWidth) {
      containerStyle = `max-width: ${config.maxWidth};`;
    }

    // Use FieldRenderer for consistent field rendering
    const fieldContent = FieldRenderer.renderField(
      fieldName,
      config,
      computedValue,
      {
        showLabel: false, // ArrayEditor doesn't show labels for individual fields
        flavor: flavor,
        extraClasses: 'form-control',
        formData: item,
        onChange: (e: Event) => {
          let value: any;
          const target = e.target as any;

          // Handle different field types and their change events
          if (config.type === 'select') {
            // Use consistent temba-select value normalization
            value = target.values;
          } else {
            // For other field types, use the target value directly
            value = target.value;
          }

          this.handleFieldChange(itemIndex, fieldName, value);
        }
      }
    );

    // Wrap in container with style if maxWidth is specified
    if (containerStyle) {
      return html`<div style="${containerStyle}">${fieldContent}</div>`;
    }

    return fieldContent;
  }

  renderItem(item: ListItem, index: number): TemplateResult {
    const canRemove = this.canRemoveItem(index);

    // Render fields and track if any value fields are visible
    const fieldElements: TemplateResult[] = [];
    let hasVisibleValueField = false;

    Object.entries(this.itemConfig).forEach(([fieldName, config]) => {
      // Check visibility condition
      let isVisible = true;
      if (config.conditions?.visible) {
        try {
          isVisible = config.conditions.visible(item);
        } catch (error) {
          console.error(`Error checking visibility for ${fieldName}:`, error);
        }
      }

      if (isVisible) {
        // Check if this is a value field (text input without fixed sizing)
        const isValueField =
          !config.width && !config.maxWidth && config.type === 'text';
        if (isValueField) {
          hasVisibleValueField = true;
        }

        fieldElements.push(html`
          <div
            data-field-name="${fieldName}"
            style="${config.width || config.maxWidth || config.type === 'select'
              ? 'flex:none'
              : 'flex:1;min-width:0'}"
          >
            ${this.renderArrayField(item, index, fieldName, config)}
          </div>
        `);
      }
    });

    // If no value fields are visible, add a spacer to maintain alignment
    if (!hasVisibleValueField) {
      // Insert spacer after operator (first field) and before category (last field)
      fieldElements.splice(
        -1,
        0,
        html`<div class="field field-flex spacer" style="flex-grow:1"></div>`
      );
    }

    return html`
      <div class="array-item" id="array-item-${index}">
        <div
          class="item-fields  ${canRemove ? '' : 'removable'}"
          style="display: flex; gap: 12px; align-items: center"
        >
          ${this.sortable
            ? html`<temba-icon
                name=${Icon.sort}
                style="margin-right: -6px;"
                class="drag-handle"
              ></temba-icon>`
            : null}
          ${fieldElements} ${this.renderRemoveButton(index)}
        </div>
      </div>
    `;
  }

  protected getContainerClass(): string {
    return 'array-editor';
  }

  static get styles() {
    return css`
      ${super.styles}

      .item-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }

      .item-title {
        font-weight: 600;
        color: #333;
      }

      .field {
        /* Base field styles */
      }

      .spacer {
        /* Empty spacer to maintain layout alignment */
      }

      .add-btn {
        padding: 4px;
        border: 1px solid var(--color-widget-border);
        border-radius: var(--curvature-widget);
        background: var(--surface);
        cursor: pointer;
        font-size: 14px;
      }

      .add-btn:hover {
        background: var(--sunken);
      }

      .removable .drag-handle {
        opacity: 0.3;
        cursor: default;
        pointer-events: none;
      }

      .drag-handle {
        cursor: grab;
        color: #ccc;
      }
    `;
  }
}
