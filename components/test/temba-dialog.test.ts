import { assert, expect, fixture } from '@open-wc/testing';
import * as sinon from 'sinon';
import { Dialog } from '../src/layout/Dialog';
import { assertScreenshot, getClip } from './utils.test';

// measured once the dialog has finished updating, so a later render pass
// can't leave part of it outside the clip
const getDialogClip = async (dialog: Dialog) => {
  await dialog.updateComplete;
  return getClip(
    dialog.shadowRoot.querySelector('.dialog-container') as HTMLElement
  );
};

const getDialogHTML = (hideOnClick = false) => {
  return `
    <temba-dialog header="Hello Dialog" ${hideOnClick ? 'hideOnClick' : ''}>
      <input name="comment" type="text" style="margin: 10px"/>
    </temba-dialog>
  `;
};

const open = async (dialog: Dialog) => {
  const clock = sinon.useFakeTimers();
  dialog.open = true;

  await dialog.updateComplete;

  // our dialog will animate onto the screen
  clock.tick(400);
  await dialog.updateComplete;

  // gain focus for first text input
  clock.tick(100);
  await dialog.updateComplete;

  clock.restore();
};

const close = async (dialog: Dialog) => {
  const clock = sinon.useFakeTimers();
  dialog.open = false;
  await dialog.updateComplete;

  // tick forward for close to complete
  clock.tick(400);

  clock.restore();
};

