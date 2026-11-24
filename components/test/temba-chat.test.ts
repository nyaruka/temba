import '../temba-modules';
import { fixture, assert } from '@open-wc/testing';
import { useFakeTimers } from 'sinon';
import {
  Chat,
  ContactEvent,
  MsgEvent,
  ObjectReference,
  TypingEvent
} from '../src/display/Chat';
import { TembaUser } from '../src/display/TembaUser';
import { clearMockGets, mockGET, removeSharedSheet } from './utils.test';

const createChat = async (attrs = ''): Promise<Chat> => {
  return (await fixture(
    `<temba-chat agent avatars ${attrs}></temba-chat>`
  )) as Chat;
};

const received = (uuid: string, text: string): ContactEvent =>
  ({
    uuid,
    type: 'msg_received',
    created_on: new Date(),
    msg: { text }
  }) as ContactEvent;

const USER_ANDY = { uuid: 'user-andy', name: 'Andy', email: 'andy@x.com' };
const USER_BOB = { uuid: 'user-bob', name: 'Bob', email: 'bob@x.com' };

const sent = (uuid: string, text: string, user = USER_ANDY): ContactEvent =>
  ({
    uuid,
    type: 'msg_created',
    created_on: new Date(),
    _user: user,
    msg: { text }
  }) as ContactEvent;

const typing = (uuid: string, user: any = USER_ANDY): TypingEvent =>
  ({
    uuid,
    type: 'typing_started',
    created_on: new Date(),
    _user: user,
    direction: user ? 'outgoing' : 'incoming'
  }) as TypingEvent;

const getAvatar = async (chat: Chat): Promise<TembaUser> => {
  await chat.updateComplete;
  const user = chat.shadowRoot.querySelector('temba-user') as TembaUser;
  if (user) {
    await user.updateComplete;
  }
  return user;
};

describe('temba-chat contact avatars', () => {
  it('renders a name-based avatar for a contact message when contactName is set', async () => {
    const chat = await createChat(
      'contactname="Jane Doe" contactuuid="contact-1"'
    );
    chat.loadMessages([received('msg-1', 'hello there')]);

    const user = await getAvatar(chat);
    assert.instanceOf(user, TembaUser);
    assert.isNotOk(user.system);
    assert.equal(user.name, 'Jane Doe');
    assert.equal(user.initials, 'JD');
    assert.isNull(user.bgimage);
  });

  it('renders the contact icon for a nameless contact message', async () => {
    const chat = await createChat('contactuuid="contact-1"');
    chat.loadMessages([received('msg-1', 'hello there')]);

    const user = await getAvatar(chat);
    assert.instanceOf(user, TembaUser);
    assert.isNotOk(user.system);
    assert.equal(user.initials, '');
    assert.isNull(user.bgimage);
    assert.isNotNull(user.shadowRoot.querySelector('temba-icon'));
  });

  it('renders the system avatar for a contact message with no contact identity', async () => {
    const chat = await createChat();
    chat.loadMessages([received('msg-1', 'hello there')]);

    const user = await getAvatar(chat);
    assert.instanceOf(user, TembaUser);
    assert.isTrue(user.system);
    assert.isNotNull(user.bgimage);
  });
});

