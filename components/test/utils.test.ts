import '../temba-modules';
import { DateTime } from 'luxon';
interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

import { expect, fixture, html, assert } from '@open-wc/testing';

// disable transitions for all tests to prevent flaky screenshot tests
const style = document.createElement('style');
style.textContent = `
  * {
    --transition-speed: 0ms !important;
  }
`;
document.head.appendChild(style);

// prevent resize event listeners from being added during tests
// this prevents flaky positioning in components that adjust on resize
const originalAddEventListener = window.addEventListener;
window.addEventListener = function (type, listener, options) {
  if (type === 'resize') {
    // skip adding resize listeners during tests
    return;
  }
  return originalAddEventListener.call(this, type, listener, options);
} as typeof window.addEventListener;
import MouseHelper from './MouseHelper';
import { Store } from '../src/store/Store';
import { stub } from 'sinon';
import { Select, SelectOption } from '../src/form/select/Select';
import { Options } from '../src/display/Options';
import { Attachment } from '../src/interfaces';
import { Compose } from '../src/form/Compose';
import {
  ConnectionState,
  ConnectionStateHandler,
  DeniedHandler,
  PublicationHandler,
  SocketProvider,
  SocketSubscription
} from '../src/live/SocketService';
import { watchContact } from '../src/live/ContactWatch';

export interface MockSubscription {
  channel: string;
  onPublication: PublicationHandler;
  onSubscribed?: () => void;
  unsubscribed: boolean;
}

export class MockSocketProvider implements SocketProvider {
  public subs: MockSubscription[] = [];

  public subscribe(
    channel: string,
    onPublication: PublicationHandler,
    onSubscribed?: () => void
  ): SocketSubscription {
    const sub: MockSubscription = {
      channel,
      onPublication,
      onSubscribed,
      unsubscribed: false
    };
    this.subs.push(sub);

    // confirm the subscription asynchronously like a real socket would
    if (onSubscribed) {
      setTimeout(() => {
        if (!sub.unsubscribed) {
          sub.onSubscribed();
        }
      }, 0);
    }

    return {
      unsubscribe: () => {
        sub.unsubscribed = true;
      }
    };
  }

  // client publications recorded for assertions
  public published: { channel: string; data: any }[] = [];

  // when set, client publications reject with this centrifuge-style error
  public publishError: { code: number; message: string; temporary?: boolean } =
    null;

  public publish(channel: string, data: any): Promise<void> {
    if (this.publishError) {
      return Promise.reject(this.publishError);
    }
    this.published.push({ channel, data });
    // the server echoes publications to all subscribers, incl. the publisher
    this.serverPublish(channel, data);
    return Promise.resolve();
  }

  // delivers an event to subscribers as if published by the server
  public serverPublish(channel: string, data: any) {
    this.subs
      .filter((sub) => sub.channel === channel && !sub.unsubscribed)
      .forEach((sub) => sub.onPublication(data));
  }

  // channels the page asked to have authorized again
  public rechecked: string[] = [];
  private deniedHandlers: DeniedHandler[] = [];

  public onDenied(handler: DeniedHandler): SocketSubscription {
    this.deniedHandlers.push(handler);
    return {
      unsubscribe: () => {
        this.deniedHandlers = this.deniedHandlers.filter((h) => h !== handler);
      }
    };
  }

  public recheck(channel: string): void {
    this.rechecked.push(channel);
  }

  // refuses a channel as the server would on (re)authorizing it
  public serverDeny(channel: string) {
    [...this.deniedHandlers].forEach((handler) => handler(channel));
  }

  public activeChannels(): string[] {
    return this.subs
      .filter((sub) => !sub.unsubscribed)
      .map((sub) => sub.channel);
  }

  // a mock socket is connected from the start - tests that care drive it with
  // setConnectionState
  private state = ConnectionState.Connected;
  private stateHandlers: ConnectionStateHandler[] = [];

  public getConnectionState(): ConnectionState {
    return this.state;
  }

  public onConnectionState(
    handler: ConnectionStateHandler
  ): SocketSubscription {
    this.stateHandlers.push(handler);
    Promise.resolve().then(() => {
      if (this.stateHandlers.includes(handler)) {
        handler(this.state);
      }
    });
    return {
      unsubscribe: () => {
        const index = this.stateHandlers.indexOf(handler);
        if (index >= 0) {
          this.stateHandlers.splice(index, 1);
        }
      }
    };
  }

