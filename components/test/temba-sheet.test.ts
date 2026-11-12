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
  });

  it('submits a form in its content and shows what comes back', async () => {
    mockGET(
      /\/sheet\/reconnect/,
      '<form id="reconnect" method="post" action="/sheet/reconnect"><input name="token" value="abc"></form>'
    );
    mockPOST(
      /\/sheet\/reconnect/,
      '<p class="errorlist">Unable to reconnect</p>'
    );

    const sheet = await getSheet();
    sheet.show('/sheet/reconnect', 'Reconnect');
    await waitForCondition(() => !!sheet.querySelector('#reconnect'));

    // a script of the content's submitting the form directly goes through the sheet, without leaving the page
    (sheet.querySelector('#reconnect') as HTMLFormElement).submit();
    await waitForCondition(() => !!sheet.querySelector('.errorlist'));

    const posted = (window.fetch as any)
      .getCalls()
      .find((c) => c.args[1]?.method === 'POST');
    expect(posted.args[0]).to.equal('/sheet/reconnect');
    expect(posted.args[1].body).to.equal('token=abc');
    expect(posted.args[1].headers['X-Temba-Sheet']).to.equal('1');

    expect(sheet.querySelector('#reconnect')).to.be.null;
    expect(sheet.querySelector('.errorlist').textContent).to.equal(
      'Unable to reconnect'
    );
    expect(sheet.open).to.be.true;
  });
});
