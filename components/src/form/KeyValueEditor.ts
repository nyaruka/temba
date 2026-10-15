import { html, css, TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { BaseListEditor, ListItem } from './BaseListEditor';

interface KeyValueItem extends ListItem {
  key: string;
  value: string;
}

@customElement('temba-key-value-editor')
export class KeyValueEditor extends BaseListEditor<KeyValueItem> {
  @property({ type: String })
  keyPlaceholder = 'Key';

  @property({ type: String })
  valuePlaceholder = 'Value';

  @property({ type: Boolean })
  showValidation = true;

  @property({ type: Boolean })
  readOnlyKeys = false;

  @state()
  private keyErrors: { [index: number]: string } = {};

  constructor() {
    super();
    this._items = [];
    // maintain an empty item. Set in the constructor, not as a class field - a field
    // would shadow the reactive accessor under define semantics (see lit
    // class-field-shadowing)
    this.maintainEmptyItem = true;
  }

  // External API uses array format to preserve duplicate keys
  @property({ type: Array })
  get value(): KeyValueItem[] | any[] {
    return this._items.filter(
      ({ key, value }) => key.trim() !== '' || value.trim() !== ''
    );
  }

  set value(newValue: KeyValueItem[] | Record<string, string> | any) {
    if (Array.isArray(newValue)) {
      this._items = [...newValue];
    } else {
      // Convert Record to array format
      this._items = Object.entries(newValue || {}).map(([key, value]) => ({
        key,
        value: typeof value === 'string' ? value : String(value)
      }));
    }
    this.requestUpdate();
  }

  // Implement abstract methods
  isEmptyItem(item: KeyValueItem): boolean {
    return item.key.trim() === '' && item.value.trim() === '';
  }

  createEmptyItem(): KeyValueItem {
    return { key: '', value: '' };
  }

  // Override cleanItems to return array format to preserve duplicate keys
  protected cleanItems(items: KeyValueItem[]): KeyValueItem[] {
    return items.filter(
      ({ key, value }) => key.trim() !== '' || value.trim() !== ''
    );
  }

  // Method to convert to Record format for final form submission
  toRecord(): Record<string, string> {
    const result: Record<string, string> = {};
    this._items.forEach(({ key, value }) => {
      if (key.trim() !== '' || value.trim() !== '') {
        result[key] = value;
      }
    });
    return result;
  }

  // Method to validate and set key errors for duplicates and empty keys with values
  validateKeys(): boolean {
    const newKeyErrors: { [index: number]: string } = {};

    // Check for empty keys with values
    this._items.forEach(({ key, value }, index) => {
      if (key.trim() === '' && value.trim() !== '') {
        newKeyErrors[index] = 'Key is required when value is provided';
      }
    });

    // Check for duplicate keys (only non-empty ones)
    const nonEmptyKeys = this._items
      .map(({ key }, index) => ({ key: key.trim(), index }))
      .filter(({ key }) => key !== '');

    const keyCount = new Map<string, number[]>();
    nonEmptyKeys.forEach(({ key, index }) => {
      if (!keyCount.has(key)) {
        keyCount.set(key, []);
      }
      keyCount.get(key)!.push(index);
    });

    // Mark duplicate keys with errors
    keyCount.forEach((indices, key) => {
      if (indices.length > 1) {
        indices.forEach((index) => {
          // Only show duplicate error if there's no empty key error already
          if (!newKeyErrors[index]) {
            newKeyErrors[index] = `Duplicate key "${key}"`;
          }
        });
      }
    });

    this.keyErrors = newKeyErrors;
    return Object.keys(newKeyErrors).length === 0;
  }

  // Clear key errors
  clearKeyErrors(): void {
    this.keyErrors = {};
  }

  // Override updateValue to emit array format and validate keys
  protected updateValue(newValue: KeyValueItem[]) {
    this._items = newValue;

    // Clear errors and re-validate when items change
    this.clearKeyErrors();
    this.validateKeys();

    this.dispatchEvent(
      new CustomEvent('change', {
        detail: { value: this.cleanItems(newValue) },
        bubbles: true
      })
    );
    this.requestUpdate();
  }

  private handleKeyChange(index: number, newKey: string) {
    const items = this.displayItems;
    const currentItem = items[index];

    // Clear any existing error for this key when it's modified
    if (this.keyErrors[index]) {
      const newKeyErrors = { ...this.keyErrors };
      delete newKeyErrors[index];
      this.keyErrors = newKeyErrors;
    }

    this.handleItemChange(index, {
      key: newKey,
      value: currentItem.value
    });
  }

  private handleValueChange(index: number, newValue: string) {
    const items = this.displayItems;
    const currentItem = items[index];

    // Clear any existing error for this key when value is modified
    if (this.keyErrors[index]) {
      const newKeyErrors = { ...this.keyErrors };
      delete newKeyErrors[index];
      this.keyErrors = newKeyErrors;
    }

    this.handleItemChange(index, {
      key: currentItem.key,
      value: newValue
    });
  }

  // Override renderWidget for readOnlyKeys to use a single grid
  // so all key labels share one auto-sized column
  renderWidget(): TemplateResult {
    if (this.readOnlyKeys) {
      const items = this.displayItems;
      return html`
        <div class="readonly-keys-grid">
          ${items.map(
            (item, index) => html`
              <div class="key-label">${item.key}</div>
              <temba-textinput
                flavor="xsmall"
                .value=${item.value}
                .placeholder=${this.valuePlaceholder}
                @change=${(e: any) =>
                  this.handleValueChange(index, e.target.value)}
              ></temba-textinput>
            `
          )}
        </div>
      `;
    }
    return super.renderWidget();
  }

  renderItem(item: KeyValueItem, index: number): TemplateResult {
    const keyError =
      this.showValidation && this.keyErrors[index] ? this.keyErrors[index] : '';

    return html`
      <div class="row">
        <temba-textinput
          flavor="xsmall"
          .value=${item.key}
          .placeholder=${this.keyPlaceholder}
          .errors=${keyError ? [keyError] : []}
          @change=${(e: any) => this.handleKeyChange(index, e.target.value)}
        ></temba-textinput>
        <temba-textinput
          flavor="xsmall"
          .value=${item.value}
          .placeholder=${this.valuePlaceholder}
          @change=${(e: any) => this.handleValueChange(index, e.target.value)}
        ></temba-textinput>
        ${this.renderRemoveButton(index)}
      </div>
    `;
  }

  protected get displayItems(): KeyValueItem[] {
    if (this.readOnlyKeys) {
      // In readOnlyKeys mode, show only the actual items (no empty row)
      return [...this._items];
    }
    return super.displayItems;
  }

  protected shouldShowAddButton(): boolean {
    if (this.readOnlyKeys) {
      return false;
    }
    return super.shouldShowAddButton();
  }

  protected getContainerClass(): string {
    return 'key-value-editor';
  }

  static get styles() {
    return css`
      ${super.styles}

      .key-value-editor {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .row {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        align-items: center;
        column-gap: 12px;
      }

      .readonly-keys-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 8px 10px;
        align-items: center;
      }

      .key-label {
        font-size: 13px;
        color: #555;
        padding: 6px 10px;
        white-space: nowrap;
      }
    `;
  }
}
