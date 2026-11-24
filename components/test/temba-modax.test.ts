import { fixture, expect, assert } from '@open-wc/testing';
import * as sinon from 'sinon';
import { useFakeTimers } from 'sinon';
import { Button } from '../src/display/Button';
import { Dialog } from '../src/layout/Dialog';
import { Modax } from '../src/layout/Modax';
import { CustomEventType } from '../src/interfaces';
import { assertScreenshot, getClip, mockGET, mockPOST } from './utils.test';

let clock: any;

const getModaxHTML = (endpoint: string): string => {
  return `
      <temba-modax header="Hello Modax" endpoint="${endpoint}">
        <div>Open Me</div>
      </temba-modax>
    `;
};

const getButtons = (modax: Modax, type: string = null) => {
  return modax.shadowRoot
    .querySelector('temba-dialog')
    .shadowRoot.querySelectorAll(
      type ? `temba-button[${type}='']` : 'temba-button'
    );
};

const open = async (modax: Modax) => {
  return new Promise((resolve: any) => {
    modax.addEventListener(
      CustomEventType.Loaded,
      async (event: CustomEvent) => {
        await clock.runAll();
        resolve(event.detail);
      }
    );

    modax.addEventListener(
      CustomEventType.Redirected,
      async (event: CustomEvent) => {
        await clock.runAll();
        resolve(event.detail);
      }
    );

    modax.open = true;
  });
};

const clickPrimary = async (modax: Modax) => {
  const buttons = getButtons(modax);

  if (buttons.length > 0) {
    let primary = buttons[0] as Button;

    if (buttons.length > 1) {
      // look for our primary flag
      buttons.forEach((button: Button) => {
        if (button.primary) {
          primary = button;
        }
      });
    }

    expect(primary).not.equals(undefined, 'Missing primary button');
    primary.click();
  }
};

// measured once modax and its dialog have finished updating, since the footer
// renders in a later pass and would otherwise fall outside the clip
const getDialogClip = async (modax: Modax) => {
  const dialog = modax.shadowRoot.querySelector('temba-dialog') as Dialog;
  await modax.updateComplete;
  await dialog.updateComplete;
  return getClip(
    dialog.shadowRoot.querySelector('.dialog-container') as HTMLElement
  );
};

