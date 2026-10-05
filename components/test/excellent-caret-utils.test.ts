import { expect, fixture } from '@open-wc/testing';
import {
  getSelectionFromRoot,
  getTextFromEditableDiv,
  getCaretOffset,
  getCaretEndOffset,
  getSelectionRange,
  setCaretOffset,
  setCaretRange
} from '../src/excellent/caret-utils';

// builds a contenteditable div matching the shape our renderer produces
const editable = async (inner: string): Promise<HTMLElement> => {
  return (await fixture(
    `<div contenteditable="true">${inner}</div>`
  )) as HTMLElement;
};

const spans = (...texts: string[]) =>
  texts.map((t) => `<span class="tok">${t}</span>`).join('');

describe('excellent/caret-utils', () => {
  afterEach(() => {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  });

  describe('getSelectionFromRoot', () => {
    it('falls back to the window selection for light DOM elements', async () => {
      const element = await editable(spans('hello'));
      expect(getSelectionFromRoot(element)).to.equal(window.getSelection());
    });
  });

  describe('getTextFromEditableDiv', () => {
    it('returns empty string for an empty editable', async () => {
      const element = await editable('');
      expect(getTextFromEditableDiv(element)).to.equal('');
    });

    it('concatenates the text of token spans', async () => {
      const element = await editable(spans('hello', ' ', 'world'));
      expect(getTextFromEditableDiv(element)).to.equal('hello world');
    });

    it('reads newlines held inside token spans', async () => {
      const element = await editable(spans('a', '\n', 'b'));
      expect(getTextFromEditableDiv(element)).to.equal('a\nb');
    });

    it('ignores the trailing sentinel br', async () => {
      const element = await editable(spans('hello') + '<br data-sentinel>');
      expect(getTextFromEditableDiv(element)).to.equal('hello');
    });

    it('translates a browser inserted br into a newline', async () => {
      const element = await editable(spans('a') + '<br>' + spans('b'));
      expect(getTextFromEditableDiv(element)).to.equal('a\nb');
    });

    it('does not prefix a newline before a leading block', async () => {
      const element = await editable('<div>a</div>');
      expect(getTextFromEditableDiv(element)).to.equal('a');
    });

    it('prefixes a newline before blocks that follow content', async () => {
      const element = await editable('<div>a</div><div>b</div>');
      expect(getTextFromEditableDiv(element)).to.equal('a\nb');
    });

    it('prefixes a newline before a block following inline text', async () => {
      const element = await editable('x<div>b</div>');
      expect(getTextFromEditableDiv(element)).to.equal('x\nb');
    });

    it('treats paragraphs as blocks too', async () => {
      const element = await editable('<p>a</p><p>b</p>');
      expect(getTextFromEditableDiv(element)).to.equal('a\nb');
    });

    it('reads text nested inside elements', async () => {
      const element = await editable('<span><span>deep</span></span>');
      expect(getTextFromEditableDiv(element)).to.equal('deep');
    });

    it('skips empty blocks when deciding on the newline prefix', async () => {
      // the leading empty div contributes nothing, so no newline precedes "a"
      const element = await editable('<div></div><div>a</div>');
      expect(getTextFromEditableDiv(element)).to.equal('a');
    });
  });

  describe('caret offsets', () => {
    it('returns zero when there is no selection', async () => {
      const element = await editable(spans('hello'));
      window.getSelection().removeAllRanges();
      expect(getCaretOffset(element)).to.equal(0);
      expect(getCaretEndOffset(element)).to.equal(0);
    });

    it('round trips an offset inside a single span', async () => {
      const element = await editable(spans('hello world'));
      setCaretOffset(element, 4);
      expect(getCaretOffset(element)).to.equal(4);
    });

    it('round trips an offset across several spans', async () => {
      const element = await editable(spans('hello', ' ', 'world'));
      for (const offset of [0, 3, 5, 6, 9]) {
        setCaretOffset(element, offset);
        expect(getCaretOffset(element), `offset ${offset}`).to.equal(offset);
      }
    });

    it('round trips an offset past a newline span', async () => {
      const element = await editable(spans('ab', '\n', 'cd'));
      for (const offset of [1, 2, 3, 4]) {
        setCaretOffset(element, offset);
        expect(getCaretOffset(element), `offset ${offset}`).to.equal(offset);
      }
    });

    it('places the caret at the very end of the content', async () => {
      const element = await editable(spans('hello'));
      setCaretOffset(element, 5);
      expect(getCaretOffset(element)).to.equal(5);
    });

    it('places the caret before a trailing sentinel br', async () => {
      const element = await editable(spans('hello') + '<br data-sentinel>');
      setCaretOffset(element, 5);
      expect(getCaretOffset(element)).to.equal(5);
    });

    it('round trips offsets around a browser inserted br', async () => {
      const element = await editable(spans('ab') + '<br>' + spans('cd'));
      expect(getTextFromEditableDiv(element)).to.equal('ab\ncd');
      for (const offset of [2, 3, 4]) {
        setCaretOffset(element, offset);
        expect(getCaretOffset(element), `offset ${offset}`).to.equal(offset);
      }
    });

    it('leaves the selection alone for an unreachable offset', async () => {
      const element = await editable(spans('hi'));
      setCaretOffset(element, 1);
      // well past the end of the content, so no position can be resolved
      setCaretOffset(element, 99);
      expect(getCaretOffset(element)).to.equal(1);
    });
  });

  describe('setCaretRange', () => {
    it('selects a range by plain text offsets', async () => {
      const element = await editable(spans('hello world'));
      setCaretRange(element, 2, 7);
      expect(getCaretOffset(element)).to.equal(2);
      expect(getCaretEndOffset(element)).to.equal(7);
      expect(window.getSelection().toString()).to.equal('llo w');
    });

    it('selects across span boundaries', async () => {
      const element = await editable(spans('hello', ' ', 'world'));
      setCaretRange(element, 3, 8);
      expect(getCaretOffset(element)).to.equal(3);
      expect(getCaretEndOffset(element)).to.equal(8);
      expect(window.getSelection().toString()).to.equal('lo wo');
    });

    it('collapses to a caret when start and end match', async () => {
      const element = await editable(spans('hello'));
      setCaretRange(element, 2, 2);
      expect(getCaretOffset(element)).to.equal(2);
      expect(getCaretEndOffset(element)).to.equal(2);
      expect(window.getSelection().toString()).to.equal('');
    });

    it('leaves the selection alone when an endpoint cannot be resolved', async () => {
      const element = await editable(spans('hi'));
      setCaretRange(element, 0, 1);
      setCaretRange(element, 0, 99);
      expect(getCaretEndOffset(element)).to.equal(1);
    });
  });

  describe('inside a shadow root', () => {
    // builds the editable inside a shadow root, optionally without
    // ShadowRoot.getSelection the way Safari has it
    const shadowEditable = async (
      inner: string,
      withGetSelection: boolean
    ): Promise<HTMLElement> => {
      const host = (await fixture('<div></div>')) as HTMLElement;
      const root = host.attachShadow({ mode: 'open' });
      if (!withGetSelection) {
        Object.defineProperty(root, 'getSelection', { value: undefined });
      }
      root.innerHTML = `<div contenteditable="true">${inner}</div>`;
      const element = root.firstElementChild as HTMLElement;
      element.focus();
      return element;
    };

    for (const withGetSelection of [true, false]) {
      const label = withGetSelection
        ? 'with ShadowRoot.getSelection'
        : 'without ShadowRoot.getSelection';

      it(`round trips caret offsets ${label}`, async () => {
        const element = await shadowEditable(
          spans('hello', ' ', 'world'),
          withGetSelection
        );
        for (const offset of [0, 3, 5, 6, 11]) {
          setCaretOffset(element, offset);
          expect(getCaretOffset(element), `offset ${offset}`).to.equal(offset);
        }
      });

      it(`reads a selected range ${label}`, async () => {
        const element = await shadowEditable(
          spans('hello', ' ', 'world'),
          withGetSelection
        );
        setCaretRange(element, 3, 8);
        expect(getCaretOffset(element)).to.equal(3);
        expect(getCaretEndOffset(element)).to.equal(8);
        expect(element.contains(getSelectionRange(element).startContainer)).to
          .be.true;
      });

      it(`keeps focus after the content is rebuilt ${label}`, async () => {
        const element = await shadowEditable(spans('hel'), withGetSelection);
        setCaretOffset(element, 3);

        // what RichEditor does on every input
        element.textContent = 'hell';
        setCaretOffset(element, 4);

        expect(element.getRootNode()['activeElement']).to.equal(element);
        expect(getCaretOffset(element)).to.equal(4);
      });
    }
  });
});
