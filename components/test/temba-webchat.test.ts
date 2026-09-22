import { expect } from '@open-wc/testing';
import { SinonStub, stub as sinonStub, useFakeTimers } from 'sinon';
import { WebChat } from '../src/webchat/WebChat';
import { Chat } from '../src/display/Chat';
import {
  DEFAULT_FREQUENT,
  EMOJI,
  EMOJI_COOKIE,
  MAX_FREQUENT,
  MAX_SEARCH_RESULTS,
  getFrequentEmoji,
  recordEmojiUse,
  searchEmoji
} from '../src/webchat/emoji';
import { getCookie } from '../src/utils';
import {
  ConnectionState,
  setSocketProvider,
  SocketProvider
} from '../src/live/SocketService';
import {
  assertScreenshot,
  clearMockGets,
  clearMockPosts,
  getComponent,
  mockGET,
  mockNow,
  mockPOST,
  MockSocketProvider
} from '../test/utils.test';

const TAG = 'temba-webchat';
const CHANNEL = 'e3b643b7-c5a7-43b2-a08c-06749a8d9ad8';
const CHAT_ID = 'AbCdEfGhIjKlMnOpQrStUvWx';
const SOCKET = `chat:${CHANNEL}:${CHAT_ID}`;
const COOKIE = `temba-chat-${CHANNEL}`;

const START_URL = new RegExp(`/c/wch/${CHANNEL}/start$`);
const RECEIVE_URL = new RegExp(`/c/wch/${CHANNEL}/receive$`);
const UPLOAD_URL = new RegExp(`/c/wch/${CHANNEL}/upload$`);
const HISTORY_URL = new RegExp(`/c/wch/${CHANNEL}/history\\?`);
const HISTORY_PAGE_URL = new RegExp(`/c/wch/${CHANNEL}/history\\?.*before=`);

let clock: any;
let mockedNow: SinonStub;
let mockSocket: MockSocketProvider;
let previousProvider: SocketProvider;

// a fake cookie jar so a chat remembered by one test doesn't leak into the next
let cookies: string[] = [];
const installCookieJar = (initial: string[] = []) => {
  cookies = [...initial];
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => cookies.join('; '),
    set: (value: string) => {
      const pair = value.split(';')[0];
      const name = pair.split('=')[0];
      cookies = cookies.filter((c) => c.split('=')[0] !== name);
      cookies.push(pair);
    }
  });
};

const removeCookieJar = () => {
  delete (document as any).cookie;
};

// real time, so mocked http roundtrips can complete while the clock is faked
const realSetTimeout = window.setTimeout.bind(window);
const settle = async (predicate: () => boolean, attempts = 300) => {
  for (let i = 0; i < attempts; i++) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
    clock.tick(20);
    if (predicate()) {
      return;
    }
  }
  throw new Error('condition never met');
};

// the requests the widget has made to a courier endpoint
const requestsTo = (url: RegExp) => {
  return (window.fetch as SinonStub)
    .getCalls()
    .filter((call) => url.test(call.args[0]))
    .map((call) => ({
      url: call.args[0] as string,
      init: (call.args[1] || {}) as RequestInit
    }));
};

const bodyOf = (request: { init: RequestInit }) => {
  return JSON.parse(request.init.body as string);
};

const msgOut = (uuid: string, text: string, extra: any = {}) => {
  return {
    type: 'msg_out',
    created_on: '2021-03-30T10:00:00Z',
    msg_uuid: uuid,
    text,
    ...extra
  };
};

const msgIn = (uuid: string, text: string, extra: any = {}) => {
  return {
    type: 'msg_in',
    created_on: '2021-03-30T10:00:00Z',
    msg_uuid: uuid,
    text,
    ...extra
  };
};

const getWebChat = async (attrs: any = {}) => {
  const webChat = (await getComponent(
    TAG,
    { channel: CHANNEL, ...attrs },
    '',
    400,
    600
  )) as WebChat;

  // no open/close animation, so screenshots aren't taken mid-transition
  webChat.style.setProperty('--toggle-speed', '0ms');
  await webChat.updateComplete;
  return webChat;
};

const getChat = (webChat: WebChat): Chat => {
  return webChat.shadowRoot.querySelector('temba-chat') as Chat;
};

const getEmojiButton = (
  webChat: WebChat,
  within: string,
  emoji: string
): HTMLElement => {
  return Array.from(
    webChat.shadowRoot.querySelectorAll(`${within} .emoji`)
  ).find((el) => el.textContent.trim() === emoji) as HTMLElement;
};

const hasMessage = (webChat: WebChat, uuid: string): boolean => {
  return getChat(webChat).messageExists({ uuid } as any);
};

