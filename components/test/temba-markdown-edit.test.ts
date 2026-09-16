import { fixture, assert, expect } from '@open-wc/testing';
import { stub } from 'sinon';
import { Options } from '../src/display/Options';
import { MarkdownEditor } from '../src/form/MarkdownEditor';
import {
  blockOf,
  joinBlocks,
  renderBlock,
  splitBlocks
} from '../src/form/MarkdownDocument';
import {
  assertScreenshot,
  clearMockPosts,
  getClip,
  getComponent,
  mockGET,
  mockPOST,
  mouseClickElement,
  waitForImages
} from './utils.test';

const TAG = 'temba-markdown-edit';
const UPLOAD = '/msgmedia/upload/';

const getEditor = async (
  value = '',
  minHeight = 0
): Promise<MarkdownEditor> => {
  const editor = (await fixture(
    `<${TAG} widget_only endpoint="${UPLOAD}"></${TAG}>`
  )) as MarkdownEditor;

  editor.minHeight = minHeight;
  editor.value = value;
  await editor.updateComplete;
  return editor;
};

const doc = (editor: MarkdownEditor): HTMLElement => editor.doc;

/** the document's top level blocks, which are the rendered article itself */
const blocks = (editor: MarkdownEditor): HTMLElement[] =>
  [...editor.doc.children] as HTMLElement[];

const selectionOf = (editor: MarkdownEditor): Selection => {
  const root = editor.shadowRoot as any;
  return root.getSelection ? root.getSelection() : document.getSelection();
};

/** puts the caret in a block at an offset into its text, the way clicking there would */
const caretIn = async (
  editor: MarkdownEditor,
  index: number,
  offset: number
): Promise<void> => {
  const block = blocks(editor)[index];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const range = document.createRange();

  let seen = 0;
  let node: Text;
  let placed = false;

  while ((node = walker.nextNode() as Text)) {
    if (seen + node.length >= offset) {
      range.setStart(node, offset - seen);
      placed = true;
      break;
    }
    seen += node.length;
  }

  if (!placed) {
    range.selectNodeContents(block);
    range.collapse(false);
  }

  range.collapse(true);

  doc(editor).focus();
  const selection = selectionOf(editor);
  selection.removeAllRanges();
  selection.addRange(range);

  // selectionchange is a task of its own, and it's what tells the toolbar and the link bar where the caret went
  await new Promise((resolve) => setTimeout(resolve, 0));
  await editor.updateComplete;
};

/** selects from one place in the document to another, across blocks if asked */
const selectAcross = async (
  editor: MarkdownEditor,
  from: [number, number],
  to: [number, number]
): Promise<void> => {
  await caretIn(editor, from[0], from[1]);
  const start = selectionOf(editor).getRangeAt(0);

  await caretIn(editor, to[0], to[1]);
  const end = selectionOf(editor).getRangeAt(0);

  const range = document.createRange();
  range.setStart(start.startContainer, start.startOffset);
  range.setEnd(end.startContainer, end.startOffset);

  const selection = selectionOf(editor);
  selection.removeAllRanges();
  selection.addRange(range);
};

