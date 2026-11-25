import { assert, expect } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { APITokenList } from '../src/list/APITokenList';
import { getComponent, mockNow, removeSharedSheet } from './utils.test';

const TAG = 'temba-apitoken-list';
const getTokenList = async (attrs: any = {}, width = 700, height = 0) => {
  return (await getComponent(TAG, attrs, '', width, height)) as APITokenList;
};

const token = (over: any = {}) => ({
  key: 'KEY1',
  created_on: '2026-05-11T09:12:00.000000Z',
  last_used_on: null,
  ...over
});

const renderRows = async (list: APITokenList, items: any[]) => {
  (list as any).items = items;
  list.requestUpdate();
  await list.updateComplete;
};

describe('temba-apitoken-list', () => {
  let nowStub: any;
  beforeEach(() => {
    // pin "now" so the dates render the same across runs
    nowStub = mockNow('2026-05-11T14:00:00Z');
  });
  afterEach(() => {
    if (nowStub) nowStub.restore();
    removeSharedSheet();
  });

  it('can be created', async () => {
    const list: APITokenList = await getTokenList();
    assert.instanceOf(list, APITokenList);
    expect(list.valueKey).to.equal('key');
    // too few tokens to need search
    expect(list.searchable).to.be.false;
  });

  it("doesn't navigate on row click", async () => {
    const list: APITokenList = await getTokenList();
    expect((list as any).getRowHref(token())).to.be.null;
  });

  it('renders the key, created and last used cells', async () => {
    const list: APITokenList = await getTokenList();
    await renderRows(list, [
      token(),
      token({ key: 'KEY2', last_used_on: '2026-05-11T10:00:00.000000Z' })
    ]);

    const rows = list.shadowRoot.querySelectorAll('tr.row');
    expect(rows).to.have.length(2);

    expect(rows[0].querySelector('.key').textContent.trim()).to.equal('KEY1');
    expect(rows[0].textContent).to.contain('Never');
    expect(rows[0].querySelectorAll('temba-date')).to.have.length(1);

    expect(rows[1].querySelector('.key').textContent.trim()).to.equal('KEY2');
    expect(rows[1].textContent).to.not.contain('Never');
    expect(rows[1].querySelectorAll('temba-date')).to.have.length(2);
  });

  it('fires a delete event from the delete button', async () => {
    const list: APITokenList = await getTokenList();
    await renderRows(list, [token()]);

    const deletes: any[] = [];
    const rowClicks: any[] = [];
    list.addEventListener(CustomEventType.APITokenDelete, (e: any) =>
      deletes.push(e.detail)
    );
    list.addEventListener(CustomEventType.RowClick, (e: any) =>
      rowClicks.push(e.detail)
    );

    const button = list.shadowRoot.querySelector(
      '.actions-cell temba-icon'
    ) as HTMLElement;
    button.dispatchEvent(
      new MouseEvent('click', { bubbles: true, composed: true })
    );

    expect(deletes).to.have.length(1);
    expect(deletes[0].item.key).to.equal('KEY1');
    expect(rowClicks, 'the click stays on the button').to.have.length(0);
  });

  it('copies the key from the copy button', async () => {
    const list: APITokenList = await getTokenList();
    await renderRows(list, [token()]);

    const copied: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        }
      }
    });

    try {
      const button = list.shadowRoot.querySelector(
        '.key-cell temba-icon'
      ) as HTMLElement;
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, composed: true })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      await list.updateComplete;

      expect(copied).to.deep.equal(['KEY1']);
      const icon = list.shadowRoot.querySelector(
        '.key-cell temba-icon'
      ) as HTMLElement;
      expect(icon.classList.contains('copied')).to.be.true;
    } finally {
      if (original) {
        Object.defineProperty(navigator, 'clipboard', original);
      } else {
        delete (navigator as any).clipboard;
      }
    }
  });
});
