import { TemplateResult, css, html } from 'lit';
import { property } from 'lit/decorators.js';
import { FieldElement } from './FieldElement';

export interface ListItem {
  [key: string]: any;
}

export interface ListEditorConfig {
  // Determines if empty items should be automatically maintained
  maintainEmptyItem?: boolean;
  // Function to check if an item is considered empty
  isEmptyItem?: (item: ListItem) => boolean;
  // Function to create a new empty item
  createEmptyItem?: () => ListItem;
  // Function to clean items before emitting (e.g., filter out empty items)
  cleanItems?: (items: ListItem[]) => ListItem[];
  // Minimum number of items to maintain
  minItems?: number;
  // Maximum number of items allowed
  maxItems?: number;
}

export abstract class BaseListEditor<
  T extends ListItem = ListItem
> extends FieldElement {
  @property({ attribute: false })
  protected _items: T[] = [];

  @property({ type: Number })
  minItems = 0;

  @property({ type: Number })
  maxItems?: number;

  @property({ type: Boolean })
  maintainEmptyItem = false;

  static get styles() {
    return css`
      ${super.styles}

      .remove-btn {
        padding: 4px;
        border: 1px solid var(--color-widget-border);
        border-radius: var(--curvature-widget);
        background: var(--surface);
        color: var(--text-3);
        cursor: pointer;
        font-size: 14px;
      }

      .remove-btn:hover:not(:disabled) {
        background: var(--sunken);
      }

      .remove-btn:disabled {
        opacity: 0.3;
        cursor: default;
      }
    `;
  }

  // Abstract methods that must be implemented by subclasses
  abstract isEmptyItem(item: T): boolean;
  abstract createEmptyItem(): T;
  abstract renderItem(item: T, index: number): TemplateResult;

  // Optional methods that subclasses can override
  protected getContainerClass(): string {
    return 'base-list-editor';
  }

  protected renderAddButton(): TemplateResult {
    return html`
      <button class="add-btn" @click=${() => this.addItem()}>Add Item</button>
    `;
  }

  // the × at the end of each row, faded while the row can't be removed
  protected renderRemoveButton(index: number): TemplateResult {
    const canRemove = this.canRemoveItem(index);
    return html`<button
      type="button"
      class="remove-btn"
      ?disabled=${!canRemove}
      @click=${() => this.removeItem(index)}
    >
      <temba-icon name="x"></temba-icon>
    </button>`;
  }

  protected shouldShowAddButton(): boolean {
    // Never show add button when maintaining empty items (auto-add behavior)
    if (this.maintainEmptyItem) {
      return false;
    }

    return !this.maxItems || this._items.length < this.maxItems;
  }

  renderWidget(): TemplateResult {
    const items = this.displayItems;
    return html`
      <div class=${this.getContainerClass()}>
        <div
          class="list-items"
          style="display: grid; grid-template-columns: 1fr; gap: 8px;"
        >
          ${items.map((item, index) => this.renderItem(item, index))}
        </div>
        ${this.shouldShowAddButton() ? this.renderAddButton() : ''}
      </div>
    `;
  }

  // Optional method for cleaning items before emission (can return any type)
  protected cleanItems(items: T[]): any {
    if (!this.maintainEmptyItem) {
      return items;
    }
    // Filter out empty items for the emitted value
    return items.filter((item) => !this.isEmptyItem(item));
  }

  // Get the items to display (may include empty items for UI)
  protected get displayItems(): T[] {
    const items = [...this._items];

    if (this.maintainEmptyItem) {
      const hasEmptyItem = items.some((item) => this.isEmptyItem(item));
      // Only add empty item if we haven't reached maxItems and don't already have an empty item
      if (!hasEmptyItem && (!this.maxItems || items.length < this.maxItems)) {
        items.push(this.createEmptyItem());
      }
    }

    return items;
  }

  // Handle changes to an item
  protected handleItemChange(index: number, newItem: T) {
    const updatedItems = [...this._items];
    updatedItems[index] = newItem;
    this.updateValue(updatedItems);
  }

  // Handle field changes within an item (for complex items)
  protected handleFieldChange(
    index: number,
    fieldName: string,
    fieldValue: any
  ) {
    const updatedItems = [...this._items];

    // If editing beyond the current array (auto-generated empty row), check maxItems
    if (index >= this._items.length) {
      if (this.maxItems && this._items.length >= this.maxItems) {
        // Don't allow adding new items if we've reached maxItems
        return;
      }
      // Extend the array to include the new item
      while (updatedItems.length <= index) {
        updatedItems.push(this.createEmptyItem());
      }
    }

    const currentItem = updatedItems[index] || this.createEmptyItem();

    updatedItems[index] = {
      ...currentItem,
      [fieldName]: fieldValue
    };

    this.updateValue(updatedItems);
  }

  // Add a new item
  protected addItem(item?: T) {
    if (this.maxItems && this._items.length >= this.maxItems) {
      return;
    }

    const newItem = item || this.createEmptyItem();
    const updatedItems = [...this._items, newItem];
    this.updateValue(updatedItems);
  }

  // Remove an item
  protected removeItem(index: number) {
    if (this._items.length <= this.minItems) {
      return;
    }

    const updatedItems = this._items.filter((_, i) => i !== index);
    this.updateValue(updatedItems);
  }

  // Check if an item can be removed
  protected canRemoveItem(index: number): boolean {
    const item = this.displayItems[index];

    // Can't remove if it would go below minimum
    if (this._items.length <= this.minItems) {
      return false;
    }

    // Can't remove empty items if we're maintaining them
    if (this.maintainEmptyItem && this.isEmptyItem(item)) {
      return false;
    }

    return true;
  }

  // Update the value and emit change event
  protected updateValue(newValue: T[]) {
    this._items = newValue;
    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { value: this.cleanItems(newValue) },
        bubbles: true
      })
    );
  }

  // Utility method for subclasses to check if two items are equal
  protected itemsEqual(item1: T, item2: T): boolean {
    return JSON.stringify(item1) === JSON.stringify(item2);
  }
}
