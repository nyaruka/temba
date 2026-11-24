import { SinonStub, useFakeTimers } from 'sinon';
import { Compose } from '../src/form/Compose';
import { ContactChat } from '../src/live/ContactChat';
import { setSocketProvider, SocketProvider } from '../src/live/SocketService';
import { Attachment, CustomEventType } from '../src/interfaces';
import {
  assertScreenshot,
  clearMockPosts,
  getClip,
  getComponent,
  getValidAttachments,
  getValidText,
  loadStore,
  mockAPI,
  mockGET,
  mockNow,
  mockPOST,
  MockSocketProvider,
  updateComponent
} from '../test/utils.test';

import { expect, oneEvent } from '@open-wc/testing';

let clock: any;

let mockSocket: MockSocketProvider;
let previousSocketProvider: SocketProvider;

const TAG = 'temba-contact-chat';

// polls with short real sleeps (so mocked HTTP roundtrips can complete) while
// advancing fake timers, until the predicate holds for stableFor consecutive
// iterations
const settle = async (
  predicate: () => boolean,
  tickMs = 0,
  maxAttempts = 400,
  stableFor = 1
) => {
  let stable = 0;
  for (let i = 0; i < maxAttempts; i++) {
    await waitFor(10);
    clock.tick(tickMs);
    if (predicate()) {
      stable++;
      if (stable >= stableFor) {
        return;
      }
    } else {
      stable = 0;
    }
  }
  throw new Error('Condition not met while settling');
};

// the contact and its history have loaded and rendered
const chatLoaded = (chat: ContactChat) => {
  const inner = chat.shadowRoot.querySelector('temba-chat') as any;
  return !!(
    chat.currentContact &&
    inner &&
    !inner.fetching &&
    inner.messageGroups.length > 0
  );
};

// waits for history to load and the fetch chain to drain. when the loaded
// view isn't scrollable the chat keeps requesting older pages, and each
// completion is deferred by up to MIN_FETCH_TIME of (faked) time — so tick
// generously and require the loaded state to survive several ticks before
// calling it settled
const settleLoaded = async (chat: ContactChat) => {
  await settle(() => chatLoaded(chat), 150, 400, 5);
};

const getContactChat = async (attrs: any = {}) => {
  attrs['endpoint'] = '/test/assets/contacts/';
  // add some sizes and styles to force our chat history to scroll
  const chat = (await getComponent(
    TAG,
    attrs,
    '',
    500,
    500,
    'display:flex;flex-direction:column;flex-grow:1;min-height:0;'
  )) as ContactChat;

  // wait for contact data and history to load (real HTTP), flushing fake
  // timers so addMessages' setTimeout(fn, 0) fires
  await settleLoaded(chat);
  return chat;
};

const getResponseSuccessFiles = (attachments: Attachment[]) => {
  const response_attachments = attachments.map((attachment) => {
    return { content_type: attachment.content_type, url: attachment.url };
  });
  return response_attachments;
};

