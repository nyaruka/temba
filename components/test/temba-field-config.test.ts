import { html, fixture, expect } from '@open-wc/testing';
import '../src/form/KeyValueEditor';
import '../src/form/ArrayEditor';

if (!customElements.get('temba-rich-edit')) {
  class TestRichEdit extends HTMLElement {
    private editableDiv: HTMLDivElement;
    private caretStart = 0;
    private caretEnd = 0;

    connectedCallback() {
      if (this.shadowRoot) {
        return;
      }

      const shadow = this.attachShadow({ mode: 'open' });
      this.editableDiv = document.createElement('div');
      this.editableDiv.className = 'highlight-editor';
      this.editableDiv.setAttribute('contenteditable', 'true');
      shadow.appendChild(this.editableDiv);

      const hiddenInput = document.createElement('input');
      hiddenInput.type = 'hidden';
      hiddenInput.name = this.getAttribute('name') || '';
      this.appendChild(hiddenInput);

      Object.defineProperty(this.editableDiv, 'selectionStart', {
        get: () => this.caretStart
      });
      Object.defineProperty(this.editableDiv, 'selectionEnd', {
        get: () => this.caretEnd
      });
      (this.editableDiv as any).setSelectionRange = (
        start: number,
        end: number
      ) => {
        this.caretStart = start;
        this.caretEnd = end;
      };
    }

    focus() {
      this.editableDiv?.focus();
    }
  }

  customElements.define('temba-rich-edit', TestRichEdit);
}

