import { fixture, assert } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { TicketList } from '../src/list/TicketList';
import {
  assertScreenshot,
  getClip,
  getComponent,
  loadStore,
  mockGET,
  mockNow
} from './utils.test';

export const getHTML = () => {
  return `<temba-ticket-list></temba-ticket-list>`;
};

const getList = async (endpoint: string) => {
  const list = (await getComponent(
    'temba-ticket-list',
    { endpoint },
    '',
    300,
    600
  )) as TicketList;
  await new Promise<void>((resolve) => {
    list.addEventListener(
      CustomEventType.FetchComplete,
      () => {
        resolve();
      },
      { once: true }
    );
  });
  await list.updateComplete;
  return list;
};

const openTicket = (uuid: string, lastActivity: string) => {
  return {
    name: 'Contact',
    ticket: { uuid, last_activity_on: lastActivity, closed_on: null }
  };
};

const closedTicket = (uuid: string, lastActivity: string) => {
  return {
    name: 'Contact',
    ticket: {
      uuid,
      last_activity_on: lastActivity,
      closed_on: lastActivity
    }
  };
};

// uuids of the tickets in test/assets/list/tickets-merged.json, in the order
// the fixture serves them (three open, then three closed)
const MERGED = [
  'a1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000002',
  'a1000000-0000-0000-0000-000000000003',
  'a1000000-0000-0000-0000-000000000004',
  'a1000000-0000-0000-0000-000000000005',
  'a1000000-0000-0000-0000-000000000006'
];

const ticketUuids = (list: TicketList) => {
  return list.items.map((item: any) => item.ticket.uuid);
};

const mockAgents = () => {
  mockGET(/\/api\/v2\/users\.json\?uuid=/, {
    results: [
      {
        uuid: 'u1000000-0000-0000-0000-000000000001',
        email: 'agent1@nyaruka.com',
        first_name: 'Agnes',
        last_name: 'McAgent',
        avatar: null
      }
    ]
  });
};

