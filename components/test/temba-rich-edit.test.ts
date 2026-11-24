import '../temba-modules';
import { fixture, html, expect } from '@open-wc/testing';
import { serialize } from '../src/utils';

describe('temba-rich-edit', () => {
  it('emits input when selecting a completion option', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="@con" session></temba-rich-edit>
    `)) as any;

    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as any;
    const options = editor.shadowRoot.querySelector('temba-options') as any;

    // Place caret at end so completion replacement applies to the query.
    editableDiv.focus();
    editableDiv.setSelectionRange(4, 4);
    editor.query = 'con';

    let inputEvents = 0;
    let changeEvents = 0;
    editor.addEventListener('input', () => {
      inputEvents += 1;
    });
    editor.addEventListener('change', () => {
      changeEvents += 1;
    });

    options.dispatchEvent(
      new CustomEvent('temba-selection', {
        detail: {
          selected: { name: 'contact.name' },
          tabbed: false
        },
        bubbles: true,
        composed: true
      })
    );

    expect(editor.value).to.equal('@contact.name');
    expect(inputEvents).to.equal(1);
    expect(changeEvents).to.equal(1);
  });

  it('emits input when selecting completion via keyboard', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="@con" session></temba-rich-edit>
    `)) as any;

    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as any;
    editor.query = 'con';
    editor.options = [{ name: 'contact.name' }];
    await editor.updateComplete;

    editableDiv.focus();
    editableDiv.setSelectionRange(4, 4);

    let inputEvents = 0;
    editor.addEventListener('input', () => {
      inputEvents += 1;
    });

    editableDiv.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        composed: true
      })
    );

    expect(editor.value).to.equal('@contact.name');
    expect(inputEvents).to.equal(1);
  });

  it('undoes completion back to pre-completion value', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="@co" session></temba-rich-edit>
    `)) as any;

    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as any;
    const options = editor.shadowRoot.querySelector('temba-options') as any;

    // Type one character so undo history contains "@co".
    editableDiv.focus();
    editableDiv.setSelectionRange(3, 3);
    editableDiv.textContent = '@con';
    editableDiv.dispatchEvent(new Event('input', { bubbles: true }));
    await editor.updateComplete;
    expect(editor.value).to.equal('@con');

    editor.query = 'con';
    editableDiv.setSelectionRange(4, 4);
    options.dispatchEvent(
      new CustomEvent('temba-selection', {
        detail: {
          selected: { name: 'contact.name' },
          tabbed: false
        },
        bubbles: true,
        composed: true
      })
    );
    expect(editor.value).to.equal('@contact.name');

    // Undo should return to "@con" (state immediately before completion),
    // not to the earlier "@co" typing state.
    editor.performUndo();
    expect(editor.value).to.equal('@con');
  });

  // Synthesized keydowns can't drive native arrow/cursor navigation in
  // Chromium (the browser only does that for real input from the OS), so the
  // arrow-key tests below assert defaultPrevented instead of caret position.
  it('does not consume arrow keys in another editor when a sibling has options open', async () => {
    const wrapper = (await fixture(html`
      <div>
        <temba-rich-edit
          id="popup"
          value="@con"
          textarea
          session
        ></temba-rich-edit>
        <temba-rich-edit
          id="active"
          value="line one${'\n'}line two${'\n'}line three"
          textarea
        ></temba-rich-edit>
      </div>
    `)) as HTMLElement;

    const popup = wrapper.querySelector('#popup') as any;
    const active = wrapper.querySelector('#active') as any;
    await popup.updateComplete;
    await active.updateComplete;

    popup.options = [{ name: 'contact.name' }, { name: 'contact.uuid' }];
    await popup.updateComplete;

    const activeDiv = active.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;
    activeDiv.focus();
    (activeDiv as any).setSelectionRange(0, 0);

    const evt = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      composed: true,
      cancelable: true
    });
    activeDiv.dispatchEvent(evt);
    await active.updateComplete;

    expect(evt.defaultPrevented).to.equal(false);
  });

  it('still consumes arrow keys when the same editor has options open', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="@con" textarea session></temba-rich-edit>
    `)) as any;
    editor.options = [{ name: 'contact.name' }, { name: 'contact.uuid' }];
    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;
    editableDiv.focus();

    const evt = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      composed: true,
      cancelable: true
    });
    editableDiv.dispatchEvent(evt);
    await editor.updateComplete;

    expect(evt.defaultPrevented).to.equal(true);
  });

  it('lets Ctrl+Y pass through on macOS so Cocoa yank works', async () => {
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      configurable: true
    });

    try {
      const editor = (await fixture(html`
        <temba-rich-edit value="hello world" textarea></temba-rich-edit>
      `)) as any;
      await editor.updateComplete;

      const editableDiv = editor.shadowRoot.querySelector(
        '.highlight-editor'
      ) as HTMLDivElement;
      editableDiv.focus();

      const evt = new KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        bubbles: true,
        composed: true,
        cancelable: true
      });
      editableDiv.dispatchEvent(evt);
      await editor.updateComplete;

      expect(evt.defaultPrevented).to.equal(false);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUA,
        configurable: true
      });
    }
  });

  it('still treats Ctrl+Y as redo on non-Mac platforms', async () => {
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      configurable: true
    });

    try {
      const editor = (await fixture(html`
        <temba-rich-edit value="hello" textarea></temba-rich-edit>
      `)) as any;
      await editor.updateComplete;

      const editableDiv = editor.shadowRoot.querySelector(
        '.highlight-editor'
      ) as HTMLDivElement;
      editableDiv.focus();

      const evt = new KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        bubbles: true,
        composed: true,
        cancelable: true
      });
      editableDiv.dispatchEvent(evt);
      await editor.updateComplete;

      expect(evt.defaultPrevented).to.equal(true);
    } finally {
      Object.defineProperty(navigator, 'userAgent', {
        value: originalUA,
        configurable: true
      });
    }
  });

  it('inserts a newline on Enter when options popup is not visible', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="hello" textarea></temba-rich-edit>
    `)) as any;
    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;
    editableDiv.focus();
    (editableDiv as any).setSelectionRange(5, 5);

    const evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      composed: true,
      cancelable: true
    });
    editableDiv.dispatchEvent(evt);
    await editor.updateComplete;

    expect(editor.value).to.equal('hello\n');
  });

  it('renders a sentinel <br> for trailing newlines so they are visible', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit
        value="hello
"
        textarea
      ></temba-rich-edit>
    `)) as any;
    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;

    // The last child should be a <br> so Firefox renders the trailing newline.
    expect(editableDiv.lastElementChild?.tagName).to.equal('BR');
    // Round-tripping through the text extractor should still yield the value.
    const text = (editableDiv as any).value;
    expect(text).to.equal('hello\n');
  });

  it('does not add a sentinel <br> when text does not end in a newline', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="hello" textarea></temba-rich-edit>
    `)) as any;
    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;
    expect(editableDiv.lastElementChild?.tagName).to.not.equal('BR');
  });

  it('preserves newlines from yanked content with intermixed <br> elements', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="" textarea></temba-rich-edit>
    `)) as any;
    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;

    // Simulate the DOM Chrome leaves behind after yanking multi-line text:
    // text nodes separated by browser <br> elements (no data-sentinel attr).
    editableDiv.textContent = '';
    editableDiv.appendChild(document.createTextNode('line1'));
    editableDiv.appendChild(document.createElement('br'));
    editableDiv.appendChild(document.createTextNode('line2'));
    editableDiv.appendChild(document.createElement('br'));
    editableDiv.appendChild(document.createTextNode('line3'));

    editableDiv.dispatchEvent(new Event('input', { bubbles: true }));
    await editor.updateComplete;

    expect(editor.value).to.equal('line1\nline2\nline3');
  });

  it('preserves newlines from yanked content split into <div> blocks', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="" textarea></temba-rich-edit>
    `)) as any;
    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;

    // Chrome sometimes wraps yanked lines into <div> blocks.
    editableDiv.textContent = '';
    editableDiv.appendChild(document.createTextNode('line1'));
    const div2 = document.createElement('div');
    div2.textContent = 'line2';
    editableDiv.appendChild(div2);
    const div3 = document.createElement('div');
    div3.textContent = 'line3';
    editableDiv.appendChild(div3);

    editableDiv.dispatchEvent(new Event('input', { bubbles: true }));
    await editor.updateComplete;

    expect(editor.value).to.equal('line1\nline2\nline3');
  });

  it('still ignores the trailing data-sentinel <br> when reading the value', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit
        value="hello
"
        textarea
      ></temba-rich-edit>
    `)) as any;
    await editor.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;
    const lastChild = editableDiv.lastElementChild;
    expect(lastChild?.tagName).to.equal('BR');
    expect(lastChild?.hasAttribute('data-sentinel')).to.equal(true);

    // The sentinel must not contribute an extra "\n" when round-tripping.
    expect((editableDiv as any).value).to.equal('hello\n');
  });

  it('does not consume Enter when options array is populated but popup is not visible', async () => {
    const editor = (await fixture(html`
      <temba-rich-edit value="hello" textarea></temba-rich-edit>
    `)) as any;
    await editor.updateComplete;

    const optionsEl = editor.shadowRoot.querySelector('temba-options') as any;
    // Force the temba-options into the inconsistent state: populated options
    // but not visible. Setting via the element directly bypasses the parent
    // re-render that would normally tie these together.
    optionsEl.options = [{ name: 'contact.name' }];
    optionsEl.visible = false;
    await optionsEl.updateComplete;

    const editableDiv = editor.shadowRoot.querySelector(
      '.highlight-editor'
    ) as HTMLDivElement;
    editableDiv.focus();
    (editableDiv as any).setSelectionRange(5, 5);

    const evt = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      composed: true,
      cancelable: true
    });
    editableDiv.dispatchEvent(evt);
    await editor.updateComplete;

    // Enter should reach the editor and insert a newline rather than being
    // swallowed by the hidden popup.
    expect(editor.value).to.equal('hello\n');
  });

  it('submits its value once in a form', async () => {
    const form = (await fixture(html`
      <form><temba-rich-edit name="text" value="hello"></temba-rich-edit></form>
    `)) as HTMLFormElement;
    const editor = form.querySelector('temba-rich-edit') as any;
    await editor.updateComplete;

    expect([...new FormData(form).entries()]).to.deep.equal([
      ['text', 'hello']
    ]);
    expect(serialize(form)).to.equal('text=hello');

    editor.value = 'changed';
    await editor.updateComplete;

    expect([...new FormData(form).entries()]).to.deep.equal([
      ['text', 'changed']
    ]);
    expect(serialize(form)).to.equal('text=changed');
  });
});
