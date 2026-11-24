import { assert, expect } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { BroadcastList } from '../src/list/BroadcastList';
import { getComponent } from './utils.test';

const TAG = 'temba-broadcast-list';
const getBroadcastList = async (attrs: any = {}, width = 800, height = 0) => {
  return (await getComponent(TAG, attrs, '', width, height)) as BroadcastList;
};

const broadcast = (over: any = {}) => {
  const item = {
    uuid: 'bcast-201',
    status: 'completed',
    text: 'Your appointment is confirmed for tomorrow at 10am.',
    attachments: [],
    quick_replies: [],
    groups: [{ uuid: 'group-1', name: 'Patients' }],
    contacts: [],
    query: null,
    exclusions: [],
    schedule: null,
    msg_count: 1250,
    created_on: '2026-07-14T14:32:00.000000Z',
    created_by: 'admin@textit.com',
    ...over
  };
  return item;
};

const scheduled = (over: any = {}) =>
  broadcast({
    uuid: 'bcast-301',
    status: 'pending',
    msg_count: undefined,
    schedule: {
      repeat_period: 'W',
      display: 'each week on Monday',
      next_fire: '2026-07-20T14:30:00.000000Z'
    },
    ...over
  });

const setItems = async (list: BroadcastList, items: any[]) => {
  (list as any).items = items;
  list.requestUpdate();
  await list.updateComplete;
};

const openDetail = async (list: BroadcastList, item: any) => {
  await setItems(list, [item]);
  const row = list.shadowRoot.querySelector('tr.row') as HTMLElement;
  row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await list.updateComplete;
  return list.shadowRoot.querySelector('temba-dialog') as any;
};