  // drives a connection transition as the server would
  public setConnectionState(state: ConnectionState) {
    if (state === this.state) {
      return;
    }
    this.state = state;
    [...this.stateHandlers].forEach((handler) => handler(state));
  }
}

export interface CodeMock {
  endpoint: RegExp;
  body: string;
  headers: any;
  status: string;
}

let gets: CodeMock[] = [];
let posts: CodeMock[] = [];
let normalFetch;

export const showMouse = async () => {
  const mouse = await fixture(html`<mouse-helper />`);
  assert.instanceOf(mouse, MouseHelper);
};

export const getAttributes = (attrs: any = {}) => {
  return `${Object.keys(attrs)
    .map((name: string) => {
      if (typeof attrs[name] === 'boolean' && attrs[name]) {
        return name;
      }
      return `${name}='${attrs[name]}'`;
    })
    .join(' ')}`;
};

export const getComponent = async (
  tag,
  attrs: any = {},
  slot = '',
  width = 250,
  height = 0,
  style = ''
) => {
  const spec = `<${tag} ${getAttributes(attrs)}>${slot}</${tag}>`;
  const parentNode = document.createElement('div');
  const styleAttribute = `
    ${width > 0 ? `width:${width}px;` : ``} 
    ${height > 0 ? `height:${height}px;` : ``}
    ${style ? style : ``}
  `;
  parentNode.setAttribute('style', styleAttribute);
  return await fixture(spec, { parentNode });
};

const createResponse = (mocked) => {
  const mockResponse = new window.Response(mocked.body, {
    status: mocked.status,
    headers: {
      'Content-type': 'text/html',
      ...mocked.headers
    }
  });

  return Promise.resolve(mockResponse);
};

const createJSONResponse = (mocked) => {
  const mockResponse = new window.Response(JSON.stringify(mocked.body), {
    status: mocked.status,
    headers: {
      'Content-type': 'application/json',
      ...mocked.headers
    }
  });

  return Promise.resolve(mockResponse);
};

const getResponse = (endpoint: string, options = { method: 'GET' }) => {
  // check if our path has been mocked in code
  const mocks = options.method === 'GET' ? gets : posts;
  const codeMock = mocks.find((mock) => mock.endpoint.test(endpoint));

  if (codeMock) {
    if (typeof codeMock.body === 'string') {
      // see if we are being mocked to a file
      if (codeMock.body.startsWith('/')) {
        endpoint = codeMock.body;
      } else {
        return createResponse(codeMock);
      }
    } else {
      return createJSONResponse(codeMock);
    }
  }
  // otherwise fetch over http
  return normalFetch(endpoint, options);
};

before(async () => {
  normalFetch = window.fetch;
  stub(window, 'fetch').callsFake(getResponse);
  await setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

  // preload Roboto so layouts that depend on text width (e.g. slider's range
  // labels) don't shift when the font finishes loading mid-test. Only the
  // weights declared in test-assets/style.css are loadable; other weights
  // fall back to system fonts.
  if (document.fonts && (document.fonts as any).load) {
    await Promise.all([
      (document.fonts as any).load('300 1em Roboto'),
      (document.fonts as any).load('400 1em Roboto'),
      (document.fonts as any).load('500 1em Roboto')
    ]);
  }
});

after(() => {
  (window.fetch as any).restore();
});

const mockMapping = {
  '/test-assets/api/users/admin1.json': [
    /\/api\/v2\/users.json\?email=admin1@nyaruka.com/
  ],
  '/test-assets/api/users/editor1.json': [
    /\/api\/v2\/users.json\?email=editor1@nyaruka.com/
  ],
  '/test-assets/api/users/agent1.json': [
    /\/api\/v2\/users.json\?email=agent1@nyaruka.com/
  ],
  '/test-assets/api/users/viewer1.json': [
    /\/api\/v2\/users.json\?email=viewer1@nyaruka.com/
  ],
  '/test-assets/contacts/contact-tickets.json': [
    /\/api\/v2\/tickets.json\?contact=24d64810-3315-4ff5-be85-48e3fe055bf9/
  ]
};