describe('temba-modax', () => {
  beforeEach(function () {
    clock = useFakeTimers();
  });

  afterEach(function () {
    clock.restore();
  });

  it('can be created', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/hello.html')
    );
    assert.instanceOf(modax, Modax);
  });

  it('opens', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/hello.html')
    );

    await open(modax);
    expect(modax.open).equals(true);

    // Now our body should have our endpoint text
    expect(modax.getBody().innerHTML).to.contain('Hello World');

    await assertScreenshot('modax/simple', await getDialogClip(modax));
  });

  it('fetches forms', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/form.html')
    );
    expect(modax.open).to.equal(false);
    await open(modax);

    expect(modax.open).to.equal(true);

    expect(modax.buttons[1].name).to.equal('Save Everything');
    expect(modax.buttons[0].name).to.equal('Cancel');

    await assertScreenshot('modax/form', await getDialogClip(modax));
  });

  // the fetched form is rendered inside the modax, so its fields and the focus among them are read from there
  const isFocused = (modax: Modax, selector: string): boolean => {
    const field = modax.shadowRoot.querySelector(selector);
    return !!field && modax.shadowRoot.activeElement === field;
  };

  it('focuses the first field on opening', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/form.html')
    );
    await open(modax);
    await clock.runAll();

    assert.isTrue(isFocused(modax, 'input[type="text"]'));
  });

  it('leaves focus alone on opening when told to', async () => {
    // a dialog that's read before it's written in
    const modax: Modax = await fixture(
      `<temba-modax header="Quiet" endpoint="/test/assets/modax/form.html" no-autofocus>
        <div>Open Me</div>
      </temba-modax>`
    );
    await open(modax);
    await clock.runAll();

    assert.isOk(modax.shadowRoot.querySelector('input[type="text"]'));
    assert.isFalse(isFocused(modax, 'input[type="text"]'));
  });

  it('reverts primary name on reuse', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/hello.html')
    );

    // await click('temba-modax');
    await open(modax);
    expect(modax.open).equals(true);

    // should only have one button, okay
    let buttons = getButtons(modax);
    expect(buttons.length).equals(1);

    // close our dialog
    await clickPrimary(modax);
    expect(modax.open).equals(false);

    // now fetch form from the same modax
    modax.endpoint = '/test/assets/modax/form.html';
    await open(modax);
    expect(modax.open).equals(true);

    // now we should have two buttons, 'Save Everything' and 'Cancel'
    buttons = getButtons(modax);
    expect(buttons.length).equals(2);

    // secondary should be Cancel, not Ok
    const secondary = getButtons(modax, 'secondary')[0] as Button;
    expect(secondary.name).equals('Cancel');
  });

  it('closes after redirect', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/form.html')
    );

    await open(modax);
    const primary = getButtons(modax, 'primary')[0] as Button;
    expect(primary.name).equals('Save Everything');

    // click the submit button
    mockPOST(/\/test\/assets\/modax\/form\.html/, 'arst', {
      'X-Temba-Success': 'hide'
    });

    const hideTest = new Promise<void>((resolve) => {
      modax.addEventListener(CustomEventType.Submitted, () => {
        expect(modax.open).equals(false, 'Modal still visible');
        resolve();
      });
    });

    await clickPrimary(modax);
    await clock.runAllAsync();
    await hideTest;
  });

  it('posts multipart only when the form holds files', async () => {
    // opens a modax, lets the caller add to its form, submits it and returns the request made
    const submitWith = async (
      addFields: (form: HTMLFormElement) => Promise<void>
    ) => {
      const modax: Modax = await fixture(
        getModaxHTML('/test/assets/modax/upload.html')
      );
      await open(modax);
      await addFields(modax.shadowRoot.querySelector('form'));

      mockPOST(/\/test\/assets\/modax\/upload\.html/, 'arst', {
        'X-Temba-Success': 'hide'
      });
      modax.submit({ extra: '1' });
      await clock.runAllAsync();
      return (window.fetch as any).lastCall.args[1];
    };

    // no files, so url-encoded as ever
    let post = await submitWith(async () => {});
    expect(post.headers['Content-Type']).to.equal(
      'application/x-www-form-urlencoded'
    );
    expect(post.body).to.equal('title=Help&extra=1');

    // a component holding a file sends everything as multipart
    post = await submitWith(async (form) => {
      const picker = document.createElement('temba-image-picker') as any;
      picker.name = 'favicon';
      form.appendChild(picker);
      await picker.updateComplete;
      const image = new FormData();
      image.append(
        'favicon',
        new Blob(['img'], { type: 'image/webp' }),
        'f.webp'
      );
      picker.value = image;
    });

    // the browser sets the multipart boundary, so no content type of our own
    expect(post.headers['Content-Type']).to.equal(undefined);
    expect(post.body).to.be.instanceOf(FormData);
    expect([...post.body.keys()]).to.have.members([
      'favicon',
      'title',
      'extra'
    ]);
    expect((post.body.get('favicon') as File).name).to.equal('f.webp');
    expect(post.body.get('title')).to.equal('Help');
  });

  it('sizes the dialog it renders', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/form.html')
    );

    const dialog = () =>
      modax.shadowRoot.querySelector('temba-dialog') as Dialog;
    const dialogWidth = () =>
      (dialog().shadowRoot.querySelector('.dialog-container') as HTMLElement)
        .style.width;

    await open(modax);

    // the dialog's own default until it's asked for something else
    expect(dialog().size).to.equal('medium');
    expect(dialogWidth()).to.equal(Dialog.widths.medium);

    modax.size = 'large';
    await modax.updateComplete;
    await dialog().updateComplete;
    expect(dialogWidth()).to.equal(Dialog.widths.large);

    // an explicit width wins over the named size
    modax.width = 'min(60rem, 92vw)';
    await modax.updateComplete;
    await dialog().updateComplete;
    expect(dialogWidth()).to.equal('min(60rem, 92vw)');
  });

  it('makes its dialog destructive when told to or for a delete', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/form.html')
    );
    const dialog = () =>
      modax.shadowRoot.querySelector('temba-dialog') as Dialog;

    await open(modax);
    expect(dialog().destructive).to.not.be.ok;

    modax.destructive = true;
    await modax.updateComplete;
    expect(dialog().destructive).to.be.ok;

    modax.destructive = false;
    modax.endpoint = '/contact/delete/1234/';
    await modax.updateComplete;
    expect(dialog().destructive).to.be.ok;
  });

  it('renders page level gutter content in the dialog footer', async () => {
    const modax: Modax = await fixture(`
      <temba-modax header="Hello Modax" endpoint="/test/assets/modax/form.html">
        <div>Open Me</div>
        <div slot="gutter" id="extra">Extra controls</div>
      </temba-modax>
    `);

    await open(modax);

    // the page's content lands in the modax's own gutter slot
    const extra = modax.querySelector('#extra') as HTMLElement;
    const forwarded = extra.assignedSlot as HTMLSlotElement;
    expect(forwarded.name).to.equal('gutter');
    expect(forwarded.getRootNode()).to.equal(modax.shadowRoot);

    // which is passed through to the dialog's gutter, in the footer next to the buttons
    const dialog = modax.shadowRoot.querySelector('temba-dialog') as Dialog;
    const passthrough = forwarded.closest('[slot="gutter"]') as HTMLElement;
    expect(passthrough.assignedSlot).to.equal(
      dialog.shadowRoot.querySelector('slot[name="gutter"]')
    );

    // and it really is on screen inside the footer, to the left of the buttons
    const footer = dialog.shadowRoot.querySelector(
      '.dialog-footer'
    ) as HTMLElement;
    const rect = extra.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const button = footer.querySelector('temba-button').getBoundingClientRect();

    expect(rect.width).to.be.greaterThan(0);
    expect(rect.top).to.be.at.least(footerRect.top);
    expect(rect.bottom).to.be.at.most(footerRect.bottom);
    expect(rect.right).to.be.at.most(button.left);
  });

  it('applies header colors from response headers', async () => {
    mockGET(/\/test\/assets\/modax\/hello\.html/, '<div>Colored Header</div>', {
      'X-Temba-Header-Bg': '#8e5ea7',
      'X-Temba-Header-Text': '#fff'
    });

    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/hello.html')
    );

    await open(modax);
    expect(modax.style.getPropertyValue('--header-bg')).to.equal('#8e5ea7');
    expect(modax.style.getPropertyValue('--header-text')).to.equal('#fff');
  });

  it('clears header colors when headers are absent', async () => {
    // First load with custom headers
    mockGET(/\/colored-header\.html/, '<div>Colored</div>', {
      'X-Temba-Header-Bg': '#8e5ea7',
      'X-Temba-Header-Text': '#fff'
    });

    const modax: Modax = await fixture(getModaxHTML('/colored-header.html'));

    await open(modax);
    expect(modax.style.getPropertyValue('--header-bg')).to.equal('#8e5ea7');

    // Close and reopen with a different endpoint (no headers)
    await clickPrimary(modax);
    modax.endpoint = '/test/assets/modax/form.html';
    await open(modax);
    expect(modax.style.getPropertyValue('--header-bg')).to.equal('');
    expect(modax.style.getPropertyValue('--header-text')).to.equal('');
  });

  it('keeps its body until the dialog exit finishes', async () => {
    const modax: Modax = await fixture(
      getModaxHTML('/test/assets/modax/hello.html')
    );
    await open(modax);

    // an exit we finish by hand
    const dialog = modax.shadowRoot.querySelector('temba-dialog') as Dialog;
    let finishExit: () => void;
    const exited = new Promise<void>((resolve) => (finishExit = resolve));
    sinon.stub(dialog, 'exit').returns(exited);

    const body = modax.getBody().innerHTML;
    expect(body).to.not.equal('');

    modax.open = false;
    await modax.updateComplete;
    await dialog.updateComplete;
    expect(modax.getBody().innerHTML).to.equal(body);

    // modax clears its body once the exit resolves, a few microtasks on
    finishExit();
    await exited;
    for (let i = 0; i < 10 && modax.body; i++) {
      await Promise.resolve();
    }
    // compare as a boolean - a failing compare would try to print the
    // rendered body
    expect(modax.body === '').to.equal(true);
  });
});