describe('temba-broadcast-list', () => {
  it('can be created', async () => {
    const list: BroadcastList = await getBroadcastList();
    assert.instanceOf(list, BroadcastList);
    // rows key off the broadcast uuid
    expect(list.valueKey).to.equal('uuid');
  });

  it('keeps rows event-only (no row href)', async () => {
    const list: BroadcastList = await getBroadcastList();
    // rows open the in-component detail dialog instead of navigating
    expect((list as any).getRowHref(broadcast())).to.be.null;
  });

  it('swaps trailing columns with the mode', async () => {
    const list: BroadcastList = await getBroadcastList();
    expect(list.columns.map((c) => c.key)).to.deep.equal([
      'message',
      'recipients',
      'messages',
      'created_on'
    ]);
    expect((list as any).getRowIcon(broadcast())).to.equal('announcement-01');

    list.mode = 'scheduled';
    await list.updateComplete;
    expect(list.columns.map((c) => c.key)).to.deep.equal([
      'message',
      'recipients',
      'schedule',
      'next_fire'
    ]);
    expect((list as any).getRowIcon(scheduled())).to.equal('calendar');
  });

  it('renders the message text with attachments and content pills', async () => {
    const list: BroadcastList = await getBroadcastList();
    await setItems(list, [
      broadcast({
        attachments: [
          { content_type: 'image/jpeg', url: '/test/assets/img/meow.jpg' }
        ],
        template: { uuid: 'tpl-1', name: 'order_update' }
      })
    ]);

    const cell = list.shadowRoot.querySelector('.msg-cell') as HTMLElement;
    expect(cell.querySelector('.msg-text').textContent).to.contain(
      'Your appointment is confirmed'
    );
    expect(cell.querySelectorAll('temba-thumbnail')).to.have.length(1);

    // the template pill rides the trailing edge of the cell
    const pills = cell.querySelectorAll('.cell-pills temba-label');
    expect(pills).to.have.length(1);
    expect(pills[0].textContent.trim()).to.equal('order_update');
    expect(pills[0].getAttribute('icon')).to.equal('channel-whatsapp');
  });

  it('renders no text span for a template-only broadcast', async () => {
    const list: BroadcastList = await getBroadcastList();
    await setItems(list, [
      broadcast({ text: '', template: { uuid: 'tpl-1', name: 'order_update' } })
    ]);
    const cell = list.shadowRoot.querySelector('.msg-cell') as HTMLElement;
    expect(cell.querySelector('.msg-text')).to.not.exist;
    expect(cell.textContent).to.contain('order_update');
  });

  it('renders recipient pills for groups, contacts, queries and urns', async () => {
    const list: BroadcastList = await getBroadcastList();
    await setItems(list, [
      broadcast({
        groups: [{ uuid: 'g-1', name: 'Farmers' }],
        contacts: [{ uuid: 'c-1', name: 'Ben Haggerty' }]
      })
    ]);

    let cell = list.shadowRoot.querySelectorAll('tr.row td')[1];
    let pills = cell.querySelectorAll('temba-label');
    expect(pills).to.have.length(2);
    expect(pills[0].getAttribute('type')).to.equal('group');
    expect(pills[0].textContent.trim()).to.equal('Farmers');
    expect(pills[1].getAttribute('type')).to.equal('contact');

    // a query-addressed broadcast renders the query as a search pill
    await setItems(list, [
      broadcast({ groups: [], query: 'age > 18', urns: ['tel:+1234567890'] })
    ]);
    cell = list.shadowRoot.querySelectorAll('tr.row td')[1];
    pills = cell.querySelectorAll('temba-label');
    expect(pills[0].getAttribute('icon')).to.equal('search-refraction');
    expect(pills[0].textContent.trim()).to.equal('age > 18');
    expect(pills[1].textContent.trim()).to.equal('tel:+1234567890');

    // no recipients at all reads as the empty placeholder
    await setItems(list, [broadcast({ groups: [] })]);
    cell = list.shadowRoot.querySelectorAll('tr.row td')[1];
    expect(cell.textContent).to.contain('--');
  });

  it('folds recipients past the cap into a +N summary', async () => {
    const list: BroadcastList = await getBroadcastList();
    await setItems(list, [
      broadcast({
        groups: [
          { uuid: 'g-1', name: 'Farmers' },
          { uuid: 'g-2', name: 'Doctors' },
          { uuid: 'g-3', name: 'Teachers' }
        ],
        contacts: [{ uuid: 'c-1', name: 'Ben Haggerty' }]
      })
    ]);

    const cell = list.shadowRoot.querySelectorAll('tr.row td')[1];
    const pills = cell.querySelectorAll('temba-label');
    // two real pills plus the summary
    expect(pills).to.have.length(3);
    expect(pills[2].textContent.trim()).to.equal('+2');
    expect(pills[2].getAttribute('title')).to.equal('Teachers, Ben Haggerty');
  });

  it('renders the message count, progress or status per state', async () => {
    const list: BroadcastList = await getBroadcastList();
    await setItems(list, [
      broadcast(),
      broadcast({
        uuid: 'bcast-202',
        status: 'started',
        msg_count: 40,
        progress: { total: 100, started: 40 }
      }),
      broadcast({ uuid: 'bcast-203', status: 'queued', msg_count: 0 }),
      broadcast({ uuid: 'bcast-204', status: 'failed', msg_count: 0 }),
      broadcast({ uuid: 'bcast-205', status: 'wobble' })
    ]);

    const rows = list.shadowRoot.querySelectorAll('tr.row');
    // completed → the plain count
    expect(rows[0].querySelectorAll('td')[2].textContent).to.contain('1,250');
    // mid-send with a resolved total → a live progress bar
    const progress = rows[1]
      .querySelectorAll('td')[2]
      .querySelector('temba-progress') as any;
    expect(progress).to.exist;
    expect(progress.total).to.equal(100);
    expect(progress.current).to.equal(40);
    // queued before mailroom resolves the total → the Sending pill
    expect(
      rows[2].querySelectorAll('td')[2].querySelector('.status-pill')
        .textContent
    ).to.contain('Sending');
    expect(
      rows[3].querySelectorAll('td')[2].querySelector('.status-pill')
        .textContent
    ).to.contain('Failed');
    // an unknown status falls back to the empty placeholder
    expect(rows[4].querySelectorAll('td')[2].textContent).to.contain('--');
  });

  it('shows send progress in the detail for an in-flight broadcast', async () => {
    const list: BroadcastList = await getBroadcastList();
    await openDetail(
      list,
      broadcast({
        status: 'started',
        msg_count: 40,
        progress: { total: 100, started: 40 }
      })
    );

    const status = list.shadowRoot.querySelector(
      '.detail-status'
    ) as HTMLElement;
    const progress = status.querySelector('temba-progress') as any;
    expect(progress).to.exist;
    expect(progress.total).to.equal(100);
    expect(progress.current).to.equal(40);
    // the bar replaces the Sending pill
    expect(status.querySelector('.status-pill')).to.not.exist;
    // and renders as a bare meter, no percentage box
    await progress.updateComplete;
    expect(progress.hidePercentage).to.be.true;
    expect(progress.shadowRoot.querySelector('.etc')).to.not.exist;
  });

  it('keeps a moving sliver of bar at 0% so the send reads as live', async () => {
    const list: BroadcastList = await getBroadcastList();
    await setItems(list, [
      broadcast({
        status: 'queued',
        msg_count: 0,
        progress: { total: 310, started: 0 }
      })
    ]);

    const progress = list.shadowRoot.querySelector('temba-progress') as any;
    expect(progress).to.exist;
    await progress.updateComplete;
    const meter = progress.shadowRoot.querySelector('.meter') as HTMLElement;
    // the zero state keeps a min-width sliver whose animated stripes
    // show the send is underway
    expect(meter.classList.contains('zero')).to.be.true;
    expect(
      getComputedStyle(meter.querySelector('span.complete')).minWidth
    ).to.not.equal('0px');
  });

  it('renders the sent date', async () => {
    const list: BroadcastList = await getBroadcastList();
    await setItems(list, [
      broadcast(),
      broadcast({ uuid: 'bcast-202', created_on: '' })
    ]);
    const rows = list.shadowRoot.querySelectorAll('tr.row');
    expect(rows[0].querySelectorAll('td')[3].querySelector('temba-date')).to
      .exist;
    expect(rows[1].querySelectorAll('td')[3].textContent).to.contain('--');
  });

  it('renders the schedule display and next fire', async () => {
    const list: BroadcastList = await getBroadcastList({ mode: 'scheduled' });
    await setItems(list, [
      scheduled(),
      scheduled({
        uuid: 'bcast-302',
        schedule: { repeat_period: 'O', display: 'once', next_fire: null }
      }),
      scheduled({
        uuid: 'bcast-303',
        schedule: {
          repeat_period: 'D',
          display: '',
          next_fire: '2026-08-01T06:00:00.000000Z'
        }
      })
    ]);

    const rows = list.shadowRoot.querySelectorAll('tr.row');
    expect(rows[0].querySelectorAll('td')[2].textContent).to.contain(
      'each week on Monday'
    );
    expect(rows[0].querySelectorAll('td')[3].querySelector('temba-date')).to
      .exist;
    // a paused / exhausted schedule reads as not scheduled
    expect(rows[1].querySelectorAll('td')[2].textContent).to.contain(
      'Not scheduled'
    );
    expect(rows[1].querySelectorAll('td')[3].textContent).to.contain('--');
    // a schedule with no display falls back to the empty placeholder
    expect(rows[2].querySelectorAll('td')[2].textContent).to.contain('--');
  });

  it('opens the detail dialog on row click', async () => {
    const list: BroadcastList = await getBroadcastList();
    const dialog = await openDetail(list, broadcast());

    expect(dialog).to.exist;
    expect(dialog.open).to.be.true;
    // page-like dialog — no colored header bar
    expect(dialog.header).to.not.be.ok;

    const detail = list.shadowRoot.querySelector('.detail') as HTMLElement;
    expect(detail.querySelector('.detail-name').textContent).to.contain(
      'Broadcast'
    );
    // the creator trails the sent date in the header
    const when = detail.querySelector('.detail-subtitle') as HTMLElement;
    expect(when.textContent).to.contain('Sent');
    expect(when.querySelector('temba-date')).to.exist;
    expect(when.textContent).to.contain('by admin@textit.com');
    // the message count sits across from the Recipients section title
    const sectionRow = detail.querySelector('.detail-section-row');
    expect(
      sectionRow.querySelector('.detail-section-title').textContent
    ).to.contain('Recipients');
    expect(sectionRow.querySelector('.detail-count').textContent).to.contain(
      '1,250 messages'
    );
    // the status pill sits in the header, just left of the close
    const headerPill = detail.querySelector('.detail-header .status-pill');
    expect(headerPill.textContent).to.contain('Sent');
    expect(headerPill.nextElementSibling.classList.contains('detail-close')).to
      .be.true;
    // with the count in the header, no status row renders in the body
    expect(detail.querySelector('.detail-status-row')).to.not.exist;
  });

  it('navigates from recipient pills without opening the dialog', async () => {
    const list: BroadcastList = await getBroadcastList();
    await setItems(list, [broadcast()]);

    const redirects: any[] = [];
    list.addEventListener(CustomEventType.Redirected, (e: any) =>
      redirects.push(e.detail)
    );

    const pill = list.shadowRoot.querySelector(
      'temba-label[type="group"]'
    ) as HTMLElement;
    pill.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true })
    );
    await list.updateComplete;

    expect(redirects).to.have.length(1);
    expect(redirects[0].url).to.equal('/contact/group/group-1/');
    // the pill click must not fall through to the row's dialog
    expect((list as any).detailItem).to.be.null;
  });

  it('closes the dialog when a recipient pill inside it is clicked', async () => {
    const list: BroadcastList = await getBroadcastList();
    await openDetail(
      list,
      broadcast({ contacts: [{ uuid: 'c-1', name: 'Ben Haggerty' }] })
    );

    const redirects: any[] = [];
    list.addEventListener(CustomEventType.Redirected, (e: any) =>
      redirects.push(e.detail)
    );

    const pill = list.shadowRoot.querySelector(
      '.detail-body temba-label[type="contact"]'
    ) as HTMLElement;
    pill.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true })
    );
    await list.updateComplete;

    // navigating away — the dialog closes behind the redirect
    expect(redirects).to.have.length(1);
    expect(redirects[0].url).to.equal('/contact/read/c-1/');
    expect((list as any).detailItem).to.be.null;
  });

  it('refuses unsafe pill hrefs and honors meta-click', async () => {
    const list: BroadcastList = await getBroadcastList();
    const redirects: any[] = [];
    list.addEventListener(CustomEventType.Redirected, (e: any) =>
      redirects.push(e.detail)
    );

    // unsafe href — swallowed, no redirect
    const event: any = {
      metaKey: false,
      ctrlKey: false,
      stopPropagation: () => (event.stopped = true)
    };
    (list as any).handlePillClick('//evil.com/x', event);
    expect(event.stopped).to.be.true;
    expect(redirects).to.have.length(0);

    // meta-click — new tab, no in-app redirect, dialog untouched
    (list as any).detailItem = broadcast();
    const opened: string[] = [];
    const realOpen = window.open;
    (window as any).open = (url: string) => opened.push(url);
    try {
      (list as any).handlePillClick('/contact/group/g-1/', {
        metaKey: true,
        ctrlKey: false,
        stopPropagation: () => null
      });
    } finally {
      window.open = realOpen;
    }
    expect(opened).to.deep.equal(['/contact/group/g-1/']);
    expect(redirects).to.have.length(0);
    expect((list as any).detailItem).to.not.be.null;
  });

  it('details the full message: attachments, quick replies, exclusions', async () => {
    const list: BroadcastList = await getBroadcastList();
    await openDetail(
      list,
      broadcast({
        attachments: [
          { content_type: 'image/jpeg', url: '/test/assets/img/meow.jpg' }
        ],
        // server sends engine {text} objects; plain strings are legacy
        quick_replies: [{ text: 'Confirm' }, 'Change', { type: 'location' }],
        exclusions: ['Skip contacts in a flow'],
        contacts: [{ uuid: 'c-1', name: 'Ben Haggerty' }]
      })
    );

    const detail = list.shadowRoot.querySelector('.detail') as HTMLElement;
    const message = detail.querySelector('.detail-message') as HTMLElement;
    expect(message.querySelector('temba-expression-highlight')).to.exist;
    expect(
      message.querySelectorAll('.detail-attachments temba-thumbnail')
    ).to.have.length(1);
    const replies = message.querySelectorAll('.detail-pills temba-label');
    expect(replies).to.have.length(3);
    expect(replies[0].textContent.trim()).to.equal('Confirm');
    expect(replies[1].textContent.trim()).to.equal('Change');
    expect(replies[2].textContent.trim()).to.equal('location');

    // recipients render un-capped in the detail, with exclusions below
    const recipients = detail.querySelectorAll(
      '.detail-body > .detail-pills temba-label'
    );
    expect(recipients).to.have.length(2);
    expect(detail.querySelector('.detail-exclusions').textContent).to.contain(
      'Skip contacts in a flow'
    );
  });

  it('details the schedule for a scheduled broadcast', async () => {
    const list: BroadcastList = await getBroadcastList({ mode: 'scheduled' });
    const dialog = await openDetail(list, scheduled());
    expect(dialog.open).to.be.true;

    const detail = list.shadowRoot.querySelector('.detail') as HTMLElement;
    expect(detail.querySelector('.detail-name').textContent).to.contain(
      'Scheduled Broadcast'
    );
    const status = detail.querySelector('.detail-status') as HTMLElement;
    expect(status.textContent).to.contain('each week on Monday');
    expect(status.textContent).to.contain('starting');
    expect(status.querySelector('temba-date')).to.exist;
    // no message count on a broadcast that hasn't sent anything
    expect(detail.querySelector('.detail-count')).to.not.exist;
    // no edit/delete without the permission flags
    expect(detail.querySelector('.detail-actions')).to.not.exist;
  });

  it('reads not-scheduled for an exhausted schedule', async () => {
    const list: BroadcastList = await getBroadcastList({ mode: 'scheduled' });
    await openDetail(
      list,
      scheduled({
        schedule: { repeat_period: 'O', display: 'once', next_fire: null }
      })
    );
    const status = list.shadowRoot.querySelector(
      '.detail-status'
    ) as HTMLElement;
    expect(status.textContent).to.contain('Not scheduled');
  });

  it('closes the detail dialog and can reopen it', async () => {
    const list: BroadcastList = await getBroadcastList();
    const dialog = await openDetail(list, broadcast());
    expect(dialog.open).to.be.true;

    // the header's ✕ closes the dialog
    (
      list.shadowRoot.querySelector(
        '.detail-header .detail-close'
      ) as HTMLElement
    ).click();
    await list.updateComplete;
    expect((list as any).detailItem).to.be.null;
    expect((list.shadowRoot.querySelector('temba-dialog') as any).open).to.not
      .be.true;

    // reopening the same row works — the open state fully reset
    const row = list.shadowRoot.querySelector('tr.row') as HTMLElement;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;
    expect((list.shadowRoot.querySelector('temba-dialog') as any).open).to.be
      .true;

    // the dialog also hides itself (mask click) and tells us after
    dialog.dispatchEvent(new CustomEvent('temba-dialog-hidden'));
    await list.updateComplete;
    expect((list as any).detailItem).to.be.null;
  });

  it('closes on escape', async () => {
    const list: BroadcastList = await getBroadcastList();
    const dialog = await openDetail(list, broadcast());
    dialog.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })
    );
    await list.updateComplete;
    expect((list as any).detailItem).to.be.null;
  });

  it('fires selection events for edit and delete', async () => {
    const list: BroadcastList = await getBroadcastList({
      mode: 'scheduled',
      'can-edit': true,
      'can-delete': true
    });
    await openDetail(list, scheduled());

    const fired: any[] = [];
    list.addEventListener(CustomEventType.Selection, (e: any) =>
      fired.push(e.detail)
    );

    const detail = list.shadowRoot.querySelector('.detail') as HTMLElement;
    const buttons = detail.querySelectorAll('.detail-actions .menu-button');
    expect(buttons).to.have.length(2);

    // edit closes the dialog before the host opens its modal
    (buttons[0] as HTMLElement).click();
    await list.updateComplete;
    expect(fired).to.have.length(1);
    expect(fired[0].action).to.equal('edit_broadcast');
    expect(fired[0].broadcast.uuid).to.equal('bcast-301');
    expect((list as any).detailItem).to.be.null;

    // reopen and delete
    const row = list.shadowRoot.querySelector('tr.row') as HTMLElement;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;
    const deleteButton = list.shadowRoot.querySelector(
      '.detail-actions .menu-button.destructive'
    ) as HTMLElement;
    deleteButton.click();
    await list.updateComplete;
    expect(fired).to.have.length(2);
    expect(fired[1].action).to.equal('delete_broadcast');
  });

  it('gates the detail actions on the permission flags', async () => {
    // sent mode never shows edit/delete, even with the flags
    const list: BroadcastList = await getBroadcastList({
      'can-edit': true,
      'can-delete': true
    });
    await openDetail(list, broadcast());
    expect(list.shadowRoot.querySelector('.detail-actions')).to.not.exist;

    // scheduled mode with only edit shows just the one action
    const editOnly: BroadcastList = await getBroadcastList({
      mode: 'scheduled',
      'can-edit': true
    });
    await openDetail(editOnly, scheduled());
    const buttons = editOnly.shadowRoot.querySelectorAll(
      '.detail-actions .menu-button'
    );
    expect(buttons).to.have.length(1);
    expect(buttons[0].textContent).to.contain('Edit');
  });
});