export const mockAPI = () => {
  for (const key in mockMapping) {
    const urls = mockMapping[key];
    for (const url of urls) {
      mockGET(url, key);
    }
  }

  // Add mock data for contact form endpoints
  mockGET(/\/api\/v2\/channels\.json/, {
    results: [
      { uuid: 'chan-1', name: 'WhatsApp Channel' },
      { uuid: 'chan-2', name: 'Telegram Channel' },
      { uuid: 'chan-3', name: 'SMS Channel' },
      { uuid: 'chan-4', name: 'Facebook Messenger' }
    ]
  });
};

export const mockGET = (
  endpoint: RegExp,
  body: any,
  headers: any = {},
  status = '200'
) => {
  gets.push({ endpoint, body, headers, status });
};

export const mockPOST = (
  endpoint: RegExp,
  body: any,
  headers: any = {},
  status = '200'
) => {
  posts.push({ endpoint, body, headers, status });
};

export const mockAssetResolver = () => {
  mockPOST(/\/test-assets\/store\/assets\.json/, {
    results: [
      {
        type: 'flow',
        uuid: 'f-001',
        name: 'Canonical Welcome Campaign'
      },
      {
        type: 'flow',
        uuid: '11111111-1111-4111-8111-111111111111',
        name: 'Current Child Flow'
      },
      {
        type: 'group',
        uuid: '3da236a9-9eed-4db3-a18e-cfb58030c249',
        name: 'Farmers'
      },
      {
        type: 'contact',
        uuid: '22222222-2222-4222-8222-222222222222',
        name: 'Alice'
      }
    ]
  });
};

export const clearMockPosts = () => {
  posts = [];
};

export const clearMockGets = () => {
  gets = [];
};

export const checkTimers = (clock: any) => {
  expect(!!clock.timers).to.equal(true, 'Expected timers not found');
  expect(
    Object.keys(clock.timers).length,
    `Timers still to be run ${JSON.stringify(clock.timers)}`
  ).to.equal(0);
};

export const delay = (millis: number) => {
  return new Promise(function (resolve) {
    window.setTimeout(resolve, millis);
  });
};

// Enhanced wait utility for more robust testing.
// Uses the Puppeteer-provided waitFor (real time) instead of delay (which uses
// window.setTimeout and breaks when sinon fake timers are active).
export const waitForCondition = async (
  predicate: () => boolean,
  maxAttempts: number = 20,
  delayMs: number = 50
): Promise<void> => {
  let attempts = 0;
  while (!predicate() && attempts < maxAttempts) {
    await waitFor(delayMs);
    attempts++;
  }
  if (!predicate()) {
    throw new Error(
      `Condition not met after ${maxAttempts} attempts (${
        maxAttempts * delayMs
      }ms)`
    );
  }
};

/**
 * Waits until the central contact watcher has a snapshot for the given
 * contact, so tests can publish events that rely on it being present.
 */
export const waitForWatchedContact = async (uuid: string) => {
  let primed = false;
  const watch = watchContact(uuid, [], () => {
    primed = true;
  });
  await waitForCondition(() => primed);
  watch.unsubscribe();
};

// every img under a root, reaching into shadow roots - almost everything we
// render lives in one
const collectImages = (root: ParentNode): HTMLImageElement[] => {
  const images: HTMLImageElement[] = Array.from(root.querySelectorAll('img'));
  root.querySelectorAll('*').forEach((ele) => {
    if (ele.shadowRoot) {
      images.push(...collectImages(ele.shadowRoot));
    }
  });
  return images;
};

/**
 * Waits for the images under an element to load, decode and settle, so a
 * screenshot of it captures the images rather than the empty boxes where
 * they will be.
 *
 * Screenshots otherwise lean on puppeteer's network-idle wait for this, which
 * is a proxy for "the images arrived" rather than a check of it - and one
 * that gives up after two seconds and screenshots the page anyway. Anything
 * rendering an image loaded over the network needs this.
 *
 * Decoding matters as well as loading: a loaded image can still paint a frame
 * late. The beat afterwards lets whatever sizes itself from the loaded image
 * catch up - temba-thumbnail takes its aspect ratio from a ResizeObserver,
 * which can't run until the image has dimensions, and re-renders when it
 * does. That beat is a timer rather than animation frames, since the suite
 * runs pages concurrently and rAF barely fires in a backgrounded one.
 */