describe('temba-dialog', () => {
  it('can be created', async () => {
    const dialog: Dialog = await fixture(getDialogHTML());
    assert.instanceOf(dialog, Dialog);
  });

  it('can be opened', async () => {
    const dialog: Dialog = await fixture(getDialogHTML());
    await open(dialog);
    expect(dialog.ready).to.equal(true);
  });

  it('can be closed by attribute', async () => {
    const dialog: Dialog = await fixture(getDialogHTML());
    await open(dialog);
    expect(dialog.ready).to.equal(true);
    dialog.open = false;
  });

  it('can be canceled', async () => {
    const dialog: Dialog = await fixture(getDialogHTML());
    await open(dialog);
    expect(dialog.ready).to.equal(true);

    dialog.getCancelButton().click();
    expect(dialog.open).to.equal(false);
  });

  it('restricts and restores background scrolling', async () => {
    const dialog: Dialog = await fixture(getDialogHTML());
    await open(dialog);
    const body = document.querySelector('body');
    expect(body.style.position).to.equal('fixed');

    await close(dialog);
    dialog.getCancelButton().click();
    await dialog.updateComplete;
    expect(body.style.position).to.equal('');
  });

  it('does not auto-focus the first text input on open', async () => {
    const dialog: Dialog = await fixture(getDialogHTML());
    await open(dialog);

    const input = dialog.querySelector('input');
    expect(document.activeElement).to.not.equal(input);
    await assertScreenshot('dialog/focused', await getDialogClip(dialog));
  });

  it('hides on click', async () => {
    const dialog: Dialog = await fixture(getDialogHTML(true));
    await open(dialog);

    const mask: HTMLDivElement =
      dialog.shadowRoot.querySelector('#dialog-mask');
    mask.click();

    await dialog.updateComplete;
    expect(dialog.open).to.equal(false);
  });

  it('hides on escape', async () => {
    const dialog: Dialog = await fixture(getDialogHTML(true));
    await open(dialog);
    expect(dialog.open).to.equal(true);

    // simulate the escape key
    const element = dialog.shadowRoot.querySelector('.dialog-container');
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    expect(dialog.open).to.equal(false);
  });

  it('only shows submitting state on the primary button', async () => {
    const dialog: Dialog = await fixture(getDialogHTML());
    await open(dialog);

    dialog.submitting = true;
    await dialog.updateComplete;

    const primary = dialog.getPrimaryButton();
    const cancel = dialog.getCancelButton();
    expect(primary.submitting).to.equal(true);
    expect(cancel.submitting).to.equal(false);
  });

  describe('escape with unsaved changes', () => {
    let confirmStub: sinon.SinonStub;

    beforeEach(() => {
      confirmStub = sinon.stub(window, 'confirm');
    });

    afterEach(() => {
      confirmStub.restore();
    });

    const pressEscape = (dialog: Dialog) => {
      const container = dialog.shadowRoot.querySelector('.dialog-container');
      container.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape' }));
    };

    const editContent = (dialog: Dialog) => {
      const input = dialog.querySelector('input');
      // edits only count after a user interaction with the dialog
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    it('hides without confirming when content was not edited', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);

      pressEscape(dialog);

      expect(confirmStub.called).to.equal(false);
      expect(dialog.open).to.equal(false);
    });

    it('ignores change events fired without user interaction', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);

      // components initializing preset values fire change events on load;
      // without a pointer or key interaction these must not count as edits
      dialog
        .querySelector('input')
        .dispatchEvent(new Event('change', { bubbles: true }));
      pressEscape(dialog);

      expect(confirmStub.called).to.equal(false);
      expect(dialog.open).to.equal(false);
    });

    it('ignores change events from elements the user never touched', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);

      // interact with the input, but a change arrives from a different
      // element (e.g. an async select resolving preset values late)
      const other = document.createElement('span');
      dialog.appendChild(other);
      dialog
        .querySelector('input')
        .dispatchEvent(new Event('pointerdown', { bubbles: true }));
      other.dispatchEvent(new Event('change', { bubbles: true }));

      pressEscape(dialog);

      expect(confirmStub.called).to.equal(false);
      expect(dialog.open).to.equal(false);
    });

    it('counts changes fired by a component containing the touched element', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);
      confirmStub.returns(false);

      // interaction lands on an inner element; the change is fired by its
      // container (how temba components re-fire changes on their host)
      const container = document.createElement('div');
      const inner = document.createElement('span');
      container.appendChild(inner);
      dialog.appendChild(container);

      inner.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      container.dispatchEvent(new Event('change', { bubbles: true }));

      pressEscape(dialog);

      expect(confirmStub.calledOnce).to.equal(true);
      expect(dialog.open).to.equal(true);
    });

    it('stays open when content was edited and confirm is declined', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);
      confirmStub.returns(false);

      editContent(dialog);
      pressEscape(dialog);

      expect(confirmStub.calledOnce).to.equal(true);
      expect(confirmStub.firstCall.args[0]).to.equal(
        Dialog.UNSAVED_CHANGES_MESSAGE
      );
      expect(dialog.open).to.equal(true);
    });

    it('hides when content was edited and confirm is accepted', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);
      confirmStub.returns(true);

      editContent(dialog);
      pressEscape(dialog);

      expect(confirmStub.calledOnce).to.equal(true);
      expect(dialog.open).to.equal(false);
    });

    it('resets edit tracking when reopened', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);

      editContent(dialog);
      await close(dialog);
      await open(dialog);

      pressEscape(dialog);

      expect(confirmStub.called).to.equal(false);
      expect(dialog.open).to.equal(false);
    });

    it('prefers checkForChanges over event tracking', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);

      // owner says nothing changed, so edit events don't matter
      dialog.checkForChanges = () => false;
      editContent(dialog);
      pressEscape(dialog);

      expect(confirmStub.called).to.equal(false);
      expect(dialog.open).to.equal(false);

      await open(dialog);
      confirmStub.returns(false);

      // owner says there are changes even though no events fired
      dialog.checkForChanges = () => true;
      pressEscape(dialog);

      expect(confirmStub.calledOnce).to.equal(true);
      expect(dialog.open).to.equal(true);
    });
  });

  describe('subtitle', () => {
    it('renders under the header when set', async () => {
      const dialog: Dialog = await fixture(
        '<temba-dialog header="Hello" subtitle="A little more detail"></temba-dialog>'
      );
      const subtitle = dialog.shadowRoot.querySelector('.subtitle');
      expect(subtitle.textContent.trim()).to.equal('A little more detail');
    });

    it('is left out when not set', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      expect(dialog.shadowRoot.querySelector('.subtitle')).to.equal(null);
    });
  });

  describe('theme', () => {
    const openThemed = async (color: string) => {
      const dialog: Dialog = await fixture(
        `<temba-dialog header="Themed" primaryButtonName="Add" style="--header-bg: ${color}"></temba-dialog>`
      );
      await open(dialog);
      await dialog.updateComplete;
      return dialog.shadowRoot.querySelector(
        '.dialog-container'
      ) as HTMLElement;
    };

    it('focuses with the color itself when it carries white text', async () => {
      const container = await openThemed('#8e5ea7');
      expect(container.classList.contains('themed')).to.equal(true);
      expect(container.classList.contains('light')).to.equal(false);
      expect(container.style.getPropertyValue('--focus-rgb')).to.equal(
        '142, 94, 167'
      );
    });

    it('uses dark text and a deeper focus for a light color', async () => {
      const container = await openThemed('rgb(255, 249, 194)');
      expect(container.classList.contains('light')).to.equal(true);

      // same hue, darkened enough to read against white
      expect(container.style.getPropertyValue('--focus-rgb')).to.equal(
        '214, 193, 0'
      );

      // white header text would be unreadable on it
      const title = container.querySelector('.header-text') as HTMLElement;
      const [r, g, b] = getComputedStyle(title)
        .color.match(/[\d.]+/g)
        .map(Number);
      expect(r + g + b).to.be.lessThan(200);
    });

    it('leaves an unthemed dialog alone', async () => {
      const container = await openThemed('');
      expect(container.classList.contains('themed')).to.equal(false);
      expect(container.classList.contains('light')).to.equal(false);
    });
  });

  describe('exit', () => {
    it("finishes right away when it can't animate", async () => {
      // the suite runs with reduced motion, as some users do
      const dialog: Dialog = await fixture(getDialogHTML());
      await open(dialog);
      expect(dialog.canAnimateExit()).to.equal(false);
      await dialog.exit('cancel');
    });

    it('plays a submit after the primary button and a cancel otherwise', async () => {
      const dialog: Dialog = await fixture(getDialogHTML());
      const exit = sinon.spy(dialog, 'exit');

      await open(dialog);
      dialog.getPrimaryButton().click();
      await close(dialog);
      expect(exit.lastCall.args[0]).to.equal('submit');

      // working in the dialog after the primary button (a submit that came
      // back with errors) makes the next close a cancel
      await open(dialog);
      dialog.getPrimaryButton().click();
      dialog.shadowRoot
        .querySelector('.dialog-container')
        .dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await close(dialog);
      expect(exit.lastCall.args[0]).to.equal('cancel');
    });
  });
});
