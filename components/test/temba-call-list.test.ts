import { assert, expect } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { CallList } from '../src/list/CallList';
import { formatDuration } from '../src/utils';
import {
  assertScreenshot,
  getClip,
  getComponent,
  loadStore,
  mockGET,
  mockNow
} from './utils.test';

const TAG = 'temba-call-list';
const getCallList = async (attrs: any = {}, width = 700, height = 0) => {
  return (await getComponent(TAG, attrs, '', width, height)) as CallList;
};

const call = (over: any = {}) => ({
  uuid: 'call-1',
  direction: 'in',
  status: 'completed',
  error_reason: null,
  contact: { uuid: 'contact-1', name: 'Bob' },
  channel: { uuid: 'chan-1', name: 'Twilio' },
  duration: 75,
  created_on: '2026-05-11T09:12:00.000000Z',
  ...over
});

const renderRows = async (list: CallList, items: any[]) => {
  (list as any).items = items;
  list.requestUpdate();
  await list.updateComplete;
};

describe('temba-call-list', () => {
  let nowStub: any;
  beforeEach(() => {
    // pin "now" so the relative dates render the same across runs
    nowStub = mockNow('2026-05-11T14:00:00Z');
  });
  afterEach(() => {
    if (nowStub) nowStub.restore();
  });

  it('can be created', async () => {
    const list: CallList = await getCallList();
    assert.instanceOf(list, CallList);
    expect(list.valueKey).to.equal('uuid');
    // the endpoint has no search
    expect(list.searchable).to.be.false;
  });

  it('formats durations', () => {
    expect(formatDuration(0)).to.equal('0:00');
    expect(formatDuration(15)).to.equal('0:15');
    expect(formatDuration(75)).to.equal('1:15');
    expect(formatDuration(3661)).to.equal('1:01:01');
    expect(formatDuration(undefined)).to.equal('0:00');
  });

  it('opens the contact for a row', async () => {
    const list: CallList = await getCallList();
    expect((list as any).getRowHref(call())).to.equal(
      '/contact/read/contact-1/'
    );
    expect((list as any).getRowHref(call({ contact: null }))).to.be.null;
  });

  it('leads each row with its direction icon', async () => {
    const list: CallList = await getCallList();
    expect((list as any).getRowIcon(call({ direction: 'in' }))).to.equal(
      'phone-incoming-01'
    );
    expect((list as any).getRowIcon(call({ direction: 'out' }))).to.equal(
      'phone-call-01'
    );
  });

  it('renders the status, duration and created cells', async () => {
    const list: CallList = await getCallList();
    await renderRows(list, [
      call(),
      call({
        uuid: 'call-2',
        status: 'errored',
        error_reason: 'no_answer',
        duration: 0
      })
    ]);

    const rows = list.shadowRoot.querySelectorAll('tr.row');
    expect(rows).to.have.length(2);

    const pill1 = rows[0].querySelector('.status-pill') as HTMLElement;
    expect(pill1.textContent.trim()).to.equal('Complete');
    expect(pill1.classList.contains('status-active')).to.be.true;
    expect(rows[0].querySelector('.duration').textContent.trim()).to.equal(
      '1:15'
    );

    const pill2 = rows[1].querySelector('.status-pill') as HTMLElement;
    expect(pill2.textContent.trim()).to.equal('Errored (No Answer)');
    expect(pill2.classList.contains('status-warning')).to.be.true;
    expect(rows[1].querySelector('.duration').textContent.trim()).to.equal(
      '0:00'
    );

    // no log links until the host enables them
    expect(list.shadowRoot.querySelectorAll('.log-link')).to.have.length(0);
  });

  it('links to channel logs when the host enables them', async () => {
    const list: CallList = await getCallList({
      'show-logs-after': '2026-05-01T00:00:00Z'
    });
    await renderRows(list, [
      call(),
      // created before the retention cutoff, so its logs are gone
      call({ uuid: 'call-2', created_on: '2026-04-30T09:12:00.000000Z' }),
      // no channel to link to
      call({ uuid: 'call-3', channel: null })
    ]);

    const rows = list.shadowRoot.querySelectorAll('tr.row');
    const log = rows[0].querySelector('.log-link') as HTMLAnchorElement;
    expect(log).to.exist;
    expect(log.getAttribute('href')).to.equal(
      '/channels/channel/logs/chan-1/call/call-1/'
    );
    expect(rows[1].querySelector('.log-link')).to.not.exist;
    expect(rows[2].querySelector('.log-link')).to.not.exist;
  });

  it('navigates to the contact on row click, and opens the log in a sheet from its link', async () => {
    mockGET(
      /\/channels\/channel\/logs\/chan-1\/call\/call-1\//,
      '<div id="log">a log</div>'
    );
    const list: CallList = await getCallList({
      'show-logs-after': '2026-05-01T00:00:00Z'
    });
    await renderRows(list, [call()]);

    const redirects: any[] = [];
    list.addEventListener(CustomEventType.Redirected, (e: any) =>
      redirects.push(e.detail)
    );

    const log = list.shadowRoot.querySelector('.log-link') as HTMLElement;
    const click = new MouseEvent('click', {
      bubbles: true,
      composed: true,
      cancelable: true
    });
    log.dispatchEvent(click);
    expect(click.defaultPrevented, 'the link is not followed').to.be.true;
    expect(redirects, 'log link click stays on the link').to.have.length(0);

    const sheet = document.querySelector('temba-sheet[data-shared]') as any;
    expect(sheet).to.exist;
    expect(sheet.current.endpoint).to.equal(
      '/channels/channel/logs/chan-1/call/call-1/'
    );
    sheet.remove();

    const row = list.shadowRoot.querySelector('tr.row') as HTMLElement;
    row.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true })
    );
    expect(redirects).to.have.length(1);
    expect(redirects[0].url).to.equal('/contact/read/contact-1/');
  });

  it('renders the calls list (screenshot)', async () => {
    await loadStore();
    const list = (await getComponent(
      TAG,
      {
        endpoint: '/test/assets/content-list/calls.json',
        // the host enables log links for viewers who may read them
        'show-logs-after': '2026-05-11T00:00:00Z'
      },
      '',
      1100
    )) as CallList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;
    expect((list as any).cursorMode).to.equal(true);
    await assertScreenshot('content-list/calls', getClip(list));
  });
});
