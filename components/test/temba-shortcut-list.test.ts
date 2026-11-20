import { assert, expect } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { ShortcutContentList } from '../src/list/ShortcutContentList';
import { assertScreenshot, getClip, getComponent } from './utils.test';

const TAG = 'temba-shortcut-list';

const SHORTCUT = {
  uuid: 'shortcut-1',
  name: 'Greeting',
  text: 'Hello and welcome!',
  modified_on: '2026-01-01T00:00:00Z'
};

const getShortcutList = async (attrs: any = {}) =>
  (await getComponent(TAG, attrs)) as ShortcutContentList;

const setItems = async (list: ShortcutContentList) => {
  (list as any).items = [SHORTCUT];
  list.requestUpdate();
  await list.updateComplete;
};

const openDetail = async (list: ShortcutContentList) => {
  await setItems(list);
  list.shadowRoot
    .querySelector('tr.row')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await list.updateComplete;
  return list.shadowRoot.querySelector('temba-dialog') as any;
};

describe('temba-shortcut-list', () => {
  it('can be created with shortcut columns', async () => {
    const list = await getShortcutList();

    assert.instanceOf(list, ShortcutContentList);
    expect(list.columns.map((column) => column.key)).to.deep.equal([
      'name',
      'text'
    ]);
    // the default placeholder resolves at render time so it localizes
    expect(list['defaultSearchPlaceholder']()).to.equal('Search shortcuts');
  });

  it('renders shortcut names and text', async () => {
    const list = await getShortcutList();
    await setItems(list);

    const row = list.shadowRoot.querySelector('tr.row');
    expect(row.textContent).to.contain('Greeting');
    expect(row.textContent).to.contain('Hello and welcome!');
    expect(row.querySelectorAll('td')).to.have.length(2);

    const cells = row.querySelectorAll('td');
    expect(getComputedStyle(cells[0]).paddingLeft).to.equal('20px');
    expect(getComputedStyle(cells[1]).paddingRight).to.equal('20px');
  });

  it('opens a floating detail when a row is clicked', async () => {
    const list = await getShortcutList();
    const dialog = await openDetail(list);

    expect(dialog.open).to.be.true;
    expect(dialog.getAttribute('variant')).to.equal('flat');
    expect(list.shadowRoot.querySelector('.detail-name').textContent).to.equal(
      'Greeting'
    );
    // the text is rendered pre-wrap, so it must not pick up the template's
    // own indentation as leading whitespace
    const text = list.shadowRoot.querySelector('.detail-text');
    expect(text.textContent).to.equal('Hello and welcome!');
    expect(getComputedStyle(text).whiteSpace).to.equal('pre-wrap');
    expect(
      getComputedStyle(list.shadowRoot.querySelector('.detail-response'))
        .whiteSpace
    ).to.not.equal('pre-wrap');
  });

  it('fires edit and delete events from the detail', async () => {
    const list = await getShortcutList({ editable: true, deletable: true });

    const edits: any[] = [];
    const deletes: any[] = [];
    list.addEventListener(CustomEventType.ShortcutEdit, (event: any) =>
      edits.push(event.detail.item)
    );
    list.addEventListener(CustomEventType.ShortcutDelete, (event: any) =>
      deletes.push(event.detail.item)
    );

    let dialog = await openDetail(list);
    list.shadowRoot
      .querySelector('.detail-actions .menu-button:not(.destructive)')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;

    expect(edits).to.deep.equal([SHORTCUT]);
    expect(dialog.open).to.be.false;

    dialog = await openDetail(list);
    list.shadowRoot
      .querySelector('.detail-actions .menu-button.destructive')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;

    expect(deletes).to.deep.equal([SHORTCUT]);
    expect(dialog.open).to.be.false;
  });

  it('hides detail actions without permissions', async () => {
    const list = await getShortcutList();
    await openDetail(list);

    expect(list.shadowRoot.querySelector('.detail-actions')).to.not.exist;
  });

  it('renders the shortcut list (screenshot)', async () => {
    const list = (await getComponent(
      TAG,
      { searchable: true },
      '',
      800
    )) as ShortcutContentList;
    (list as any).items = [
      SHORTCUT,
      {
        uuid: 'shortcut-2',
        name: 'Office hours',
        text: 'We are open Monday to Friday, 9am to 5pm.',
        modified_on: '2026-01-02T00:00:00Z'
      },
      {
        uuid: 'shortcut-3',
        name: 'Closing',
        text: 'Thanks for getting in touch - closing this out now.',
        modified_on: '2026-01-03T00:00:00Z'
      }
    ];
    list.requestUpdate();
    await list.updateComplete;

    await assertScreenshot('shortcut-list/list', getClip(list));
  });
});