describe('Field Configuration System', () => {
  describe('KeyValueEditor', () => {
    it('should render with empty value and always show one empty row', async () => {
      const el = await fixture(html`
        <temba-key-value-editor></temba-key-value-editor>
      `);

      expect(el).to.exist;
      // Should always have at least one row (empty row)
      const rows = el.shadowRoot?.querySelectorAll('.row');
      expect(rows?.length).to.equal(1);
      // Should not have add button anymore
      expect(el.shadowRoot?.querySelector('.add-btn')).to.not.exist;
    });

    it('should render with initial values and maintain empty row', async () => {
      const initialValue = {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token123'
      };

      const el = await fixture(html`
        <temba-key-value-editor .value=${initialValue}></temba-key-value-editor>
      `);

      expect(el).to.exist;
      // Should have 2 data rows + 1 empty row = 3 total
      const rows = el.shadowRoot?.querySelectorAll('.row');
      expect(rows?.length).to.equal(3);
    });

    it('should emit clean values without empty rows', async () => {
      const el = await fixture(html`
        <temba-key-value-editor></temba-key-value-editor>
      `);

      let changeEvent: any = null;
      el.addEventListener('change', (e) => {
        changeEvent = e;
      });

      // Trigger a field change that should cause an update
      const keyInput = el.shadowRoot?.querySelector('temba-textinput') as any;
      if (keyInput) {
        keyInput.value = 'test-key';
        keyInput.dispatchEvent(new Event('change'));
      }

      await (el as any).updateComplete;

      expect(changeEvent).to.exist;
      // Should emit the array format with key-value pairs
      expect(changeEvent.detail.value).to.be.an('array');
      expect(changeEvent.detail.value).to.deep.include({
        key: 'test-key',
        value: ''
      });
    });

    it('should disable remove button for empty rows', async () => {
      const initialValue = {
        'Content-Type': 'application/json'
      };

      const el = await fixture(html`
        <temba-key-value-editor .value=${initialValue}></temba-key-value-editor>
      `);

      expect(el).to.exist;
      const rows = el.shadowRoot?.querySelectorAll('.row');
      expect(rows?.length).to.equal(2); // 1 data row + 1 empty row

      // First row (with data) can be removed
      const firstRowRemoveBtn = rows?.[0]?.querySelector(
        '.remove-btn'
      ) as HTMLButtonElement;
      expect(firstRowRemoveBtn.disabled).to.be.false;

      // Second row (empty) can't be
      const secondRowRemoveBtn = rows?.[1]?.querySelector(
        '.remove-btn'
      ) as HTMLButtonElement;
      expect(secondRowRemoveBtn.disabled).to.be.true;
    });

    it('should enable remove button when empty row gets content', async () => {
      const el = await fixture(html`
        <temba-key-value-editor></temba-key-value-editor>
      `);

      const removeDisabled = (row: Element) =>
        (row.querySelector('.remove-btn') as HTMLButtonElement).disabled;

      // Initially the empty row can't be removed
      let rows = el.shadowRoot?.querySelectorAll('.row');
      expect(removeDisabled(rows[0])).to.be.true;

      // Simulate adding content by setting value and triggering update
      (el as any).value = { 'test-key': '' };
      (el as any).requestUpdate();
      await (el as any).updateComplete;

      // Now should have remove button for the row with content
      rows = el.shadowRoot?.querySelectorAll('.row');
      expect(rows?.length).to.equal(2); // row with content + empty row
      expect(removeDisabled(rows[0])).to.be.false;
      expect(removeDisabled(rows[1])).to.be.true;
    });

    it('should render evaluated values as rich-edit, keys as textinput', async () => {
      const el = await fixture(html`
        <temba-key-value-editor
          evaluatedValues
          .value=${{ Authorization: '@globals.api_token' }}
        ></temba-key-value-editor>
      `);

      const row = el.shadowRoot?.querySelector('.row');
      expect(row?.querySelector('temba-textinput')).to.exist;
      expect(row?.querySelector('temba-rich-edit')).to.exist;
    });

    it('should not render rich-edit values by default', async () => {
      const el = await fixture(html`
        <temba-key-value-editor
          .value=${{ Authorization: '@globals.api_token' }}
        ></temba-key-value-editor>
      `);

      expect(el.shadowRoot?.querySelector('temba-rich-edit')).to.not.exist;
    });

    it('should update value on rich-edit changes', async () => {
      const el = await fixture(html`
        <temba-key-value-editor
          evaluatedValues
          .value=${{ Authorization: 'Token abc' }}
        ></temba-key-value-editor>
      `);

      const valueInput = el.shadowRoot?.querySelector('temba-rich-edit') as any;
      valueInput.value = 'Token @globals.api_token';
      valueInput.dispatchEvent(new Event('change'));
      await (el as any).updateComplete;

      expect((el as any).value).to.deep.include({
        key: 'Authorization',
        value: 'Token @globals.api_token'
      });
    });

    it('should render evaluated values as rich-edit with readOnlyKeys', async () => {
      const el = await fixture(html`
        <temba-key-value-editor
          evaluatedValues
          readOnlyKeys
          .value=${{ Authorization: '@globals.api_token' }}
        ></temba-key-value-editor>
      `);

      const grid = el.shadowRoot?.querySelector('.readonly-keys-grid');
      expect(grid?.querySelector('temba-rich-edit')).to.exist;
      expect(grid?.querySelector('temba-textinput')).to.not.exist;
    });
  });

  describe('ArrayEditor', () => {
    it('should render with empty array', async () => {
      const itemConfig = {
        name: { type: 'text', label: 'Name', required: true },
        value: { type: 'text', label: 'Value' }
      };

      const el = await fixture(html`
        <temba-array-editor .itemConfig=${itemConfig}></temba-array-editor>
      `);

      await (el as any).updateComplete;

      expect(el).to.exist;
      // ArrayEditor with maintainEmptyItem=true doesn't show add button
      expect(el.shadowRoot?.querySelector('.add-btn')).to.not.exist;
    });

    it('should render with initial items', async () => {
      const itemConfig = {
        operator: { type: 'text', label: 'Operator' },
        value: { type: 'text', label: 'Value' }
      };

      const initialValue = [
        { operator: 'equals', value: 'test' },
        { operator: 'contains', value: 'example' }
      ];

      const el = await fixture(html`
        <temba-array-editor
          .value=${initialValue}
          .itemConfig=${itemConfig}
          itemLabel="Rule"
        ></temba-array-editor>
      `);

      expect(el).to.exist;
      const items = el.shadowRoot?.querySelectorAll('.array-item');
      // Expects 3 items: 2 initial items + 1 auto-generated empty item
      expect(items?.length).to.equal(3);
    });

    it('should render with sortable list when sortable=true', async () => {
      const itemConfig = {
        operator: { type: 'text', label: 'Operator' },
        value: { type: 'text', label: 'Value' }
      };

      const initialValue = [
        { operator: 'equals', value: 'test' },
        { operator: 'contains', value: 'example' }
      ];

      const el = await fixture(html`
        <temba-array-editor
          .value=${initialValue}
          .itemConfig=${itemConfig}
          .sortable=${true}
          itemLabel="Rule"
        ></temba-array-editor>
      `);

      await (el as any).updateComplete;

      expect(el).to.exist;

      // Should have a sortable list component
      const sortableList = el.shadowRoot?.querySelector('temba-sortable-list');
      expect(sortableList).to.exist;

      // Should have sortable items with proper classes and IDs
      const sortableItems = el.shadowRoot?.querySelectorAll('.sortable');
      expect(sortableItems?.length).to.equal(2); // Only non-empty items should be sortable

      // Each sortable item should have a unique ID
      const firstItem = sortableItems?.[0] as HTMLElement;
      const secondItem = sortableItems?.[1] as HTMLElement;
      expect(firstItem?.id).to.equal('array-item-0');
      expect(secondItem?.id).to.equal('array-item-1');
    });

    it('should not render sortable list when sortable=false', async () => {
      const itemConfig = {
        operator: { type: 'text', label: 'Operator' },
        value: { type: 'text', label: 'Value' }
      };

      const initialValue = [{ operator: 'equals', value: 'test' }];

      const el = await fixture(html`
        <temba-array-editor
          .value=${initialValue}
          .itemConfig=${itemConfig}
          .sortable=${false}
          itemLabel="Rule"
        ></temba-array-editor>
      `);

      await (el as any).updateComplete;

      expect(el).to.exist;

      // Should not have a sortable list component
      const sortableList = el.shadowRoot?.querySelector('temba-sortable-list');
      expect(sortableList).to.not.exist;

      // Should have regular list container instead
      const listContainer = el.shadowRoot?.querySelector('.list-items');
      expect(listContainer).to.exist;
    });

    it('should capture caret position for evaluated text fields', async () => {
      const itemConfig = {
        expression: { type: 'text', label: 'Expression', evaluated: true }
      };

      const el = await fixture(html`
        <temba-array-editor
          .value=${[{ expression: '@contact.name' }]}
          .itemConfig=${itemConfig}
        ></temba-array-editor>
      `);

      await (el as any).updateComplete;

      const richEdit = el.shadowRoot?.querySelector('temba-rich-edit') as any;
      expect(richEdit).to.exist;

      richEdit.focus();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const editable = richEdit.shadowRoot?.querySelector(
        '.highlight-editor'
      ) as any;
      expect(editable).to.exist;
      editable.setSelectionRange(3, 3);

      (el as any).captureFocus();

      expect((el as any).focusInfo.itemIndex).to.equal(0);
      expect((el as any).focusInfo.fieldName).to.equal('expression');
      expect((el as any).focusInfo.selectionStart).to.equal(3);
      expect((el as any).focusInfo.selectionEnd).to.equal(3);
    });
  });
});
