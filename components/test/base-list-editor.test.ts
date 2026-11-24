import '../temba-modules';
import { fixture, expect } from '@open-wc/testing';
import { html, TemplateResult } from 'lit';
import { BaseListEditor } from '../src/form/BaseListEditor';

interface TextItem {
  text: string;
}

/**
 * A minimal concrete editor so the shared list behaviour can be exercised
 * directly rather than through one of the richer subclasses.
 */
class TestListEditor extends BaseListEditor<TextItem> {
  public isEmptyItem(item: TextItem): boolean {
    return !item || !item.text || item.text.trim() === '';
  }

  public createEmptyItem(): TextItem {
    return { text: '' };
  }

  public renderItem(item: TextItem, index: number): TemplateResult {
    return html`<div class="item" data-index=${index}>${item.text}</div>`;
  }

  // thin public wrappers so tests can drive the protected surface
  public get items(): TextItem[] {
    return (this as any)._items;
  }
  public setItems(items: TextItem[]) {
    (this as any)._items = items;
  }
  public callDisplayItems(): TextItem[] {
    return (this as any).displayItems;
  }
  public callAddItem(item?: TextItem) {
    return (this as any).addItem(item);
  }
  public callRemoveItem(index: number) {
    return (this as any).removeItem(index);
  }
  public callCanRemoveItem(index: number) {
    return (this as any).canRemoveItem(index);
  }
  public callHandleItemChange(index: number, item: TextItem) {
    return (this as any).handleItemChange(index, item);
  }
  public callHandleFieldChange(index: number, field: string, value: any) {
    return (this as any).handleFieldChange(index, field, value);
  }
  public callCleanItems(items: TextItem[]) {
    return (this as any).cleanItems(items);
  }
  public callShouldShowAddButton() {
    return (this as any).shouldShowAddButton();
  }
}

customElements.define('test-list-editor', TestListEditor);

const createEditor = async (attrs = ''): Promise<TestListEditor> => {
  return (await fixture(
    `<test-list-editor ${attrs}></test-list-editor>`
  )) as TestListEditor;
};

// records change events emitted by the editor
const recordChanges = (editor: TestListEditor) => {
  const seen: any[] = [];
  editor.addEventListener('change', (e: any) => seen.push(e.detail.value));
  return seen;
};