const selectAll = async (editor: MarkdownEditor): Promise<void> => {
  doc(editor).focus();
  const range = document.createRange();
  range.selectNodeContents(doc(editor));
  const selection = selectionOf(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  await editor.updateComplete;
};

/** clicks a toolbar command, which wears the format it applies rather than a label the eye could read */
const toolbar = async (
  editor: MarkdownEditor,
  format: string
): Promise<void> => {
  const button = editor.shadowRoot.querySelector(
    `.toolbar .format.${format}`
  ) as HTMLElement;

  button.click();

  // formatting puts the caret back in the document when nothing is focused, so let that settle before looking
  await new Promise((resolve) => setTimeout(resolve, 0));
  await editor.updateComplete;
};

/** the switch between the rendered article and its markdown, which is a toolbar button of its own */
const modeSwitch = (editor: MarkdownEditor): HTMLElement =>
  editor.shadowRoot.querySelector(
    '.toolbar .format[title="Markdown source"]'
  ) as HTMLElement;

const uploadFile = (name = 'shot.png'): File =>
  new File(['shot'], name, { type: 'image/png' });

/** everything the author can see in the document */
const shown = (editor: MarkdownEditor): string => doc(editor).textContent;

describe('splitBlocks', () => {
  const roundTrips = (markdown: string) => {
    assert.equal(joinBlocks(splitBlocks(markdown)), markdown);
  };

  it('splits on blank lines', () => {
    const blocks = splitBlocks('# Title\n\nA paragraph.');
    assert.deepEqual(
      blocks.map((block) => block.source),
      ['# Title', 'A paragraph.']
    );
  });

  it('keeps a fenced block whole', () => {
    const blocks = splitBlocks('intro\n\n```\none\n\ntwo\n```\n\nafter');
    assert.deepEqual(
      blocks.map((block) => block.source),
      ['intro', '```\none\n\ntwo\n```', 'after']
    );
  });

  it('does not close a fence on an info string inside it', () => {
    const blocks = splitBlocks(
      '```\n```js is how you tag one\n\nstill code\n```'
    );
    assert.equal(blocks.length, 1);
  });

  it('keeps a loose list whole', () => {
    const blocks = splitBlocks('* one\n\n* two\n\n* three');
    assert.equal(blocks.length, 1);
  });

  it('keeps a list item with more than one paragraph whole', () => {
    assert.equal(
      splitBlocks('1. one\n\n   more about one\n\n2. two').length,
      1
    );
  });

  it('keeps a blockquote whole across blank lines', () => {
    assert.equal(splitBlocks('> one\n\n> two').length, 1);
  });

  it('always has somewhere to type', () => {
    assert.deepEqual(splitBlocks(''), [{ source: '', trailer: '' }]);
  });

  it('round trips byte for byte', () => {
    roundTrips('');
    roundTrips('one');
    roundTrips('one\n');
    roundTrips('one\n\n\n\ntwo');
    roundTrips('\n\nleading blanks\n\nand more');
    roundTrips(
      '# Title\n\nBody\n\n* a\n* b\n\n```js\nlet x = 1;\n\nlet y = 2;\n```\n\n'
    );
    roundTrips('trailing space   \n\nand\ttabs\n');
  });
});

describe('blockOf', () => {
  /** renders markdown and reads the rendered elements straight back */
  const trip = (source: string): string => {
    const host = document.createElement('div');
    host.innerHTML = renderBlock(source);
    return [...host.children].map(blockOf).join('\n\n');
  };

  it('writes rendered blocks back as the markdown they came from', () => {
    // everything an article actually uses comes back as itself, so editing one block doesn't rewrite it
    for (const source of [
      '# Heading',
      '## Heading with **bold**',
      'A plain paragraph.',
      'Some **bold** and _em_ and `code` here.',
      'A [link](https://example.com) inline.',
      'A [titled](https://example.com "hover") link.',
      'An ![alt text](/a.png) image.',
      'An ![alt](/a.png#size=small&layout=inline) image.',
      '* one\n* two',
      '* one\n\n* two',
      '1. one\n2. two',
      '> quoted **text**',
      '> one\n>\n> two',
      '```js\nlet x = 1;\n```',
      '```\nplain\n```',
      '---',
      'line one  \nline two',
      'line one\nline two',
      'snake_case_word stays'
    ]) {
      assert.equal(trip(source), source, `round trip of ${source}`);
    }
  });

  it('escapes text that would otherwise become markup', () => {
    // a paragraph that starts like a list has to still be a paragraph next time it is read
    for (const [source, expected] of [
      [
        'a literal * star and _ underscore',
        'a literal \\* star and \\_ underscore'
      ],
      ['1\\. not a list', '1\\. not a list'],
      ['\\- not a bullet', '\\- not a bullet'],
      ['\\# not a heading', '\\# not a heading'],
      ['text with `back``ticks` inside', 'text with ```back``ticks``` inside']
    ]) {
      assert.equal(trip(source), expected);
    }
  });

  it('keeps emphasis that touches a word renderable', () => {
    // an underscore doesn't open or close emphasis against a word character, so writing italics out that way would
    // silently unitalicize them the next time the markdown was rendered
    for (const source of [
      'word*star*word',
      'an *em*phasis inside',
      '*lead*word'
    ]) {
      const out = trip(source);
      assert.equal(out, source, `round trip of ${source}`);

      const host = document.createElement('div');
      host.innerHTML = renderBlock(out);
      assert.isOk(host.querySelector('em'), `italic lost in ${out}`);
    }
  });

  it('does not compound its escaping when written out again', () => {
    // an escape that markdown doesn't honour would be escaped again on the next save, growing a backslash each time
    for (const source of [
      '1\\. not a list',
      '\\- not a bullet',
      'a literal \\* star'
    ]) {
      assert.equal(trip(trip(source)), trip(source));
      assert.equal(renderBlock(trip(source)), renderBlock(source));
    }
  });
});

describe(TAG, () => {
  beforeEach(() => {
    clearMockPosts();
  });

  it('can be created', async () => {
    const editor = await getEditor();
    assert.instanceOf(editor, MarkdownEditor);
    assert.equal(editor.value, '');
  });

  it('renders the document rather than showing its source', async () => {
    const editor = await getEditor('# Hello\n\nSome *words*.');

    const children = blocks(editor);
    assert.equal(children.length, 2);
    assert.equal(children[0].tagName, 'H1');
    assert.equal(children[0].textContent, 'Hello');
    assert.isOk(children[1].querySelector('em'));

    // nothing anywhere is showing source
    assert.isNotOk(editor.textArea);
  });

  it('renders images inline', async () => {
    const editor = await getEditor(
      '![a shot](/test-assets/img/sim_image_c.jpg)'
    );
    const img = blocks(editor)[0].querySelector('img');
    assert.equal(img.getAttribute('src'), '/test-assets/img/sim_image_c.jpg');
    assert.equal(img.getAttribute('alt'), 'a shot');
  });

  it('escapes markup rather than running it', async () => {
    const editor = await getEditor('<img src=x onerror="alert(1)">');
    assert.isNotOk(blocks(editor)[0].querySelector('img'));
  });

  // ==========================================================
  // The thing the whole editor is for
  // ==========================================================

  describe('rich editing', () => {
    const ARTICLE = [
      '# Getting started',
      '',
      'Open the **Flows** tab and pick a [flow](https://example.com) to edit.',
      '',
      '* Add a node',
      '* Connect it up'
    ].join('\n');

    it('never shows markdown when the author clicks into it', async () => {
      const editor = await getEditor(ARTICLE);
      const before = shown(editor);

      for (const block of blocks(editor)) {
        await mouseClickElement(block);
        await editor.updateComplete;

        // no part of the document has turned into its source
        assert.isNotOk(
          editor.shadowRoot.querySelector('textarea'),
          'clicking opened a source view'
        );

        // and what is on screen is still the rendered article, character for character
        assert.equal(shown(editor), before);
      }

      // none of the markers that make up the markdown are anywhere on screen
      for (const marker of ['**', '# ', '](', '* Add']) {
        assert.notInclude(shown(editor), marker);
      }

      // the caret really is in the document rather than simply absent
      assert.isAbove(selectionOf(editor).rangeCount, 0);
    });

    it('never shows markdown while typing', async () => {
      const editor = await getEditor(ARTICLE);

      await caretIn(editor, 2, 0);
      await type('First: ');
      await editor.updateComplete;

      assert.isNotOk(editor.shadowRoot.querySelector('textarea'));
      assert.notInclude(shown(editor), '**');
      assert.notInclude(shown(editor), '](');
      assert.include(editor.value, 'Open the **Flows** tab');
    });

    it('types into the rendered text', async () => {
      const editor = await getEditor('# Hello\n\nSome words.');

      await caretIn(editor, 0, 5);
      await type(' there');
      await editor.updateComplete;

      // realtime - the value is current without the caret going anywhere
      assert.equal(editor.value, '# Hello there\n\nSome words.');
      assert.equal(blocks(editor)[0].tagName, 'H1');
    });

    it('leaves untouched blocks exactly as they were authored', async () => {
      // deliberately non-canonical markdown: setext heading, + bullets, __ emphasis, hard wrapped prose
      const original = [
        'Title',
        '=====',
        '',
        'Some __prose__ that is',
        'hard wrapped across lines.',
        '',
        '+ first',
        '+ second',
        '',
        'Last paragraph.'
      ].join('\n');

      const editor = await getEditor(original);
      assert.equal(blocks(editor).length, 4);

      await caretIn(editor, 3, 'Last paragraph.'.length);
      await type(' Edited.');
      await editor.updateComplete;

      // only the block that was touched is rewritten - everything else comes back byte for byte
      assert.equal(
        editor.value,
        original.replace('Last paragraph.', 'Last paragraph. Edited.')
      );
    });

    it('keeps italic that touches a word when its block is edited', async () => {
      const editor = await getEditor('an *em*phasis inside');

      await caretIn(editor, 0, 0);
      await type('X');
      await editor.updateComplete;

      assert.equal(editor.value, 'Xan *em*phasis inside');

      // and what was written out still renders as italic rather than as literal markers
      const host = document.createElement('div');
      host.innerHTML = renderBlock(editor.value);
      assert.isOk(host.querySelector('em'), `italic lost: ${editor.value}`);
    });

    it('splits a paragraph on enter', async () => {
      const editor = await getEditor('one two');

      await caretIn(editor, 0, 4);
      await pressKey('Enter', 1);
      await editor.updateComplete;

      assert.equal(editor.value, 'one\n\ntwo');
      assert.equal(blocks(editor).length, 2);
      assert.deepEqual(
        blocks(editor).map((block) => block.tagName),
        ['P', 'P']
      );
    });

    it('starts a paragraph when enter is pressed at the end of a heading', async () => {
      const editor = await getEditor('# Hello');

      await caretIn(editor, 0, 5);
      await pressKey('Enter', 1);
      await type('body');
      await editor.updateComplete;

      // the browser leaves a bare <div> here, which is not something the document is made of
      assert.equal(editor.value, '# Hello\n\nbody');
      assert.deepEqual(
        blocks(editor).map((block) => block.tagName),
        ['H1', 'P']
      );
    });

    it('merges a block into the one above on backspace', async () => {
      const editor = await getEditor('one\n\ntwo');

      await caretIn(editor, 1, 0);
      await pressKey('Backspace', 1);
      await editor.updateComplete;

      assert.equal(editor.value, 'onetwo');
      assert.equal(blocks(editor).length, 1);
    });

    it('adds a line to a fenced block rather than splitting it', async () => {
      const editor = await getEditor('```js\nlet x = 1;\n```');

      await caretIn(editor, 0, 'let x = 1;'.length);
      await pressKey('Enter', 1);
      await type('let y = 2;');
      await editor.updateComplete;

      // a fenced block is one block however many lines it has
      assert.equal(blocks(editor).length, 1);
      assert.equal(editor.value, '```js\nlet x = 1;\nlet y = 2;\n```');
    });

    it('deletes a selection that spans blocks', async () => {
      const editor = await getEditor('alpha\n\nbravo\n\ncharlie');

      await selectAcross(editor, [0, 2], [2, 3]);
      await pressKey('Backspace', 1);
      await editor.updateComplete;

      // the two ends join up, which is what selecting across blocks is for
      assert.equal(editor.value, 'alrlie');
      assert.equal(blocks(editor).length, 1);
    });

    it('empties the whole document on select all and delete', async () => {
      const editor = await getEditor('# Title\n\nbody\n\n* a\n* b');

      await selectAll(editor);
      await pressKey('Backspace', 1);
      await editor.updateComplete;

      assert.equal(editor.value, '');
      assert.equal(blocks(editor).length, 1);

      // an author who has just emptied the article is starting a paragraph, not another heading
      assert.equal(blocks(editor)[0].tagName, 'P');

      await type('fresh start');
      await editor.updateComplete;
      assert.equal(editor.value, 'fresh start');
    });

    it('replaces the whole document when select all is typed over', async () => {
      const editor = await getEditor('# Title\n\nbody');

      await selectAll(editor);
      await type('replaced');
      await editor.updateComplete;

      assert.equal(editor.value, 'replaced');
    });

    it('rebuilds the document when the value is set from outside', async () => {
      const editor = await getEditor('one');
      await caretIn(editor, 0, 0);

      editor.value = '# two\n\nthree';
      await editor.updateComplete;

      assert.equal(blocks(editor).length, 2);
      assert.equal(blocks(editor)[0].tagName, 'H1');
      assert.equal(blocks(editor)[0].textContent, 'two');
    });

    it('keeps content it cannot write back out from being edited', async () => {
      // a link reference definition renders to nothing at all, so there is nothing on screen to edit and nothing to
      // read back - it is held onto invisibly instead, since dropping it would lose it
      const definition = '[docs]: https://example.com "The docs"';
      const editor = await getEditor(`intro\n\n${definition}\n\nafter`);

      const kept = blocks(editor)[1];
      assert.equal(
        kept.getAttribute('contenteditable'),
        'false',
        'a block that renders to nothing is not edited richly'
      );
      assert.equal(kept.textContent, '', 'it shows nothing of its source');

      // editing around it leaves it exactly as it was authored
      await caretIn(editor, 2, 'after'.length);
      await type('!');
      await editor.updateComplete;

      assert.equal(editor.value, `intro\n\n${definition}\n\nafter!`);
    });

    it('edits a table as the content it is', async () => {
      // a table is written back out as the markdown it came from, so it is an ordinary block rather than a locked one
      const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
      const editor = await getEditor(`intro\n\n${table}\n\nafter`);

      const rendered = blocks(editor)[1];
      assert.equal(rendered.tagName, 'TABLE');
      assert.isNotOk(rendered.closest('[contenteditable="false"]'));

      await caretIn(editor, 2, 'after'.length);
      await type('!');
      await editor.updateComplete;

      assert.equal(editor.value, `intro\n\n${table}\n\nafter!`);
    });

    it('stays realtime on a long article', async () => {
      const article: string[] = [];
      for (let section = 0; section < 150; section++) {
        article.push(`## Section ${section}`);
        article.push(
          `Body for section ${section} with **bold** and a [link](https://example.com/${section}).`
        );
      }

      const editor = await getEditor(article.join('\n\n'));
      assert.equal(blocks(editor).length, 300);

      const target = blocks(editor)[299];
      const started = performance.now();

      for (let stroke = 0; stroke < 20; stroke++) {
        target.firstChild.textContent += 'x';
        doc(editor).dispatchEvent(
          new InputEvent('input', { inputType: 'insertText' })
        );
      }

      const each = (performance.now() - started) / 20;

      // a block that hasn't changed is recognized rather than re-serialized, so this stays flat as articles grow
      assert.isBelow(
        each,
        25,
        `a keystroke over 300 blocks took ${each.toFixed(2)}ms`
      );
      assert.include(editor.value, 'Section 149');
    });
  });

  // ==========================================================
  // Toolbar
  // ==========================================================

  describe('the ground beside the article', () => {
    it('puts the caret at the end of the article when pressed', async () => {
      const editor = await getEditor('# Title\n\nA paragraph.');
      const frame = editor.shadowRoot.querySelector('.doc-frame');

      frame.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, composed: true })
      );
      await editor.updateComplete;

      assert.equal(editor.shadowRoot.activeElement, doc(editor));
      const range = selectionOf(editor).getRangeAt(0);
      assert.isTrue(range.collapsed);

      // at the end of the last block - everything in the block is before the caret
      const last = blocks(editor)[1];
      assert.isTrue(last.contains(range.startContainer));
      const before = document.createRange();
      before.selectNodeContents(last);
      before.setEnd(range.startContainer, range.startOffset);
      assert.equal(before.toString(), last.textContent);
    });

    it('leaves a press on the article itself to the browser', async () => {
      const editor = await getEditor('# Title\n\nA paragraph.');
      const evt = new MouseEvent('mousedown', {
        bubbles: true,
        composed: true,
        cancelable: true
      });
      blocks(editor)[0].dispatchEvent(evt);
      assert.isFalse(evt.defaultPrevented);
    });
  });

  describe('a slotted title', () => {
    const getTitled = async (): Promise<MarkdownEditor> => {
      const editor = (await fixture(
        `<${TAG} widget_only endpoint="${UPLOAD}">
          <textarea slot="title" name="title" rows="1">Getting started</textarea>
        </${TAG}>`
      )) as MarkdownEditor;
      editor.value = '# Heading\n\nA paragraph.';
      await editor.updateComplete;
      return editor;
    };

    const titleOf = (editor: MarkdownEditor): HTMLTextAreaElement =>
      editor.querySelector('textarea[slot="title"]');

    it('heads the article with it', async () => {
      const editor = await getTitled();
      const slot = titleOf(editor).assignedSlot;
      assert.isOk(slot, 'the title was not slotted');
      assert.isOk(slot.closest('.article'), 'the title is not in the card');
      assert.isTrue(
        !!(
          slot.compareDocumentPosition(doc(editor)) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
        'the title does not come before the article'
      );
    });

    it('mutes the toolbar while the title is being written', async () => {
      const editor = await getTitled();
      const toolbar = editor.shadowRoot.querySelector('.toolbar');

      titleOf(editor).focus();
      await editor.updateComplete;
      assert.isTrue(toolbar.classList.contains('muted'));

      titleOf(editor).blur();
      await editor.updateComplete;
      assert.isFalse(toolbar.classList.contains('muted'));
    });

    it('wraps a long title rather than clipping it', async () => {
      const editor = await getTitled();
      const title = titleOf(editor);
      const oneLine = title.offsetHeight;

      title.value =
        'A title long enough that it has to wrap onto a second line of the card';
      title.dispatchEvent(
        new Event('input', { bubbles: true, composed: true })
      );
      await editor.updateComplete;

      assert.isAbove(title.offsetHeight, oneLine);
      assert.equal(title.scrollHeight, title.clientHeight, 'the title scrolls');
    });

    it('keeps the title to one line of text', async () => {
      const editor = await getTitled();
      const title = titleOf(editor);

      title.value = 'Getting\nstarted\r\n  today';
      title.dispatchEvent(
        new Event('input', { bubbles: true, composed: true })
      );

      assert.equal(title.value, 'Getting started today');
    });

    it('moves on to the article on Enter rather than submitting', async () => {
      const editor = await getTitled();
      const title = titleOf(editor);
      title.focus();

      const evt = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        composed: true,
        cancelable: true
      });
      title.dispatchEvent(evt);
      await editor.updateComplete;

      assert.isTrue(evt.defaultPrevented);
      assert.equal(editor.shadowRoot.activeElement, doc(editor));
      const range = selectionOf(editor).getRangeAt(0);
      assert.isTrue(range.collapsed);
      assert.isTrue(blocks(editor)[0].contains(range.startContainer));
      assert.equal(range.startOffset, 0);
    });
  });

  describe('a slotted subtitle', () => {
    const getSubtitled = async (): Promise<MarkdownEditor> => {
      const editor = (await fixture(
        `<${TAG} widget_only endpoint="${UPLOAD}">
          <textarea slot="title" name="title" rows="1">Getting started</textarea>
          <textarea slot="subtitle" name="subtitle" rows="1">The first steps</textarea>
        </${TAG}>`
      )) as MarkdownEditor;
      editor.value = '# Heading\n\nA paragraph.';
      await editor.updateComplete;
      return editor;
    };

    const fieldOf = (
      editor: MarkdownEditor,
      slot: string
    ): HTMLTextAreaElement => editor.querySelector(`textarea[slot="${slot}"]`);

    it('hangs under the title, before the article', async () => {
      const editor = await getSubtitled();
      const title = fieldOf(editor, 'title').assignedSlot;
      const subtitle = fieldOf(editor, 'subtitle').assignedSlot;
      assert.isOk(subtitle, 'the subtitle was not slotted');
      assert.isOk(
        subtitle.closest('.article'),
        'the subtitle is not in the card'
      );
      assert.isTrue(
        !!(
          title.compareDocumentPosition(subtitle) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
        'the subtitle does not come after the title'
      );
      assert.isTrue(
        !!(
          subtitle.compareDocumentPosition(doc(editor)) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
        'the subtitle does not come before the article'
      );
      assert.isTrue(
        subtitle.closest('.head').classList.contains('with-subtitle'),
        'the head does not know it has a subtitle'
      );
    });

    it('mutes the toolbar while the subtitle is being written', async () => {
      const editor = await getSubtitled();
      const toolbar = editor.shadowRoot.querySelector('.toolbar');

      fieldOf(editor, 'subtitle').focus();
      await editor.updateComplete;
      assert.isTrue(toolbar.classList.contains('muted'));

      fieldOf(editor, 'subtitle').blur();
      await editor.updateComplete;
      assert.isFalse(toolbar.classList.contains('muted'));
    });

    it('keeps the subtitle to one line of text', async () => {
      const editor = await getSubtitled();
      const subtitle = fieldOf(editor, 'subtitle');

      subtitle.value = 'The\nfirst\r\n  steps';
      subtitle.dispatchEvent(
        new Event('input', { bubbles: true, composed: true })
      );

      assert.equal(subtitle.value, 'The first steps');
    });

    it('goes from the title to the subtitle on Enter, and on to the article', async () => {
      const editor = await getSubtitled();
      const title = fieldOf(editor, 'title');
      const subtitle = fieldOf(editor, 'subtitle');
      const enter = () =>
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          composed: true,
          cancelable: true
        });

      title.focus();
      let evt = enter();
      title.dispatchEvent(evt);
      await editor.updateComplete;
      assert.isTrue(evt.defaultPrevented);
      assert.equal(document.activeElement, subtitle);
      assert.equal(subtitle.selectionStart, subtitle.value.length);

      evt = enter();
      subtitle.dispatchEvent(evt);
      await editor.updateComplete;
      assert.isTrue(evt.defaultPrevented);
      assert.equal(editor.shadowRoot.activeElement, doc(editor));
    });
  });

  describe('a slotted cover image', () => {
    const getCovered = async (hero = ''): Promise<MarkdownEditor> => {
      const editor = (await fixture(
        `<${TAG} widget_only endpoint="${UPLOAD}" hero="${hero}">
          <input type="file" slot="hero" name="hero" accept="image/png">
          <textarea slot="title" name="title" rows="1">Getting started</textarea>
        </${TAG}>`
      )) as MarkdownEditor;
      editor.value = 'A paragraph.';
      await editor.updateComplete;
      return editor;
    };

    const inputOf = (editor: MarkdownEditor): HTMLInputElement =>
      editor.querySelector('input[slot="hero"]');
    const coverOf = (editor: MarkdownEditor): HTMLElement =>
      editor.shadowRoot.querySelector('.cover');

    it('draws a cover across the head of the card, hiding the input', async () => {
      const editor = await getCovered();
      const cover = coverOf(editor);
      assert.isOk(cover, 'no cover was drawn');
      assert.isOk(cover.closest('.article'), 'the cover is not in the card');
      assert.isTrue(
        !!(
          cover.compareDocumentPosition(
            editor.querySelector('[slot="title"]').assignedSlot
          ) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
        'the cover does not come before the title'
      );
      assert.equal(getComputedStyle(inputOf(editor)).display, 'none');
    });

    it('is not drawn when there is no cover to slot', async () => {
      const editor = await getEditor();
      assert.isNull(coverOf(editor));
    });

    it('offers to add a cover when there is none, and to change one when there is', async () => {
      let editor = await getCovered();
      assert.isTrue(coverOf(editor).classList.contains('empty'));
      assert.include(coverOf(editor).textContent, 'Add a cover image');
      assert.equal(coverOf(editor).style.backgroundImage, '');

      editor = await getCovered('https://example.com/cover.jpg');
      assert.isFalse(coverOf(editor).classList.contains('empty'));
      assert.include(coverOf(editor).textContent, 'Change cover image');
      assert.include(coverOf(editor).style.backgroundImage, 'cover.jpg');
    });

    it('keeps an awkward address inside the style it is written into', async () => {
      const editor = await getCovered("https://example.com/it's (1).jpg");
      const style = coverOf(editor).getAttribute('style');
      assert.include(style, "url('https://example.com/it%27s%20%281%29.jpg')");
    });

    it('asks the input for a file when pressed', async () => {
      const editor = await getCovered();
      const click = stub(inputOf(editor), 'click');

      coverOf(editor).click();
      assert.isTrue(click.calledOnce);

      coverOf(editor).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      assert.isTrue(click.calledTwice);
      click.restore();
    });

    it('shows the file picked in place of the saved cover', async () => {
      const editor = await getCovered('https://example.com/cover.jpg');
      const input = inputOf(editor);

      const files = new DataTransfer();
      files.items.add(new File(['png'], 'new.png', { type: 'image/png' }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await editor.updateComplete;

      assert.include(coverOf(editor).style.backgroundImage, 'blob:');
      assert.isFalse(coverOf(editor).classList.contains('empty'));

      // picking cancelled and the input emptied - the saved cover is back
      input.files = new DataTransfer().files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await editor.updateComplete;
      assert.include(coverOf(editor).style.backgroundImage, 'cover.jpg');
    });
  });

  describe('toolbar', () => {
    it('bolds the selection', async () => {
      const editor = await getEditor('# Title\n\nhello world');

      await selectAcross(editor, [1, 6], [1, 11]);
      await toolbar(editor, 'bold');

      assert.equal(editor.value, '# Title\n\nhello **world**');
      // and what is on screen is the bold word, not the markers around it
      assert.equal(shown(editor), 'Titlehello world');
    });

    it('makes the block a heading and takes it back', async () => {
      const editor = await getEditor('hello world');

      await caretIn(editor, 0, 2);
      await toolbar(editor, 'h2');
      assert.equal(editor.value, '## hello world');
      assert.equal(blocks(editor)[0].tagName, 'H2');

      await caretIn(editor, 0, 2);
      await toolbar(editor, 'h2');
      assert.equal(editor.value, 'hello world');
      assert.equal(blocks(editor)[0].tagName, 'P');
    });

    it('makes a list', async () => {
      const editor = await getEditor('one');

      await caretIn(editor, 0, 1);
      await toolbar(editor, 'bullet');

      // the browser nests the list inside the block it was made from, which is not somewhere a list can live
      assert.equal(blocks(editor)[0].tagName, 'UL');
      assert.equal(editor.value, '* one');
    });

    it('makes a quote', async () => {
      const editor = await getEditor('one');

      await caretIn(editor, 0, 1);
      await toolbar(editor, 'quote');

      assert.equal(blocks(editor)[0].tagName, 'BLOCKQUOTE');
      assert.equal(editor.value, '> one');
    });

    it('marks the selection as code', async () => {
      const editor = await getEditor('run npm install now');

      await selectAcross(editor, [0, 4], [0, 15]);
      await toolbar(editor, 'code');

      assert.equal(editor.value, 'run `npm install` now');
      assert.isOk(blocks(editor)[0].querySelector('code'));
    });

    it('says what the caret is sitting in', async () => {
      const editor = await getEditor('## Heading\n\nplain');

      await caretIn(editor, 0, 3);
      const heading = editor.shadowRoot.querySelector('.format.h2');
      assert.include([...heading.classList], 'on');

      await caretIn(editor, 1, 2);
      assert.notInclude([...heading.classList], 'on');
    });

    it('writes into the document when nothing is focused', async () => {
      const editor = await getEditor('# Title\n\nlast');
      doc(editor).blur();

      await toolbar(editor, 'h2');

      // falls through to where the caret last was rather than doing nothing
      assert.equal(editor.value, '# Title\n\n## last');
    });

    it('toggles modes', async () => {
      const editor = await getEditor('# Hello');
      assert.notInclude([...modeSwitch(editor).classList], 'on');

      modeSwitch(editor).click();
      await editor.updateComplete;
      assert.isTrue(editor.sourceMode);

      // the switch is a button like the rest of them, lit for as long as the mode it turns on is the one showing
      assert.include([...modeSwitch(editor).classList], 'on');

      modeSwitch(editor).click();
      await editor.updateComplete;
      assert.isFalse(editor.sourceMode);
      assert.notInclude([...modeSwitch(editor).classList], 'on');
    });

    it('stays in reach while the article scrolls under it', async () => {
      // the scroller is outside the component, as the dialog's body is - sticky has to hold across the shadow boundary
      const scroller = (await fixture(`
        <div style="height: 150px; overflow-y: auto">
          <${TAG} widget_only endpoint="${UPLOAD}"></${TAG}>
        </div>
      `)) as HTMLElement;

      const editor = scroller.querySelector(TAG) as MarkdownEditor;
      editor.minHeight = 0;
      editor.value = new Array(40)
        .fill('A paragraph of the article.')
        .join('\n\n');
      await editor.updateComplete;

      const chrome = editor.shadowRoot.querySelector('.chrome') as HTMLElement;
      assert.equal(getComputedStyle(chrome).position, 'sticky');

      scroller.scrollTop = 300;
      await new Promise((resolve) => requestAnimationFrame(resolve));

      // the article moved, and the controls held at the top of what moved it
      assert.isAbove(scroller.scrollTop, 0);
      assert.closeTo(
        chrome.getBoundingClientRect().top,
        scroller.getBoundingClientRect().top,
        1
      );

      // and the toolbar is opaque, so the article passes behind it rather than through it
      assert.notEqual(
        getComputedStyle(chrome).backgroundColor,
        'rgba(0, 0, 0, 0)'
      );
    });

    it('scrolls the article inside itself when it fills what holds it', async () => {
      const holder = (await fixture(`
        <div style="height: 200px; display: flex">
          <${TAG} widget_only fill endpoint="${UPLOAD}"></${TAG}>
        </div>
      `)) as HTMLElement;

      const editor = holder.querySelector(TAG) as MarkdownEditor;
      editor.value = new Array(40)
        .fill('A paragraph of the article.')
        .join('\n\n');
      await editor.updateComplete;

      // the frame around the document is what scrolls, so the overlays inside it ride the article they point at
      const frame = editor.shadowRoot.querySelector(
        '.doc-frame'
      ) as HTMLElement;
      assert.equal(getComputedStyle(frame).overflowY, 'auto');

      // the editor is the height it was given rather than the height of the article, so nothing outside it scrolls
      assert.closeTo(editor.getBoundingClientRect().height, 200, 1);
      assert.isAbove(frame.scrollHeight, frame.clientHeight);

      // and the toolbar sits above the part that scrolls, so it can't be scrolled away at all
      const chrome = editor.shadowRoot.querySelector('.chrome') as HTMLElement;
      frame.scrollTop = 300;
      await new Promise((resolve) => requestAnimationFrame(resolve));

      assert.isAbove(frame.scrollTop, 0);
      assert.isAtMost(
        chrome.getBoundingClientRect().bottom,
        frame.getBoundingClientRect().top + 1
      );
    });
  });

  describe('links', () => {
    /** the popover the link under the caret is edited in, anchored on the link itself */
    const linkbar = (editor: MarkdownEditor): HTMLElement =>
      editor.shadowRoot.querySelector('.overlays .popover') as HTMLElement;

    it('offers a link to edit without showing its markdown', async () => {
      const editor = await getEditor('see the [docs](https://example.com) now');

      await caretIn(editor, 0, 10);
      await editor.updateComplete;

      const bar = linkbar(editor)?.querySelector('input');
      assert.isOk(bar, 'no link bar for a caret inside a link');
      assert.equal((bar as HTMLInputElement).value, 'https://example.com');

      // the document still reads as prose
      assert.equal(shown(editor), 'see the docs now');
    });

    it('changes where a link points', async () => {
      const editor = await getEditor('see the [docs](https://example.com) now');

      await caretIn(editor, 0, 10);
      await editor.updateComplete;

      const bar = linkbar(editor).querySelector('input') as HTMLInputElement;
      bar.value = 'https://nyaruka.com';
      bar.dispatchEvent(new Event('input'));
      await editor.updateComplete;

      assert.equal(editor.value, 'see the [docs](https://nyaruka.com) now');
    });

    it('removes a link and keeps its text', async () => {
      const editor = await getEditor('see the [docs](https://example.com) now');

      await caretIn(editor, 0, 10);
      await editor.updateComplete;

      (linkbar(editor).querySelector('.link-remove') as HTMLElement).click();
      await editor.updateComplete;

      assert.equal(editor.value, 'see the docs now');
      assert.isNotOk(linkbar(editor));
    });

    /** an editor that knows the helpdesk's other articles, so links to them can be picked by title */
    const ARTICLES = '/api/internal/articles.json';
    const FLOWS = '0d5f3a5a-2f3d-4c4e-9f6b-3a1e5b7c9d10';
    const NODES = '1e6a4b6b-3a4e-4d5f-8a7c-4b2f6c8d0e21';
    const ACTIONS = '2f7b5c7c-4b5f-4e60-9b8d-5c3a7d9e1f32';
    const getLinkingEditor = async (value: string): Promise<MarkdownEditor> => {
      mockGET(new RegExp(ARTICLES), {
        results: [
          {
            uuid: FLOWS,
            title: 'Flows',
            status: 'published',
            parent: null,
            depth: 0
          },
          {
            uuid: NODES,
            title: 'Nodes',
            status: 'published',
            parent: FLOWS,
            depth: 1
          },
          {
            uuid: ACTIONS,
            title: 'Node Actions',
            status: 'draft',
            parent: FLOWS,
            depth: 1
          }
        ]
      });
      const editor = (await fixture(
        `<${TAG} widget_only endpoint="${UPLOAD}" articles-endpoint="${ARTICLES}"></${TAG}>`
      )) as MarkdownEditor;
      editor.value = value;
      await editor.updateComplete;
      // the articles arrive on their own time
      await new Promise((resolve) => setTimeout(resolve, 50));
      await editor.updateComplete;
      return editor;
    };

    /** the options control the matches are listed in, and its rows */
    const linkOptions = (editor: MarkdownEditor): Options =>
      editor.shadowRoot.querySelector('.link-options temba-options');
    const matchRows = (editor: MarkdownEditor): HTMLElement[] =>
      [...linkOptions(editor).shadowRoot.querySelectorAll('.option')].filter(
        (row) => !row.classList.contains('no-options')
      ) as HTMLElement[];
    const search = async (editor: MarkdownEditor, text: string) => {
      const bar = linkbar(editor).querySelector('input') as HTMLInputElement;
      bar.value = text;
      bar.dispatchEvent(new Event('input'));
      await editor.updateComplete;
      await linkOptions(editor).updateComplete;
    };
    /** a key pressed in the link bar's box, which the options control hears at the document */
    const press = async (
      editor: MarkdownEditor,
      key: string,
      init: KeyboardEventInit = {}
    ) => {
      linkbar(editor)
        .querySelector('input')
        .dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            bubbles: true,
            composed: true,
            cancelable: true,
            ...init
          })
        );
      await editor.updateComplete;
      await linkOptions(editor).updateComplete;
      // the control throttles cursor moves, so one press settles before the next
      await new Promise((resolve) => setTimeout(resolve, 60));
    };

    it('shows a link to an article by the article it points at', async () => {
      const editor = await getLinkingEditor(
        `see [nodes](article:${NODES}) now`
      );

      await caretIn(editor, 0, 6);
      await editor.updateComplete;

      const bar = linkbar(editor).querySelector('input') as HTMLInputElement;
      assert.equal(bar.value, 'Nodes');
      assert.isOk(linkbar(editor).querySelector('.link-kind'));

      // the markdown keeps the uuid
      assert.equal(editor.value, `see [nodes](article:${NODES}) now`);
    });

    it('offers articles by title and links to the one picked', async () => {
      const editor = await getLinkingEditor(
        'see the [docs](https://example.com) now'
      );

      await caretIn(editor, 0, 10);
      await editor.updateComplete;
      await search(editor, 'node');

      // a search leaves the link where it was until something is picked
      assert.equal(editor.value, 'see the [docs](https://example.com) now');

      // the list hangs from the bar, as wide as it is
      assert.isTrue(linkOptions(editor).anchorTo === linkbar(editor));
      assert.equal(
        linkOptions(editor).staticWidth,
        Math.round(linkbar(editor).getBoundingClientRect().width) - 2
      );

      const rows = matchRows(editor);
      assert.deepEqual(
        rows.map((row) => row.querySelector('.name').textContent.trim()),
        ['Nodes', 'Node Actions']
      );
      assert.deepEqual(
        rows.map((row) => row.querySelector('.detail').textContent.trim()),
        ['Flows', 'Flows']
      );
      // a draft is offered, but shown for what it is
      assert.isOk((rows[1].querySelector('.name') as HTMLElement).style.color);
      assert.isNotOk(
        (rows[0].querySelector('.name') as HTMLElement).style.color
      );

      rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await editor.updateComplete;

      assert.equal(editor.value, `see the [docs](article:${NODES}) now`);
      assert.equal(
        (linkbar(editor).querySelector('input') as HTMLInputElement).value,
        'Nodes'
      );
      assert.isNotOk(linkOptions(editor).visible);
    });

    it('takes the best match on enter and says when there is none', async () => {
      const editor = await getLinkingEditor(
        'see the [docs](https://example.com) now'
      );

      await caretIn(editor, 0, 10);
      await editor.updateComplete;
      await search(editor, 'xyzzy');

      assert.isTrue(linkOptions(editor).visible);
      assert.equal(
        linkOptions(editor)
          .shadowRoot.querySelector('.option.no-options')
          .textContent.trim(),
        'No matching articles'
      );

      await search(editor, 'flows');
      await press(editor, 'Enter');

      assert.equal(editor.value, `see the [docs](article:${FLOWS}) now`);
    });

    it('steers the matches like any options list', async () => {
      const editor = await getLinkingEditor(
        'see the [docs](https://example.com) now'
      );

      await caretIn(editor, 0, 10);
      await editor.updateComplete;
      await search(editor, 'node');
      assert.equal(linkOptions(editor).cursorIndex, 0);

      // ctrl-n and ctrl-p walk the list, as the arrows do
      await press(editor, 'n', { ctrlKey: true });
      assert.equal(linkOptions(editor).cursorIndex, 1);
      await press(editor, 'p', { ctrlKey: true });
      assert.equal(linkOptions(editor).cursorIndex, 0);
      await press(editor, 'ArrowDown');
      assert.equal(linkOptions(editor).cursorIndex, 1);

      // and enter takes the one the cursor is on
      await press(editor, 'Enter');
      assert.equal(editor.value, `see the [docs](article:${ACTIONS}) now`);

      // escape gives a search up and shows the link as it is
      await search(editor, 'flo');
      assert.isTrue(linkOptions(editor).visible);
      await press(editor, 'Escape');
      assert.isNotOk(linkOptions(editor).visible);
      assert.equal(
        (linkbar(editor).querySelector('input') as HTMLInputElement).value,
        'Node Actions'
      );
    });

    it('starts a new link empty, ready for a title or an address', async () => {
      const editor = await getLinkingEditor('see the docs now');

      await caretIn(editor, 0, 8);
      await toolbar(editor, 'link');

      // the link points nowhere yet, and the bar offers the search rather than an address to overtype
      assert.equal(editor.value, 'see the [link]()docs now');
      const bar = linkbar(editor)?.querySelector('input') as HTMLInputElement;
      assert.isOk(bar, 'no link bar for the new link');
      assert.equal(bar.value, '');
      assert.equal(bar.placeholder, 'https:// or an article title');

      await search(editor, 'nodes');
      await press(editor, 'Enter');
      assert.equal(editor.value, `see the [link](article:${NODES})docs now`);
    });

    it('still takes an address as typed', async () => {
      const editor = await getLinkingEditor(
        'see the [docs](https://example.com) now'
      );

      await caretIn(editor, 0, 10);
      await editor.updateComplete;

      for (const address of [
        'https://nyaruka.com',
        '/flows/nodes/',
        'nyaruka.com/docs',
        'mailto:x@y.com'
      ]) {
        await search(editor, address);
        assert.equal(editor.value, `see the [docs](${address}) now`);
        assert.isNotOk(linkOptions(editor).visible);
      }
    });

    it('shows no link bar when the caret is not in a link', async () => {
      const editor = await getEditor('nothing linked here');
      await caretIn(editor, 0, 4);
      await editor.updateComplete;

      assert.isNotOk(linkbar(editor));
    });

    it('places the caret on a click rather than following the link', async () => {
      const editor = await getEditor('see the [docs](https://example.com) now');
      const anchor = blocks(editor)[0].querySelector('a');

      const click = new MouseEvent('click', {
        bubbles: true,
        composed: true,
        cancelable: true
      });
      anchor.dispatchEvent(click);

      // navigating would take the unsaved article with it
      assert.isTrue(click.defaultPrevented);
    });

    it('never follows the link, even on a modified click', async () => {
      const editor = await getEditor('see the [docs](https://example.com) now');
      const anchor = blocks(editor)[0].querySelector('a');
      const opened = stub(window, 'open');

      try {
        for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
          opened.resetHistory();

          const click = new MouseEvent('click', {
            bubbles: true,
            composed: true,
            cancelable: true,
            ...modifier
          });
          anchor.dispatchEvent(click);

          assert.isTrue(click.defaultPrevented);
          assert.isTrue(opened.notCalled, 'a modified click opened a window');
        }
      } finally {
        opened.restore();
      }
    });
  });

  describe('images', () => {
    const IMAGE = '/test-assets/img/sim_image_c.jpg';

    const clickImage = async (editor: MarkdownEditor): Promise<void> => {
      const img = doc(editor).querySelector('img');
      img.dispatchEvent(
        new MouseEvent('click', { bubbles: true, composed: true })
      );
      await editor.updateComplete;
    };

    /** the size controls floated inside the clicked image, null when no image is picked */
    const imagebar = (editor: MarkdownEditor): HTMLElement =>
      editor.shadowRoot.querySelector(
        '.overlays .image-actions'
      ) as HTMLElement;

    const pickSize = async (
      editor: MarkdownEditor,
      label: string
    ): Promise<void> => {
      const chip = [...imagebar(editor).querySelectorAll('.chip')].find(
        (ele) => ele.textContent.trim() === label
      ) as HTMLElement;
      chip.click();
      await editor.updateComplete;
    };

    it('renders the size and layout the fragment asks for', async () => {
      const editor = await getEditor(
        `![shot](${IMAGE}#size=medium&layout=inline)`
      );

      const img = doc(editor).querySelector('img');
      assert.include([...img.classList], 'size-medium');
      assert.include([...img.classList], 'layout-inline');

      // the fragment rides along on the src rather than being stripped out of it
      assert.equal(
        img.getAttribute('src'),
        `${IMAGE}#size=medium&layout=inline`
      );
      assert.equal(getComputedStyle(img).maxWidth, 'min(400px, 100%)');
    });

    it('renders an image without a fragment the way it always has', async () => {
      const editor = await getEditor(`![shot](${IMAGE})`);

      const img = doc(editor).querySelector('img');
      assert.equal(img.getAttribute('class'), null);
    });

    it('shows a relative reference from storage but writes it back as it was', async () => {
      const STORAGE = 'https://storage.example.com/bucket';
      const editor = (await fixture(
        `<${TAG} widget_only endpoint="${UPLOAD}" storage-url="${STORAGE}/"></${TAG}>`
      )) as MarkdownEditor;
      editor.value =
        '![shot](orgs/1/knowledge/shot.png#size=small) and ![far](https://example.com/far.png)';
      await editor.updateComplete;

      const [near, far] = [...blocks(editor)[0].querySelectorAll('img')];
      assert.equal(
        near.getAttribute('src'),
        `${STORAGE}/orgs/1/knowledge/shot.png#size=small`
      );
      assert.equal(
        near.getAttribute('data-src'),
        'orgs/1/knowledge/shot.png#size=small'
      );
      assert.isTrue(near.classList.contains('size-small'));
      assert.equal(far.getAttribute('src'), 'https://example.com/far.png');
      assert.isNull(far.getAttribute('data-src'));

      // reading the document back gives the reference, not the address it was shown from
      assert.equal(
        editor.value,
        '![shot](orgs/1/knowledge/shot.png#size=small) and ![far](https://example.com/far.png)'
      );

      // and a size change is written into the reference
      await clickImage(editor);
      await editor.updateComplete;
      await pickSize(editor, 'Large');
      assert.equal(
        near.getAttribute('data-src'),
        'orgs/1/knowledge/shot.png#size=large'
      );
      assert.equal(
        near.getAttribute('src'),
        `${STORAGE}/orgs/1/knowledge/shot.png#size=large`
      );
      assert.include(
        editor.value,
        '![shot](orgs/1/knowledge/shot.png#size=large)'
      );
    });

    it('offers sizes when an image is clicked', async () => {
      const editor = await getEditor(`![shot](${IMAGE})`);
      assert.isNotOk(imagebar(editor));

      await clickImage(editor);

      const bar = imagebar(editor);
      assert.isOk(bar, 'no image bar for a clicked image');
      assert.deepEqual(
        [...bar.querySelectorAll('.chip')].map((ele) => ele.textContent.trim()),
        ['Original', 'Small', 'Medium', 'Large']
      );

      // and the image itself is ringed, so it reads as the thing the sizes will act on
      assert.isOk(editor.shadowRoot.querySelector('.overlays .image-ring'));
    });

    it('writes the choice into the fragment and renders it live', async () => {
      const editor = await getEditor(`![shot](${IMAGE})`);
      await clickImage(editor);

      await pickSize(editor, 'Small');
      assert.equal(editor.value, `![shot](${IMAGE}#size=small)`);

      const img = doc(editor).querySelector('img');
      assert.include([...img.classList], 'size-small');
      assert.equal(getComputedStyle(img).maxWidth, 'min(200px, 100%)');

      // the size showing is the one lit, so the bar says what the image already is
      await pickSize(editor, 'Medium');
      assert.equal(editor.value, `![shot](${IMAGE}#size=medium)`);
      assert.equal(getComputedStyle(img).maxWidth, 'min(400px, 100%)');
      assert.equal(
        imagebar(editor).querySelector('.chip.on').textContent.trim(),
        'Medium'
      );
    });

    it('edits only the block the image is in', async () => {
      // deliberately non-canonical markdown that an AST round trip would rewrite
      const other = 'Title\n=====';
      const editor = await getEditor(`${other}\n\n![shot](${IMAGE})`);

      await clickImage(editor);
      await pickSize(editor, 'Large');

      assert.equal(editor.value, `${other}\n\n![shot](${IMAGE}#size=large)`);
    });

    it('takes an image back to a bare url', async () => {
      const editor = await getEditor(`![shot](${IMAGE}#size=medium)`);
      await clickImage(editor);

      await pickSize(editor, 'Original');
      assert.equal(editor.value, `![shot](${IMAGE})`);

      const img = doc(editor).querySelector('img');
      assert.equal(img.getAttribute('class'), null);
    });

    it('leaves a layout in the fragment where the author put it', async () => {
      // columns are how an article asks for layout now, but an image that was authored with one keeps it through
      // every size the bar offers
      const editor = await getEditor(
        `![shot](${IMAGE}#size=medium&layout=inline)`
      );
      await clickImage(editor);

      await pickSize(editor, 'Small');
      assert.equal(editor.value, `![shot](${IMAGE}#size=small&layout=inline)`);

      await pickSize(editor, 'Original');
      assert.equal(editor.value, `![shot](${IMAGE}#layout=inline)`);

      const img = doc(editor).querySelector('img');
      assert.include([...img.classList], 'layout-inline');
      assert.equal(getComputedStyle(img).display, 'inline-block');
    });

    it('puts the options away on a click anywhere else', async () => {
      const editor = await getEditor(`![shot](${IMAGE})\n\nsome words`);
      await clickImage(editor);
      assert.isOk(imagebar(editor));

      blocks(editor)[1].dispatchEvent(
        new MouseEvent('click', { bubbles: true, composed: true })
      );
      await editor.updateComplete;

      assert.isNotOk(imagebar(editor));
    });
  });

  describe('pasting', () => {
    const paste = async (
      editor: MarkdownEditor,
      data: { html?: string; text?: string }
    ): Promise<void> => {
      const transfer = new DataTransfer();
      if (data.html) {
        transfer.setData('text/html', data.html);
      }
      if (data.text) {
        transfer.setData('text/plain', data.text);
      }

      doc(editor).dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer
        })
      );
      await editor.updateComplete;
    };

    it('shows a pasted image from storage and keeps its reference', async () => {
      const editor = (await fixture(
        `<${TAG} widget_only endpoint="${UPLOAD}" storage-url="https://storage.example.com/bucket"></${TAG}>`
      )) as MarkdownEditor;
      editor.value = '';
      await editor.updateComplete;
      await caretIn(editor, 0, 0);

      await paste(editor, {
        html: '<p><img src="orgs/1/knowledge/shot.png#size=small" data-src="orgs/1/knowledge/shot.png#size=small" alt="shot"></p>',
        text: 'shot'
      });

      const img = doc(editor).querySelector('img');
      assert.equal(
        img.getAttribute('src'),
        'https://storage.example.com/bucket/orgs/1/knowledge/shot.png#size=small'
      );
      assert.equal(
        img.getAttribute('data-src'),
        'orgs/1/knowledge/shot.png#size=small'
      );
      assert.equal(
        editor.value,
        '![shot](orgs/1/knowledge/shot.png#size=small)'
      );
    });

    it('keeps the formatting of markup it can express', async () => {
      const editor = await getEditor('');
      await caretIn(editor, 0, 0);

      await paste(editor, {
        html: '<p>some <strong>bold</strong> text</p>',
        text: 'some bold text'
      });

      assert.equal(editor.value, 'some **bold** text');
    });

    it('falls back to plain text for markup it cannot', async () => {
      const editor = await getEditor('');
      await caretIn(editor, 0, 0);

      // a paste off the web is a pile of divs and spans, none of which the document can hold
      await paste(editor, {
        html: '<div><span style="color:red">styled</span></div>',
        text: 'styled'
      });

      assert.equal(editor.value, 'styled');
      assert.isNotOk(doc(editor).querySelector('span'));
    });

    it('does not let pasted markup smuggle in anything that runs', async () => {
      const editor = await getEditor('');
      await caretIn(editor, 0, 0);

      await paste(editor, {
        html: '<p onclick="alert(1)">safe<script>alert(2)</script></p>',
        text: 'safe'
      });

      assert.isNotOk(doc(editor).querySelector('script'));
      assert.isNotOk(doc(editor).querySelector('[onclick]'));
      assert.include(editor.value, 'safe');
    });

    it('takes plain text as the text it is', async () => {
      const editor = await getEditor('');
      await caretIn(editor, 0, 0);

      await paste(editor, { text: 'one\n\ntwo' });

      assert.equal(editor.value, 'one\n\ntwo');
    });
  });

  describe('source mode', () => {
    it('toggles to the raw markdown and back', async () => {
      const editor = await getEditor('# Hello');
      assert.isNotOk(editor.textArea);

      editor.sourceMode = true;
      await editor.updateComplete;

      assert.isOk(editor.textArea);
      assert.equal(editor.textArea.value, '# Hello');
      assert.isNotOk(editor.doc);

      editor.sourceMode = false;
      await editor.updateComplete;

      assert.isNotOk(editor.textArea);
      assert.equal(blocks(editor).length, 1);
    });

    it('carries edits made in the source back to the rendered document', async () => {
      const editor = await getEditor('# Hello');
      editor.sourceMode = true;
      await editor.updateComplete;

      editor.textArea.value = '# Hello\n\nAnd a paragraph.';
      editor.textArea.dispatchEvent(new Event('input'));
      await editor.updateComplete;

      editor.sourceMode = false;
      await editor.updateComplete;

      assert.equal(blocks(editor).length, 2);
      assert.equal(blocks(editor)[1].textContent, 'And a paragraph.');
    });

    it('carries edits made in the document back to the source', async () => {
      const editor = await getEditor('# Hello\n\nwords');

      await caretIn(editor, 1, 5);
      await type(' here');
      await editor.updateComplete;

      editor.sourceMode = true;
      await editor.updateComplete;

      assert.equal(editor.textArea.value, '# Hello\n\nwords here');
    });

    it('offers nothing in the toolbar but the way back', async () => {
      const editor = await getEditor('hello world');
      assert.isAbove(
        editor.shadowRoot.querySelectorAll('.toolbar .format').length,
        1
      );

      editor.sourceMode = true;
      await editor.updateComplete;

      // an author writing markdown writes the markers themselves, so a row of buttons that write them is only in
      // the way - all that is left is the switch back to the rendered article
      const buttons = [
        ...editor.shadowRoot.querySelectorAll('.toolbar .format')
      ];
      assert.deepEqual(buttons, [modeSwitch(editor)]);

      // including the one that uploads an image, which is an icon of its own rather than a command
      assert.isNotOk(editor.shadowRoot.querySelector('.toolbar > temba-icon'));
    });
  });

  describe('uploads', () => {
    const ok = () =>
      mockPOST(/msgmedia\/upload/, {
        url: '/test-assets/img/sim_image_c.jpg',
        name: 'shot.png'
      });

    it('inserts an image at the caret and shows it straight away', async () => {
      ok();
      const editor = await getEditor('before after');
      await caretIn(editor, 0, 7);

      await (editor as any).upload([uploadFile()]);
      await editor.updateComplete;

      assert.equal(
        editor.value,
        'before ![shot.png](/test-assets/img/sim_image_c.jpg)after'
      );

      // it is in the document as an image, not as the markdown for one
      assert.isOk(blocks(editor)[0].querySelector('img'));
      assert.notInclude(shown(editor), '![');
    });

    it('stacks files up in the order they were given', async () => {
      ok();
      const editor = await getEditor('');
      await caretIn(editor, 0, 0);

      await (editor as any).upload([uploadFile(), uploadFile()]);
      await editor.updateComplete;

      assert.equal(
        editor.value,
        '![shot.png](/test-assets/img/sim_image_c.jpg)![shot.png](/test-assets/img/sim_image_c.jpg)'
      );
      assert.equal(blocks(editor)[0].querySelectorAll('img').length, 2);
      assert.isFalse(editor.uploading);
    });

    it('writes to where the caret was, not wherever it ended up', async () => {
      ok();
      const editor = await getEditor('alpha\n\nbravo');
      await caretIn(editor, 0, 5);

      // an upload takes seconds and the author is free to click elsewhere while it runs
      const pending = (editor as any).upload([uploadFile()]);
      await caretIn(editor, 1, 5);
      await pending;
      await editor.updateComplete;

      assert.equal(
        editor.value,
        'alpha![shot.png](/test-assets/img/sim_image_c.jpg)\n\nbravo'
      );
    });

    it('goes back to where the caret was when the file dialog blurred the document', async () => {
      ok();
      const editor = await getEditor('alpha\n\nbravo');

      // picking a file takes the window, which blurs the document
      await caretIn(editor, 0, 5);
      doc(editor).dispatchEvent(new FocusEvent('blur'));
      doc(editor).blur();
      await editor.updateComplete;

      await (editor as any).upload([uploadFile()]);
      await editor.updateComplete;

      // the end of the article would have been wrong - the caret was in the first block
      assert.equal(
        editor.value,
        'alpha![shot.png](/test-assets/img/sim_image_c.jpg)\n\nbravo'
      );
    });

    it('writes no reference when the response carries no url', async () => {
      // a session that expired mid-upload redirects to a login page, which resolves as a success with nothing usable
      mockPOST(/msgmedia\/upload/, { name: 'shot.png' });

      const editor = await getEditor('body');
      await caretIn(editor, 0, 4);

      await (editor as any).upload([uploadFile()]);
      await editor.updateComplete;

      assert.equal(editor.value, 'body');
      assert.equal(editor.error, 'Unable to upload file.');
      assert.isNotOk(doc(editor).querySelector('img'));
    });

    it('strips the delimiters out of alt text', async () => {
      // clean_name deliberately keeps [ ] ( ) in filenames, which are what delimit a markdown image
      mockPOST(/msgmedia\/upload/, {
        url: '/test-assets/img/sim_image_c.jpg',
        name: 'a [weird] (name).png'
      });

      const editor = await getEditor('');
      await caretIn(editor, 0, 0);

      await (editor as any).upload([uploadFile()]);
      await editor.updateComplete;

      assert.equal(
        editor.value,
        '![a weird name.png](/test-assets/img/sim_image_c.jpg)'
      );
    });

    it('inserts into the source in source mode', async () => {
      ok();
      const editor = await getEditor('body');
      editor.sourceMode = true;
      await editor.updateComplete;
      editor.textArea.setSelectionRange(4, 4);

      await (editor as any).upload([uploadFile()]);
      await editor.updateComplete;

      assert.equal(
        editor.value,
        'body![shot.png](/test-assets/img/sim_image_c.jpg)'
      );
    });

    it('accepts a drag so the browser does not navigate to the dropped file', async () => {
      const editor = await getEditor('body');
      const over = new DragEvent('dragover', {
        bubbles: true,
        cancelable: true
      });
      doc(editor).dispatchEvent(over);

      assert.isTrue(over.defaultPrevented);
    });
  });

  describe('screenshots', () => {
    const ARTICLE = [
      'Open the **Flows** tab and pick a flow to edit. See the [docs](https://example.com) for more.',
      '',
      '* Add a node',
      '* Connect it up',
      '',
      '![a screenshot](/test-assets/img/sim_image_c.jpg)'
    ].join('\n');

    // The rendered document sizes itself to its content, so the screenshots only need a floor for source mode. The
    // title is slotted in as the page slots it, so the pictures show the article as it's edited.
    const getArticle = async (minHeight = 0): Promise<MarkdownEditor> => {
      const editor = (await getComponent(
        TAG,
        { widget_only: true },
        '<textarea slot="title" rows="1">Getting started</textarea>',
        500
      )) as MarkdownEditor;

      editor.minHeight = minHeight;
      editor.value = ARTICLE;
      await editor.updateComplete;
      await waitForImages(editor.shadowRoot);
      return editor;
    };

    it('renders the document', async () => {
      const editor = await getArticle();
      expect(blocks(editor).length).to.equal(3);
      await assertScreenshot('markdown-editor/document', getClip(editor));
    });

    it('shows the toolbar following the caret while editing', async () => {
      const editor = await getArticle();

      // the caret in the paragraph - the toolbar says what it is sitting in, and the article stays an article
      await caretIn(editor, 0, 7);
      await editor.updateComplete;

      await assertScreenshot('markdown-editor/editing', getClip(editor));
    });

    it('shows the link bar for a caret inside a link', async () => {
      const editor = await getArticle();

      // inside "docs", which is the link's own text
      const at = blocks(editor)[0].textContent.indexOf('docs') + 2;
      await caretIn(editor, 0, at);
      await editor.updateComplete;

      assert.isOk(
        editor.shadowRoot.querySelector('.overlays .popover'),
        'the caret is not in the link'
      );

      await assertScreenshot('markdown-editor/link', getClip(editor));
    });

    it('shows the image bar for a clicked image', async () => {
      const editor = await getArticle();

      doc(editor)
        .querySelector('img')
        .dispatchEvent(
          new MouseEvent('click', { bubbles: true, composed: true })
        );
      await editor.updateComplete;

      assert.isOk(
        editor.shadowRoot.querySelector('.overlays .image-actions'),
        'no image bar for the clicked image'
      );

      await assertScreenshot('markdown-editor/image', getClip(editor));
    });

    it('shows the whole document as markdown', async () => {
      const editor = await getArticle(220);
      editor.sourceMode = true;
      await editor.updateComplete;
      await assertScreenshot('markdown-editor/source', getClip(editor));
    });
  });
});
