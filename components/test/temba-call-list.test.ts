import { assert, expect } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { CallList } from '../src/list/CallList';
import { formatDuration } from '../src/utils';
import {
  assertScreenshot,
  getClip,
  getComponent,
  loadStore,
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
  status_display: 'Complete',
  contact: { uuid: 'contact-1', name: 'Bob' },
  duration: 75,
  created_on: '2026-05-11T09:12:00.000000Z',
  logs_url: null,
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
        status_display: 'Errored (No Answer)',
        duration: 0,
        logs_url: '/channels/channel/logs/chan-1/call/call-2/'
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
    // no log link without a logs_url
    expect(rows[0].querySelector('.call-log')).to.not.exist;

    const pill2 = rows[1].querySelector('.status-pill') as HTMLElement;
    expect(pill2.textContent.trim()).to.equal('Errored (No Answer)');
    expect(pill2.classList.contains('status-warning')).to.be.true;
    expect(rows[1].querySelector('.duration').textContent.trim()).to.equal(
      '0:00'
    );
    const log = rows[1].querySelector('.call-log') as HTMLAnchorElement;
    expect(log).to.exist;
    expect(log.getAttribute('href')).to.equal(
      '/channels/channel/logs/chan-1/call/call-2/'
    );
  });

  it('navigates to the contact on row click but not on the log link', async () => {
    const list: CallList = await getCallList();
    await renderRows(list, [
      call({ logs_url: '/channels/channel/logs/chan-1/call/call-1/' })
    ]);

    const redirects: any[] = [];
    list.addEventListener(CustomEventType.Redirected, (e: any) =>
      redirects.push(e.detail)
    );

    const log = list.shadowRoot.querySelector('.call-log') as HTMLElement;
    // keep the test page from actually following the link
    log.addEventListener('click', (e: Event) => e.preventDefault());
    log.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        composed: true,
        cancelable: true
      })
    );
    expect(redirects, 'log link click stays on the link').to.have.length(0);

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
      { endpoint: '/test-assets/content-list/calls.json' },
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
