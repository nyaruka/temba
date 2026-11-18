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

const ticketResult = (
  uuid: string,
  lastActivity: string,
  closedOn: string = null
) => {
  return {
    uuid: 'c-' + uuid,
    name: 'Contact ' + uuid,
    last_seen_on: lastActivity,
    last_msg: null,
    ticket: {
      uuid,
      assignee: null,
      topic: null,
      last_activity_on: lastActivity,
      closed_on: closedOn
    }
  };
};

const refreshList = async (list: TicketList, key: string) => {
  const refreshed = new Promise<void>((resolve) => {
    list.addEventListener(CustomEventType.Refreshed, () => resolve(), {
      once: true
    });
  });
  list.refreshKey = key;
  await refreshed;
  await list.updateComplete;
};

// matches only the poll the list makes next, so a later poll from the same
// list can be mocked differently
const pollAt = (list: TicketList) => {
  const escaped = list
    .getRefreshEndpoint()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}$`);
};

const settle = async (list: TicketList) => {
  // let a selection change and anything it triggers finish rendering
  await list.updateComplete;
  await list.updateComplete;
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

  it('stays within a flex column when a closed ticket has a long name', async () => {
    const column: HTMLElement = await fixture(
      `<div style="display:flex; width:300px">
        <temba-ticket-list style="flex-grow:1"></temba-ticket-list>
      </div>`
    );
    const list = column.querySelector('temba-ticket-list') as TicketList;

    // a closed ticket's name doesn't wrap, so its row can't be narrower than
    // the whole name
    list.items = [
      openTicket('o1', '2024-01-02T00:00:00.000Z'),
      {
        ...closedTicket('c1', '2024-01-01T00:00:00.000Z'),
        name: 'Long Name '.repeat(50)
      }
    ];
    await list.updateComplete;
    const options = list.shadowRoot.querySelector('temba-options');
    await (options as any).updateComplete;

    assert.equal(options.shadowRoot.querySelectorAll('.option').length, 2);
    assert.equal(list.getBoundingClientRect().width, 300);

    // and the rows don't overflow the list either
    const scroll = options.shadowRoot.querySelector('.options-scroll');
    assert.isAtMost(scroll.scrollWidth, scroll.clientWidth);
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

  it('draws closed tickets as the same rows as open ones', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList('/test/assets/list/tickets-merged.json');
    assert.equal(list.items.length, 6);

    // no divider between the open and the closed - a closed row marks
    // itself with a check where the open rows show their age
    const options = list.shadowRoot.querySelector('temba-options');
    await (options as any).updateComplete;
    assert.isNull(options.shadowRoot.querySelector('[role="separator"]'));
    const rows = options.shadowRoot.querySelectorAll('.option');
    assert.equal(rows.length, 6);
    assert.isNotNull(rows[0].querySelector('temba-date[display="age"]'));
    assert.isNull(rows[0].querySelector('temba-icon[name="check"]'));
    assert.isNull(rows[3].querySelector('temba-date'));
    assert.isNotNull(rows[3].querySelector('temba-icon[name="check"]'));

    await assertScreenshot('list/tickets-merged', getClip(list));

    // selecting a closed ticket gets the standard selection treatment
    list.cursorIndex = 4;
    await list.updateComplete;
    await assertScreenshot('list/tickets-merged-selected', getClip(list));
    now.restore();
  });

  it('names each ticket by contact, assignee and who spoke last', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();
    await loadStore();

    // the text of each row in a list loaded with the given attributes
    const rowsFor = async (attrs: any) => {
      const list = (await getComponent(
        'temba-ticket-list',
        { workspace: 'Riverside', ...attrs },
        '',
        300,
        600
      )) as TicketList;
      await new Promise<void>((resolve) => {
        list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
          once: true
        });
      });
      await list.updateComplete;
      const options = list.shadowRoot.querySelector('temba-options');
      await (options as any).updateComplete;
      return Array.from(options.shadowRoot.querySelectorAll('.option')).map(
        (row: HTMLElement) => row.innerText.replace(/\s+/g, ' ').trim()
      );
    };

    // contacts by first name, then their assignee's, and a message of ours
    // says who sent it - a user, or the workspace for an automated one. A
    // contact without a name is shown by its URN in full
    let rows = await rowsFor({
      endpoint: '/test/assets/list/tickets-merged.json?names=1',
      agent: 'someone@nyaruka.com'
    });
    assert.match(rows[0], /^Amara Agnes I still haven't/);
    assert.match(rows[1], /^Ben Agnes: Thanks, that fixed it/);
    assert.match(rows[2], /^Carmen Hola/);
    assert.match(rows[3], /^Dave Riverside: Thanks for getting in touch/);
    assert.match(rows[5], /^\+1 206-555-0142/);

    // the current user is You
    rows = await rowsFor({
      endpoint: '/test/assets/list/tickets-merged.json?names=2',
      agent: 'agent1@nyaruka.com'
    });
    assert.match(rows[0], /^Amara You I still haven't/);
    assert.match(rows[1], /^Ben You: Thanks/);

    // and a folder can leave the assignee off
    rows = await rowsFor({
      endpoint: '/test/assets/list/tickets-merged.json?names=3',
      agent: 'agent1@nyaruka.com',
      hideassignee: true
    });
    assert.match(rows[0], /^Amara I still haven't/);
    now.restore();
  });

  it("announces its folder's count as the server reports it", async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();
    await loadStore();

    mockGET(/tickets-counted\.json\?after=/, {
      results: [ticketResult('t2', '2024-05-01T12:05:00.000Z')],
      count: 2
    });
    mockGET(/tickets-counted\.json$/, {
      results: [ticketResult('t1', '2024-05-01T11:00:00.000Z')],
      count: 1,
      now: '2024-05-01T12:00:00.000Z'
    });

    const counts: number[] = [];
    const list = (await getComponent(
      'temba-ticket-list',
      { endpoint: '/test/assets/list/tickets-counted.json' },
      '',
      300,
      600
    )) as TicketList;
    list.addEventListener(CustomEventType.CountChanged, (event: CustomEvent) =>
      counts.push(event.detail.count)
    );
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    assert.equal(list.count, 1);

    // and again when a refresh brings a new count
    await refreshList(list, 'counted');
    assert.equal(list.count, 2);
    assert.deepEqual(counts.slice(-1), [2]);
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

  // a list of open tickets tall enough to scroll, with the first one selected,
  // whose next poll returns the given tickets (one with newer activity than
  // any of them unless told otherwise)
  const getScrollingList = async (
    name: string,
    refreshed = [openTicket('newer', '2024-05-01T00:00:00.000Z')]
  ) => {
    const results = [];
    for (let i = 0; i < 60; i++) {
      const activity = new Date(Date.UTC(2024, 3, 30) - i * 3600000);
      results.push(openTicket(`t${i}`, activity.toISOString()));
    }
    mockGET(new RegExp(`tickets-${name}\\.json$`), { results });
    mockGET(new RegExp(`tickets-${name}\\.json\\?after=`), {
      results: refreshed
    });

    await loadStore();
    const list = (await getComponent(
      'temba-ticket-list',
      { endpoint: `/tickets-${name}.json` },
      '',
      300,
      400
    )) as TicketList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    const options = list.shadowRoot.querySelector('temba-options');
    await (options as any).updateComplete;
    const scroll = options.shadowRoot.querySelector('.options-scroll');
    assert.equal(list.cursorIndex, 0);
    assert.isAbove(scroll.scrollHeight, 2000);
    return { list, scroll };
  };

  const selectTicket = async (list: TicketList, uuid: string) => {
    list.setSelection(uuid);
    await list.updateComplete;
    await (list.shadowRoot.querySelector('temba-options') as any)
      .updateComplete;
  };

  // polls and waits for the list to settle on the refreshed tickets
  const pollScrollingList = async (list: TicketList) => {
    const refreshed = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.Refreshed, () => resolve(), {
        once: true
      });
    });
    list.refreshKey = 'test';
    await refreshed;
    await list.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 100));
  };

  const getSelectedBounds = (list: TicketList) => {
    return list.shadowRoot
      .querySelector('temba-options')
      .shadowRoot.querySelector('.option.focused')
      .getBoundingClientRect();
  };

  // the ticket at the top of the visible part of the list, and how far its
  // row is from the top
  const getTopTicket = (list: TicketList, scroll: Element) => {
    const top = scroll.getBoundingClientRect().top;
    const row = [...scroll.querySelectorAll('.option')].find(
      (option) => option.getBoundingClientRect().bottom > top
    );
    const index = parseInt(row.getAttribute('data-option-index'));
    return {
      uuid: list.items[index].ticket.uuid,
      offset: Math.round(row.getBoundingClientRect().top - top)
    };
  };

  it('stays on the same tickets when a refresh adds one above a scrolled list', async () => {
    const { list, scroll } = await getScrollingList('scrolled');

    scroll.scrollTop = 1500;
    const showing = getTopTicket(list, scroll);
    assert.notEqual(showing.uuid, 't0');

    await pollScrollingList(list);

    // the selection, which is out of view, moved down a row
    assert.equal(list.items[0].ticket.uuid, 'newer');
    assert.equal(list.cursorIndex, 1);
    assert.equal(list.selected.ticket.uuid, 't0');

    // and the list scrolled by that row rather than back to the selection
    assert.deepEqual(getTopTicket(list, scroll), showing);
    assert.isAbove(scroll.scrollTop, 1500);
    assert.isBelow(scroll.scrollTop, 1700);
  });

  it('shows new tickets when a refresh adds them to a list scrolled to the top', async () => {
    const { list, scroll } = await getScrollingList('top');

    await pollScrollingList(list);

    assert.equal(scroll.scrollTop, 0);
    assert.equal(getTopTicket(list, scroll).uuid, 'newer');
    assert.equal(list.selected.ticket.uuid, 't0');
  });

  it('leaves an in view selection where it is when a refresh adds a ticket above it', async () => {
    const { list, scroll } = await getScrollingList('in-view');

    // select a ticket further down and sit it in the middle of the list
    await selectTicket(list, 't20');
    const bounds = scroll.getBoundingClientRect();
    scroll.scrollTop += getSelectedBounds(list).top - bounds.top - 150;
    assert.isAbove(scroll.scrollTop, 0);
    const top = Math.round(getSelectedBounds(list).top);

    await pollScrollingList(list);

    assert.equal(list.cursorIndex, 21);
    assert.equal(list.selected.ticket.uuid, 't20');
    assert.equal(Math.round(getSelectedBounds(list).top), top);
  });

  it('keeps an in view selection on its row when its own activity re-sorts it', async () => {
    // the poll returns the selected ticket with new activity, which would sort
    // it to the top of the list
    const { list, scroll } = await getScrollingList('follow', [
      openTicket('t20', '2024-05-01T00:00:00.000Z')
    ]);

    await selectTicket(list, 't20');
    const bounds = scroll.getBoundingClientRect();
    scroll.scrollTop += getSelectedBounds(list).top - bounds.top - 150;
    assert.isAbove(scroll.scrollTop, 500);
    const scrollTop = scroll.scrollTop;
    const top = Math.round(getSelectedBounds(list).top);

    await pollScrollingList(list);

    // it stays where the user is working, with its latest data
    assert.equal(list.items.length, 60);
    assert.equal(list.cursorIndex, 20);
    assert.equal(list.selected.ticket.uuid, 't20');
    assert.equal(
      list.selected.ticket.last_activity_on,
      '2024-05-01T00:00:00.000Z'
    );
    assert.equal(scroll.scrollTop, scrollTop);
    assert.equal(Math.round(getSelectedBounds(list).top), top);
  });

  it('keeps a selection made while a refresh is in flight', async () => {
    const { list } = await getScrollingList('in-flight');

    // a different ticket gets selected while the poll is being fetched
    const sanitizeResults = (list as any).sanitizeResults.bind(list);
    (list as any).sanitizeResults = async (results: any[]) => {
      await selectTicket(list, 't5');
      return sanitizeResults(results);
    };

    await pollScrollingList(list);

    assert.equal(list.items[0].ticket.uuid, 'newer');
    assert.equal(list.cursorIndex, 6);
    assert.equal(list.selected.ticket.uuid, 't5');
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

  it('holds the selected ticket in place when its own activity re-sorts it', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList('/test/assets/list/tickets-merged.json?hold=1');

    list.setSelection(MERGED[2]);
    await list.updateComplete;
    assert.equal(list.cursorIndex, 2);

    // replying to the selected ticket bumps its activity past every other one
    const replied = '2024-05-01T11:30:00.000000Z';
    mockGET(pollAt(list), {
      results: [ticketResult(MERGED[2], replied)]
    });
    await refreshList(list, 'hold');

    // it stays on its row with its latest data, rather than the list chasing
    // it to the top
    assert.deepEqual(ticketUuids(list), MERGED);
    assert.equal(list.cursorIndex, 2);
    assert.equal(list.getSelection().ticket.last_activity_on, replied);

    // it stays put once the selection moves on too, so clicking on to the
    // next ticket doesn't shift the rows under the pointer
    let changes = 0;
    list.addEventListener('change', () => changes++);
    list.cursorIndex = 0;
    await settle(list);

    assert.deepEqual(ticketUuids(list), MERGED);
    assert.equal(list.getSelection().ticket.uuid, MERGED[0]);
    assert.equal(list.cursorIndex, 0);
    assert.equal(changes, 1);

    // and through later refreshes, until the list reloads - though the
    // tickets around it can still move
    mockGET(pollAt(list), {
      results: [ticketResult(MERGED[1], '2024-05-01T11:45:00.000000Z')]
    });
    await refreshList(list, 'hold-again');

    // another ticket's own change still re-sorts it
    assert.deepEqual(ticketUuids(list), [
      MERGED[1],
      MERGED[0],
      MERGED[2],
      MERGED[3],
      MERGED[4],
      MERGED[5]
    ]);
    now.restore();
  });

  it('keeps a ticket claimed from the list where it is', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList('/test/assets/list/tickets-merged.json?claim=1');

    list.setSelection(MERGED[1]);
    await list.updateComplete;

    // replying claims it, which takes it out of an unassigned folder, so the
    // poll never returns it again
    await list.holdTicket({
      uuid: MERGED[1],
      last_activity_on: '2024-05-01T11:30:00.000000Z',
      assignee: {
        uuid: 'u1000000-0000-0000-0000-000000000001',
        email: 'agent1@nyaruka.com'
      }
    });
    await list.updateComplete;

    assert.deepEqual(ticketUuids(list), MERGED);
    assert.equal(list.cursorIndex, 1);
    assert.equal(
      list.getSelection().ticket.assignee.email,
      'agent1@nyaruka.com'
    );

    // a newer ticket arriving above doesn't knock it out of place relative to
    // its neighbours
    const fresh = ticketResult(
      'aaaaaaaa-0000-0000-0000-000000000001',
      '2024-05-01T11:45:00.000000Z'
    );
    mockGET(/tickets-merged\.json\?claim=1&after=/, { results: [fresh] });
    await refreshList(list, 'claim');

    assert.deepEqual(ticketUuids(list), [fresh.ticket.uuid, ...MERGED]);
    assert.equal(list.getSelection().ticket.uuid, MERGED[1]);
    now.restore();
  });

  it('works through a partly loaded list oldest first', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();
    await loadStore();

    // the short list doesn't fill the view so it asks for its next page right
    // away - failing that keeps it partly loaded, which is what we're testing
    mockGET(/tickets-oldest-page2\.json/, {}, {}, '500');

    // register the poll before the page, mocks match first-registered-wins
    const answered = '2024-05-01T12:05:00.000Z';
    const newest = '2024-05-01T12:07:00.000Z';
    mockGET(/tickets-oldest\.json\?order=oldest&after=/, {
      results: [
        ticketResult('o1', answered),
        ticketResult(
          'o2',
          '2024-05-01T12:06:00.000Z',
          '2024-05-01T12:06:00.000Z'
        ),
        ticketResult('n1', newest)
      ]
    });
    mockGET(/tickets-oldest\.json\?order=oldest$/, {
      results: [
        ticketResult('o1', '2024-04-01T00:00:00.000Z'),
        ticketResult('o2', '2024-04-02T00:00:00.000Z'),
        ticketResult('o3', '2024-04-03T00:00:00.000Z')
      ],
      next: '/test/assets/list/tickets-oldest-page2.json',
      now: '2024-05-01T12:00:00.000Z'
    });

    const list = (await getComponent(
      'temba-ticket-list',
      {
        endpoint: '/test/assets/list/tickets-oldest.json?order=oldest',
        order: 'oldest'
      },
      '',
      300,
      600
    )) as TicketList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    assert.deepEqual(ticketUuids(list), ['o1', 'o2', 'o3']);
    assert.equal(list.getSelection().ticket.uuid, 'o1');

    // polls start from when the server read the page, not from the newest
    // ticket loaded, which is weeks old
    const serverNow = new Date('2024-05-01T12:00:00.000Z').getTime() * 1000;
    assert.equal(
      list.getRefreshEndpoint(),
      `/test/assets/list/tickets-oldest.json?order=oldest&after=${serverNow}`
    );

    // the selected ticket was answered, another was closed and a new one came
    // in beyond what's loaded
    await refreshList(list, 'oldest');

    // the answered ticket holds its row, the closed one leaves
    // and the new one waits for a later page
    assert.deepEqual(ticketUuids(list), ['o1', 'o3']);
    assert.equal(list.cursorIndex, 0);

    // the poll cursor still moves past everything it was sent
    assert.equal(
      list.getRefreshEndpoint(),
      `/test/assets/list/tickets-oldest.json?order=oldest&after=${
        new Date(newest).getTime() * 1000
      }`
    );

    // moving on leaves the answered ticket where it is, though it now sorts
    // past what's loaded, so the next row doesn't move as it's clicked
    list.cursorIndex = 1;
    await settle(list);

    assert.deepEqual(ticketUuids(list), ['o1', 'o3']);
    assert.equal(list.cursorIndex, 1);
    assert.equal(list.getSelection().ticket.uuid, 'o3');
    now.restore();
  });

  it('keeps a ticket closed from an oldest first list in its row', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();
    await loadStore();

    const closedAt = '2024-05-01T12:05:00.000Z';
    mockGET(/tickets-closing\.json\?order=oldest&after=/, {
      results: [ticketResult('o2', closedAt, closedAt)]
    });
    mockGET(/tickets-closing\.json\?order=oldest$/, {
      results: [
        ticketResult('o1', '2024-04-01T00:00:00.000Z'),
        ticketResult('o2', '2024-04-02T00:00:00.000Z'),
        ticketResult('o3', '2024-04-03T00:00:00.000Z')
      ],
      now: '2024-05-01T12:00:00.000Z'
    });

    const list = (await getComponent(
      'temba-ticket-list',
      {
        endpoint: '/test/assets/list/tickets-closing.json?order=oldest',
        order: 'oldest'
      },
      '',
      300,
      600
    )) as TicketList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    list.cursorIndex = 1;
    await settle(list);

    // closing the selected ticket leaves it on its row, now closed, even
    // though the oldest order only lists open tickets
    await refreshList(list, 'closing');
    assert.deepEqual(ticketUuids(list), ['o1', 'o2', 'o3']);
    assert.equal(list.getSelection().ticket.closed_on, closedAt);

    // only that row shows as closed - nothing marks the open rows around it
    // as closed too
    const options = list.shadowRoot.querySelector('temba-options');
    await (options as any).updateComplete;
    assert.isNull(options.shadowRoot.querySelector('[role="separator"]'));
    const closed = Array.from(
      options.shadowRoot.querySelectorAll('.option')
    ).map((row) => !!row.querySelector('temba-icon[name="check"]'));
    assert.deepEqual(closed, [false, true, false]);

    // and it stays there once the selection moves on
    list.cursorIndex = 2;
    await settle(list);
    assert.deepEqual(ticketUuids(list), ['o1', 'o2', 'o3']);
    now.restore();
  });

  it('keeps the selection when a ticket above it is removed', async () => {
    const now = mockNow('2024-05-01T12:00:00.000Z');
    mockAgents();

    await loadStore();
    const list = await getList(
      '/test/assets/list/tickets-merged.json?remove=1'
    );

    list.setSelection(MERGED[2]);
    await list.updateComplete;

    let changes = 0;
    list.addEventListener('change', () => changes++);

    list.removeItem(MERGED[0]);
    await list.updateComplete;

    assert.equal(list.items.length, 5);
    assert.equal(list.cursorIndex, 1);
    assert.equal(list.getSelection().ticket.uuid, MERGED[2]);
    assert.equal(changes, 0);

    // removing something that isn't there leaves the list alone
    list.removeItem('not-a-ticket');
    await list.updateComplete;
    assert.equal(list.items.length, 5);
    now.restore();
  });

  it('sorts oldest activity first in the oldest order', async () => {
    const tickets: TicketList = await fixture(getHTML());
    tickets.order = 'oldest';
    const items = [
      openTicket('o2', '2024-01-03T00:00:00.000Z'),
      openTicket('o1', '2024-01-01T00:00:00.000Z')
    ];

    items.sort((tickets as any).compareItems);
    assert.deepEqual(
      items.map((item) => item.ticket.uuid),
      ['o1', 'o2']
    );
  });
});