// opens the widget and waits for it to be chatting
const openWebChat = async (attrs: any = {}) => {
  const webChat = await getWebChat(attrs);
  webChat.open = true;
  await settle(() => webChat.status === ConnectionState.Connected);
  await webChat.updateComplete;
  return webChat;
};

// the widget's own box is empty - its panel and launcher float over the page -
// so screenshots clip to whichever of those are showing
const getWidgetClip = (webChat: WebChat) => {
  const rects = ['.launcher', ...(webChat.open ? ['.panel'] : [])].map(
    (selector) =>
      webChat.shadowRoot.querySelector(selector).getBoundingClientRect()
  );
  const padding = 10;
  const left = Math.min(...rects.map((r) => r.left)) - padding;
  const top = Math.min(...rects.map((r) => r.top)) - padding;
  const right = Math.max(...rects.map((r) => r.right)) + padding;
  const bottom = Math.max(...rects.map((r) => r.bottom)) + padding;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    left,
    top,
    right,
    bottom
  };
};

const getInput = (webChat: WebChat): HTMLInputElement => {
  return webChat.shadowRoot.querySelector('.input') as HTMLInputElement;
};

const typeMessage = async (webChat: WebChat, text: string) => {
  const input = getInput(webChat);
  input.value = text;
  input.dispatchEvent(new Event('input'));
  await webChat.updateComplete;
};

const pressEnter = async (webChat: WebChat) => {
  getInput(webChat).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter' })
  );
  await webChat.updateComplete;
};