describe('temba-chat typing indicators', () => {
  let clock: any;

  beforeEach(() => {
    clock = useFakeTimers();
  });

  afterEach(() => {
    clock.restore();
  });

  it('renders a typing bubble with animated dots', async () => {
    const chat = await createChat();
    chat.setTyping(typing('typing-1'));
    await chat.updateComplete;

    const row = chat.shadowRoot.querySelector('.row.typing');
    assert.isNotNull(row);
    assert.isNotNull(row.querySelector('.typing-dots'));
    assert.equal(row.querySelectorAll('.typing-dots span').length, 3);
  });

  it('groups with messages from the same user', async () => {
    const chat = await createChat();
    chat.loadMessages([sent('msg-1', 'hello')]);
    chat.setTyping(typing('typing-1'));
    await chat.updateComplete;

    assert.equal(chat.messageGroups.length, 1);
    assert.deepEqual(chat.messageGroups[0].messages, ['msg-1', 'typing-1']);
  });

  it('starts its own group for a different author', async () => {
    const chat = await createChat();
    chat.loadMessages([sent('msg-1', 'hello')]);
    chat.setTyping(typing('typing-1', USER_BOB));
    await chat.updateComplete;

    assert.equal(chat.messageGroups.length, 2);
    assert.deepEqual(chat.messageGroups[0].messages, ['typing-1']);
  });

  it('groups contact typing with contact messages', async () => {
    const chat = await createChat();
    chat.loadMessages([received('msg-1', 'hello')]);
    chat.setTyping(typing('typing-1', null));
    await chat.updateComplete;

    assert.equal(chat.messageGroups.length, 1);
    assert.deepEqual(chat.messageGroups[0].messages, ['msg-1', 'typing-1']);
  });

  it('shows one indicator per author across repeat pulses', async () => {
    const chat = await createChat();
    chat.setTyping(typing('typing-1'));
    chat.setTyping(typing('typing-2'));
    await chat.updateComplete;

    assert.equal(chat.shadowRoot.querySelectorAll('.row.typing').length, 1);
  });

  it('clears on clearTyping and drops the empty group', async () => {
    const chat = await createChat();
    chat.setTyping(typing('typing-1'));
    await chat.updateComplete;
    assert.isNotNull(chat.shadowRoot.querySelector('.row.typing'));

    chat.clearTyping(typing('typing-2'));
    await chat.updateComplete;

    assert.isNull(chat.shadowRoot.querySelector('.row.typing'));
    assert.equal(chat.messageGroups.length, 0);
  });

  it('decays without fresh pulses', async () => {
    const chat = await createChat();
    chat.setTyping(typing('typing-1'));
    await chat.updateComplete;

    // a fresh pulse extends the indicator's life
    clock.tick(6000);
    chat.setTyping(typing('typing-2'));
    clock.tick(6000);
    await chat.updateComplete;
    assert.isNotNull(chat.shadowRoot.querySelector('.row.typing'));

    // but with no pulses it decays
    clock.tick(4001);
    await chat.updateComplete;
    assert.isNull(chat.shadowRoot.querySelector('.row.typing'));
  });

  it('is replaced by a message from the same author', async () => {
    const chat = await createChat();
    chat.setTyping(typing('typing-1'));
    await chat.updateComplete;

    chat.addMessages([sent('msg-1', 'here it is')], null, true);
    clock.tick(500);
    await chat.updateComplete;

    assert.isNull(chat.shadowRoot.querySelector('.row.typing'));
    assert.equal(chat.messageGroups.length, 1);
    assert.deepEqual(chat.messageGroups[0].messages, ['msg-1']);
  });

  it('floats below messages appended from other authors', async () => {
    const chat = await createChat();
    chat.setTyping(typing('typing-1'));
    await chat.updateComplete;

    chat.addMessages([received('msg-1', 'hello')], null, true);
    clock.tick(500);
    await chat.updateComplete;

    // the indicator is still showing and is the newest thing in the chat
    assert.isNotNull(chat.shadowRoot.querySelector('.row.typing'));
    assert.equal(chat.messageGroups.length, 2);
    assert.deepEqual(chat.messageGroups[0].messages, ['typing-1']);
    assert.deepEqual(chat.messageGroups[1].messages, ['msg-1']);
  });

  it('clears typing state on reset', async () => {
    const chat = await createChat();
    chat.setTyping(typing('typing-1'));
    await chat.updateComplete;

    chat.reset();
    await chat.updateComplete;
    assert.isNull(chat.shadowRoot.querySelector('.row.typing'));

    // the decay timer was cancelled too - no errors when it would have fired
    clock.tick(20000);
    assert.equal(chat.messageGroups.length, 0);
  });
});

