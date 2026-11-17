import { expect, fixture, html } from '@open-wc/testing';
import { Sheet } from '../src/layout/Sheet';
import { openLinkInSheet } from '../src/layout/sheets';
import {
  clearMockGets,
  clearMockPosts,
  mockGET,
  mockPOST,
  waitForCondition
} from './utils.test';

const getSheet = async (): Promise<Sheet> =>
  (await fixture(html`<temba-sheet></temba-sheet>`)) as Sheet;

describe('temba-sheet', () => {
  afterEach(() => {
    clearMockGets();
    clearMockPosts();
    document.cookie = 'csrftoken=; path=/; max-age=0';
    document
      .querySelectorAll('temba-sheet[data-shared]')
      .forEach((shared) => shared.remove());
  });

  const LOG =
    '<template data-sheet-chrome data-header="Twilio Log" data-subtitle="Logs are kept for 7 days."><span class="logo"></span></template><div id="log">a log</div>';

  it('takes its header and icon from a view which titles itself', async () => {
    mockGET(/\/sheet\/log/, LOG);

    const sheet = await getSheet();
    sheet.showTitled('/sheet/log', 'Channel log');

    // until it loads there's the header it was opened with
    expect(sheet.current.header).to.equal('Channel log');
    await waitForCondition(() => !!sheet.querySelector('#log'));
    await sheet.updateComplete;

    expect(sheet.current.header).to.equal('Twilio Log');
    expect(sheet.current.subtitle).to.equal('Logs are kept for 7 days.');
    expect(
      sheet.querySelectorAll(':scope > .logo[slot="icon"]')
    ).to.have.length(1);

    // the icon goes with the content which gave it
    mockGET(/\/sheet\/plain/, '<div id="plain">plain</div>');
    sheet.show('/sheet/plain', 'Plain');
    await waitForCondition(() => !!sheet.querySelector('#plain'));
    expect(sheet.querySelector(':scope > [slot="icon"]')).to.be.null;
  });

  it('keeps the header and icon it was opened with', async () => {
    mockGET(/\/sheet\/log/, LOG);

    const sheet = (await fixture(
      html`<temba-sheet><b slot="icon"></b></temba-sheet>`
    )) as Sheet;
    sheet.show('/sheet/log', 'Mine', 'My subtitle');
    await waitForCondition(() => !!sheet.querySelector('#log'));

    expect(sheet.current.header).to.equal('Mine');
    expect(sheet.current.subtitle).to.equal('My subtitle');
    expect(sheet.querySelectorAll(':scope > [slot="icon"]')).to.have.length(1);
    expect(sheet.querySelector(':scope > b[slot="icon"]')).to.exist;
  });

  it('closes when a link in its content leaves the page', async () => {
    mockGET(
      /\/sheet\/log/,
      '<temba-anchor id="contact" href="/contact/read/1/"><span>Bob</span></temba-anchor>'
    );

    // the page's own handler for these links keeps the click to itself
    const original = (window as any).goto;
    const went: MouseEvent[] = [];
    (window as any).goto = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      went.push(event);
    };

    try {
      const sheet = await getSheet();
      sheet.show('/sheet/log', 'Log');
      await waitForCondition(() => !!sheet.querySelector('#contact span'));
      const name = sheet.querySelector('#contact span');

      // a click asking for a new tab leaves the page where it is, and us open
      name.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          composed: true,
          metaKey: true
        })
      );
      expect(went).to.have.length(1);
      expect(sheet.open).to.be.true;

      name.dispatchEvent(
        new MouseEvent('click', { bubbles: true, composed: true })
      );
      expect(went).to.have.length(2);
      expect(sheet.open).to.be.false;
    } finally {
      (window as any).goto = original;
    }
  });

  it('gives focus back to what opened it from inside a component', async () => {
    mockGET(/\/sheet\/log/, LOG);

    const host = (await fixture(html`<div></div>`)) as HTMLElement;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<button>open</button>';
    const button = root.querySelector('button');
    button.focus();
    expect(button.matches(':focus-visible')).to.be.true;

    const sheet = await getSheet();
    sheet.show('/sheet/log', 'Log');
    await waitForCondition(() => !!sheet.querySelector('#log'));
    await waitForCondition(() => root.activeElement !== button);

    sheet.close();
    await waitForCondition(() => root.activeElement === button);
  });

  it('shares a sheet over the page for links which open in one', async () => {
    mockGET(/\/sheet\/log/, LOG);

    const link = (await fixture(
      html`<a
        href="/sheet/log"
        aria-label="Channel log"
        @click=${openLinkInSheet}
        >log</a
      >`
    )) as HTMLAnchorElement;

    // a click asking for a new tab is left alone
    const modified = new MouseEvent('click', {
      metaKey: true,
      cancelable: true
    });
    link.addEventListener('click', (e) => e.metaKey && e.preventDefault(), {
      capture: true
    });
    link.dispatchEvent(modified);
    expect(document.querySelector('temba-sheet[data-shared]')).to.be.null;

    const click = new MouseEvent('click', { cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).to.be.true;

    const sheet = document.querySelector('temba-sheet[data-shared]') as Sheet;
    expect(sheet.parentElement).to.equal(document.body);

    // the link's label is its header until the view gives its own
    expect(sheet.current.header).to.equal('Channel log');
    await waitForCondition(() => !!sheet.querySelector('#log'));
    expect(sheet.open).to.be.true;
    expect(sheet.current.header).to.equal('Twilio Log');

    // going back or forward leaves the page it was opened over, so closes it
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(sheet.open).to.be.false;

    // and it's reused the next time
    link.dispatchEvent(new MouseEvent('click', { cancelable: true }));
    expect(sheet.open).to.be.true;
    expect(
      document.querySelectorAll('temba-sheet[data-shared]')
    ).to.have.length(1);
  });

  it('submits a form in its content and shows what comes back', async () => {
    mockGET(
      /\/sheet\/reconnect/,
      '<form id="reconnect" method="post" action="/sheet/reconnect"><input type="hidden" name="csrfmiddlewaretoken" value="stale"><input name="token" value="abc"></form>'
    );
    mockPOST(
      /\/sheet\/reconnect/,
      '<p class="errorlist">Unable to reconnect</p>'
    );

    const sheet = await getSheet();
    sheet.show('/sheet/reconnect', 'Reconnect');
    await waitForCondition(() => !!sheet.querySelector('#reconnect'));

    // a sign-in popup may have replaced the CSRF cookie since the form was rendered, so it posts the current one
    document.cookie = 'csrftoken=fresh; path=/';

    // a script of the content's submitting the form directly goes through the sheet, without leaving the page
    (sheet.querySelector('#reconnect') as HTMLFormElement).submit();
    await waitForCondition(() => !!sheet.querySelector('.errorlist'));

    const posted = (window.fetch as any)
      .getCalls()
      .find((c) => c.args[1]?.method === 'POST');
    expect(posted.args[0]).to.equal('/sheet/reconnect');
    expect(posted.args[1].body).to.equal('csrfmiddlewaretoken=fresh&token=abc');
    expect(posted.args[1].headers['X-Temba-Sheet']).to.equal('1');

    expect(sheet.querySelector('#reconnect')).to.be.null;
    expect(sheet.querySelector('.errorlist').textContent).to.equal(
      'Unable to reconnect'
    );
    expect(sheet.open).to.be.true;
  });

  it('shows where a form sends it next in its place', async () => {
    mockGET(
      /\/sheet\/request/,
      '<form id="request" method="post" action="/sheet/request"><button name="method" value="sms" type="submit">Send</button></form>'
    );
    mockPOST(/\/sheet\/request/, '', { 'X-Temba-Success': '/sheet/verify' });
    mockGET(/\/sheet\/verify/, '<p class="verify">Enter the code</p>');

    const sheet = await getSheet();
    sheet.show('/sheet/request', 'Verify Number');
    await waitForCondition(() => !!sheet.querySelector('#request'));

    // the button which submitted it goes along, as it would natively
    (sheet.querySelector('#request button') as HTMLButtonElement).click();
    await waitForCondition(() => !!sheet.querySelector('.verify'));

    const posted = (window.fetch as any)
      .getCalls()
      .find(
        (c) => c.args[0] === '/sheet/request' && c.args[1]?.method === 'POST'
      );
    expect(posted.args[1].body).to.equal('method=sms');
    expect(sheet.depth).to.equal(1);
    expect(sheet.current.endpoint).to.equal('/sheet/verify');
  });

  it('says when a submit fails', async () => {
    mockGET(
      /\/sheet\/broken/,
      '<form id="broken" method="post" action="/sheet/broken"></form>'
    );
    mockPOST(/\/sheet\/broken/, 'Server Error', {}, '500');

    const sheet = await getSheet();
    sheet.show('/sheet/broken', 'Broken');
    await waitForCondition(() => !!sheet.querySelector('#broken'));

    (sheet.querySelector('#broken') as HTMLFormElement).submit();
    await waitForCondition(() => !!sheet.querySelector('.dash-empty'));
    expect(sheet.querySelector('.dash-empty').textContent).to.equal(
      'Something went wrong submitting this.'
    );
  });

  it('leaves forms which do not post to submit as they would', async () => {
    mockGET(
      /\/sheet\/search/,
      '<form id="search" action="/sheet/search"><input name="q"></form>'
    );

    const sheet = await getSheet();
    sheet.show('/sheet/search', 'Search');
    await waitForCondition(() => !!sheet.querySelector('#search'));

    const form = sheet.querySelector('#search') as HTMLFormElement;
    expect(form.submit).to.equal(HTMLFormElement.prototype.submit);

    // its submit isn't ours to stop
    const event = new SubmitEvent('submit', {
      bubbles: true,
      cancelable: true
    });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).to.be.false;
  });
});
