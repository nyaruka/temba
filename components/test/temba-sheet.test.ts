import { expect, fixture, html } from '@open-wc/testing';
import { Sheet } from '../src/layout/Sheet';
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