describe('temba-contact-chat', () => {
  let mockedNow: SinonStub;
  // map requests for contact history to our static files
  // we'll just us the same historylist for everybody for now
  beforeEach(() => {
    mockedNow = mockNow('2021-03-31T00:31:00.000-00:00');
    clearMockPosts();

    // the catch-up fetch on subscribe (after=) finds nothing new - without
    // this it races the initial history fetch for the same page of events and
    // the rendered grouping depends on which one lands first
    mockGET(/\/contact\/chat\/contact-.*\?after=/, { events: [], next: null });
    mockGET(
      /\/contact\/chat\/contact-.*/,
      '/test/assets/contacts/history.json'
    );

    mockGET(
      /\/api\/v2\/users\.json\?email=admin1%40nyaruka\.com/,
      '/test/assets/api/users/admin1.json'
    );

    mockAPI();
    clock = useFakeTimers();

    mockSocket = new MockSocketProvider();
    previousSocketProvider = setSocketProvider(mockSocket);
  });

  afterEach(function () {
    clock.restore();
    mockedNow.restore();
    setSocketProvider(previousSocketProvider);
  });

  it('show history and show chatbox if contact is active', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showMessageLogsAfter: '2025-01-01T00:00:00.000Z'
    });

    await assertScreenshot('contacts/chat-for-active-contact', getClip(chat));
  });

  it('condenses info events into wrapping pill runs', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();

    // this contact id deliberately doesn't match the generic
    // /contact\/chat\/contact-.*/ mocks above so we can feed it an
    // event-heavy history; the after= mock must be registered first
    // since the generic history pattern would also match that URL
    mockGET(/\/contact\/chat\/events-dude\/\?after=/, {
      events: [],
      next: null
    });
    mockGET(
      /\/contact\/chat\/events-dude\//,
      '/test/assets/contacts/history-events.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'events-dude'
    });

    await assertScreenshot('contacts/chat-condensed-events', getClip(chat));
  });

  it('expands the event summary into detailed pills on click', async () => {
    await loadStore();
    mockGET(/\/contact\/chat\/events-dude\/\?after=/, {
      events: [],
      next: null
    });
    mockGET(
      /\/contact\/chat\/events-dude\//,
      '/test/assets/contacts/history-events.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'events-dude'
    });

    // the run of info events renders collapsed as a summary pill —
    // clicking it swaps in the detailed pills
    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    const summary = inner.shadowRoot.querySelector(
      'temba-label[title="Show details"]'
    ) as HTMLElement;
    expect(summary).to.not.equal(null);
    expect(inner.shadowRoot.querySelector('.condensed-events')).to.equal(null);

    summary.click();
    await inner.updateComplete;
    expect(inner.shadowRoot.querySelector('.condensed-events')).to.not.equal(
      null
    );

    await assertScreenshot(
      'contacts/chat-condensed-events-expanded',
      getClip(chat)
    );
  });

  it('shows a rich tooltip when hovering an event pill', async () => {
    await loadStore();

    // a dedicated contact whose history has a single ticket assignment
    // event — hovering its pill should pop our rich tooltip with the
    // acting user (avatar + name) above the detailed timestamp
    mockGET(/\/test\/assets\/contacts\/tooltip-dude/, {
      next: null,
      previous: null,
      results: [
        {
          uuid: 'tooltip-dude',
          name: 'Tina Tooltips',
          status: 'active',
          urns: [],
          groups: [],
          fields: {},
          created_on: '2021-01-15T19:16:49.377501Z',
          modified_on: '2021-03-30T02:01:09.120952Z',
          last_seen_on: '2021-03-30T02:01:09.120952Z',
          blocked: false,
          stopped: false
        }
      ]
    });
    mockGET(/\/contact\/chat\/tooltip-dude\/\?after=/, {
      events: [],
      next: null
    });
    mockGET(/\/contact\/chat\/tooltip-dude\//, {
      events: [
        {
          uuid: 'evt-tip-2',
          type: 'ticket_assignee_changed',
          created_on: '2021-03-31T00:15:00.000Z',
          ticket: { uuid: 'ticket-1' },
          _user: {
            uuid: 'u-adam',
            name: 'Adam Ant',
            email: 'adam@nyaruka.com'
          },
          assignee: {
            uuid: 'u-sally',
            name: 'Sally Seashell',
            email: 'sally@nyaruka.com'
          }
        },
        {
          uuid: 'evt-tip-1',
          type: 'msg_received',
          created_on: '2021-03-31T00:10:00.000Z',
          msg: { text: 'Can somebody help me?' }
        }
      ],
      next: null
    });

    const chat: ContactChat = await getContactChat({
      contact: 'tooltip-dude'
    });

    // even a single informational event starts collapsed behind a
    // summary pill — expand it to get at the detailed pill
    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    const summary = inner.shadowRoot.querySelector(
      'temba-label[title="Show details"]'
    ) as HTMLElement;
    summary.click();
    await inner.updateComplete;

    // each inline event is wrapped in a temba-tip carrying the rich
    // tooltip content; hovering past the show delay pops it
    const tip = inner.shadowRoot.querySelector('temba-tip') as any;
    expect(tip).to.not.equal(null);

    tip.shadowRoot
      .querySelector('.slot')
      .dispatchEvent(new Event('mouseenter'));
    clock.tick(400);
    await tip.updateComplete;
    expect(tip.visible).to.equal(true);

    const tipEle = tip.shadowRoot.querySelector('.tip');
    expect(tipEle.textContent).to.contain('Adam Ant');
    // the assignee is already visible in the pill, so the tooltip
    // only carries the actor and the timestamp
    expect(tipEle.textContent).to.not.contain('Sally');
    expect(tipEle.querySelector('temba-user')).to.not.equal(null);

    // let the tip's opacity transition finish before comparing pixels
    await waitFor(300);
    await assertScreenshot('contacts/chat-event-tooltip', getClip(chat));
  });

  it('pins the day marker while scrolling back through history', async () => {
    await loadStore();
    mockGET(/\/contact\/chat\/events-dude\/\?after=/, {
      events: [],
      next: null
    });
    mockGET(
      /\/contact\/chat\/events-dude\//,
      '/test/assets/contacts/history-events.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'events-dude'
    });

    // expand the summary so there's enough history to scroll, then
    // scroll partway back — the current section's day marker should
    // float pinned at the top of the chat window
    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    const summary = inner.shadowRoot.querySelector(
      'temba-label[title="Show details"]'
    ) as HTMLElement;
    summary.click();
    await inner.updateComplete;

    const scroll = inner.shadowRoot.querySelector('.scroll') as HTMLElement;
    // column-reverse scroller: 0 is the bottom, negative scrolls back
    scroll.scrollTop = -(scroll.scrollHeight - scroll.clientHeight) / 2;
    await waitFor(100);

    await assertScreenshot('contacts/chat-day-marker-pinned', getClip(chat));
  });

  it('show history and hide chatbox if contact is archived', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-barack-archived',
      showMessageLogsAfter: '2025-01-01T00:00:00.000Z'
    });

    await assertScreenshot('contacts/chat-for-archived-contact', getClip(chat));
  });

  it('show history and hide chatbox if contact is blocked', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-michelle-blocked'
    });

    await assertScreenshot('contacts/chat-for-blocked-contact', getClip(chat));
  });

  it('reloads history when the same contact is set again after clearing', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-barack-archived'
    });
    expect(chat.currentContact).to.not.be.null;

    // dismissing the chat (mobile back) clears everything
    chat.contact = null;
    chat.currentTicket = null;
    chat.currentContact = null;
    await chat.updateComplete;
    expect(chat.data, 'data should clear with the contact').to.be.null;

    // re-selecting the same ticket sets the same contact again
    chat.contact = 'contact-barack-archived';
    await settleLoaded(chat);

    expect(chat.currentContact, 'contact should reload').to.not.be.null;
    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    expect(inner.messageGroups.length).to.be.greaterThan(0);
  });

  it('show history and hide chatbox if contact is stopped', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-tim-stopped'
    });

    await assertScreenshot('contacts/chat-for-stopped-contact', getClip(chat));
  });

  it('lays out last seen and current flow side by side without overlap', async () => {
    // push now past dave's last seen so both sides of the bar render
    mockedNow.restore();
    mockedNow = mockNow('2022-08-01T00:00:00.000-00:00');

    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    const contactStatus = chat.shadowRoot.querySelector(
      '.contact-status'
    ) as HTMLElement;
    const lastSeen = contactStatus.querySelector('.last-seen') as HTMLElement;
    const currentFlow = contactStatus.querySelector(
      '.current-flow'
    ) as HTMLElement;

    expect(lastSeen).to.exist;
    expect(currentFlow).to.exist;

    // the two sit in the same row but never overlap
    const seenRect = lastSeen.getBoundingClientRect();
    const flowRect = currentFlow.getBoundingClientRect();
    expect(seenRect.right).to.be.lessThan(flowRect.left);
  });

  it('sends text without attachments', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const compose = chat.shadowRoot.querySelector('temba-compose') as Compose;
    const text = getValidText();
    await updateComponent(compose, text);

    const response_body = {
      event: {
        uuid: 'msg-uuid',
        contact: { uuid: 'contact-dave-active', name: 'Dave Matthews' },
        msg: {
          text: text,
          attachments: []
        }
      }
    };
    mockPOST(/contact\/chat\/contact-dave-active\//, response_body);

    const listener = oneEvent(compose, CustomEventType.Submitted, false);
    await typeInto('temba-contact-chat:temba-compose', text, true, true);
    expect(await listener).to.exist;

    await assertScreenshot('contacts/chat-sends-text-only', getClip(chat));
  });

  it('sends attachments without text', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const compose = chat.shadowRoot.querySelector('temba-compose') as Compose;
    const attachments = getValidAttachments();
    await updateComponent(compose, null, attachments);
    const response_attachments = getResponseSuccessFiles(attachments);
    const response_body = {
      event: {
        uuid: 'msg-uuid',
        contact: { uuid: 'contact-dave-active', name: 'Dave Matthews' },
        msg: {
          text: '',
          attachments: response_attachments
        }
      }
    };
    const response_headers = {};
    const response_status = '200';
    mockPOST(
      /contact\/chat\/contact-dave-active\//,
      response_body,
      response_headers,
      response_status
    );

    const listener = oneEvent(compose, CustomEventType.Submitted, false);
    await typeInto('temba-contact-chat:temba-compose', '', false, true);
    expect(await listener).to.exist;

    await assertScreenshot(
      'contacts/chat-sends-attachments-only',
      getClip(chat)
    );
  });

  it('sends text with attachments', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const compose = chat.shadowRoot.querySelector('temba-compose') as Compose;
    const text = getValidText();
    const attachments = getValidAttachments();
    await updateComponent(compose, text, attachments);
    const response_attachments = getResponseSuccessFiles(attachments);
    const response_body = {
      event: {
        uuid: 'msg-uuid',
        contact: { uuid: 'contact-dave-active', name: 'Dave Matthews' },
        msg: {
          text,
          attachments: response_attachments
        }
      }
    };
    mockPOST(/contact\/chat\/contact-dave-active\//, response_body);

    // press enter
    const listener = oneEvent(compose, CustomEventType.Submitted, false);
    await typeInto('temba-contact-chat:temba-compose', '', false, true);
    expect(await listener).to.exist;

    await assertScreenshot(
      'contacts/chat-sends-text-and-attachments',
      getClip(chat)
    );
  });

  it('shows failure message with retry', async () => {
    // we are a StoreElement, so load a store first
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const compose = chat.shadowRoot.querySelector('temba-compose') as Compose;
    await updateComponent(compose, getValidText(), getValidAttachments());

    const response_body = {};
    const response_headers = {};
    const response_status = '500';
    mockPOST(
      /api\/v2\/messages\.json/,
      response_body,
      response_headers,
      response_status
    );

    // press
    const listener = oneEvent(compose, CustomEventType.Submitted, false);
    await typeInto('temba-contact-chat:temba-compose', '', false, true);
    expect(await listener).to.exist;

    await assertScreenshot('contacts/chat-failure', getClip(chat));
  });

  it('hides search toggle when showSearch is not set', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    const searchToggle = chat.shadowRoot.querySelector(
      '.search-toggle'
    ) as HTMLElement;
    expect(searchToggle).to.not.exist;

    await assertScreenshot('contacts/chat-no-search', getClip(chat));
  });

  it('searches messages and shows results', async () => {
    await loadStore();

    // mock the search endpoint to return results for "primus"
    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showSearch: true
    });

    // the closed state shows the search trigger chip over the history
    const searchToggle = chat.shadowRoot.querySelector(
      '.search-toggle'
    ) as HTMLElement;
    expect(searchToggle).to.exist;
    await assertScreenshot('contacts/chat-search-toggle', getClip(chat));

    // click the search toggle button
    searchToggle.click();

    // wait for search mode to activate, the input to render and the 150ms
    // slide-in animation (real time) to finish
    await waitFor(200);
    clock.tick(100);
    await chat.updateComplete;

    await assertScreenshot('contacts/chat-search-open', getClip(chat));

    // type "primus" into the search input
    const textInput = chat.shadowRoot.querySelector('.search-input') as any;
    expect(textInput).to.exist;
    textInput.value = 'primus';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await chat.updateComplete;

    // trigger search via the same UI action users use
    const searchGo = chat.shadowRoot.querySelector('.search-go') as HTMLElement;
    expect(searchGo).to.exist;
    searchGo.click();

    // wait for the search API response and results to load
    await settle(
      () => chat.searchResults && chat.searchResults.length > 0,
      50,
      30
    );

    expect(chat.searchResults.length).to.equal(2);
    expect(chat.searchIndex).to.equal(0);

    // wait for the navigation to settle (fade out + load + fade in), then
    // give the 150ms opacity transition (real time) room to finish
    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    await settle(() => inner.style.opacity === '1', 50, 30);
    await waitFor(200);
    await chat.updateComplete;

    await assertScreenshot('contacts/chat-search-result', getClip(chat));
  });

  it('starts a search programmatically landing on the given event', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    // ask for the older of the two matches
    chat.startSearch('primus', {
      uuid: '01997d74-bf67-7199-8e8a-200e41a90d71',
      type: 'msg_received',
      created_on: '2025-09-23T20:40:27.239431+00:00'
    });

    await settle(
      () => chat.searchResults && chat.searchResults.length > 0,
      50,
      30
    );

    expect(chat.searchMode).to.equal(true);
    expect(chat.searchQuery).to.equal('primus');
    expect(chat.searchResults.length).to.equal(2);

    // landed on the requested event, not the most recent match
    expect(chat.searchIndex).to.equal(1);
    expect(chat.searchResults[1].uuid).to.equal(
      '01997d74-bf67-7199-8e8a-200e41a90d71'
    );
  });

  it('runs a programmatic search requested before the contact loads', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat = (await getComponent(
      TAG,
      { contact: 'contact-dave-active', endpoint: '/test/assets/contacts/' },
      '',
      500,
      500,
      'display:flex;flex-direction:column;flex-grow:1;min-height:0;'
    )) as ContactChat;

    // request the search before the contact has finished loading - it should
    // execute once it has
    chat.startSearch('primus');

    await settle(
      () => chat.searchResults && chat.searchResults.length > 0,
      150,
      400
    );

    expect(chat.searchMode).to.equal(true);
    expect(chat.searchResults.length).to.equal(2);
    expect(chat.searchIndex).to.equal(0);
  });

  it('restores the host search opt-out when a handed-off search closes', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    // the host has not enabled search for this conversation
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    expect(chat.showSearch).to.equal(false);

    // a hand-off forces the bar on so the searched view can be navigated
    chat.startSearch('primus');
    expect(chat.showSearch).to.equal(true);

    await settle(
      () => chat.searchResults && chat.searchResults.length > 0,
      50,
      30
    );

    // closing the search puts the host's opt-out back
    (chat as any).handleSearchClose();
    clock.tick(200);
    await chat.updateComplete;
    expect(chat.searchMode).to.equal(false);
    expect(chat.showSearch).to.equal(false);
  });

  it('never runs a handed-off search against a different contact', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat = (await getComponent(
      TAG,
      { endpoint: '/test/assets/contacts/' },
      '',
      500,
      500,
      'display:flex;flex-direction:column;flex-grow:1;min-height:0;'
    )) as ContactChat;

    // hand a search off for dave and switch to carter in the same tick, so
    // carter is the only contact that ever loads
    chat.contact = 'contact-dave-active';
    chat.startSearch('primus');
    chat.contact = 'contact-carter-active';

    await settle(
      () => chat.currentContact?.uuid === 'contact-carter-active',
      150,
      400
    );
    await settleLoaded(chat);

    // dave's search was dropped rather than run against carter's history
    expect((chat as any).pendingSearch).to.equal(null);
    expect(chat.searchResults.length).to.equal(0);
  });

  it('lands on a handed-off event the endpoint did not return', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    // the endpoint caps its matches, so hand off an event it didn't return -
    // its uuid sorts between the two that it did
    chat.startSearch('primus', {
      uuid: '01997d74-bf67-7500-8e8a-200e41a90d71',
      type: 'msg_received',
      created_on: '2025-09-23T20:40:27.239432+00:00'
    });

    await settle(
      () => chat.searchResults && chat.searchResults.length > 0,
      50,
      30
    );

    // spliced into its newest-first spot, and navigated to
    expect(chat.searchResults.length).to.equal(3);
    expect(chat.searchResults[1].uuid).to.equal(
      '01997d74-bf67-7500-8e8a-200e41a90d71'
    );
    expect(chat.searchIndex).to.equal(1);
  });

  it('searches the full contact history even when viewing a ticket', async () => {
    await loadStore();

    // only a request without any ticket param is mocked, so results can
    // only appear if the search wasn't scoped to the ticket
    mockGET(
      /\/contact\/chat_search\/.*\?text=primus$/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    chat.currentTicket = {
      uuid: 'ticket-1',
      topic: { uuid: 'topic-1', name: 'General' },
      assignee: null,
      closed_on: null
    } as any;
    await chat.updateComplete;

    chat.startSearch('primus');

    await settle(
      () => chat.searchResults && chat.searchResults.length > 0,
      50,
      30
    );

    expect(chat.searchResults.length).to.equal(2);
  });

  it('clears stale results when the query changes or is emptied', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showSearch: true
    });

    // open search and run a query with results
    (chat.shadowRoot.querySelector('.search-toggle') as HTMLElement).click();
    await waitFor(200);
    clock.tick(100);
    await chat.updateComplete;

    const textInput = chat.shadowRoot.querySelector('.search-input') as any;
    textInput.value = 'primus';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await chat.updateComplete;
    (chat.shadowRoot.querySelector('.search-go') as HTMLElement).click();
    await settle(
      () => chat.searchResults && chat.searchResults.length > 0,
      50,
      30
    );
    expect(chat.shadowRoot.querySelector('.match-pager')).to.exist;
    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    expect(inner.searchHighlight).to.equal('primus');

    // editing the query invalidates its results — the match stepper and
    // the highlights in the history both go away
    textInput.value = 'primu';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await chat.updateComplete;

    expect(chat.searchResults.length).to.equal(0);
    expect(chat.searchIndex).to.equal(-1);
    expect(chat.shadowRoot.querySelector('.match-pager')).to.not.exist;
    expect(inner.searchHighlight).to.be.null;

    // and backspacing to empty is just an empty search — no run-search
    // affordance either
    textInput.value = '';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await chat.updateComplete;

    expect(chat.searchResults.length).to.equal(0);
    expect(chat.shadowRoot.querySelector('.match-pager')).to.not.exist;
    expect(chat.shadowRoot.querySelector('.search-go')).to.not.exist;
  });

  it('ignores a stale search response after the query is edited mid-flight', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showSearch: true
    });

    // open search and type a query
    (chat.shadowRoot.querySelector('.search-toggle') as HTMLElement).click();
    await waitFor(200);
    clock.tick(100);
    await chat.updateComplete;

    const textInput = chat.shadowRoot.querySelector('.search-input') as any;
    textInput.value = 'primus';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await chat.updateComplete;

    // kick off the search, then — synchronously, before the response can
    // resolve — edit the query. handleSearchInput clears lastSearchedQuery,
    // so the in-flight response is now for a superseded query.
    (chat.shadowRoot.querySelector('.search-go') as HTMLElement).click();
    expect(chat.searchLoading).to.equal(true);
    textInput.value = 'primu';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));

    // let the stale response land
    await settle(() => chat.searchLoading === false, 0, 400);

    // the superseded response must not repopulate results, move the index, or
    // scroll/highlight the history
    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    expect(chat.searchResults.length).to.equal(0);
    expect(chat.searchIndex).to.equal(-1);
    expect(inner.searchHighlight).to.be.null;
  });

  it('abandons an in-flight match navigation when search is closed', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=primus/,
      '/test/assets/contacts/chat-search-primus.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showSearch: true
    });

    // open search and run a query with results, letting the first
    // navigation fully settle
    (chat.shadowRoot.querySelector('.search-toggle') as HTMLElement).click();
    await waitFor(200);
    clock.tick(100);
    await chat.updateComplete;

    const textInput = chat.shadowRoot.querySelector('.search-input') as any;
    textInput.value = 'primus';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await chat.updateComplete;
    (chat.shadowRoot.querySelector('.search-go') as HTMLElement).click();
    await settle(
      () => chat.searchResults && chat.searchResults.length > 0,
      50,
      30
    );
    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    await settle(() => inner.style.opacity === '1', 50, 30);
    await chat.updateComplete;

    // step to the next match (starting a fresh fade/load chain) and close
    // search before that chain can finish
    (chat.shadowRoot.querySelector('.page-btn') as HTMLElement).click();
    (chat.shadowRoot.querySelector('.search-cancel') as HTMLElement).click();

    // flush the abandoned chain's timers, the close timer, and the
    // restore fetch
    await settle(
      () =>
        !chat.searchMode &&
        inner.shadowRoot.querySelectorAll('.row').length > 0,
      50,
      30
    );
    await waitFor(100);
    clock.tick(200);
    await chat.updateComplete;

    // the abandoned navigation must not have re-asserted its highlight or
    // left the chat hidden over the restored view
    expect(inner.searchHighlight).to.be.null;
    expect(inner.highlightMessageUuid).to.be.null;
    expect(inner.style.visibility).to.not.equal('hidden');
    expect(inner.style.opacity).to.equal('1');
  });

  it('restores the unsearched history when the query changes after a search', async () => {
    await loadStore();

    mockGET(
      /\/contact\/chat_search\/.*\?text=xyznotfound/,
      '/test/assets/contacts/chat-search-empty.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showSearch: true
    });

    // open search and run a query with no matches — the history view is
    // reset and left empty behind the no-results message
    (chat.shadowRoot.querySelector('.search-toggle') as HTMLElement).click();
    await waitFor(200);
    clock.tick(100);
    await chat.updateComplete;

    const textInput = chat.shadowRoot.querySelector('.search-input') as any;
    textInput.value = 'xyznotfound';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await chat.updateComplete;
    (chat.shadowRoot.querySelector('.search-go') as HTMLElement).click();
    await settle(() => chat.searchNoResults, 50, 30);
    await chat.updateComplete;

    const inner = chat.shadowRoot.querySelector('temba-chat') as any;
    expect(inner.shadowRoot.querySelectorAll('.row').length).to.equal(0);

    // editing the query reloads the normal history view
    textInput.value = 'xyznotfoun';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    clock.tick(100);
    await settle(
      () => inner.shadowRoot.querySelectorAll('.row').length > 0,
      50,
      30
    );
    expect(chat.searchNoResults).to.be.false;
  });

  it('shows no results message when search has no matches', async () => {
    await loadStore();

    // mock the search endpoint to return empty results
    mockGET(
      /\/contact\/chat_search\/.*\?text=xyznotfound/,
      '/test/assets/contacts/chat-search-empty.json'
    );

    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showSearch: true
    });

    // open search mode
    const searchToggle = chat.shadowRoot.querySelector(
      '.search-toggle'
    ) as HTMLElement;
    searchToggle.click();
    // include real time for the 150ms slide-in animation before screenshots
    await waitFor(200);
    clock.tick(100);
    await chat.updateComplete;

    // type a query with no matches
    const textInput = chat.shadowRoot.querySelector('.search-input') as any;
    textInput.value = 'xyznotfound';
    textInput.dispatchEvent(new Event('input', { bubbles: true }));
    await chat.updateComplete;

    // trigger search via the same UI action users use
    const searchGo = chat.shadowRoot.querySelector('.search-go') as HTMLElement;
    expect(searchGo).to.exist;
    searchGo.click();

    // wait for the search API response
    await settle(() => chat.searchNoResults, 50, 30);
    await chat.updateComplete;

    expect(chat.searchResults.length).to.equal(0);
    expect(chat.searchNoResults).to.be.true;

    await assertScreenshot('contacts/chat-search-no-results', getClip(chat));
  });

  it('subscribes to the contact history channel', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    expect(mockSocket.activeChannels()).to.deep.equal([
      `history:${chat.currentContact.uuid}`
    ]);
  });

  it('renders events published on the socket', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    const eventUUID = '01998888-0000-7000-8000-000000000001';
    mockSocket.publish(`history:${chat.currentContact.uuid}`, {
      uuid: eventUUID,
      type: 'msg_received',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      msg: {
        urn: 'tel:+250788123123',
        text: 'hello over the socket',
        channel: { uuid: '8a81e9e0-10a0-4319-9b00-ce723cfa8303', name: 'SMS' }
      }
    });

    // flush the render timeouts in addMessages
    const tembaChat = chat.shadowRoot.querySelector('temba-chat');
    await settle(
      () =>
        !!tembaChat.shadowRoot.querySelector(`.row[data-uuid="${eventUUID}"]`),
      50,
      10
    );
    await chat.updateComplete;

    // the event was ingested and is now our newest seen event
    expect(chat.afterUUID).to.equal(eventUUID);

    // and it rendered in the chat
    const row = tembaChat.shadowRoot.querySelector(
      `.row[data-uuid="${eventUUID}"]`
    );
    expect(row).to.exist;
  });

  it('ignores socket events while searching', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showSearch: true
    });

    // enter search mode
    const searchToggle = chat.shadowRoot.querySelector(
      '.search-toggle'
    ) as HTMLElement;
    searchToggle.click();
    await waitFor(10);
    clock.tick(100);
    await chat.updateComplete;

    const before = chat.afterUUID;
    mockSocket.publish(`history:${chat.currentContact.uuid}`, {
      uuid: '01998888-0000-7000-8000-000000000002',
      type: 'msg_received',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      msg: { text: 'should be ignored' }
    });

    expect(chat.afterUUID).to.equal(before);
  });

  it('keeps the contact channel subscribed across ticket changes', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    const contactChannel = `history:${chat.currentContact.uuid}`;
    expect(mockSocket.activeChannels()).to.deep.equal([contactChannel]);
    const contactSub = mockSocket.subs[0];

    const makeTicket = (uuid: string) =>
      ({
        uuid,
        topic: { uuid: 'topic-1', name: 'General' },
        assignee: null,
        closed_on: null
      }) as any;

    chat.currentTicket = makeTicket('ticket-1');
    await chat.updateComplete;
    expect(mockSocket.activeChannels()).to.deep.equal([
      contactChannel,
      `${contactChannel}:ticket-1`
    ]);

    chat.currentTicket = makeTicket('ticket-2');
    await chat.updateComplete;
    expect(mockSocket.activeChannels()).to.deep.equal([
      contactChannel,
      `${contactChannel}:ticket-2`
    ]);

    // the contact subscription was never torn down along the way
    expect(contactSub.unsubscribed).to.be.false;
  });

  it('never pairs a ticket with the previous contact during a contact switch', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    const makeTicket = (uuid: string) =>
      ({
        uuid,
        topic: { uuid: 'topic-1', name: 'General' },
        assignee: null,
        closed_on: null
      }) as any;

    chat.currentTicket = makeTicket('ticket-dave');
    await chat.updateComplete;
    expect(mockSocket.activeChannels()).to.deep.equal([
      'history:contact-dave-active',
      'history:contact-dave-active:ticket-dave'
    ]);

    // the agent clicks a ticket for a different contact - the new ticket is
    // set synchronously while the new contact is still fetching
    chat.contact = 'contact-barack-archived';
    chat.currentTicket = makeTicket('ticket-barack');
    await chat.updateComplete;

    // the ticket channel is held back until the contact catches up
    expect(mockSocket.activeChannels()).to.deep.equal([
      'history:contact-dave-active'
    ]);

    // let the contact fetch land
    await settle(() => chat.currentContact?.uuid === 'contact-barack-archived');
    await chat.updateComplete;

    expect(mockSocket.activeChannels()).to.deep.equal([
      'history:contact-barack-archived',
      'history:contact-barack-archived:ticket-barack'
    ]);

    // at no point was the new ticket paired with the old contact
    const mismatched = mockSocket.subs.filter(
      (sub) => sub.channel === 'history:contact-dave-active:ticket-barack'
    );
    expect(mismatched).to.be.empty;
  });

  it('keeps the current ticket in step with its socket events', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    chat.currentTicket = {
      uuid: 'ticket-1',
      topic: { uuid: 'topic-1', name: 'General' },
      assignee: null,
      closed_on: null,
      status: 'open'
    } as any;
    await chat.updateComplete;

    const updates: any[] = [];
    chat.addEventListener(CustomEventType.TicketUpdated, (evt: CustomEvent) =>
      updates.push(evt.detail)
    );

    const contactChannel = `history:${chat.currentContact.uuid}`;
    const ticketChannel = `${contactChannel}:ticket-1`;

    // someone else assigns it, which arrives on the ticket's channel
    const assigned = {
      uuid: '01998888-0000-7000-8000-000000000010',
      type: 'ticket_assignee_changed',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      ticket_uuid: 'ticket-1',
      assignee: { uuid: 'user-bob', name: 'Bob McFlow' }
    };
    mockSocket.publish(ticketChannel, assigned);
    await chat.updateComplete;

    expect(chat.currentTicket.assignee).to.deep.equal({
      uuid: 'user-bob',
      name: 'Bob McFlow'
    });
    expect(updates.length).to.equal(1);
    expect(updates[0].previous.assignee).to.be.null;
    expect(updates[0].ticket.assignee.uuid).to.equal('user-bob');

    // hearing the same change again changes nothing
    mockSocket.publish(ticketChannel, assigned);
    await chat.updateComplete;
    expect(updates.length).to.equal(1);

    // events for other tickets of the contact are ignored
    mockSocket.publish(contactChannel, {
      uuid: '01998888-0000-7000-8000-000000000011',
      type: 'ticket_closed',
      created_on: '2025-09-25T12:01:00.000000+00:00',
      ticket_uuid: 'ticket-2'
    });
    await chat.updateComplete;
    expect(chat.currentTicket.closed_on).to.be.null;
    expect(updates.length).to.equal(1);

    // closing it arrives on the contact's channel
    mockSocket.publish(contactChannel, {
      uuid: '01998888-0000-7000-8000-000000000012',
      type: 'ticket_closed',
      created_on: '2025-09-25T12:02:00.000000+00:00',
      ticket_uuid: 'ticket-1'
    });
    await chat.updateComplete;
    expect(chat.currentTicket.closed_on).to.equal(
      '2025-09-25T12:02:00.000000+00:00'
    );
    expect(chat.currentTicket.status).to.equal('closed');
    expect(updates.length).to.equal(2);
  });

  it('fills in missing user avatars from the store cache', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    const channel = `history:${chat.currentContact.uuid}`;
    const userUUID = 'aaaa1111-0000-4000-8000-000000000001';

    // a hydrated event seeds the avatar cache
    mockSocket.publish(channel, {
      uuid: '01998888-0000-7000-8000-000000000003',
      type: 'ticket_note_added',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      note: 'first note',
      _user: {
        uuid: userUUID,
        name: 'Ann Admin',
        avatar: '/media/avatars/ann.jpg'
      }
    });

    // an unhydrated ref for the same user gets the cached avatar
    const unhydrated = {
      uuid: '01998888-0000-7000-8000-000000000004',
      type: 'ticket_note_added',
      created_on: '2025-09-25T12:01:00.000000+00:00',
      note: 'second note',
      _user: { uuid: userUUID, name: 'Ann Admin' }
    };
    mockSocket.publish(channel, unhydrated);

    // the avatar is resolved onto what we render, not onto the wire event
    // the channel handed every subscriber
    const rendered = () =>
      (getTembaChat(chat) as any).msgMap.get(unhydrated.uuid);
    await settle(() => !!rendered(), 150);

    expect(rendered()._user.avatar).to.equal('/media/avatars/ann.jpg');
    expect(unhydrated._user).to.not.have.property('avatar');
  });

  it('unsubscribes when removed from the page', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    expect(mockSocket.activeChannels().length).to.equal(1);
    chat.remove();
    expect(mockSocket.activeChannels().length).to.equal(0);
  });

  const getTembaChat = (chat: ContactChat) =>
    chat.shadowRoot.querySelector('temba-chat') as any;

  const getTypingRow = async (chat: ContactChat) => {
    const tembaChat = getTembaChat(chat);
    await tembaChat.updateComplete;
    return tembaChat.shadowRoot.querySelector('.row.typing');
  };

  const serverTyping = (
    chat: ContactChat,
    type: string,
    user = { uuid: 'user-bob', name: 'Bob' }
  ) => {
    mockSocket.serverPublish(`history:${chat.currentContact.uuid}`, {
      uuid: `01998888-0000-7000-8000-00000000${
        type === 'typing_started' ? '1111' : '2222'
      }`,
      type,
      created_on: '2025-09-25T12:00:00.000000+00:00',
      _user: user,
      direction: 'outgoing'
    });
  };

  const setComposeText = async (chat: ContactChat, text: string) => {
    const compose = chat.shadowRoot.querySelector('temba-compose');
    compose.dispatchEvent(
      new CustomEvent(CustomEventType.ContentChanged, {
        detail: { und: { text } }
      })
    );
    // let publish promises settle
    await waitFor(1);
  };

  it('shows and clears a typing indicator from socket typing events', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    serverTyping(chat, 'typing_started');
    expect(await getTypingRow(chat)).to.exist;

    serverTyping(chat, 'typing_stopped');
    expect(await getTypingRow(chat)).to.not.exist;
  });

  it('renders socket events without writing back to the wire object', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const channel = `history:${chat.currentContact.uuid}`;

    // every subscriber on the channel is handed these same objects, so
    // parsing a date or resolving an avatar into one writes through to all
    // of them
    const typingUser = { uuid: 'user-bob', name: 'Bob' };
    const typing = {
      uuid: '01998888-0000-7000-8000-00000000aaaa',
      type: 'typing_started',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      _user: typingUser,
      direction: 'outgoing'
    };
    mockSocket.serverPublish(channel, typing);
    expect(await getTypingRow(chat)).to.exist;

    expect(typing.created_on).to.equal('2025-09-25T12:00:00.000000+00:00');
    expect(typingUser).to.not.have.property('avatar');

    // the same holds for events that land in the history rather than the
    // typing indicator
    const msgUser = { uuid: 'user-bob', name: 'Bob' };
    const msg = {
      uuid: '01998888-0000-7000-8000-00000000bbbb',
      type: 'msg_created',
      created_on: '2025-09-25T12:01:00.000000+00:00',
      _user: msgUser,
      msg: { text: 'hello there' }
    };
    mockSocket.serverPublish(channel, msg);
    await chat.updateComplete;

    expect(msg.created_on).to.equal('2025-09-25T12:01:00.000000+00:00');
    expect(msgUser).to.not.have.property('avatar');
  });

  it('shows and clears contact typing with no user attached', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const channel = `history:${chat.currentContact.uuid}`;

    // contact typing events arrive with a direction but no _user
    mockSocket.serverPublish(channel, {
      uuid: '01998888-0000-7000-8000-000000004444',
      type: 'typing_started',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      direction: 'incoming'
    });
    expect(await getTypingRow(chat)).to.exist;

    mockSocket.serverPublish(channel, {
      uuid: '01998888-0000-7000-8000-000000005555',
      type: 'typing_stopped',
      created_on: '2025-09-25T12:00:01.000000+00:00',
      direction: 'incoming'
    });
    expect(await getTypingRow(chat)).to.not.exist;
  });

  it('decays a typing indicator without fresh pulses', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    serverTyping(chat, 'typing_started');
    expect(await getTypingRow(chat)).to.exist;

    clock.tick(10001);
    expect(await getTypingRow(chat)).to.not.exist;
  });

  it('ignores echoes of our own typing events', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      user: 'user-me'
    });

    serverTyping(chat, 'typing_started', { uuid: 'user-me', name: 'Me' });
    expect(await getTypingRow(chat)).to.not.exist;
  });

  it('publishes typing pulses while composing and a stop when emptied', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const channel = `history:${chat.currentContact.uuid}`;

    await setComposeText(chat, 'hello there');
    expect(mockSocket.published.length).to.equal(1);
    expect(mockSocket.published[0].channel).to.equal(channel);
    expect(mockSocket.published[0].data.type).to.equal('typing_started');

    // pulses repeat while composing
    clock.tick(4000);
    expect(mockSocket.published.length).to.equal(2);
    expect(mockSocket.published[1].data.type).to.equal('typing_started');

    // emptying the box stops pulsing and publishes a stop
    await setComposeText(chat, '');
    expect(mockSocket.published.length).to.equal(3);
    expect(mockSocket.published[2].data.type).to.equal('typing_stopped');

    clock.tick(8000);
    expect(mockSocket.published.length).to.equal(3);
  });

  it('includes the external id of the last incoming message in pulses', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    // an incoming message with an external id arrives
    mockSocket.serverPublish(`history:${chat.currentContact.uuid}`, {
      uuid: '01998888-0000-7000-8000-000000003333',
      type: 'msg_received',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      msg: { text: 'hi', external_id: 'ex123' }
    });

    await setComposeText(chat, 'typing away');
    expect(mockSocket.published.length).to.equal(1);
    expect(mockSocket.published[0].data.msg_external_id).to.equal('ex123');
  });

  it('silently disables pulsing when publishes are denied', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    mockSocket.publishError = { code: 103, message: 'permission denied' };
    await setComposeText(chat, 'hello');

    // the denial disabled pulsing - no retries, no stop event
    clock.tick(20000);
    await setComposeText(chat, 'hello again');
    await setComposeText(chat, '');
    expect(mockSocket.published.length).to.equal(0);
  });

  it('keeps pulsing through temporary publish errors', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    // the first pulse hits a temporary server error
    mockSocket.publishError = {
      code: 100,
      message: 'internal server error',
      temporary: true
    };
    await setComposeText(chat, 'hello');
    expect(mockSocket.published.length).to.equal(0);

    // the server recovers and the next pulse goes through
    mockSocket.publishError = null;
    clock.tick(4000);
    await waitFor(1);
    expect(mockSocket.published.length).to.equal(1);
    expect(mockSocket.published[0].data.type).to.equal('typing_started');
  });

  it('publishes typing_stopped when a send empties the compose', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    await setComposeText(chat, 'hello there');
    expect(mockSocket.published.length).to.equal(1);
    expect(mockSocket.published[0].data.type).to.equal('typing_started');

    // a successful send resets the compose, which fires a content-changed with
    // the (now empty) language entry dropped entirely - model that here
    const compose = chat.shadowRoot.querySelector('temba-compose');
    compose.dispatchEvent(
      new CustomEvent(CustomEventType.ContentChanged, { detail: {} })
    );
    await waitFor(1);

    expect(mockSocket.published.length).to.equal(2);
    expect(mockSocket.published[1].data.type).to.equal('typing_stopped');
  });

  it('publishes pulses for a non-default compose language', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const channel = `history:${chat.currentContact.uuid}`;

    // composing in a non-'und' language must still drive pulses
    const compose = chat.shadowRoot.querySelector('temba-compose');
    compose.dispatchEvent(
      new CustomEvent(CustomEventType.ContentChanged, {
        detail: { eng: { text: 'hola' } }
      })
    );
    await waitFor(1);

    expect(mockSocket.published.length).to.equal(1);
    expect(mockSocket.published[0].channel).to.equal(channel);
    expect(mockSocket.published[0].data.type).to.equal('typing_started');
  });

  const getCurrentFlow = (chat: ContactChat) =>
    chat.shadowRoot.querySelector('.contact-status .current-flow');

  const getLastSeen = (chat: ContactChat) =>
    chat.shadowRoot.querySelector('.contact-status .last-seen');

  it('updates the current flow from socket contact_flow_changed events', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const channel = `history:${chat.currentContact.uuid}`;

    // the fetched contact is in a flow
    expect(getCurrentFlow(chat).textContent).to.contain('Daily Flow');

    // moving to another flow renames the chip
    const before = chat.afterUUID;
    mockSocket.serverPublish(channel, {
      uuid: '01998888-0000-7000-8000-000000006666',
      type: 'contact_flow_changed',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      flow: { uuid: 'flow-registration', name: 'Registration' }
    });
    await chat.updateComplete;
    expect(getCurrentFlow(chat).textContent).to.contain('Registration');

    // ephemeral events are state, not history - the newest-seen anchor
    // must not advance and nothing renders in the chat itself
    expect(chat.afterUUID).to.equal(before);
    const tembaChat = getTembaChat(chat);
    expect(
      tembaChat.shadowRoot.querySelector(
        '.row[data-uuid="01998888-0000-7000-8000-000000006666"]'
      )
    ).to.not.exist;

    // leaving the flow removes the chip entirely
    mockSocket.serverPublish(channel, {
      uuid: '01998888-0000-7000-8000-000000007777',
      type: 'contact_flow_changed',
      created_on: '2025-09-25T12:01:00.000000+00:00',
      flow: null
    });
    await chat.updateComplete;
    expect(getCurrentFlow(chat)).to.not.exist;
  });

  it('ellipsizes long flow names in the status bar', async () => {
    // push now past dave's last seen so both sides of the bar render
    mockedNow.restore();
    mockedNow = mockNow('2022-08-01T00:00:00.000-00:00');

    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    mockSocket.serverPublish(`history:${chat.currentContact.uuid}`, {
      uuid: '01998888-0000-7000-8000-00000000bbbb',
      type: 'contact_flow_changed',
      created_on: '2025-09-25T12:00:00.000000+00:00',
      flow: {
        uuid: 'flow-long',
        name: 'Customer Satisfaction Survey Follow Up For Returning Subscribers 2025'
      }
    });
    await chat.updateComplete;

    const contactStatus = chat.shadowRoot.querySelector(
      '.contact-status'
    ) as HTMLElement;
    const currentFlow = getCurrentFlow(chat) as HTMLElement;
    const flowName = currentFlow.querySelector('.flow-name') as HTMLElement;

    // the name shrank to fit - it stays inside the bar and clear of
    // the last seen side
    const barRect = contactStatus.getBoundingClientRect();
    const flowRect = currentFlow.getBoundingClientRect();
    const seenRect = getLastSeen(chat).getBoundingClientRect();
    expect(flowRect.right).to.be.at.most(barRect.right + 1);

    // the flow gave way before ever compressing the guaranteed gap
    expect(flowRect.left - seenRect.right).to.be.at.least(23);

    // and the name is actually ellipsized rather than resized to fit
    expect(flowName.scrollWidth).to.be.greaterThan(flowName.clientWidth);

    await assertScreenshot('contacts/chat-status-long-flow', getClip(chat));
  });

  it('fires an interrupt event from the status area', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showInterrupt: true
    });

    const interrupt = chat.shadowRoot.querySelector(
      '.contact-status .current-flow temba-button'
    ) as HTMLElement;
    expect(interrupt).to.exist;
    await assertScreenshot('contacts/chat-status-interrupt', getClip(chat));

    const listener = oneEvent(chat, CustomEventType.Interrupt, false);
    interrupt.click();
    const event = await listener;
    expect(event.detail.contact.uuid).to.equal('contact-dave-active');
  });

  it('shows last seen in the status bar and updates it from socket events', async () => {
    // dave was last seen 2022-07-08 - view him the next morning
    mockedNow.restore();
    mockedNow = mockNow('2022-07-09T00:00:00.000-00:00');

    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });
    const channel = `history:${chat.currentContact.uuid}`;

    expect(getLastSeen(chat).textContent).to.contain('hours ago');

    // the contact was seen an hour ago
    mockSocket.serverPublish(channel, {
      uuid: '01998888-0000-7000-8000-000000008888',
      type: 'contact_last_seen_changed',
      created_on: '2022-07-08T23:00:00.000000+00:00',
      last_seen_on: '2022-07-08T23:00:00.000000+00:00'
    });
    await chat.updateComplete;
    expect(getLastSeen(chat).textContent).to.contain('1 hour ago');

    // an out of order (older) last seen is ignored
    mockSocket.serverPublish(channel, {
      uuid: '01998888-0000-7000-8000-000000009999',
      type: 'contact_last_seen_changed',
      created_on: '2022-07-01T00:00:00.000000+00:00',
      last_seen_on: '2022-07-01T00:00:00.000000+00:00'
    });
    await chat.updateComplete;
    expect(getLastSeen(chat).textContent).to.contain('1 hour ago');

    // checking in just now hides last seen entirely - it only shows
    // once the contact has been quiet for at least an hour
    mockSocket.serverPublish(channel, {
      uuid: '01998888-0000-7000-8000-00000000cccc',
      type: 'contact_last_seen_changed',
      created_on: '2022-07-09T00:00:00.000000+00:00',
      last_seen_on: '2022-07-09T00:00:00.000000+00:00'
    });
    await chat.updateComplete;
    expect(getLastSeen(chat)).to.not.exist;
  });

  it('shows ticket controls and contact status in one area above the chat box', async () => {
    // push now past dave's last seen so the contact status renders too
    mockedNow.restore();
    mockedNow = mockNow('2022-08-01T00:00:00.000-00:00');

    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active',
      showInterrupt: true
    });

    chat.currentTicket = {
      uuid: 'ticket-1',
      topic: { uuid: 'topic-1', name: 'General' },
      assignee: null,
      closed_on: null
    } as any;
    await chat.updateComplete;

    const statusArea = chat.shadowRoot.querySelector(
      '.status-area'
    ) as HTMLElement;

    // both the ticket controls and the contact status live in the area
    expect(statusArea.querySelector('.ticket-controls')).to.exist;
    expect(statusArea.querySelector('.contact-status .last-seen')).to.exist;
    expect(statusArea.querySelector('.contact-status .current-flow')).to.exist;

    // and the area sits between the chat history and the compose box
    const areaRect = statusArea.getBoundingClientRect();
    const historyRect = chat.shadowRoot
      .querySelector('temba-chat')
      .getBoundingClientRect();
    const composeRect = chat.shadowRoot
      .querySelector('.compose')
      .getBoundingClientRect();
    expect(areaRect.top).to.be.at.least(historyRect.bottom - 1);
    expect(areaRect.bottom).to.be.at.most(composeRect.top + 1);

    // the interrupt button right-aligns with the close button above it
    const closeRect = statusArea
      .querySelector('.ticket-controls temba-button')
      .getBoundingClientRect();
    const interruptRect = statusArea
      .querySelector('.current-flow temba-button')
      .getBoundingClientRect();
    expect(Math.abs(closeRect.right - interruptRect.right)).to.be.at.most(1);

    await assertScreenshot('contacts/chat-ticket-status-area', getClip(chat));
  });

  it('keeps ticket controls the same width whatever the topic', async () => {
    await loadStore();
    const chat: ContactChat = await getContactChat({
      contact: 'contact-dave-active'
    });

    const controls = () =>
      chat.shadowRoot.querySelector('.ticket-controls') as HTMLElement;

    chat.currentTicket = {
      uuid: 'ticket-1',
      topic: { uuid: 'topic-1', name: 'General' },
      assignee: null,
      closed_on: null
    } as any;
    await chat.updateComplete;
    const shortWidth = chat.getBoundingClientRect().width;

    chat.currentTicket = {
      uuid: 'ticket-2',
      topic: {
        uuid: 'topic-2',
        name: 'Billing and payment questions from customers with a very long topic name'
      },
      assignee: null,
      closed_on: null
    } as any;
    await chat.updateComplete;

    // a long topic doesn't widen the chat or overflow the row
    expect(chat.getBoundingClientRect().width).to.equal(shortWidth);
    expect(controls().scrollWidth).to.be.at.most(controls().clientWidth);

    // and close stays fully in view, even when the chat is narrow
    chat.style.width = '260px';
    chat.style.flexGrow = '0';
    await chat.updateComplete;
    const rowRect = controls().getBoundingClientRect();
    const closeRect = controls()
      .querySelector('temba-button')
      .getBoundingClientRect();
    expect(closeRect.right).to.be.at.most(rowRect.right);

    chat.style.width = '';
    chat.style.flexGrow = '';
    await chat.updateComplete;
    await assertScreenshot('contacts/chat-ticket-long-topic', getClip(chat));
  });
});