describe('temba-ticket-list', () => {
  it('can be created', async () => {
    const tickets: TicketList = await fixture(getHTML());
    assert.instanceOf(tickets, TicketList);
  });

  it('sorts open tickets above closed tickets', async () => {
    const tickets: TicketList = await fixture(getHTML());
    const items = [
      closedTicket('c1', '2024-01-04T00:00:00.000Z'),
      openTicket('o1', '2024-01-01T00:00:00.000Z'),
      closedTicket('c2', '2024-01-02T00:00:00.000Z'),
      openTicket('o2', '2024-01-03T00:00:00.000Z')
    ];

    items.sort((tickets as any).compareItems);
    assert.deepEqual(
      items.map((item) => item.ticket.uuid),
      ['o2', 'o1', 'c1', 'c2']
    );
  });

  it('shows an empty message when there are no tickets', async () => {
    await loadStore();
    const list = await getList('/test/assets/list/tickets-empty.json');
    assert.equal(list.items.length, 0);

    const options = list.shadowRoot.querySelector('temba-options');
    await (options as any).updateComplete;
    const empty = options.shadowRoot.querySelector('.no-options');
    assert.equal(empty.textContent.trim(), 'No tickets');
    await assertScreenshot('list/tickets-empty', getClip(list));
  });

  it('separates closed tickets with a divider', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList('/test/assets/list/tickets-merged.json');
    assert.equal(list.items.length, 6);

    await assertScreenshot('list/tickets-merged', getClip(list));

    // selecting a closed ticket gets the standard selection treatment
    list.cursorIndex = 4;
    await list.updateComplete;
    await assertScreenshot('list/tickets-merged-selected', getClip(list));
    now.restore();
  });

  it('moves a newly closed ticket below the open ones on refresh', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList('/test/assets/list/tickets-merged.json');
    assert.deepEqual(ticketUuids(list), MERGED);

    // the poll returns the second (open) ticket, now closed
    mockGET(/tickets-merged\.json\?after=/, {
      results: [
        {
          uuid: 'c1000000-0000-0000-0000-000000000002',
          name: 'Ben Haggerty',
          last_seen_on: '2024-05-01T08:00:00.000000Z',
          last_msg: null,
          ticket: {
            uuid: MERGED[1],
            assignee: null,
            topic: {
              uuid: 'b1000000-0000-0000-0000-000000000001',
              name: 'General'
            },
            last_activity_on: '2024-05-01T11:00:00.000000Z',
            closed_on: '2024-05-01T11:00:00.000000Z'
          }
        }
      ]
    });

    const refreshed = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.Refreshed, () => resolve(), {
        once: true
      });
    });

    list.refreshKey = 'test';
    await refreshed;
    await list.updateComplete;

    // the ticket was merged in place (not duplicated) and dropped below the
    // remaining open tickets, at the top of the closed ones
    assert.deepEqual(ticketUuids(list), [
      MERGED[0],
      MERGED[2],
      MERGED[1],
      MERGED[3],
      MERGED[4],
      MERGED[5]
    ]);
    now.restore();
  });

  it('keeps appended pages in sort order', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList('/test/assets/list/tickets-merged.json');

    // the next page has an older open ticket, which belongs above the closed
    // ones we already have loaded
    const appended = 'a1000000-0000-0000-0000-000000000007';
    mockGET(/tickets-merged-page2\.json/, {
      results: [
        {
          uuid: 'c1000000-0000-0000-0000-000000000007',
          name: 'Grace Wanjiru',
          last_seen_on: '2024-04-28T09:00:00.000000Z',
          last_msg: null,
          ticket: {
            uuid: appended,
            assignee: null,
            topic: {
              uuid: 'b1000000-0000-0000-0000-000000000001',
              name: 'General'
            },
            last_activity_on: '2024-04-28T09:00:00.000000Z',
            closed_on: null
          }
        }
      ]
    });

    const fetched = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });

    list.nextPage = '/test/assets/list/tickets-merged-page2.json';
    const options = list.shadowRoot.querySelector('temba-options') as any;
    options.fireCustomEvent(CustomEventType.ScrollThreshold);

    await fetched;
    await list.updateComplete;

    assert.deepEqual(ticketUuids(list), [
      MERGED[0],
      MERGED[1],
      MERGED[2],
      appended,
      MERGED[3],
      MERGED[4],
      MERGED[5]
    ]);
    now.restore();
  });

  it('keeps the selection pinned when an appended page sorts above it', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList('/test/assets/list/tickets-merged.json');

    // select a closed ticket, the second one in the closed block
    list.setSelection(MERGED[4]);
    await list.updateComplete;
    assert.equal(list.cursorIndex, 4);

    // the next page has an open ticket, which sorts above every closed one we
    // already have loaded, plus a ticket we already have
    // note the distinct page, mocked gets are matched first-registered-wins and
    // are never cleared between tests
    const appended = 'a1000000-0000-0000-0000-000000000007';
    mockGET(/tickets-merged-page3\.json/, {
      results: [
        {
          uuid: 'c1000000-0000-0000-0000-000000000007',
          name: 'Grace Wanjiru',
          last_seen_on: '2024-04-28T09:00:00.000000Z',
          last_msg: null,
          ticket: {
            uuid: appended,
            assignee: null,
            topic: {
              uuid: 'b1000000-0000-0000-0000-000000000001',
              name: 'General'
            },
            last_activity_on: '2024-04-28T09:00:00.000000Z',
            closed_on: null
          }
        },
        {
          uuid: 'c1000000-0000-0000-0000-000000000006',
          name: 'Femi Adeyemi',
          last_seen_on: '2024-04-18T11:05:00.000000Z',
          last_msg: null,
          ticket: {
            uuid: MERGED[5],
            assignee: null,
            topic: {
              uuid: 'b1000000-0000-0000-0000-000000000001',
              name: 'General'
            },
            last_activity_on: '2024-04-18T11:05:00.000000Z',
            closed_on: '2024-04-18T11:05:00.000000Z'
          }
        }
      ]
    });

    const fetched = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });

    list.nextPage = '/test/assets/list/tickets-merged-page3.json';
    const options = list.shadowRoot.querySelector('temba-options') as any;
    options.fireCustomEvent(CustomEventType.ScrollThreshold);

    await fetched;
    await list.updateComplete;

    // the already loaded ticket wasn't appended a second time
    const uuids = ticketUuids(list);
    assert.deepEqual(uuids, [
      MERGED[0],
      MERGED[1],
      MERGED[2],
      appended,
      MERGED[3],
      MERGED[4],
      MERGED[5]
    ]);
    assert.equal(new Set(uuids).size, uuids.length);

    // the new open ticket pushed our selection down a row, but we stayed on it
    assert.equal(list.getSelection().ticket.uuid, MERGED[4]);
    assert.equal(list.cursorIndex, 5);
    assert.equal(list.items[list.cursorIndex].ticket.uuid, MERGED[4]);
    now.restore();
  });

  it('recovers from a failed page fetch', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList('/test/assets/list/tickets-merged.json');

    mockGET(/tickets-merged-page4\.json/, {}, {}, '500');

    const fetched = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });

    list.nextPage = '/test/assets/list/tickets-merged-page4.json';
    const options = list.shadowRoot.querySelector('temba-options') as any;
    options.fireCustomEvent(CustomEventType.ScrollThreshold);

    await fetched;
    await list.updateComplete;

    // loading was released so the next scroll can try again
    assert.isFalse(list.loading);
    assert.deepEqual(ticketUuids(list), MERGED);
    now.restore();
  });

  it('refreshes using the newest activity in the list', async () => {
    const tickets: TicketList = await fixture(getHTML());
    tickets.endpoint = '/ticket/folder/mine/';

    // the closed ticket in the middle of the list has the newest activity
    tickets.items = [
      openTicket('o1', '2024-01-02T00:00:00.000Z'),
      closedTicket('c1', '2024-01-05T00:00:00.000Z'),
      closedTicket('c2', '2024-01-01T00:00:00.000Z')
    ];

    const newest = new Date('2024-01-05T00:00:00.000Z').getTime() * 1000;
    assert.equal(
      tickets.getRefreshEndpoint(),
      `/ticket/folder/mine/?after=${newest}`
    );
  });

  it('ignores unparseable activity dates when refreshing', async () => {
    const tickets: TicketList = await fixture(getHTML());
    tickets.endpoint = '/ticket/folder/mine/';

    tickets.items = [
      openTicket('o1', 'not-a-date'),
      openTicket('o2', '2024-01-02T00:00:00.000Z')
    ];

    const newest = new Date('2024-01-02T00:00:00.000Z').getTime() * 1000;
    assert.equal(
      tickets.getRefreshEndpoint(),
      `/ticket/folder/mine/?after=${newest}`
    );

    // nothing usable at all means no cursor, not after=NaN
    tickets.items = [openTicket('o1', 'not-a-date')];
    assert.equal(tickets.getRefreshEndpoint(), '/ticket/folder/mine/');
  });
});
