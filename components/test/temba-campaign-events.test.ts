import { assert, expect } from '@open-wc/testing';
import { CampaignEvents } from '../src/live/CampaignEvents';
import {
  clearMockGets,
  getComponent,
  loadStore,
  mockGET,
  waitForCondition
} from './utils.test';

const TAG = 'temba-campaign-events';

// two fields, so the schedule renders as two subway lines: a "Due Date" line
// with an event before and an event after the anchor, and a "Last Visit"
// line with a single flow event still scheduling
const EVENTS = {
  campaign: { uuid: 'camp-1', name: 'Prenatal Care' },
  can_edit: true,
  can_delete: true,
  events: [
    {
      uuid: 'event-1',
      type: 'message',
      status: 'ready',
      offset: -3,
      unit: 'D',
      offset_display: '3 days before',
      relative_to: { key: 'due_date', name: 'Due Date' },
      message: 'Your delivery is coming up, @fields.due_date is close!',
      count: 120,
      edit_url: '/campaignevent/update/event-1/',
      delete_url: '/campaignevent/delete/event-1/',
      fires_url: '/campaignevent/fires/event-1/'
    },
    {
      uuid: 'event-2',
      type: 'flow',
      status: 'ready',
      offset: 2,
      unit: 'W',
      offset_display: '2 weeks after',
      delivery_hour_display: 'at 9:00 a.m.',
      relative_to: { key: 'due_date', name: 'Due Date' },
      flow: { uuid: 'flow-1', name: 'Followup', url: '/flow/editor/flow-1/' },
      count: 88,
      edit_url: '/campaignevent/update/event-2/',
      delete_url: '/campaignevent/delete/event-2/',
      fires_url: '/campaignevent/fires/event-2/'
    },
    {
      uuid: 'event-3',
      type: 'flow',
      status: 'scheduling',
      offset: 0,
      unit: 'D',
      offset_display: 'on',
      relative_to: { key: 'last_visit', name: 'Last Visit', system: true },
      flow: { uuid: 'flow-2', name: 'Checkin', url: '/flow/editor/flow-2/' },
      count: 0,
      edit_url: '/campaignevent/update/event-3/',
      delete_url: '/campaignevent/delete/event-3/',
      fires_url: '/campaignevent/fires/event-3/'
    }
  ]
};

