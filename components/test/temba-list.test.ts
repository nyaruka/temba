import { assert, expect } from '@open-wc/testing';
import * as sinon from 'sinon';
import { useFakeTimers } from 'sinon';
import { CustomEventType } from '../src/interfaces';
import { TembaList } from '../src/list/TembaList';
import { assertScreenshot, getClip, getComponent } from './utils.test';

let clock: any;

// TembaList is a base class with no tag of its own, so register one to test it
const TAG = 'temba-list';
if (!customElements.get(TAG)) {
  customElements.define(TAG, TembaList);
}
const getList = async (attrs: any = {}) => {
  const list = (await getComponent(TAG, attrs)) as TembaList;

  if (!list.endpoint) {
    return list;
  }

  return new Promise<TembaList>((resolve) => {
    list.addEventListener(
      CustomEventType.FetchComplete,
      async () => {
        resolve(list);
      },
      { once: true }
    );
  });
};

describe('temba-list', () => {
  beforeEach(function () {
    clock = useFakeTimers();
  });

  afterEach(function () {
    clock.restore();
  });

  it('can be created', async () => {
    const list: TembaList = await getList();
    assert.instanceOf(list, TembaList);
    expect(list.items.length).to.equal(0);
  });

  it('shows empty list with bad endpoint', async () => {
    const list: TembaList = await getList({ endpoint: 'expected-404.json' });
    expect(list.items.length).to.equal(0);
  });

  it('renders with endpoint', async () => {
    const list: TembaList = await getList({
      endpoint: '/test/assets/list/temba-list.json'
    });
    expect(list.items.length).to.equal(4);
    await assertScreenshot('list/items', getClip(list));
  });

  it('polls for changes', async () => {
    const list: TembaList = await getList({
      endpoint: '/test/assets/list/temba-list.json'
    });

    const refreshKey = list.refreshKey;
    clock.tick(10001);
    expect(list.refreshKey).to.not.equal(refreshKey);
  });

  it('fires change event on cursor change', async () => {
    const list: TembaList = await getList({
      endpoint: '/test/assets/list/temba-list.json'
    });

    const changeTest = new Promise<void>((resolve) => {
      list.addEventListener('change', () => {
        resolve();
      });
    });

    list.cursorIndex = 1;

    await changeTest;
    await assertScreenshot('list/items-selected', getClip(list));
  });

  it('clears selection without firing change', async () => {
    const list: TembaList = await getList({
      endpoint: '/test/assets/list/temba-list.json'
    });

    list.cursorIndex = 1;
    await list.updateComplete;
    expect(list.getSelection()).to.not.be.null;

    let fired = false;
    list.addEventListener('change', () => {
      fired = true;
    });

    list.clearSelection();
    await list.updateComplete;

    expect(list.cursorIndex).to.equal(-1);
    expect(list.getSelection()).to.be.null;
    expect(fired).to.equal(false);

    // selecting the same item again fires change
    const changeTest = new Promise<void>((resolve) => {
      list.addEventListener('change', () => {
        resolve();
      });
    });
    list.cursorIndex = 1;
    await changeTest;
  });

  it('fires change when first element changes after fetch', async () => {
    const list: TembaList = await getList({
      endpoint: '/test/assets/list/temba-list.json'
    });

    // spy on change event
    const changeEvent = sinon.spy();
    list.addEventListener('change', changeEvent);

    const refreshTest = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => {
        resolve();
      });
    });

    list.endpoint = '/test/assets/list/temba-list-shorter.json';
    await refreshTest;

    assert(changeEvent.called, 'change event not fired');
    await assertScreenshot('list/items-updated', getClip(list));
  });
});