describe('form/BaseListEditor', () => {
  describe('displayItems', () => {
    it('returns the items as-is by default', async () => {
      const editor = await createEditor();
      editor.setItems([{ text: 'a' }]);
      expect(editor.callDisplayItems()).to.deep.equal([{ text: 'a' }]);
    });

    it('appends a trailing empty item when maintaining one', async () => {
      const editor = await createEditor('maintainEmptyItem');
      editor.setItems([{ text: 'a' }]);
      expect(editor.callDisplayItems()).to.deep.equal([
        { text: 'a' },
        { text: '' }
      ]);
    });

    it('does not append a second empty item', async () => {
      const editor = await createEditor('maintainEmptyItem');
      editor.setItems([{ text: 'a' }, { text: '' }]);
      expect(editor.callDisplayItems()).to.have.length(2);
    });

    it('stops appending once maxItems is reached', async () => {
      const editor = await createEditor('maintainEmptyItem maxItems="2"');
      editor.setItems([{ text: 'a' }, { text: 'b' }]);
      expect(editor.callDisplayItems()).to.have.length(2);
    });

    it('does not mutate the underlying items', async () => {
      const editor = await createEditor('maintainEmptyItem');
      const items = [{ text: 'a' }];
      editor.setItems(items);
      editor.callDisplayItems();
      expect(items).to.have.length(1);
    });
  });

  describe('addItem', () => {
    it('appends a new empty item', async () => {
      const editor = await createEditor();
      const changes = recordChanges(editor);
      editor.callAddItem();
      expect(editor.items).to.deep.equal([{ text: '' }]);
      expect(changes).to.have.length(1);
    });

    it('appends a supplied item', async () => {
      const editor = await createEditor();
      editor.callAddItem({ text: 'hello' });
      expect(editor.items).to.deep.equal([{ text: 'hello' }]);
    });

    it('refuses to go past maxItems', async () => {
      const editor = await createEditor('maxItems="1"');
      editor.setItems([{ text: 'a' }]);
      const changes = recordChanges(editor);
      editor.callAddItem({ text: 'b' });
      expect(editor.items).to.have.length(1);
      expect(changes).to.have.length(0);
    });
  });

  describe('removeItem', () => {
    it('removes the item at the given index', async () => {
      const editor = await createEditor();
      editor.setItems([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
      editor.callRemoveItem(1);
      expect(editor.items).to.deep.equal([{ text: 'a' }, { text: 'c' }]);
    });

    it('refuses to go below minItems', async () => {
      const editor = await createEditor('minItems="2"');
      editor.setItems([{ text: 'a' }, { text: 'b' }]);
      const changes = recordChanges(editor);
      editor.callRemoveItem(0);
      expect(editor.items).to.have.length(2);
      expect(changes).to.have.length(0);
    });
  });

  describe('canRemoveItem', () => {
    it('allows removing an ordinary item', async () => {
      const editor = await createEditor();
      editor.setItems([{ text: 'a' }, { text: 'b' }]);
      expect(editor.callCanRemoveItem(0)).to.equal(true);
    });

    it('refuses when at the minimum', async () => {
      const editor = await createEditor('minItems="2"');
      editor.setItems([{ text: 'a' }, { text: 'b' }]);
      expect(editor.callCanRemoveItem(0)).to.equal(false);
    });

    it('refuses to remove the maintained empty item', async () => {
      const editor = await createEditor('maintainEmptyItem');
      editor.setItems([{ text: 'a' }, { text: 'b' }]);
      // index 2 is the auto-appended empty row
      expect(editor.callCanRemoveItem(2)).to.equal(false);
      expect(editor.callCanRemoveItem(0)).to.equal(true);
    });
  });

  describe('handleItemChange', () => {
    it('replaces the item and emits the new value', async () => {
      const editor = await createEditor();
      editor.setItems([{ text: 'a' }, { text: 'b' }]);
      const changes = recordChanges(editor);
      editor.callHandleItemChange(1, { text: 'updated' });
      expect(editor.items).to.deep.equal([{ text: 'a' }, { text: 'updated' }]);
      expect(changes[0]).to.deep.equal([{ text: 'a' }, { text: 'updated' }]);
    });
  });

  describe('handleFieldChange', () => {
    it('updates a single field on an existing item', async () => {
      const editor = await createEditor();
      editor.setItems([{ text: 'a' }]);
      editor.callHandleFieldChange(0, 'text', 'changed');
      expect(editor.items).to.deep.equal([{ text: 'changed' }]);
    });

    it('extends the list when editing the trailing empty row', async () => {
      const editor = await createEditor('maintainEmptyItem');
      editor.setItems([{ text: 'a' }]);
      editor.callHandleFieldChange(1, 'text', 'new');
      expect(editor.items).to.deep.equal([{ text: 'a' }, { text: 'new' }]);
    });

    it('fills any gap with empty items', async () => {
      const editor = await createEditor();
      editor.setItems([{ text: 'a' }]);
      editor.callHandleFieldChange(3, 'text', 'far');
      expect(editor.items).to.have.length(4);
      expect(editor.items[1]).to.deep.equal({ text: '' });
      expect(editor.items[3]).to.deep.equal({ text: 'far' });
    });

    it('refuses to extend past maxItems', async () => {
      const editor = await createEditor('maxItems="1"');
      editor.setItems([{ text: 'a' }]);
      const changes = recordChanges(editor);
      editor.callHandleFieldChange(1, 'text', 'new');
      expect(editor.items).to.have.length(1);
      expect(changes).to.have.length(0);
    });

    it('preserves other fields on the item', async () => {
      const editor = await createEditor();
      editor.setItems([{ text: 'a', extra: 'keep' } as any]);
      editor.callHandleFieldChange(0, 'text', 'changed');
      expect(editor.items[0]).to.deep.equal({ text: 'changed', extra: 'keep' });
    });
  });

  describe('cleanItems', () => {
    it('passes items through untouched by default', async () => {
      const editor = await createEditor();
      const items = [{ text: 'a' }, { text: '' }];
      expect(editor.callCleanItems(items)).to.deep.equal(items);
    });

    it('strips empty items when maintaining an empty row', async () => {
      const editor = await createEditor('maintainEmptyItem');
      expect(
        editor.callCleanItems([{ text: 'a' }, { text: '  ' }, { text: 'b' }])
      ).to.deep.equal([{ text: 'a' }, { text: 'b' }]);
    });

    it('emits the cleaned value on change', async () => {
      const editor = await createEditor('maintainEmptyItem');
      const changes = recordChanges(editor);
      editor.callHandleItemChange(0, { text: '' });
      expect(changes[0]).to.deep.equal([]);
    });
  });

  describe('add button', () => {
    it('is shown by default', async () => {
      const editor = await createEditor();
      expect(editor.callShouldShowAddButton()).to.equal(true);
      await editor.updateComplete;
      expect(editor.shadowRoot.querySelector('.add-btn')).to.not.equal(null);
    });

    it('is hidden once maxItems is reached', async () => {
      const editor = await createEditor('maxItems="1"');
      editor.setItems([{ text: 'a' }]);
      expect(editor.callShouldShowAddButton()).to.equal(false);
    });

    it('is hidden when an empty row is maintained instead', async () => {
      const editor = await createEditor('maintainEmptyItem');
      expect(editor.callShouldShowAddButton()).to.equal(false);
      await editor.updateComplete;
      expect(editor.shadowRoot.querySelector('.add-btn')).to.equal(null);
    });

    it('adds an item when clicked', async () => {
      const editor = await createEditor();
      await editor.updateComplete;
      const button = editor.shadowRoot.querySelector(
        '.add-btn'
      ) as HTMLButtonElement;
      button.click();
      expect(editor.items).to.have.length(1);
    });
  });

  describe('rendering', () => {
    it('renders a row per display item', async () => {
      const editor = await createEditor('maintainEmptyItem');
      editor.setItems([{ text: 'a' }, { text: 'b' }]);
      await editor.updateComplete;
      // two real rows plus the maintained empty one
      expect(editor.shadowRoot.querySelectorAll('.item')).to.have.length(3);
    });
  });
});