const getEvents = async (data: any = EVENTS): Promise<CampaignEvents> => {
  mockGET(/campaign\/events\//, data);

  const events = (await getComponent(
    TAG,
    { campaign: 'camp-1' },
    '',
    600
  )) as CampaignEvents;

  await waitForCondition(() => !!events.data);
  await events.updateComplete;
  return events;
};

describe(TAG, () => {
  beforeEach(() => {
    clearMockGets();
  });

  it('renders the page header and card when a title is set', async () => {
    await loadStore();
    mockGET(/campaign\/events\//, EVENTS);

    const events = (await getComponent(
      TAG,
      { campaign: 'camp-1', 'header-title': 'Prenatal Care' },
      '',
      600
    )) as CampaignEvents;
    await waitForCondition(() => !!events.data);
    await events.updateComplete;

    const root = events.shadowRoot;

    // the header is a flush bar above the per-field cards
    expect(root.querySelector('.header-panel')).to.not.equal(null);

    const header = root.querySelector('.header-panel temba-page-header');
    expect(header).to.not.equal(null);
    // the title is forwarded into the header as slot fallback content
    expect(header.querySelector('[slot="title"]').textContent).to.contain(
      'Prenatal Care'
    );
  });

  it('omits the page header without a title or menu', async () => {
    await loadStore();
    const events = await getEvents();

    expect(events.shadowRoot.querySelector('temba-page-header')).to.equal(null);
    expect(events.shadowRoot.querySelector('.panel')).to.not.equal(null);
  });

  it('renders one card per relative-to field', async () => {
    await loadStore();
    const events = await getEvents();
    assert.instanceOf(events, CampaignEvents);

    const root = events.shadowRoot;
    // each field's line is its own card
    expect(root.querySelectorAll('.panel.section').length).to.equal(2);

    // each section carries its field's anchor dot and pill; system fields
    // (Last Visit here) get the dashed muted pill instead of the field pill
    expect(root.querySelectorAll('.dot.anchor').length).to.equal(2);
    const pills = Array.from(root.querySelectorAll('.anchor-label')).map((p) =>
      p.textContent.trim()
    );
    expect(pills).to.deep.equal(['Due Date', 'Last Visit']);
    expect(
      root.querySelector('.anchor-label temba-label').textContent
    ).to.contain('Due Date');
    expect(
      root.querySelector('.anchor-label .system-pill').textContent
    ).to.contain('Last Visit');

    // three event dots in total, on either side of their anchors
    expect(root.querySelectorAll('.dot:not(.anchor)').length).to.equal(3);
  });

  it('splits events around the anchor by offset', async () => {
    await loadStore();
    const events = await getEvents();

    const section = events.shadowRoot.querySelector('.section');
    const rows = Array.from(section.querySelectorAll('.row'));
    expect(rows.length).to.equal(3);

    // before-event, then the anchor, then the after-event
    expect(rows[0].textContent).to.contain('3 days before');
    expect(rows[1].querySelector('.dot.anchor')).to.not.equal(null);
    expect(rows[2].textContent).to.contain('2 weeks after');
  });

  it('assigns each field line its own color', async () => {
    await loadStore();
    const events = await getEvents();

    const sections = events.shadowRoot.querySelectorAll('.section');
    const colorOf = (section: Element) =>
      section.querySelector('.dot').getAttribute('style');
    expect(colorOf(sections[0])).to.not.equal(colorOf(sections[1]));
  });

  it('syntax highlights expressions in message events', async () => {
    await loadStore();
    const events = await getEvents();

    const highlight = events.shadowRoot.querySelector(
      '.title-text temba-expression-highlight'
    ) as any;
    expect(highlight).to.not.equal(null);
    expect(highlight.textContent).to.contain('@fields.due_date');

    await highlight.updateComplete;
    const identifier = highlight.shadowRoot.querySelector('.tok-id');
    expect(identifier).to.not.equal(null);
    expect(identifier.textContent).to.contain('fields.due_date');
  });

  it('shows the scheduled count inside the selectable event outline', async () => {
    await loadStore();
    const events = await getEvents();

    const counts = Array.from(
      events.shadowRoot.querySelectorAll('.event .count')
    );
    expect(counts.length).to.equal(3);
    expect(counts[0].textContent).to.contain('120');
    expect(counts[2].textContent).to.contain('Scheduling');
  });

  it('surfaces the delivery hour as a tip on the offset', async () => {
    await loadStore();
    const events = await getEvents();

    const tip = events.shadowRoot.querySelector('.time temba-tip');
    expect(tip).to.not.equal(null);
    expect(tip.getAttribute('text')).to.equal('at 9:00 a.m.');
  });

  it('renders an empty state when there are no events', async () => {
    await loadStore();
    const events = await getEvents({ events: [] });

    const empty = events.shadowRoot.querySelector('.empty');
    expect(empty).to.not.equal(null);
    expect(events.shadowRoot.querySelector('.events')).to.equal(null);
    expect(empty.querySelector('.empty-help')).to.not.equal(null);
  });

  it('opens a detail modal when an event row is clicked', async () => {
    await loadStore();
    mockGET(/campaignevent\/fires\//, {
      fires: [
        {
          contact: {
            uuid: 'contact-1',
            name: 'Ann',
            url: '/contact/read/contact-1/'
          },
          time: '2024-06-01T12:00:00+00:00',
          skipped: false
        },
        {
          contact: {
            uuid: 'contact-2',
            name: 'Bob',
            url: '/contact/read/contact-2/'
          },
          time: '2024-06-01T11:00:00+00:00',
          skipped: true
        }
      ]
    });
    const events = await getEvents();

    const entry = events.shadowRoot.querySelector(
      '.event.clickable'
    ) as HTMLElement;
    entry.click();
    await waitForCondition(() => (events as any).fires !== null);
    await events.updateComplete;

    const dialog = events.shadowRoot.querySelector('temba-dialog') as any;
    expect(dialog.open).to.equal(true);

    // page-like: no colored dialog header, our own title row instead with
    // a separating rule and a close (✕) in its upper right
    expect(dialog.header).to.not.be.ok;
    expect(
      events.shadowRoot.querySelector('.detail-header .detail-close')
    ).to.not.equal(null);
    const detail = events.shadowRoot.querySelector('.detail');
    // the campaign is the title so the modal carries context on any page,
    // with the schedule as the subtitle
    expect(detail.querySelector('.detail-name').textContent).to.contain(
      'Prenatal Care'
    );
    // the schedule leads the body with the labeled count on its right
    const schedule = detail.querySelector('.detail-schedule');
    expect(schedule.textContent).to.contain('3 days before');
    expect(schedule.querySelector('temba-label').textContent).to.contain(
      'Due Date'
    );
    const count = detail.querySelector('.detail-count');
    expect(count.textContent).to.contain('120');
    expect(count.textContent).to.contain('scheduled');
    // the action is contained with a leading type label
    const action = detail.querySelector('.detail-action');
    expect(action.textContent).to.contain('Send Message');
    expect(action.textContent).to.contain('Your delivery is coming up');

    // the recent contacts render inline in the detail
    const rows = detail.querySelectorAll('.fire-row');
    expect(rows.length).to.equal(2);
    const row = rows[0] as HTMLElement;
    expect(row.textContent).to.contain('Ann');
    expect(row.querySelector('.fire-skipped')).to.equal(null);

    // contacts the event was skipped for are labeled as such
    expect(rows[1].classList.contains('skipped')).to.equal(true);
    expect(rows[1].querySelector('.fire-skipped').textContent).to.contain(
      'Skipped'
    );

    // clicking a contact closes the modal and navigates to them
    let selected: any = null;
    events.addEventListener('temba-selection', (e: CustomEvent) => {
      selected = e.detail;
    });
    row.click();

    expect(selected).to.not.equal(null);
    expect(selected.url).to.equal('/contact/read/contact-1/');
    await events.updateComplete;
    expect(dialog.open).to.equal(false);
  });

  it('opens the edit modal from the detail, closing it first', async () => {
    await loadStore();
    mockGET(/campaignevent\/fires\//, { fires: [] });
    const events = await getEvents();

    let selected: any = null;
    events.addEventListener('temba-selection', (e: CustomEvent) => {
      selected = e.detail;
    });

    (
      events.shadowRoot.querySelector('.event.clickable') as HTMLElement
    ).click();
    await events.updateComplete;

    const edit = events.shadowRoot.querySelector(
      '.detail-actions .menu-button:not(.destructive)'
    ) as HTMLElement;
    expect(edit).to.not.equal(null);
    edit.click();
    await events.updateComplete;

    // the detail modal closes before the host opens the edit modal
    expect(selected).to.not.equal(null);
    expect(selected.action).to.equal('edit_event');
    expect(selected.event.uuid).to.equal('event-1');
    expect(selected.event.edit_url).to.equal('/campaignevent/update/event-1/');
    expect(
      (events.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.equal(false);
  });

  it('opens the delete modal from the detail, closing it first', async () => {
    await loadStore();
    mockGET(/campaignevent\/fires\//, { fires: [] });
    const events = await getEvents();

    let selected: any = null;
    events.addEventListener('temba-selection', (e: CustomEvent) => {
      selected = e.detail;
    });

    (
      events.shadowRoot.querySelector('.event.clickable') as HTMLElement
    ).click();
    await events.updateComplete;

    const trash = events.shadowRoot.querySelector(
      '.detail-actions .menu-button.destructive'
    ) as HTMLElement;
    expect(trash).to.not.equal(null);
    trash.click();
    await events.updateComplete;

    expect(selected).to.not.equal(null);
    expect(selected.action).to.equal('delete_event');
    expect(selected.event.delete_url).to.equal(
      '/campaignevent/delete/event-1/'
    );
    expect(
      (events.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.equal(false);
  });

  it('locks editing for scheduling events', async () => {
    await loadStore();
    mockGET(/campaignevent\/fires\//, { fires: [] });
    const events = await getEvents();

    // open the scheduling event (last row) - it can be deleted but not edited
    const rows = events.shadowRoot.querySelectorAll('.event.clickable');
    (rows[rows.length - 1] as HTMLElement).click();
    await events.updateComplete;

    const detail = events.shadowRoot.querySelector('.detail');
    expect(detail.textContent).to.contain('Scheduling');

    // an offset-0 event leads its schedule with a capitalized "On", and a
    // system anchor field renders the dashed pill in the modal too
    const schedule = detail.querySelector('.detail-schedule');
    expect(schedule.querySelector('span').textContent.trim()).to.equal('On');
    expect(schedule.querySelector('.system-pill').textContent).to.contain(
      'Last Visit'
    );
    expect(
      detail.querySelector('.detail-actions .menu-button.destructive')
    ).to.not.equal(null);
    expect(
      detail.querySelector('.detail-actions .menu-button:not(.destructive)')
    ).to.equal(null);
  });

  it('hides detail actions for permission-less viewers', async () => {
    await loadStore();
    mockGET(/campaignevent\/fires\//, { fires: [] });
    const locked = await getEvents({
      ...EVENTS,
      can_edit: false,
      can_delete: false
    });

    // rows still open the detail, but it offers no actions
    (
      locked.shadowRoot.querySelector('.event.clickable') as HTMLElement
    ).click();
    await locked.updateComplete;

    expect(locked.shadowRoot.querySelector('.detail')).to.not.equal(null);
    expect(locked.shadowRoot.querySelector('.menu-button')).to.equal(null);

    // with no recent contacts the section is omitted entirely
    expect(
      locked.shadowRoot.querySelector('.detail').textContent
    ).to.not.contain('Recent Contacts');
  });

  it('reopens the detail modal after an ✕ close', async () => {
    await loadStore();
    mockGET(/campaignevent\/fires\//, { fires: [] });
    const events = await getEvents();

    const entry = events.shadowRoot.querySelector(
      '.event.clickable'
    ) as HTMLElement;
    const dialog = events.shadowRoot.querySelector('temba-dialog') as any;

    entry.click();
    await events.updateComplete;
    expect(dialog.open).to.equal(true);

    // these page-like modals close from the header's ✕
    (
      events.shadowRoot.querySelector(
        '.detail-header .detail-close'
      ) as HTMLElement
    ).click();
    await events.updateComplete;
    expect(dialog.open).to.equal(false);

    entry.click();
    await events.updateComplete;
    expect(dialog.open).to.equal(true);
  });

  it('closes the detail modal on Escape', async () => {
    await loadStore();
    mockGET(/campaignevent\/fires\//, { fires: [] });
    const events = await getEvents();

    const dialog = events.shadowRoot.querySelector('temba-dialog') as any;
    (
      events.shadowRoot.querySelector('.event.clickable') as HTMLElement
    ).click();
    await events.updateComplete;
    expect(dialog.open).to.equal(true);

    // with no dialog buttons the component itself handles Escape
    dialog.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Escape', bubbles: true })
    );
    await events.updateComplete;
    expect(dialog.open).to.equal(false);
  });

  it('closes the detail modal on a mask click', async () => {
    await loadStore();
    mockGET(/campaignevent\/fires\//, { fires: [] });
    const events = await getEvents();

    const dialog = events.shadowRoot.querySelector('temba-dialog') as any;
    (
      events.shadowRoot.querySelector('.event.clickable') as HTMLElement
    ).click();
    await events.updateComplete;
    expect(dialog.open).to.equal(true);

    // with no cancel button the dialog's own clickCancel is a no-op - the
    // close relies on the component handling temba-dialog-hidden
    (dialog.shadowRoot.querySelector('#dialog-mask') as HTMLElement).click();
    await events.updateComplete;
    expect(dialog.open).to.equal(false);
  });

  it('renders slotted badges in their own row', async () => {
    await loadStore();
    mockGET(/campaign\/events\//, EVENTS);

    const events = (await getComponent(
      TAG,
      { campaign: 'camp-1' },
      '<div slot="badges"><temba-label>Doctors</temba-label></div>',
      600
    )) as CampaignEvents;
    await waitForCondition(() => !!events.data);
    await events.updateComplete;

    const badges = events.shadowRoot.querySelector('.badges');
    expect(badges).to.not.equal(null);
  });

  it('activates a clickable event row via the Enter key', async () => {
    await loadStore();
    const events = await getEvents();

    let selected: any = null;
    events.addEventListener('temba-selection', (e: CustomEvent) => {
      selected = e.detail;
    });

    const entry = events.shadowRoot.querySelector(
      '.event.clickable'
    ) as HTMLElement;
    entry.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await events.updateComplete;

    // the row opens the detail modal rather than firing a selection
    expect(selected).to.equal(null);
    expect(
      (events.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.equal(true);
  });

  it('fires selection with the flow when a flow pill is clicked', async () => {
    await loadStore();
    const events = await getEvents();

    let selected: any = null;
    events.addEventListener('temba-selection', (e: CustomEvent) => {
      selected = e.detail;
    });

    const pill = events.shadowRoot.querySelector(
      'temba-label[type="flow"]'
    ) as HTMLElement;
    expect(pill).to.not.equal(null);
    pill.click();

    // the pill's selection carries the flow, not the row's event
    expect(selected).to.not.equal(null);
    expect(selected.uuid).to.equal('flow-1');
    expect(selected.url).to.equal('/flow/editor/flow-1/');
  });

  it('fires details-changed with the event count', async () => {
    await loadStore();

    let detail: any = null;
    const handler = (e: CustomEvent) => {
      detail = e.detail;
    };
    document.addEventListener('temba-details-changed', handler);

    try {
      await getEvents();
      expect(detail).to.not.equal(null);
      expect(detail.count).to.equal(3);
    } finally {
      document.removeEventListener('temba-details-changed', handler);
    }
  });
});
