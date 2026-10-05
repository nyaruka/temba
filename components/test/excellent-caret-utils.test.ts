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
    type Mode = 'native' | 'composed' | 'variadic' | 'unsupported';

    // Safari has no ShadowRoot.getSelection and its window selection reports
    // ranges retargeted to the shadow host, leaving getComposedRanges as the
    // only way to see where the caret really is. Older Safari takes the shadow
    // roots as arguments rather than an options dictionary.
    const actSafari = (root: ShadowRoot, mode: Mode) => {
      Object.defineProperty(root, 'getSelection', { value: undefined });

      const selection = window.getSelection() as any;
      const getRangeAt = Selection.prototype.getRangeAt;
      const host = root.host;

      selection.getRangeAt = (index: number) => {
        const real = getRangeAt.call(selection, index);
        if (!root.contains(real.startContainer)) return real;
        const retargeted = document.createRange();
        retargeted.setStartBefore(host);
        return retargeted;
      };

      selection.getComposedRanges = (arg: any) => {
        const dictionary = !(arg instanceof ShadowRoot);
        if (
          mode === 'unsupported' ||
          (mode === 'variadic' && dictionary) ||
          (mode === 'composed' && !dictionary)
        ) {
          throw new TypeError('unsupported getComposedRanges signature');
        }
        return [getRangeAt.call(selection, 0)];
      };
    };

    const shadowEditable = async (
      inner: string,
      mode: Mode
    ): Promise<HTMLElement> => {
      const host = (await fixture('<div></div>')) as HTMLElement;
      const root = host.attachShadow({ mode: 'open' });
      if (mode !== 'native') {
        actSafari(root, mode);
      }
      root.innerHTML = `<div contenteditable="true">${inner}</div>`;
      const element = root.firstElementChild as HTMLElement;
      element.focus();
      return element;
    };

    afterEach(() => {
      const selection = window.getSelection() as any;
      delete selection.getRangeAt;
      delete selection.getComposedRanges;
    });

    for (const mode of ['native', 'composed', 'variadic'] as Mode[]) {
      it(`round trips caret offsets (${mode})`, async () => {
        const element = await shadowEditable(
          spans('hello', ' ', 'world'),
          mode
        );
        for (const offset of [0, 3, 5, 6, 11]) {
          setCaretOffset(element, offset);
          expect(getCaretOffset(element), `offset ${offset}`).to.equal(offset);
        }
      });

      it(`reads a selected range (${mode})`, async () => {
        const element = await shadowEditable(
          spans('hello', ' ', 'world'),
          mode
        );
        setCaretRange(element, 3, 8);
        expect(getCaretOffset(element)).to.equal(3);
        expect(getCaretEndOffset(element)).to.equal(8);
        expect(element.contains(getSelectionRange(element).startContainer)).to
          .be.true;
      });

      it(`keeps focus after the content is rebuilt (${mode})`, async () => {
        const element = await shadowEditable(spans('hel'), mode);
        setCaretOffset(element, 3);

        // what RichEditor does on every input
        element.textContent = 'hell';
        setCaretOffset(element, 4);

        expect(element.getRootNode()['activeElement']).to.equal(element);
        expect(getCaretOffset(element)).to.equal(4);
      });
    }

    it('reads no range when getComposedRanges is unusable', async () => {
      const element = await shadowEditable(
        spans('hello', ' ', 'world'),
        'unsupported'
      );
      setCaretOffset(element, 4);
      expect(getSelectionRange(element)).to.equal(null);
      expect(getCaretOffset(element)).to.equal(0);
      expect(getCaretEndOffset(element)).to.equal(0);
    });
  });
});