describe('temba-webchat', () => {
  beforeEach(() => {
    mockedNow = mockNow('2021-03-31T00:31:00.000-00:00');
    clock = useFakeTimers({
      shouldAdvanceTime: true,
      advanceTimeDelta: 10
    });
    installCookieJar();
    (window.fetch as SinonStub).resetHistory();

    mockSocket = new MockSocketProvider();
    previousProvider = setSocketProvider(mockSocket);

    mockPOST(START_URL, { chat_id: CHAT_ID });
    mockPOST(RECEIVE_URL, {
      message: 'Message Accepted',
      data: [{ type: 'msg', msg_uuid: 'sent-msg-uuid', text: 'x' }]
    });
  });

  afterEach(() => {
    setSocketProvider(previousProvider);
    clearMockGets();
    clearMockPosts();
    removeCookieJar();
    clock.restore();
    mockedNow.restore();
  });

  it('renders closed by default', async () => {
    const webChat = await getWebChat();

    expect(webChat.open).to.equal(false);
    expect(webChat.status).to.equal(ConnectionState.Disconnected);
    expect(requestsTo(START_URL).length).to.equal(0);
    expect(mockSocket.activeChannels()).to.deep.equal([]);

    await assertScreenshot('webchat/closed-widget', getWidgetClip(webChat));
  });

  it('starts a new chat when opened for the first time', async () => {
    const webChat = await openWebChat();

    // no chat to resume, so one was started
    expect(requestsTo(START_URL).length).to.equal(1);
    expect(requestsTo(HISTORY_URL).length).to.equal(0);
    expect(webChat.chatId).to.equal(CHAT_ID);

    // remembered for next time, and its socket subscribed to
    expect(document.cookie).to.equal(`${COOKIE}=${CHAT_ID}`);
    expect(mockSocket.activeChannels()).to.deep.equal([SOCKET]);

    // the cursor is blinking, make it transparent for the screenshot
    const input = getInput(webChat);
    expect(input).to.exist;
    input.style.caretColor = 'transparent';
    await assertScreenshot('webchat/connected-state', getWidgetClip(webChat));
  });

  it('resumes a remembered chat with its history', async () => {
    installCookieJar([`${COOKIE}=${CHAT_ID}`]);
    mockGET(HISTORY_URL, {
      events: [
        msgOut('msg-3', 'Which one?', {
          quick_replies: [
            { type: 'text', text: 'Red' },
            { type: 'text', text: 'Blue' },
            { type: 'location' }
          ]
        }),
        msgIn('msg-2', 'I would like to order a hat'),
        msgOut('msg-1', 'Hi there, how can we help?', {
          user: { uuid: 'user-1', name: 'Bob McBob' }
        })
      ]
    });

    const webChat = await openWebChat();

    // resumed rather than started
    expect(requestsTo(START_URL).length).to.equal(0);
    expect(requestsTo(HISTORY_URL).length).to.equal(1);
    expect(requestsTo(HISTORY_URL)[0].url).to.contain(`chat_id=${CHAT_ID}`);
    expect(mockSocket.activeChannels()).to.deep.equal([SOCKET]);

    await settle(() => hasMessage(webChat, 'msg-1'));
    expect(hasMessage(webChat, 'msg-2')).to.equal(true);
    expect(hasMessage(webChat, 'msg-3')).to.equal(true);

    // the newest message's text quick replies are offered
    expect(webChat.quickReplies).to.deep.equal(['Red', 'Blue']);
    await webChat.updateComplete;
    const buttons = webChat.shadowRoot.querySelectorAll('.quick-reply');
    expect(buttons.length).to.equal(2);

    // replies get an avatar like they do in the app's own chat, and one sent
    // by a user says who
    await getChat(webChat).updateComplete;
    const chatRoot = getChat(webChat).shadowRoot;
    expect(chatRoot.querySelectorAll('.avatar temba-user').length).to.equal(2);
    expect(chatRoot.querySelector('.bubble .name').textContent.trim()).to.equal(
      'Bob McBob'
    );
    expect(chatRoot.querySelector('temba-user').getAttribute('name')).to.equal(
      'Bob McBob'
    );

    // and no hover timestamps - a visitor doesn't need the app's detail
    expect(chatRoot.querySelectorAll('.popup').length).to.equal(0);

    getInput(webChat).style.caretColor = 'transparent';
    await assertScreenshot('webchat/with-messages', getWidgetClip(webChat));
  });

  it('starts over when the remembered chat is no longer valid', async () => {
    installCookieJar([`${COOKIE}=stale`]);
    mockGET(HISTORY_URL, { message: 'unknown chat id' }, {}, '400');

    const webChat = await openWebChat();

    expect(requestsTo(HISTORY_URL).length).to.equal(1);
    expect(requestsTo(START_URL).length).to.equal(1);
    expect(webChat.chatId).to.equal(CHAT_ID);
    expect(document.cookie).to.equal(`${COOKIE}=${CHAT_ID}`);
    expect(mockSocket.activeChannels()).to.deep.equal([SOCKET]);
  });

  it('reports a failure to connect and can retry', async () => {
    clearMockPosts();
    mockPOST(START_URL, { message: 'nope' }, {}, '500');

    const webChat = await getWebChat();
    webChat.open = true;
    await settle(() => webChat.status === ConnectionState.Disconnected);
    await webChat.updateComplete;

    expect(webChat.error).to.equal('Unable to connect to chat');
    expect(mockSocket.activeChannels()).to.deep.equal([]);
    const reconnect = webChat.shadowRoot.querySelector('.reconnect');
    expect(reconnect).to.exist;

    // then the platform comes back
    clearMockPosts();
    mockPOST(START_URL, { chat_id: CHAT_ID });
    (reconnect as HTMLElement).click();
    await settle(() => webChat.status === ConnectionState.Connected);

    expect(webChat.error).to.equal(null);
    expect(mockSocket.activeChannels()).to.deep.equal([SOCKET]);
  });

  it('shows live messages and their quick replies', async () => {
    const webChat = await openWebChat();

    mockSocket.serverPublish(SOCKET, {
      type: 'msg_out',
      created_on: '2021-03-31T00:30:00Z',
      msg_uuid: 'live-1',
      text: 'Are you still there?',
      quick_replies: [
        { type: 'text', text: 'Yes' },
        { type: 'text', text: 'No' }
      ]
    });

    await settle(() => hasMessage(webChat, 'live-1'));
    await settle(
      () => webChat.shadowRoot.querySelectorAll('.quick-reply').length === 2
    );

    // picking a quick reply sends it
    const yes = webChat.shadowRoot.querySelector('.quick-reply') as HTMLElement;
    yes.click();

    await settle(() => hasMessage(webChat, 'sent-msg-uuid'));
    const sent = requestsTo(RECEIVE_URL);
    expect(sent.length).to.equal(1);
    expect(bodyOf(sent[0])).to.deep.equal({
      chat_id: CHAT_ID,
      text: 'Yes',
      attachments: []
    });

    // which spends them
    expect(webChat.quickReplies).to.deep.equal([]);
  });

  it('sends typed messages', async () => {
    const webChat = await openWebChat();

    await typeMessage(webChat, 'Hello there');
    expect(webChat.hasPendingText).to.equal(true);

    await pressEnter(webChat);
    await settle(() => hasMessage(webChat, 'sent-msg-uuid'));

    const sent = requestsTo(RECEIVE_URL);
    expect(sent.length).to.equal(1);
    expect(sent[0].init.method).to.equal('POST');
    expect(bodyOf(sent[0])).to.deep.equal({
      chat_id: CHAT_ID,
      text: 'Hello there',
      attachments: []
    });

    expect(getInput(webChat).value).to.equal('');
    expect(webChat.hasPendingText).to.equal(false);

    // and they can keep typing without reaching for the mouse
    expect(webChat.shadowRoot.activeElement).to.equal(getInput(webChat));

    // nothing to send doesn't send anything
    await pressEnter(webChat);
    expect(requestsTo(RECEIVE_URL).length).to.equal(1);
  });

  it('treats a message the platform refused as unsent', async () => {
    const webChat = await openWebChat();

    // accepted-looking, but nothing was taken
    clearMockPosts();
    mockPOST(RECEIVE_URL, { message: 'Message Accepted', data: [] });

    await typeMessage(webChat, 'Hello there');
    await pressEnter(webChat);
    await settle(() => webChat.error !== null);

    expect(webChat.error).to.equal('Your message could not be sent');
    expect(getInput(webChat).value).to.equal('Hello there');
    expect(getChat(webChat).messageGroups.length).to.equal(0);
  });

  it('gives a message back when it fails to send', async () => {
    const webChat = await openWebChat();

    clearMockPosts();
    mockPOST(RECEIVE_URL, { message: 'nope' }, {}, '500');

    await typeMessage(webChat, 'Hello there');
    await pressEnter(webChat);
    await settle(() => webChat.error !== null);

    expect(webChat.error).to.equal('Your message could not be sent');
    expect(getInput(webChat).value).to.equal('Hello there');
    expect(webChat.hasPendingText).to.equal(true);
    expect(webChat.shadowRoot.activeElement).to.equal(getInput(webChat));
  });

  it('pages back through history', async () => {
    installCookieJar([`${COOKIE}=${CHAT_ID}`]);

    // the first page points at the one before it
    mockGET(HISTORY_PAGE_URL, {
      events: [msgOut('older-1', 'Welcome!')]
    });
    mockGET(HISTORY_URL, {
      events: [msgIn('newer-2', 'Thanks'), msgOut('newer-1', 'Hello')],
      next: 'newer-1'
    });

    const webChat = await openWebChat();
    await settle(() => hasMessage(webChat, 'newer-1'));

    // the chat asks for more when it can't scroll, otherwise on scrolling up
    webChat.fetchPreviousMessages();
    await settle(() => hasMessage(webChat, 'older-1'));

    const pages = requestsTo(HISTORY_PAGE_URL);
    expect(pages.length).to.equal(1);
    expect(pages[0].url).to.contain('before=newer-1');

    // and that was the last page
    await settle(() => webChat.blockHistoryFetching === false);
    webChat.fetchPreviousMessages();
    await settle(() => webChat.blockHistoryFetching === false);
    expect(requestsTo(HISTORY_URL).length).to.equal(2);
  });

  it('recovers missed messages when the socket resubscribes', async () => {
    const webChat = await openWebChat();
    expect(requestsTo(HISTORY_URL).length).to.equal(0);

    mockGET(HISTORY_URL, {
      events: [
        msgOut('missed-2', 'Anyone home?', {
          quick_replies: [{ type: 'text', text: 'Yes' }]
        }),
        msgOut('missed-1', 'You still there?')
      ]
    });

    // the connection dropped and came back
    mockSocket.subs[0].onSubscribed();

    await settle(() => hasMessage(webChat, 'missed-2'));
    expect(hasMessage(webChat, 'missed-1')).to.equal(true);
    expect(requestsTo(HISTORY_URL).length).to.equal(1);
    expect(webChat.quickReplies).to.deep.equal(['Yes']);

    // while the panel was open, so nothing is unread
    expect(webChat.unread).to.equal(0);

    // recovered while closed, only the replies not already shown count
    webChat.open = false;
    await webChat.updateComplete;
    clearMockGets();
    mockGET(HISTORY_URL, {
      events: [
        msgOut('missed-3', 'Hello again'),
        msgOut('missed-2', 'Anyone home?'),
        msgOut('missed-1', 'You still there?')
      ]
    });
    mockSocket.subs[0].onSubscribed();
    await settle(() => hasMessage(webChat, 'missed-3'));
    expect(webChat.unread).to.equal(1);
  });

  it('opens a connection of its own to a platform on another origin', async () => {
    const own = new MockSocketProvider();
    const disconnect = sinonStub();
    const created: string[] = [];
    const createStub = sinonStub(
      WebChat.prototype,
      'createSocketManager'
    ).callsFake((url: string) => {
      created.push(url);
      return Object.assign(own, { disconnect }) as any;
    });

    try {
      const webChat = await openWebChat({
        host: 'https://platform.example.com'
      });

      // the widget's own connection, to the platform, not the page's
      expect(created).to.deep.equal(['wss://platform.example.com/ws/connect']);
      expect(own.activeChannels()).to.deep.equal([SOCKET]);
      expect(mockSocket.activeChannels()).to.deep.equal([]);

      // and its requests go there too
      expect(requestsTo(START_URL)[0].url).to.equal(
        `https://platform.example.com/c/wch/${CHANNEL}/start`
      );

      // leaving the page closes it
      webChat.remove();
      expect(own.activeChannels()).to.deep.equal([]);
      expect(disconnect.calledOnce).to.equal(true);
    } finally {
      createStub.restore();
    }
  });

  it('uploads attachments and sends them with the next message', async () => {
    const webChat = await openWebChat();
    const attachment =
      'image/jpeg:https://storage.example.com/attachments/1/hat.jpg';
    mockPOST(UPLOAD_URL, { attachment });

    await webChat.uploadFiles([
      new File(['hat'], 'hat.jpg', { type: 'image/jpeg' })
    ]);
    await webChat.updateComplete;

    const uploads = requestsTo(UPLOAD_URL);
    expect(uploads.length).to.equal(1);
    const form = uploads[0].init.body as FormData;
    expect(form.get('chat_id')).to.equal(CHAT_ID);
    expect((form.get('file') as File).name).to.equal('hat.jpg');

    expect(webChat.attachments).to.deep.equal([attachment]);
    const chip = webChat.shadowRoot.querySelector('.attachment .name');
    expect(chip.textContent).to.equal('hat.jpg');

    await typeMessage(webChat, 'Like this one');
    await pressEnter(webChat);
    await settle(() => hasMessage(webChat, 'sent-msg-uuid'));

    expect(bodyOf(requestsTo(RECEIVE_URL)[0])).to.deep.equal({
      chat_id: CHAT_ID,
      text: 'Like this one',
      attachments: [attachment]
    });
    expect(webChat.attachments).to.deep.equal([]);
  });

  it('reports a rejected upload and can drop pending attachments', async () => {
    const webChat = await openWebChat();
    mockPOST(UPLOAD_URL, { message: 'unsupported file type' }, {}, '400');

    // a file the browser can't put a type to is left for courier to sniff
    await webChat.uploadFiles([new File(['zip'], 'archive.zip', { type: '' })]);
    expect(requestsTo(UPLOAD_URL).length).to.equal(1);
    expect(webChat.error).to.equal('File type not supported');
    expect(webChat.attachments).to.deep.equal([]);

    // one it can isn't sent at all
    await webChat.uploadFiles([
      new File(['zip'], 'archive.zip', { type: 'application/zip' })
    ]);
    expect(requestsTo(UPLOAD_URL).length).to.equal(1);
    expect(webChat.error).to.equal('File type not supported');

    webChat.attachments = [
      'application/pdf:https://storage.example.com/a/b/doc.pdf'
    ];
    await webChat.updateComplete;
    const remove = webChat.shadowRoot.querySelector('.attachment .remove');
    (remove as HTMLElement).click();
    await webChat.updateComplete;
    expect(webChat.attachments).to.deep.equal([]);
  });

  it('opens the file picker from the attach button', async () => {
    const webChat = await openWebChat();
    const fileInput = webChat.shadowRoot.querySelector(
      '.file-input'
    ) as HTMLInputElement;

    // the picker is the default action of the click on the file input, so
    // nothing the click bubbles through can be allowed to cancel it
    let click: Event = null;
    fileInput.addEventListener('click', (event) => (click = event));
    (webChat.shadowRoot.querySelector('.attach') as HTMLElement).click();

    expect(click).to.not.equal(null);
    expect(click.defaultPrevented).to.equal(false);

    // and the files it comes back with are uploaded
    const attachment =
      'image/jpeg:https://storage.example.com/attachments/1/hat.jpg';
    mockPOST(UPLOAD_URL, { attachment });
    const files = new DataTransfer();
    files.items.add(new File(['hat'], 'hat.jpg', { type: 'image/jpeg' }));
    fileInput.files = files.files;
    fileInput.dispatchEvent(new Event('change'));

    await settle(() => webChat.attachments.length === 1);
    expect(webChat.attachments).to.deep.equal([attachment]);
  });

  it('attaches files dropped on the panel', async () => {
    const webChat = await openWebChat();
    const attachment =
      'image/jpeg:https://storage.example.com/attachments/1/hat.jpg';
    mockPOST(UPLOAD_URL, { attachment });
    const panel = webChat.shadowRoot.querySelector('.panel') as HTMLElement;

    const files = new DataTransfer();
    files.items.add(new File(['hat'], 'hat.jpg', { type: 'image/jpeg' }));
    const drag = (type: string, target: Element = panel) => {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: files
      });
      target.dispatchEvent(event);
      return event;
    };

    // the drag is claimed when it comes in, and the drop zone shows
    expect(drag('dragenter').defaultPrevented).to.equal(true);
    await webChat.updateComplete;
    expect(webChat.shadowRoot.querySelector('.dropzone')).to.exist;
    expect(drag('dragover').defaultPrevented).to.equal(true);

    // passing over the panel's children doesn't end it
    drag('dragenter', webChat.shadowRoot.querySelector('.body'));
    drag('dragleave', webChat.shadowRoot.querySelector('.body'));
    expect(webChat.dragging).to.equal(true);

    // leaving the panel altogether does
    drag('dragleave');
    await webChat.updateComplete;
    expect(webChat.dragging).to.equal(false);
    expect(webChat.shadowRoot.querySelector('.dropzone')).to.not.exist;

    drag('dragenter');
    expect(drag('drop').defaultPrevented).to.equal(true);
    await settle(() => webChat.attachments.length === 1);
    expect(webChat.dragging).to.equal(false);
    expect(webChat.attachments).to.deep.equal([attachment]);

    // text dragged off the page isn't ours
    const text = new DataTransfer();
    text.setData('text/plain', 'hello');
    const event = new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: text
    });
    panel.dispatchEvent(event);
    expect(event.defaultPrevented).to.equal(false);
    expect(webChat.dragging).to.equal(false);
  });

  it('does not take dropped files while disconnected', async () => {
    const webChat = await openWebChat();
    mockSocket.setConnectionState(ConnectionState.Disconnected);
    await settle(() => webChat.status === ConnectionState.Disconnected);
    mockPOST(UPLOAD_URL, { attachment: 'image/jpeg:https://x/hat.jpg' });

    const files = new DataTransfer();
    files.items.add(new File(['hat'], 'hat.jpg', { type: 'image/jpeg' }));
    const panel = webChat.shadowRoot.querySelector('.panel');
    const drag = (type: string) => {
      const event = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: files
      });
      panel.dispatchEvent(event);
      return event;
    };

    // the drag is still claimed - an unclaimed drop would have the browser
    // open the file in place of the page - but shown as not allowed
    expect(drag('dragenter').defaultPrevented).to.equal(true);
    await webChat.updateComplete;
    expect(webChat.dragging).to.equal(false);
    expect(webChat.shadowRoot.querySelector('.dropzone')).to.not.exist;
    const over = drag('dragover');
    expect(over.defaultPrevented).to.equal(true);
    expect(over.dataTransfer.dropEffect).to.equal('none');

    // and a drop goes nowhere
    expect(drag('drop').defaultPrevented).to.equal(true);
    await webChat.updateComplete;
    expect(requestsTo(UPLOAD_URL).length).to.equal(0);
    expect(webChat.attachments).to.deep.equal([]);
  });

  it('searches the emoji catalog', async () => {
    const webChat = await openWebChat();
    webChat.openEmojiPicker();
    await webChat.updateComplete;

    const search = webChat.shadowRoot.querySelector(
      '.emoji-search'
    ) as HTMLInputElement;
    expect(webChat.shadowRoot.activeElement).to.equal(search);

    const type = async (value: string) => {
      search.value = value;
      search.dispatchEvent(new Event('input'));
      await webChat.updateComplete;
    };

    // results take the place of the shortcuts and the browsing grid, and
    // reach past what's offered for browsing
    await type('zzz');
    expect(webChat.shadowRoot.querySelector('.emoji-grid.frequent')).to.not
      .exist;
    const results = Array.from(
      webChat.shadowRoot.querySelectorAll('.emoji-grid.results .emoji')
    ).map((el) => el.textContent.trim());
    expect(results).to.deep.equal(['💤']);
    expect(EMOJI.includes('💤')).to.equal(false);

    await type('xyzzy');
    expect(
      webChat.shadowRoot.querySelector('.emoji-empty').textContent.trim()
    ).to.equal('No emoji found');

    // enter takes the first result and clears the search
    await type('fire');
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await webChat.updateComplete;
    expect(getInput(webChat).value).to.equal('🔥');
    expect(webChat.emojiQuery).to.equal('');
    expect(webChat.emojiOpen).to.equal(true);
    expect(webChat.shadowRoot.querySelector('.emoji-grid.frequent')).to.exist;

    // escape clears a search before it closes the picker
    await type('cat');
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    await webChat.updateComplete;
    expect(webChat.emojiQuery).to.equal('');
    expect(webChat.emojiOpen).to.equal(true);
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(webChat.emojiOpen).to.equal(false);
  });

  it('inserts emoji where the cursor is', async () => {
    const webChat = await openWebChat();
    expect(webChat.shadowRoot.querySelector('.emoji-picker')).to.not.exist;

    const toggle = webChat.shadowRoot.querySelector(
      '.emoji-toggle'
    ) as HTMLElement;
    toggle.click();
    await webChat.updateComplete;
    expect(webChat.shadowRoot.querySelector('.emoji-picker')).to.exist;
    expect(toggle.getAttribute('aria-expanded')).to.equal('true');

    await typeMessage(webChat, 'Thanks!');
    const input = getInput(webChat);
    input.setSelectionRange(6, 6);

    // the picker stays up so they can add more than one
    getEmojiButton(webChat, '.emoji-scroll', '🎉').click();
    getEmojiButton(webChat, '.emoji-scroll', '🙏').click();
    await webChat.updateComplete;
    expect(input.value).to.equal('Thanks🎉🙏!');
    expect(input.selectionStart).to.equal(10);
    expect(webChat.emojiOpen).to.equal(true);

    // an emoji on its own is something to send
    input.value = '';
    webChat.hasPendingText = false;
    webChat.insertEmoji('👍');
    expect(webChat.hasPendingText).to.equal(true);

    // sending puts the picker away
    await pressEnter(webChat);
    await settle(() => hasMessage(webChat, 'sent-msg-uuid'));
    expect(bodyOf(requestsTo(RECEIVE_URL)[0]).text).to.equal('👍');
    expect(webChat.emojiOpen).to.equal(false);
  });

  it('closes the emoji picker on escape or a press elsewhere', async () => {
    const webChat = await openWebChat();

    webChat.openEmojiPicker();
    await webChat.updateComplete;
    getInput(webChat).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    expect(webChat.emojiOpen).to.equal(false);

    // a press inside the picker isn't a press elsewhere
    webChat.openEmojiPicker();
    await webChat.updateComplete;
    webChat.shadowRoot
      .querySelector('.emoji-label')
      .dispatchEvent(
        new Event('pointerdown', { bubbles: true, composed: true })
      );
    expect(webChat.emojiOpen).to.equal(true);

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await webChat.updateComplete;
    expect(webChat.emojiOpen).to.equal(false);
    expect(webChat.shadowRoot.querySelector('.emoji-picker')).to.not.exist;

    // nor does it outlive the panel
    webChat.openEmojiPicker();
    webChat.open = false;
    await webChat.updateComplete;
    expect(webChat.emojiOpen).to.equal(false);
  });

  it('offers the emoji used most as shortcuts', async () => {
    const webChat = await openWebChat();

    const getShortcuts = async () => {
      webChat.closeEmojiPicker();
      webChat.openEmojiPicker();
      await webChat.updateComplete;
      return Array.from(
        webChat.shadowRoot.querySelectorAll('.emoji-grid.frequent .emoji')
      ).map((el) => el.textContent.trim());
    };

    // nothing used yet, so the defaults
    expect(await getShortcuts()).to.deep.equal(DEFAULT_FREQUENT);

    webChat.insertEmoji('🔥');
    webChat.insertEmoji('☕');
    webChat.insertEmoji('🔥');
    webChat.insertEmoji('👍');

    // shortcuts hold still while the picker is open
    expect(webChat.frequentEmoji).to.deep.equal(DEFAULT_FREQUENT);

    // most used first, then most recent, then defaults not already there
    expect(await getShortcuts()).to.deep.equal([
      '🔥',
      '👍',
      '☕',
      '❤️',
      '😂',
      '😊',
      '🙏',
      '🎉'
    ]);

    // it's remembered in a cookie, which a new widget picks up
    expect(JSON.parse(getCookie(EMOJI_COOKIE))).to.deep.equal([
      ['👍', 1],
      ['🔥', 2],
      ['☕', 1]
    ]);
    expect(getFrequentEmoji().slice(0, 3)).to.deep.equal(['🔥', '👍', '☕']);
  });

  it('ignores an emoji cookie it did not write', async () => {
    installCookieJar([
      `${EMOJI_COOKIE}=${encodeURIComponent(
        JSON.stringify([
          ['<b>', 50],
          ['🔥', 'lots'],
          ['☕', 2],
          ['☕', 9],
          'nope',
          ['✨', -1]
        ])
      )}`
    ]);
    expect(getFrequentEmoji()).to.deep.equal([
      '☕',
      ...DEFAULT_FREQUENT.slice(0, MAX_FREQUENT - 1)
    ]);

    installCookieJar([`${EMOJI_COOKIE}=not%20json`]);
    expect(getFrequentEmoji()).to.deep.equal(DEFAULT_FREQUENT);

    // something that isn't one of ours isn't counted either
    recordEmojiUse('<b>');
    expect(getFrequentEmoji()).to.deep.equal(DEFAULT_FREQUENT);

    // but one from the wider catalog counts
    recordEmojiUse('💤');
    expect(getFrequentEmoji()[0]).to.equal('💤');
  });

  it('ranks emoji search results', async () => {
    // named exactly, then by name, then by shortcode, then anything matching
    expect(searchEmoji('fire').slice(0, 2)).to.deep.equal(['🔥', '🧑‍🚒']);
    expect(searchEmoji('+1')).to.deep.equal(['👍']);
    expect(searchEmoji('thumbs')).to.deep.equal(['👍', '👎']);
    expect(searchEmoji('Red HEART')[0]).to.equal('❤️');

    // every word has to match, at the start of a word
    expect(searchEmoji('flag canada')).to.deep.equal(['🇨🇦']);
    expect(searchEmoji('anada')).to.deep.equal([]);
    expect(searchEmoji('   ')).to.deep.equal([]);
    expect(searchEmoji('face').length).to.equal(MAX_SEARCH_RESULTS);
  });

  it('keeps the emoji cookie to a bounded size', async () => {
    installCookieJar();
    recordEmojiUse('🔥');
    recordEmojiUse('🔥');
    EMOJI.slice(0, 40).forEach((emoji) => recordEmojiUse(emoji));

    const usage = JSON.parse(getCookie(EMOJI_COOKIE));
    expect(usage.length).to.equal(24);

    // the well used one survives the churn of single uses
    expect(usage.find((use: any) => use[0] === '🔥')).to.deep.equal(['🔥', 2]);
    expect(usage[0][0]).to.equal(EMOJI[39]);
    expect(document.cookie.length).to.be.lessThan(2048);
  });

  it('shows a notice while disconnected', async () => {
    const webChat = await openWebChat();

    mockSocket.setConnectionState(ConnectionState.Disconnected);
    await settle(() => webChat.status === ConnectionState.Disconnected);
    await webChat.updateComplete;

    expect(getInput(webChat).disabled).to.equal(true);
    expect(webChat.shadowRoot.querySelector('.reconnect')).to.exist;
    expect(
      webChat.shadowRoot.querySelector('.presence').textContent.trim()
    ).to.equal('Offline');

    await assertScreenshot(
      'webchat/disconnected-state',
      getWidgetClip(webChat)
    );

    mockSocket.setConnectionState(ConnectionState.Connected);
    await settle(() => webChat.status === ConnectionState.Connected);
    await webChat.updateComplete;
    expect(getInput(webChat).disabled).to.equal(false);
    expect(webChat.shadowRoot.querySelector('.reconnect')).to.not.exist;
  });

  it('closes and reopens without starting over', async () => {
    const webChat = await openWebChat();

    const close = webChat.shadowRoot.querySelector('.close') as HTMLElement;
    close.click();
    await webChat.updateComplete;
    expect(webChat.open).to.equal(false);

    webChat.openChat();
    await webChat.updateComplete;
    expect(webChat.open).to.equal(true);
    expect(requestsTo(START_URL).length).to.equal(1);
    expect(mockSocket.activeChannels()).to.deep.equal([SOCKET]);
  });

  it('counts replies that arrive while closed', async () => {
    const webChat = await openWebChat();

    // an empty conversation invites the first message
    expect(webChat.shadowRoot.querySelector('.empty')).to.exist;

    webChat.open = false;
    await webChat.updateComplete;

    mockSocket.serverPublish(SOCKET, msgOut('while-closed', 'Still there?'));
    mockSocket.serverPublish(SOCKET, msgOut('while-closed-2', 'Hello?'));
    await settle(() => webChat.unread === 2);
    await webChat.updateComplete;

    expect(webChat.shadowRoot.querySelector('.badge').textContent).to.equal(
      '2'
    );
    expect(webChat.shadowRoot.querySelector('.empty')).to.not.exist;

    // opening the panel reads them
    webChat.open = true;
    await webChat.updateComplete;
    expect(webChat.unread).to.equal(0);
    expect(webChat.shadowRoot.querySelector('.badge')).to.not.exist;
  });

  it('tears down its subscription when removed from the page', async () => {
    const webChat = await openWebChat();
    expect(mockSocket.activeChannels()).to.deep.equal([SOCKET]);

    webChat.remove();
    expect(mockSocket.activeChannels()).to.deep.equal([]);
  });
});