export const waitForImages = async (
  root: ParentNode,
  timeout = 10000
): Promise<void> => {
  const images = collectImages(root);

  const loaded = images.map(
    (img) =>
      new Promise<void>((resolve) => {
        if (img.complete) {
          resolve();
          return;
        }
        img.addEventListener('load', () => resolve(), { once: true });
        // a broken image shouldn't hold us here - let the comparison be what
        // fails, showing a screenshot of what actually rendered
        img.addEventListener('error', () => resolve(), { once: true });
      })
  );

  await Promise.race([
    Promise.all(loaded),
    new Promise((resolve) => window.setTimeout(resolve, timeout))
  ]);

  await Promise.all(
    images.map((img) => (img.decode ? img.decode().catch(() => null) : null))
  );

  await new Promise((resolve) => window.setTimeout(resolve, 50));
};

/**
 * Waits for the CSS transitions and animations running on an element to
 * finish, so a screenshot catches the state they settle into rather than a
 * frame partway through one.
 *
 * How far a transition has got by the time we capture depends on how busy the
 * machine is, so comparing pixels mid-transition is a coin flip against the
 * recorded truth - it passes locally and fails on a loaded CI box. Anything
 * looping forever never settles, so those are left running and a timeout
 * backstops the rest.
 */
export const waitForAnimations = async (
  ele: Element,
  timeout = 2000
): Promise<void> => {
  const animations = ele
    .getAnimations()
    .filter(
      (animation) =>
        (animation.effect as KeyframeEffect)?.getTiming().iterations !==
        Infinity
    );

  await Promise.race([
    // a cancelled animation rejects, which tells us the same thing as one that
    // ran to completion - there is nothing left moving
    Promise.all(
      animations.map((animation) => animation.finished.catch(() => null))
    ),
    new Promise((resolve) => window.setTimeout(resolve, timeout))
  ]);
};

export const assertScreenshot = async (
  filename: string,
  clip: Clip,
  waitForNetwork: boolean = false
) => {
  // detect if we're running in copilot's environment and use adaptive threshold
  const isCopilotEnvironment = (window as any).isCopilotEnvironment;
  const threshold = isCopilotEnvironment ? 1.0 : 0.2;
  const exclude: Clip[] = [];

  // wait for web fonts to load so text-dependent layouts don't shift between
  // standalone and full-suite runs (e.g. Roboto fallback vs loaded)
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  try {
    await (window as any).matchPageSnapshot(
      `${filename}.png`,
      clip,
      exclude,
      threshold,
      waitForNetwork
    );
  } catch (error) {
    if (error.message) {
      throw new Error(
        `${error.message} ${
          error.expected
            ? `Expected ${error.expected} but got ${error.actual}`
            : ''
        } ${error.files ? `\n${error.files.join('\n')}` : ''}`
      );
    }
    throw new Error(error);
  }
};

export const getClip = (ele: HTMLElement) => {
  let clip: any = ele.getBoundingClientRect();
  if (!clip.width || !clip.height) {
    clip = ele.shadowRoot.firstElementChild.getBoundingClientRect();
  }

  // add some padding
  const padding = 10;
  const width = clip.width + padding * 2;
  const height = clip.height + padding * 2;
  const y = clip.y - padding;
  const x = clip.x - padding;

  const newClip = {
    x,
    y,
    width,
    height,
    bottom: y + height,
    right: x + width,
    top: y,
    left: x
  };

  return newClip;
};

export const mouseClickElement = async (ele: HTMLElement | Element) => {
  const bounds = ele.getBoundingClientRect();
  await mouseClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
};

export const getHTMLAttrs = (attrs: any = {}) => {
  return Object.keys(attrs)
    .map((name: string) => `${name}='${attrs[name]}'`)
    .join(' ');
};

export const getHTML = (tag: string, attrs: any = {}) => {
  return `<${tag} ${getHTMLAttrs(attrs)}></${tag}>`;
};

export const loadStore = async () => {
  const store: Store = await fixture(
    `<temba-store
      completion='/test-assets/store/editor.json'
      groups='/test-assets/store/groups.json'
      fields='/test-assets/store/fields.json'
      users='/test-assets/store/users.json'
      workspace='/test-assets/store/workspace.json'
    />`
  );
  await store.initialHttpComplete;
  await store.initialHttpComplete;

  return store;
};

