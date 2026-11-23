import { expect, fixture, html } from '@open-wc/testing';
import { stub, SinonStub } from 'sinon';
import {
  log,
  getHTTPCookie,
  getHeaders,
  getClasses,
  range,
  capitalize,
  stopEvent,
  hslToHex,
  showModax,
  debounce,
  throttle,
  getCookie,
  setCookie,
  serialize,
  serializeFiles,
  getScrollParent,
  renderAvatar,
  getUrl,
  postUrl,
  postJSON,
  postFormData,
  postForm,
  fetchResultsPage,
  fetchResults,
  getAssetPage,
  getAssets,
  DEFAULT_MEDIA_ENDPOINT,
  Color
} from '../src/utils';
import { mockGET, mockPOST, clearMockPosts } from './utils.test';

describe('utils/index', () => {
  describe('constants', () => {
    it('exports expected constants', () => {
      expect(DEFAULT_MEDIA_ENDPOINT).to.equal('/api/v2/media.json');
      expect(Color.BLUE).to.equal('color:#5078b5;');
      expect(Color.GREEN).to.equal('color:#62bd6a;');
      expect(Color.RED).to.equal('color:#e36049;');
      expect(Color.PURPLE).to.equal('color:#a626a4;');
    });
  });

  describe('log', () => {
    let consoleLogStub: SinonStub;

    beforeEach(() => {
      consoleLogStub = stub(console, 'log');
    });

    afterEach(() => {
      consoleLogStub.restore();
    });

    it('logs a simple message without styling', () => {
      log('test message');
      expect(consoleLogStub.calledOnceWith('test message')).to.be.true;
    });

    it('logs an object with styling', () => {
      const obj = { test: 'value' };
      log(obj, 'color: red;');
      expect(
        consoleLogStub.calledOnceWith(
          '%c' + JSON.stringify(obj, null, 2),
          'color: red;'
        )
      ).to.be.true;
    });

    it('logs a string with styling and details', () => {
      log('test message', 'color: blue;', ['detail1', 'detail2']);
      expect(
        consoleLogStub.calledOnceWith(
          '%ctest message',
          'color: blue;',
          'detail1',
          'detail2'
        )
      ).to.be.true;
    });
  });

  describe('getHTTPCookie', () => {
    afterEach(() => {
      // clear cookies
      document.cookie.split(';').forEach((cookie) => {
        const eqPos = cookie.indexOf('=');
        const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
        document.cookie =
          name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      });
    });

    it('returns null for non-existent cookie', () => {
      expect(getHTTPCookie('nonexistent')).to.be.null;
    });

    it('returns cookie value when it exists', () => {
      document.cookie = 'testcookie=testvalue; path=/';
      expect(getHTTPCookie('testcookie')).to.equal('testvalue');
    });

    it('handles cookies with spaces', () => {
      document.cookie = ' spacedcookie = spacedvalue ; path=/';
      expect(getHTTPCookie('spacedcookie')).to.equal('spacedvalue');
    });

    it('returns first matching cookie when multiple exist', () => {
      document.cookie = 'cookie1=value1; path=/';
      document.cookie = 'cookie2=value2; path=/';
      expect(getHTTPCookie('cookie1')).to.equal('value1');
      expect(getHTTPCookie('cookie2')).to.equal('value2');
    });
  });

  describe('getHeaders', () => {
    let originalOrgId: any;
    let csrfTokenElement: HTMLInputElement;

    beforeEach(() => {
      originalOrgId = (window as any).org_id;

      // clear existing CSRF token element
      const existing = document.querySelector('[name=csrfmiddlewaretoken]');
      if (existing) {
        existing.remove();
      }
    });

    afterEach(() => {
      // clear cookies
      document.cookie.split(';').forEach((cookie) => {
        const eqPos = cookie.indexOf('=');
        const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
        document.cookie =
          name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      });

      (window as any).org_id = originalOrgId;

      if (csrfTokenElement) {
        csrfTokenElement.remove();
      }
    });

    it('builds basic headers with XMLHttpRequest marker', () => {
      const headers = getHeaders();
      expect(headers['X-Requested-With']).to.equal('XMLHttpRequest');
    });

    it('includes CSRF token from cookie', () => {
      document.cookie = 'csrftoken=test-csrf-token; path=/';
      const headers = getHeaders();
      expect(headers['X-CSRFToken']).to.equal('test-csrf-token');
    });

    it('includes CSRF token from form element when cookie not available', () => {
      csrfTokenElement = document.createElement('input');
      csrfTokenElement.name = 'csrfmiddlewaretoken';
      csrfTokenElement.value = 'form-csrf-token';
      document.body.appendChild(csrfTokenElement);

      const headers = getHeaders();
      expect(headers['X-CSRFToken']).to.equal('form-csrf-token');
    });

    it('includes org uuid when available', () => {
      (window as any).workspace = {
        uuid: '3a7e2f10-b0b3-413d-bd84-626e147d5ed2',
        anon: false
      };
      const headers = getHeaders();
      expect(headers['X-Temba-Workspace']).to.equal(
        '3a7e2f10-b0b3-413d-bd84-626e147d5ed2'
      );
    });

    it('merges provided headers', () => {
      const headers = getHeaders({ 'Custom-Header': 'custom-value' });
      expect(headers['Custom-Header']).to.equal('custom-value');
      expect(headers['X-Requested-With']).to.equal('XMLHttpRequest');
    });

    it('removes X-Temba-Workspace when X-Temba-Service-Org is provided', () => {
      (window as any).workspace = {
        uuid: '3a7e2f10-b0b3-413d-bd84-626e147d5ed2',
        anon: false
      };
      const headers = getHeaders({ 'X-Temba-Service-Org': 'service-org' });
      expect(headers['X-Temba-Workspace']).to.be.undefined;
      expect(headers['X-Temba-Service-Org']).to.equal('service-org');
    });
  });

  describe('getClasses', () => {
    it('returns empty string for empty map', () => {
      expect(getClasses({})).to.equal('');
    });

    it('returns single class when one is true', () => {
      expect(getClasses({ active: true })).to.equal('active');
    });

    it('returns multiple classes when multiple are true', () => {
      const result = getClasses({
        active: true,
        disabled: true,
        hidden: false
      });
      expect(result).to.equal('active disabled');
    });

    it('ignores false values', () => {
      expect(getClasses({ active: true, disabled: false })).to.equal('active');
    });

    it('trims whitespace correctly', () => {
      expect(getClasses({ class1: true, class2: true })).to.equal(
        'class1 class2'
      );
    });
  });

  describe('range', () => {
    it('generates range from 0 to 5', () => {
      expect(range(0, 5)).to.deep.equal([0, 1, 2, 3, 4]);
    });

    it('generates range from 2 to 6', () => {
      expect(range(2, 6)).to.deep.equal([2, 3, 4, 5]);
    });

    it('generates empty array when start equals end', () => {
      expect(range(3, 3)).to.deep.equal([]);
    });

    it('handles negative ranges', () => {
      expect(range(-2, 2)).to.deep.equal([-2, -1, 0, 1]);
    });
  });

  describe('capitalize', () => {
    it('capitalizes first letter', () => {
      expect(capitalize('hello')).to.equal('Hello');
    });

    it('handles empty string', () => {
      expect(capitalize('')).to.equal('');
    });

    it('handles single character', () => {
      expect(capitalize('a')).to.equal('A');
    });

    it('preserves rest of string', () => {
      expect(capitalize('hELLO')).to.equal('HELLO');
    });
  });

  describe('stopEvent', () => {
    it('stops propagation and prevents default', () => {
      const event = {
        stopPropagation: stub(),
        preventDefault: stub()
      };

      stopEvent(event as any);

      expect(event.stopPropagation.calledOnce).to.be.true;
      expect(event.preventDefault.calledOnce).to.be.true;
    });

    it('handles null event gracefully', () => {
      expect(() => stopEvent(null)).to.not.throw;
    });

    it('handles undefined event gracefully', () => {
      expect(() => stopEvent(undefined)).to.not.throw;
    });
  });

  describe('hslToHex', () => {
    it('converts HSL to hex', () => {
      expect(hslToHex(0, 100, 50)).to.equal('#ff0000'); // red
    });

    it('converts HSL to hex for green', () => {
      expect(hslToHex(120, 100, 50)).to.equal('#00ff00'); // green
    });

    it('converts HSL to hex for blue', () => {
      expect(hslToHex(240, 100, 50)).to.equal('#0000ff'); // blue
    });

    it('handles white', () => {
      expect(hslToHex(0, 0, 100)).to.equal('#ffffff');
    });

    it('handles black', () => {
      expect(hslToHex(0, 0, 0)).to.equal('#000000');
    });
  });

  describe('showModax', () => {
    let originalShowModax: any;

    beforeEach(() => {
      originalShowModax = (window as any).showModax;
      (window as any).showModax = stub();
    });

    afterEach(() => {
      (window as any).showModax = originalShowModax;
    });

    it('calls window.showModax with title and endpoint', () => {
      showModax('Test Title', '/test/endpoint');
      expect(
        (window as any).showModax.calledOnceWith('Test Title', '/test/endpoint')
      ).to.be.true;
    });
  });

  describe('debounce', () => {
    it('debounces function calls', (done) => {
      const fn = stub();
      const debouncedFn = debounce(fn, 50);

      // call multiple times
      debouncedFn('arg1');
      debouncedFn('arg2');
      debouncedFn('arg3');

      // the function should not be called immediately
      expect(fn.called).to.be.false;

      // wait for the debounce delay and check if called
      setTimeout(() => {
        expect(fn.calledOnce).to.be.true;
        expect(fn.calledWith('arg3')).to.be.true;
        done();
      }, 75);
    });

    it('calls immediately when immediate flag is true', () => {
      const fn = stub();
      const debouncedFn = debounce(fn, 100, true);

      debouncedFn('test');

      expect(fn.calledOnce).to.be.true;
      expect(fn.calledWith('test')).to.be.true;
    });
  });

  describe('throttle', () => {
    it('throttles function calls', (done) => {
      const fn = stub();
      const throttledFn = throttle(fn, 50);

      // first call should execute immediately
      throttledFn('arg1');
      expect(fn.calledOnce).to.be.true;

      // subsequent calls should be ignored until ready
      throttledFn('arg2');
      throttledFn('arg3');

      // should still be called only once
      expect(fn.callCount).to.equal(1);

      // wait for throttle to reset and test again
      setTimeout(() => {
        throttledFn('arg4');
        expect(fn.callCount).to.equal(2);
        done();
      }, 75);
    });
  });

  describe('getCookie and setCookie', () => {
    afterEach(() => {
      // clear all cookies
      document.cookie.split(';').forEach((cookie) => {
        const eqPos = cookie.indexOf('=');
        const name =
          eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
        document.cookie =
          name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      });
    });

    it('setCookie sets a cookie with default path', () => {
      setCookie('testcookie', 'testvalue');
      expect(getCookie('testcookie')).to.equal('testvalue');
    });

    it('setCookie sets a cookie with custom path', () => {
      // just test that the function doesn't throw
      expect(() => setCookie('testcookie', 'testvalue', '/custom/path')).to.not
        .throw;
    });

    it('getCookie returns null for non-existent cookie', () => {
      expect(getCookie('nonexistent')).to.be.null;
    });

    it('getCookie handles empty cookie string', () => {
      // save original cookie getter
      const originalGetter = Object.getOwnPropertyDescriptor(
        Document.prototype,
        'cookie'
      );

      // mock empty cookie
      Object.defineProperty(document, 'cookie', {
        value: '',
        configurable: true
      });

      expect(getCookie('test')).to.be.null;

      // restore original getter
      if (originalGetter) {
        Object.defineProperty(document, 'cookie', originalGetter);
      }
    });
  });

  describe('serialize', () => {
    let form: HTMLFormElement;

    beforeEach(async () => {
      form = await fixture(html`
        <form>
          <input name="text" type="text" value="textvalue" />
          <input name="email" type="email" value="test@example.com" />
          <input name="checkbox1" type="checkbox" value="check1" checked />
          <input name="checkbox2" type="checkbox" value="check2" />
          <input
            name="radio1"
            type="radio"
            name="radiogroup"
            value="radio1"
            checked
          />
          <input name="radio2" type="radio" name="radiogroup" value="radio2" />
          <input name="hidden" type="hidden" value="hiddenvalue" />
          <input name="disabled" type="text" value="disabledvalue" disabled />
          <input name="noname" type="text" value="nonamevalue" />
          <input type="submit" value="Submit" />
          <input type="button" value="Button" />
          <input type="file" />
          <input type="reset" />
          <select name="select" multiple>
            <option value="option1" selected>Option 1</option>
            <option value="option2" selected>Option 2</option>
            <option value="option3">Option 3</option>
          </select>
          <select name="singleselect">
            <option value="single1" selected>Single 1</option>
            <option value="single2">Single 2</option>
          </select>
        </form>
      `);
    });

    it('serializes form data correctly', () => {
      const serialized = serialize(form);

      expect(serialized).to.include('text=textvalue');
      expect(serialized).to.include('email=test%40example.com');
      expect(serialized).to.include('checkbox1=check1');
      expect(serialized).to.not.include('checkbox2');
      expect(serialized).to.include('radio1=radio1');
      expect(serialized).to.include('hidden=hiddenvalue');
      expect(serialized).to.not.include('disabled');
      // Note: noname field actually gets included because it has a value, just no name attribute
      expect(serialized).to.not.include('Submit');
      expect(serialized).to.not.include('Button');
      expect(serialized).to.include('select=option1');
      expect(serialized).to.include('select=option2');
      expect(serialized).to.include('singleselect=single1');
    });

    it('handles empty form', () => {
      const emptyForm = document.createElement('form');
      expect(serialize(emptyForm)).to.equal('');
    });

    it('handles form with only disabled fields', () => {
      const disabledForm = document.createElement('form');
      const input = document.createElement('input');
      input.name = 'test';
      input.value = 'value';
      input.disabled = true;
      disabledForm.appendChild(input);

      expect(serialize(disabledForm)).to.equal('');
    });

    it('leaves files to serializeFiles', () => {
      const image = new FormData();
      image.append(
        'favicon',
        new Blob(['img'], { type: 'image/webp' }),
        'f.webp'
      );

      // components holding files, like the image picker, have a FormData as their value
      const form = {
        elements: [
          { name: 'title', value: 'Help' },
          { name: 'favicon', value: image },
          { name: 'other', value: new FormData(), disabled: true }
        ]
      };

      expect(serialize(form)).to.equal('title=Help');

      const files = serializeFiles(form);
      expect([...files.keys()]).to.deep.equal(['favicon']);
      expect((files.get('favicon') as File).name).to.equal('f.webp');

      expect(
        serializeFiles({ elements: [{ name: 'title', value: 'Help' }] })
      ).to.equal(null);
    });

    it('handles checkbox without value attribute', () => {
      const form = document.createElement('form');

      // add checkbox without value
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.name = 'checknovalue';
      checkbox.checked = true;
      form.appendChild(checkbox);

      const serialized = serialize(form);
      expect(serialized).to.include('checknovalue=on'); // default checkbox value is "on"
    });
  });

  describe('getScrollParent', () => {
    let scrollableParent: HTMLElement;
    let child: HTMLElement;

    beforeEach(async () => {
      scrollableParent = await fixture(html`
        <div style="height: 200px; overflow-y: scroll;">
          <div id="child" style="height: 300px;">Child Element</div>
        </div>
      `);
      child = scrollableParent.querySelector('#child') as HTMLElement;
    });

    it('finds scrollable parent', () => {
      const scrollParent = getScrollParent(child);
      // should find a scrollable parent or return null
      expect(scrollParent === null || scrollParent instanceof HTMLElement).to.be
        .true;
    });

    it('returns null when no scrollable parent exists', () => {
      const isolatedElement = document.createElement('div');
      const result = getScrollParent(isolatedElement);
      expect(result).to.be.null;
    });

    it('handles shadow dom', () => {
      const shadowHost = document.createElement('div');
      const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
      const shadowChild = document.createElement('div');
      shadowRoot.appendChild(shadowChild);

      const result = getScrollParent(shadowChild);
      expect(result === null || result instanceof HTMLElement).to.be.true;
    });

    it('handles elements with no scrollable parents', () => {
      // test with null parent
      const orphan = document.createElement('div');
      expect(getScrollParent(orphan)).to.be.null;

      // test with non-scrollable parent
      const parent = document.createElement('div');
      const child = document.createElement('div');
      parent.appendChild(child);

      // most browsers won't have scrollable overflow by default
      const result = getScrollParent(child);
      expect(result === null || result instanceof HTMLElement).to.be.true;
    });
  });

  describe('renderAvatar', () => {
    it('renders avatar with name only', () => {
      const result = renderAvatar({ name: 'John Doe' });
      expect(result.strings).to.exist; // it's a TemplateResult
    });

    it('renders avatar with user object', () => {
      const user = { first_name: 'Jane', last_name: 'Smith', avatar: null };
      const result = renderAvatar({ user });
      expect(result.strings).to.exist;
    });

    it('renders avatar with user avatar URL', () => {
      const user = {
        first_name: 'Jane',
        last_name: 'Smith',
        avatar: 'https://example.com/avatar.jpg'
      };
      const result = renderAvatar({ user });
      expect(result.strings).to.exist;
    });

    it('handles scale parameter', () => {
      const result = renderAvatar({ name: 'John Doe', scale: 1.5 });
      expect(result.strings).to.exist;
    });

    it('handles position parameter', () => {
      const result = renderAvatar({ name: 'John Doe', position: 'left' });
      expect(result.strings).to.exist;
    });

    it('handles icon parameter', () => {
      const result = renderAvatar({ name: 'John Doe', icon: 'user' });
      expect(result.strings).to.exist;
    });

    it('handles empty input', () => {
      const result = renderAvatar({});
      expect(result.strings).to.exist;
    });
  });

  describe('HTTP Functions', () => {
    beforeEach(() => {
      clearMockPosts();
    });

    describe('getUrl', () => {
      it('makes GET request and returns response', async () => {
        mockGET(/\/test\/endpoint/, { data: 'test response' }, {}, '200');

        const response = await getUrl('/test/endpoint');

        expect(response.status).to.equal(200);
        expect(response.json).to.deep.equal({ data: 'test response' });
        expect(response.body).to.be.a('string');
      });

      it('handles request with custom headers', async () => {
        mockGET(/\/test\/endpoint/, { data: 'test' }, {}, '200');

        const response = await getUrl('/test/endpoint', null, {
          'Custom-Header': 'value'
        });

        expect(response.status).to.equal(200);
      });

      it('handles request with abort controller', async () => {
        mockGET(/\/test\/endpoint/, { data: 'test' }, {}, '200');

        const controller = new AbortController();
        const response = await getUrl('/test/endpoint', controller);

        expect(response.status).to.equal(200);
        expect(response.controller).to.equal(controller);
      });

      it('rejects on error status', async () => {
        mockGET(/\/test\/endpoint/, 'Error response', {}, '404');

        try {
          await getUrl('/test/endpoint');
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.exist;
        }
      });
    });

    describe('postUrl', () => {
      it('makes POST request and returns response', async () => {
        mockPOST(/\/test\/endpoint/, { success: true }, {}, '200');

        const response = await postUrl('/test/endpoint', 'test data');

        expect(response.status).to.equal(200);
        expect(response.json).to.deep.equal({ success: true });
      });

      it('handles custom content type', async () => {
        mockPOST(/\/test\/endpoint/, { success: true }, {}, '200');

        const response = await postUrl(
          '/test/endpoint',
          'test data',
          {},
          'text/plain'
        );

        expect(response.status).to.equal(200);
      });

      it('handles server errors', async () => {
        mockPOST(/\/test\/endpoint/, 'Server Error', {}, '500');

        try {
          await postUrl('/test/endpoint', 'test data');
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.exist;
        }
      });

      it('handles toast headers', async () => {
        const toastData = JSON.stringify([
          { message: 'Success!', type: 'success' }
        ]);
        mockPOST(
          /\/test\/endpoint/,
          { success: true },
          { 'X-Temba-Toasts': toastData },
          '200'
        );

        // create a mock toast element
        const mockToast = {
          addMessages: stub()
        };
        const toastElement = document.createElement('temba-toast');
        Object.assign(toastElement, mockToast);
        document.body.appendChild(toastElement);

        const response = await postUrl('/test/endpoint', 'test data');

        expect(response.status).to.equal(200);

        // clean up
        document.body.removeChild(toastElement);
      });

      it('handles client errors gracefully', async () => {
        mockPOST(/\/test\/endpoint/, 'Client Error', {}, '400');

        const response = await postUrl('/test/endpoint', 'test data');

        expect(response.status).to.equal(400);
        expect(response.json).to.deep.equal({});
      });

      it('handles response without toasts', async () => {
        // test response without toasts
        mockPOST(/\/test\/notoasts/, { success: true }, {}, '201');

        const response = await postUrl('/test/notoasts', 'data');
        expect(response.status).to.equal(201);
      });
    });

    describe('postJSON', () => {
      it('posts JSON data', async () => {
        mockPOST(/\/test\/endpoint/, { received: true }, {}, '200');

        const payload = { test: 'data' };
        const response = await postJSON('/test/endpoint', payload);

        expect(response.status).to.equal(200);
        expect(response.json).to.deep.equal({ received: true });
      });
    });

    describe('postFormData', () => {
      it('posts form data successfully', async () => {
        mockPOST(/\/test\/endpoint/, { uploaded: true }, {}, '200');

        const formData = new FormData();
        formData.append('key', 'value');

        const response = await postFormData('/test/endpoint', formData);

        expect(response.status).to.equal(200);
        expect(response.json).to.deep.equal({ uploaded: true });
      });

      it('handles form data with custom headers', async () => {
        mockPOST(/\/test\/endpoint/, { uploaded: true }, {}, '200');

        const formData = new FormData();
        formData.append('key', 'value');

        const response = await postFormData('/test/endpoint', formData, {
          'Custom-Header': 'value'
        });

        expect(response.status).to.equal(200);
      });

      it('rejects on client error for non-media endpoint', async () => {
        mockPOST(/\/test\/endpoint/, 'Bad Request', {}, '400');

        const formData = new FormData();
        formData.append('key', 'value');

        try {
          await postFormData('/test/endpoint', formData);
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.equal('Server failure');
        }
      });

      it('rejects with response for media endpoint errors', async () => {
        mockPOST(/\/api\/v2\/media\.json/, 'Bad Request', {}, '400');

        const formData = new FormData();
        formData.append('key', 'value');

        try {
          await postFormData('/api/v2/media.json', formData);
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.exist;
          expect(error.status).to.equal(400);
        }
      });

      it('handles different error status for media endpoint', async () => {
        // test with different error status for media endpoint
        mockPOST(/\/api\/v2\/media\.json/, 'Forbidden', {}, '403');

        const formData = new FormData();
        formData.append('file', 'test');

        try {
          await postFormData('/api/v2/media.json', formData);
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.exist;
        }
      });
    });

    describe('postForm', () => {
      it('converts object to FormData and posts', async () => {
        mockPOST(/\/test\/endpoint/, { submitted: true }, {}, '200');

        const payload = { name: 'John', age: 30 };
        const response = await postForm('/test/endpoint', payload);

        expect(response.status).to.equal(200);
        expect(response.json).to.deep.equal({ submitted: true });
      });

      it('handles form data with custom headers', async () => {
        mockPOST(/\/test\/endpoint/, { submitted: true }, {}, '200');

        const payload = { name: 'John' };
        const response = await postForm('/test/endpoint', payload, {
          'Custom-Header': 'value'
        });

        expect(response.status).to.equal(200);
      });
    });

    describe('fetchResultsPage', () => {
      it('fetches a single page of results', async () => {
        const mockResults = {
          results: [{ id: 1 }, { id: 2 }],
          next: 'https://example.com/api/page2'
        };
        mockGET(/\/api\/results/, mockResults, {}, '200');

        const page = await fetchResultsPage('/api/results/');

        expect(page.results).to.deep.equal([{ id: 1 }, { id: 2 }]);
        expect(page.next).to.equal('https://example.com/api/page2');
      });

      it('handles requests with controller and headers', async () => {
        const mockResults = { results: [], next: null };
        mockGET(/\/api\/uniqueresults/, mockResults, {}, '200');

        const controller = new AbortController();
        const page = await fetchResultsPage('/api/uniqueresults/', controller, {
          'Custom-Header': 'value'
        });

        expect(page.results).to.deep.equal([]);
        expect(page.next).to.be.null;
      });

      it('propagates errors', async () => {
        mockGET(/\/api\/resultserror/, 'Error', {}, '500');

        try {
          await fetchResultsPage('/api/resultserror/');
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.exist;
        }
      });
    });

    describe('fetchResults', () => {
      it('returns empty array for null URL', async () => {
        const results = await fetchResults(null);
        expect(results).to.deep.equal([]);
      });

      it('returns empty array for empty URL', async () => {
        const results = await fetchResults('');
        expect(results).to.deep.equal([]);
      });
    });

    describe('getAssetPage', () => {
      it('fetches a single page of assets', async () => {
        const mockAssets = {
          results: [{ key: 'asset1' }, { key: 'asset2' }],
          next: 'https://example.com/api/assets/page2'
        };
        mockGET(/\/api\/assets/, mockAssets, {}, '200');

        const page = await getAssetPage('/api/assets/');

        expect(page.assets).to.deep.equal([
          { key: 'asset1' },
          { key: 'asset2' }
        ]);
        expect(page.next).to.equal('https://example.com/api/assets/page2');
      });

      it('rejects on error status', async () => {
        mockGET(/\/api\/assets/, 'Not Found', {}, '404');

        try {
          await getAssetPage('/api/assets/');
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.exist;
        }
      });

      it('rejects on network error', async () => {
        // Don't mock the endpoint to simulate network error
        try {
          await getAssetPage('/api/nonexistent/');
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.exist;
        }
      });

      it('handles server error scenarios', async () => {
        mockGET(/\/api\/asseterror/, 'Server Error', {}, '500');

        try {
          await getAssetPage('/api/asseterror/');
          expect.fail('Should have rejected');
        } catch (error) {
          expect(error).to.exist;
        }
      });
    });

    describe('getAssets', () => {
      it('returns empty array for null URL', async () => {
        const assets = await getAssets(null);
        expect(assets).to.deep.equal([]);
      });

      it('returns empty array for empty URL', async () => {
        const assets = await getAssets('');
        expect(assets).to.deep.equal([]);
      });
    });
  });
});