describe('temba-chat channel logs', () => {
  const CHANNEL: ObjectReference = { uuid: 'channel-1', name: 'Twilio' };

  afterEach(() => {
    clearMockGets();
    removeSharedSheet();
  });

  const withChannel = (event: ContactEvent): MsgEvent => {
    const msgEvent = event as MsgEvent;
    msgEvent.msg.channel = CHANNEL;
    return msgEvent;
  };

  const deleted = (msgUuid: string): ContactEvent =>
    ({
      uuid: 'event-1',
      type: 'msg_deleted',
      created_on: new Date(),
      msg_uuid: msgUuid,
      by_contact: true
    }) as unknown as ContactEvent;

  const getLogLink = async (chat: Chat): Promise<HTMLAnchorElement> => {
    await chat.updateComplete;
    return chat.shadowRoot.querySelector('.log-link') as HTMLAnchorElement;
  };

  it('links to the channel log for a message', async () => {
    const chat = await createChat();
    chat.showMessageLogsAfter = new Date(0);
    chat.loadMessages([withChannel(received('msg-1', 'hello there'))]);

    const link = await getLogLink(chat);
    assert.isNotNull(link);
    assert.equal(
      link.getAttribute('href'),
      '/channels/channel/logs/channel-1/msg/msg-1/'
    );

    mockGET(
      /\/channels\/channel\/logs\/channel-1\/msg\/msg-1\//,
      '<div id="log">a log</div>'
    );

    // the click is the link's alone, so the page doesn't take it as its own to navigate with
    const reached: Event[] = [];
    const listener = (e: Event) => reached.push(e);
    document.addEventListener('click', listener);

    try {
      // one asking for a new tab is left to the browser
      const modified = new MouseEvent('click', {
        bubbles: true,
        composed: true,
        cancelable: true,
        ctrlKey: true
      });
      // keep the test page from actually following the link
      link.addEventListener('click', (e) => e.ctrlKey && e.preventDefault(), {
        capture: true
      });
      link.dispatchEvent(modified);
      assert.isNull(document.querySelector('temba-sheet[data-shared]'));

      // any other opens the log in a sheet over the page rather than a tab of its own
      assert.isNull(link.getAttribute('target'));
      const click = new MouseEvent('click', {
        bubbles: true,
        composed: true,
        cancelable: true
      });
      link.dispatchEvent(click);
      assert.isTrue(click.defaultPrevented);
      assert.lengthOf(reached, 0);
    } finally {
      document.removeEventListener('click', listener);
    }

    const sheet = document.querySelector('temba-sheet[data-shared]') as any;
    assert.equal(
      sheet.current.endpoint,
      '/channels/channel/logs/channel-1/msg/msg-1/'
    );
  });

  it("doesn't link to the channel log for a deleted message", async () => {
    const chat = await createChat();
    chat.showMessageLogsAfter = new Date(0);

    const event = withChannel(received('msg-1', ''));
    event._deleted = {
      created_on: new Date().toISOString(),
      by_contact: true
    };
    chat.loadMessages([event]);

    assert.isNull(await getLogLink(chat));
  });

  it('removes the log link when a message is deleted while loaded', async () => {
    const chat = await createChat();
    chat.showMessageLogsAfter = new Date(0);
    const event = withChannel(received('msg-1', 'hello there'));
    chat.loadMessages([event]);

    assert.isNotNull(await getLogLink(chat));

    chat.loadMessages([deleted('msg-1')]);

    assert.isNull(await getLogLink(chat));
    assert.isNotNull(
      chat.shadowRoot.querySelector('.message-deleted'),
      'message should render as deleted'
    );
    assert.equal(event.msg.text, '');
  });

  it('applies a deletion that arrives before its message', async () => {
    const chat = await createChat();
    chat.showMessageLogsAfter = new Date(0);

    chat.loadMessages([deleted('msg-1')]);
    chat.loadMessages([withChannel(received('msg-1', 'hello there'))]);

    assert.isNull(await getLogLink(chat));
    assert.isNotNull(chat.shadowRoot.querySelector('.message-deleted'));
  });
});

describe('temba-chat failed messages', () => {
  const failed = (uuid: string, reason: string): ContactEvent => {
    const event = sent(uuid, 'hi there') as MsgEvent;
    event._status = {
      created_on: new Date().toISOString(),
      status: 'failed',
      reason: reason as MsgEvent['_status']['reason']
    };
    return event;
  };

  const getError = async (chat: Chat): Promise<string> => {
    await chat.updateComplete;
    return chat.shadowRoot
      .querySelector('.popup div[style*="--color-error"]')
      ?.textContent.trim();
  };

  it('describes why a message failed', async () => {
    const tests = [
      ['channel_removed', 'Channel was removed'],
      ['no_destination', 'No channel available to send message'],
      ['org_suspended', 'Workspace was suspended'],
      ['unknown', 'Message failed to send']
    ];

    for (const [reason, expected] of tests) {
      const chat = await createChat();
      chat.loadMessages([failed('msg-1', reason)]);
      assert.equal(await getError(chat), expected, reason);
    }
  });
});