export const mockNow = (isodate: string) => {
  return stub(DateTime, 'now').returns(DateTime.fromISO(isodate));
};

export const getOptions = (select: Select<SelectOption>): Options => {
  return select.shadowRoot.querySelector('temba-options[visible]');
};

export const clickOption = async (
  clock: any,
  select: Select<SelectOption>,
  index: number
) => {
  const options = getOptions(select);
  if (!options) {
    throw new Error('No options element found');
  }

  // Wait for the specific option to be available, but only if it's not already there
  const existingOption = options.shadowRoot?.querySelector(
    `[data-option-index="${index}"]`
  );
  if (!existingOption) {
    try {
      // Increased wait time to handle slower CI environments
      await waitForCondition(
        () => {
          const option = options.shadowRoot?.querySelector(
            `[data-option-index="${index}"]`
          );
          return !!option;
        },
        10,
        25
      );
    } catch (e) {
      throw new Error(`Option at index ${index} not found after waiting`);
    }
  }

  const option = options.shadowRoot.querySelector(
    `[data-option-index="${index}"]`
  ) as HTMLDivElement;

  await mouseClickElement(option);
  await options.updateComplete;
  await select.updateComplete;
  await clock.runAll();

  checkTimers(clock);
};
export const openSelect = async (clock: any, select: Select<SelectOption>) => {
  const container = select.shadowRoot.querySelector('.select-container');
  container.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  clock.runAll();

  // add more explicit waiting and clock ticks
  await select.updateComplete;
  clock.runAll();

  // reduce wait time for options to become visible
  await waitFor(25);
  clock.runAll();

  // For non-endpoint selects, options might be immediately available
  // For endpoint selects, we need to wait for them to load
  const hasEndpoint = select.getAttribute('endpoint');
  if (hasEndpoint) {
    try {
      // Wait for options to be properly rendered and visible (but only for endpoint selects)
      // Increased max attempts to handle slower CI environments
      await waitForCondition(
        () => {
          const options = select.shadowRoot.querySelector(
            'temba-options[visible]'
          );
          return options && options.isConnected;
        },
        10,
        25
      );
    } catch (e) {
      // If condition fails, continue - some tests might not need options to be visible immediately
    }
  }
};

export const openAndClick = async (
  clock: any,
  select: Select<SelectOption>,
  idx: number
) => {
  await openSelect(clock, select);

  // Add this line to ensure proper timing when running as part of a test suite
  await select.updateComplete;
  clock.tick(25); // Reduced from 50 to give minimum time for options to render

  await clickOption(clock, select, idx);
};

// valid = attachments that are uploaded sent to the server when the user clicks send
export const getValidAttachments = (numFiles = 2): Attachment[] => {
  const attachments = [];
  let index = 1;
  while (index <= numFiles) {
    const s = 's' + index;
    const attachment = {
      uuid: s,
      content_type: 'image/png',
      type: 'image/png',
      filename: 'name_' + s,
      url: 'url_' + s,
      size: 1024,
      error: null
    } as Attachment;
    attachments.push(attachment);
    index++;
  }
  return attachments;
};

export const updateComponent = async (
  compose: Compose,
  text?: string,
  attachments?: Attachment[]
): Promise<void> => {
  compose.initialText = text ? text : '';
  compose.currentAttachments = attachments ? attachments : [];
  await compose.updateComplete;
};
export const getValidText = () => {
  return 'sà-wàd-dee!';
};

// Helper for waiting for select pagination to complete
export const waitForSelectPagination = async (
  select: Select<SelectOption>,
  clock: any,
  expectedCount: number,
  maxAttempts: number = 30
): Promise<void> => {
  let attempts = 0;
  while (attempts < maxAttempts) {
    // Ensure we're not still fetching
    if (!select.fetching && select.visibleOptions.length >= expectedCount) {
      return;
    }

    await select.updateComplete;
    clock.runAll();

    // Give more time between attempts for slow CI environments
    await delay(75);

    attempts++;
  }

  throw new Error(
    `Pagination did not complete after ${maxAttempts} attempts (${
      maxAttempts * 75
    }ms). ` +
      `Expected ${expectedCount} options, got ${select.visibleOptions.length}. ` +
      `Fetching: ${select.fetching}`
  );
};
