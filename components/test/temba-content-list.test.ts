import { assert, expect } from '@open-wc/testing';
import { stub } from 'sinon';
import { CustomEventType } from '../src/interfaces';
import { ContentList } from '../src/list/ContentList';
import { ContactList } from '../src/list/ContactList';
import { FlowList } from '../src/list/FlowList';
import { MsgList } from '../src/list/MsgList';
import { TriggerList } from '../src/list/TriggerList';
import {
  assertScreenshot,
  clearMockGets,
  getClip,
  getComponent,
  loadStore,
  mockGET,
  mockNow,
  mockPOST,
  waitForCondition
} from './utils.test';

const TAG = 'temba-content-list';

const getList = async (attrs: any = {}) => {
  const list = (await getComponent(TAG, attrs, '', 700)) as ContentList;
  if (!list.endpoint) return list;
  return new Promise<ContentList>((resolve) => {
    list.addEventListener(CustomEventType.FetchComplete, () => resolve(list), {
      once: true
    });
  });
};

const getResizeHandle = (header: HTMLElement): HTMLElement | null => {
  return (
    header.nextElementSibling?.querySelector<HTMLElement>(
      '.resize-handle.leading'
    ) ?? header.querySelector<HTMLElement>('.resize-handle.trailing')
  );
};

describe('temba-content-list', () => {
  let nowStub: any;
  beforeEach(() => {
    // Pin "now" so duration cells render stable text across runs.
    nowStub = mockNow('2026-05-11T14:00:00Z');
  });
  afterEach(() => {
    if (nowStub) nowStub.restore();
  });

  it('can be created', async () => {
    const list: ContentList = await getList();
    assert.instanceOf(list, ContentList);
  });

  it('fetches items from endpoint', async () => {
    const list: ContentList = await getList({
      endpoint: '/test/assets/content-list/items.json'
    });
    // protected state — cast to any for test access
    expect((list as any).items.length).to.equal(3);
    expect((list as any).total).to.equal(3);
  });

  it('renders default columns from item keys', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [
      { key: 'name', label: 'Name' },
      { key: 'value', label: 'Value' }
    ];
    await list.updateComplete;
    const rows = list.shadowRoot!.querySelectorAll('.row');
    expect(rows.length).to.equal(3);
    // first row should mention "Alpha"
    expect(rows[0].textContent).to.contain('Alpha');
    expect(list.shadowRoot!.querySelector('.resize-handle')).to.equal(null);
  });

  it('rebuilds its column labels when the locale lands', async () => {
    // The workspace locale arrives long after the lists are constructed,
    // so the labels a list resolved before then have to be rebuilt -
    // otherwise every header stays in the source language.
    const list = (await getComponent('temba-msg-list', {}, '', 700)) as MsgList;
    list.columns = list.columns.map((column) => ({
      ...column,
      label: 'stale'
    }));
    await list.updateComplete;

    window.dispatchEvent(
      new CustomEvent('lit-localize-status', { detail: { status: 'ready' } })
    );
    await list.updateComplete;

    expect(list.columns.map((column) => column.label)).to.deep.equal([
      'Contact',
      'Message',
      'Sent'
    ]);
  });

  it('fires temba-bulk-action when an action is clicked', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name' }];
    list.bulkActions = [{ key: 'delete', label: 'Delete' }];
    // pre-select an item
    (list as any).selectedIds = new Set(['u-1']);
    await list.updateComplete;

    let bulkDetail: any = null;
    list.addEventListener(CustomEventType.BulkAction, (e: Event) => {
      bulkDetail = (e as CustomEvent).detail;
    });

    const action = list.shadowRoot!.querySelector(
      '.bulk-action'
    ) as HTMLElement;
    assert.exists(action, 'bulk action button should render');
    action.click();

    expect(bulkDetail).to.deep.equal({ action: 'delete', ids: ['u-1'] });
  });

  it('does not POST a clientOnly action, only fires the event', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    // An action-endpoint is set, but a clientOnly action must still
    // skip the POST and leave the work (e.g. opening a modal) to the host.
    list.actionEndpoint = '/test/assets/content-list/action';
    list.columns = [{ key: 'name' }];
    list.bulkActions = [{ key: 'send', label: 'Send', clientOnly: true }];
    (list as any).selectedIds = new Set(['u-1']);
    await list.updateComplete;

    const fetchStub = window.fetch as any;
    const countPosts = () =>
      fetchStub
        .getCalls()
        .filter((c: any) => (c.args[1] || {}).method === 'POST').length;
    const postsBefore = countPosts();

    let bulkDetail: any = null;
    list.addEventListener(CustomEventType.BulkAction, (e: Event) => {
      bulkDetail = (e as CustomEvent).detail;
    });

    const action = list.shadowRoot!.querySelector(
      '.bulk-action'
    ) as HTMLElement;
    assert.exists(action, 'bulk action button should render');
    action.click();
    await list.updateComplete;

    expect(bulkDetail).to.deep.equal({ action: 'send', ids: ['u-1'] });
    expect(countPosts()).to.equal(postsBefore);
  });

  it('folds the committed search into the content-menu-endpoint', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json',
      // hosts bake the original request's query string into the
      // attribute, so a deep-linked search arrives pre-folded
      'content-menu-endpoint': '/contact/active/?search=stale'
    })) as ContentList;

    const header = () =>
      list
        .shadowRoot!.querySelector('temba-page-header')!
        .getAttribute('content-menu-endpoint');

    // no committed search → any search baked into the attribute is
    // stripped, so search-dependent items (e.g. Create Smart Group)
    // don't linger once the search is gone
    expect(header()).to.equal('/contact/active/');

    // a committed search is folded in so the server's build_context_menu
    // sees it (and can surface e.g. the Create Smart Group button)
    (list as any).search = 'age > 30';
    await list.updateComplete;
    expect(header()).to.contain('search=age');

    // clearing the search strips it again
    (list as any).search = '';
    await list.updateComplete;
    expect(header()).to.equal('/contact/active/');
  });

  it('marks the frame scrolled-down so the header gets a scroll shadow', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name' }];
    await list.updateComplete;

    const scroll = list.shadowRoot!.querySelector(
      '.table-scroll'
    ) as HTMLElement;
    const frame = list.shadowRoot!.querySelector('.table-frame') as HTMLElement;

    // not scrolled yet
    expect(frame.classList.contains('scrolled-down')).to.be.false;

    // constrain the height so the body can scroll under the sticky header
    scroll.style.maxHeight = '40px';
    scroll.scrollTop = 100;
    scroll.dispatchEvent(new Event('scroll'));
    await list.updateComplete;

    expect(frame.classList.contains('scrolled-down')).to.be.true;
  });

  it('stacks the subtitle tight under the title and truncates it', async () => {
    const longSubtitle =
      'A long sub-header that should stay on the title side of the header and truncate with an ellipsis when it runs into the pagination and content menu on the right, rather than flowing full width.';
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json',
      subtitle: longSubtitle
    })) as ContentList;
    await list.updateComplete;

    const header = list.shadowRoot!.querySelector(
      'temba-page-header'
    ) as HTMLElement & { updateComplete: Promise<unknown> };
    await header.updateComplete;
    const sub = header.shadowRoot!.querySelector('.subtitle') as HTMLElement;
    const titleBlock = header.shadowRoot!.querySelector(
      '.title-block'
    ) as HTMLElement;
    const actions = header.shadowRoot!.querySelector('.actions') as HTMLElement;
    assert.exists(sub, 'subtitle should render');
    assert.exists(titleBlock, 'title block should render');

    // the subtitle lives in the left title block, not full width — it
    // stays left of the actions (pagination + content menu)
    expect(sub.getBoundingClientRect().right).to.be.at.most(
      actions.getBoundingClientRect().left + 1
    );

    // and it truncates rather than wrapping when it runs out of room
    const style = getComputedStyle(sub);
    expect(style.whiteSpace).to.equal('nowrap');
    expect(style.textOverflow).to.equal('ellipsis');
    expect(sub.scrollWidth).to.be.greaterThan(sub.clientWidth);

    // since it truncates, the full text is offered as a hover tooltip
    expect(sub.getAttribute('title')).to.equal(longSubtitle);
  });

  it('shows the empty state over the body, not as a table cell', async () => {
    const list = (await getList()) as ContentList;
    list.columns = [{ key: 'name' }];
    list.emptyMessage = 'No contacts';
    (list as any).items = [];
    (list as any).loading = false;
    (list as any).requestUpdate();
    await list.updateComplete;

    // rendered as a sibling overlay (centered in the container) rather
    // than a colspan row that would scroll off with an overflowing table
    const state = list.shadowRoot!.querySelector('.list-state') as HTMLElement;
    assert.exists(state, 'empty state should render');
    expect(state.textContent!.trim()).to.equal('No contacts');
    expect(list.shadowRoot!.querySelector('tbody td')).to.not.exist;
    expect(state.closest('.table-scroll')).to.equal(null);
  });

  it('takes the empty message from the empty-message attribute', async () => {
    // hosts set this in markup, so the hyphenated attribute has to map to
    // the property — subclasses defaulting it in their constructors used to
    // hide the fact that it didn't
    const list = (await getList({
      'empty-message': 'No widgets'
    })) as ContentList;
    list.columns = [{ key: 'name' }];
    (list as any).items = [];
    (list as any).loading = false;
    (list as any).requestUpdate();
    await list.updateComplete;

    expect(list.emptyMessage).to.equal('No widgets');
    const state = list.shadowRoot!.querySelector('.list-state') as HTMLElement;
    expect(state.textContent!.trim()).to.equal('No widgets');
  });

  it('lets the empty-message attribute beat a subclass constructor default', async () => {
    // the subclasses each assign an emptyMessage in their constructor, which
    // runs before the parser applies attributes — hosts pass a translated
    // string in markup and it has to win
    const list = (await getComponent(
      'temba-msg-list',
      { 'empty-message': 'Aucun message' },
      '',
      700
    )) as MsgList;
    (list as any).items = [];
    (list as any).loading = false;
    (list as any).requestUpdate();
    await list.updateComplete;

    expect(list.emptyMessage).to.equal('Aucun message');
    const state = list.shadowRoot!.querySelector('.list-state') as HTMLElement;
    expect(state.textContent!.trim()).to.equal('Aucun message');
  });

  it('suppresses the horizontal scroll when there are no rows', async () => {
    const list = (await getList()) as ContentList;
    list.columns = [{ key: 'name' }];
    list.minTableWidth = '1400px';
    (list as any).items = [];
    (list as any).loading = false;
    (list as any).requestUpdate();
    await list.updateComplete;

    const scroll = list.shadowRoot!.querySelector(
      '.table-scroll'
    ) as HTMLElement;
    const table = list.shadowRoot!.querySelector('table.table') as HTMLElement;

    // no rows → the scroller hides overflow-x and the forced min-width is
    // dropped, so a wide column set can't arm a horizontal scrollbar
    expect(scroll.classList.contains('no-rows')).to.be.true;
    expect(getComputedStyle(scroll).overflowX).to.equal('hidden');
    expect(table.style.minWidth).to.equal('');

    // once rows are present the scroll is armed again (min-width restored)
    (list as any).items = [{ uuid: 'u-1', name: 'Alpha' }];
    (list as any).requestUpdate();
    await list.updateComplete;
    expect(scroll.classList.contains('no-rows')).to.be.false;
    expect(table.style.minWidth).to.equal('1400px');
  });

  it('reflects membership from labelsKey across the selected rows', async () => {
    const list = (await getList()) as ContentList;
    (list as any).items = [
      { uuid: 'c1', groups: [{ uuid: 'g1' }, { uuid: 'g2' }] },
      { uuid: 'c2', groups: [{ uuid: 'g1' }] }
    ];
    (list as any).selectedIds = new Set(['c1', 'c2']);

    // g1 is on both selected rows → all; g2 on one → some; g3 on none
    expect((list as any).computeLabelState('g1', 'groups')).to.equal('all');
    expect((list as any).computeLabelState('g2', 'groups')).to.equal('some');
    expect((list as any).computeLabelState('g3', 'groups')).to.equal('none');
    // the default key ('labels') finds nothing on contact rows
    expect((list as any).computeLabelState('g1')).to.equal('none');
  });

  it('builds a contact-read href for message rows', async () => {
    const list = (await getComponent('temba-msg-list', {}, '', 700)) as MsgList;
    expect((list as any).getRowHref({ contact: { uuid: 'c-123' } })).to.equal(
      '/contact/read/c-123/'
    );
    // No uuid (or no contact at all) leaves the row non-navigating.
    expect((list as any).getRowHref({ contact: {} })).to.equal(null);
    expect((list as any).getRowHref({})).to.equal(null);
  });

  it('fires temba-redirected on row click when the row has an href', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name' }];
    // Make rows navigate; this also marks them `.clickable`.
    (list as any).getRowHref = (item: any) => `/contact/read/${item.uuid}/`;
    (list as any).requestUpdate();
    await list.updateComplete;

    let redirectUrl: string | null = null;
    list.addEventListener(CustomEventType.Redirected, (e: Event) => {
      redirectUrl = (e as CustomEvent).detail.url;
    });

    const row = list.shadowRoot!.querySelector(
      'tr.row.clickable'
    ) as HTMLElement;
    assert.exists(row, 'first row should be clickable');
    row.click();

    // Routes through the SPA via the Redirected event rather than a
    // full-page window.location assignment.
    expect(redirectUrl).to.equal('/contact/read/u-1/');
  });

  it('opens a new tab on meta-click without firing temba-redirected or temba-row-click', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name' }];
    (list as any).getRowHref = (item: any) => `/contact/read/${item.uuid}/`;
    (list as any).requestUpdate();
    await list.updateComplete;

    let redirected = false;
    list.addEventListener(CustomEventType.Redirected, () => {
      redirected = true;
    });

    // Host pages navigate on RowClick unconditionally, so firing it on
    // a meta-click would swap out the current page alongside the new tab.
    let rowClicked = false;
    list.addEventListener(CustomEventType.RowClick, () => {
      rowClicked = true;
    });

    const openStub = stub(window, 'open');
    try {
      const row = list.shadowRoot!.querySelector(
        'tr.row.clickable'
      ) as HTMLElement;
      row.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          composed: true,
          metaKey: true
        })
      );
      expect(openStub.calledOnceWithExactly('/contact/read/u-1/', '_blank')).to
        .be.true;
      expect(redirected).to.be.false;
      expect(rowClicked).to.be.false;
    } finally {
      openStub.restore();
    }
  });

  it('truncates a long message instead of widening the table (auto layout)', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-msg-list',
      { endpoint: '/test/assets/content-list/messages.json' },
      '',
      1100
    )) as MsgList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    // the message list is auto layout (so Contact/Sent size to content)
    expect((list as any).fixedLayout).to.be.false;

    // the long first message overflows (ellipsizes) within its cell
    const msgText = list.shadowRoot!.querySelector(
      'tr.row td.grow .msg-text'
    ) as HTMLElement;
    assert.exists(msgText, 'message text should render');
    expect(msgText.scrollWidth).to.be.greaterThan(msgText.clientWidth);

    // ...rather than stretching the table past its scroll frame
    const scroll = list.shadowRoot!.querySelector(
      '.table-scroll'
    ) as HTMLElement;
    expect(scroll.scrollWidth).to.be.at.most(scroll.clientWidth + 1);
  });

  it('resizes the pinned message contact column by dragging', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-msg-list',
      { endpoint: '/test/assets/content-list/messages.json' },
      '',
      520
    )) as MsgList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    const contactHeader = list.shadowRoot!.querySelector(
      'th.head-cell.pin-last'
    ) as HTMLElement;
    const handle = getResizeHandle(contactHeader) as HTMLElement;
    const initialWidth = (
      contactHeader.querySelector('.head-inner') as HTMLElement
    ).getBoundingClientRect().width;
    assert.exists(handle, 'the Contact header should have a resize handle');
    expect(getComputedStyle(handle, '::after').opacity).to.equal('1');

    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 200,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 340,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 340,
        pointerType: 'mouse'
      })
    );
    await list.updateComplete;

    const resizedWidth = (
      list.shadowRoot!.querySelector(
        'th.head-cell.pin-last .head-inner'
      ) as HTMLElement
    ).getBoundingClientRect().width;
    expect(resizedWidth).to.be.closeTo(initialWidth + 140, 1);

    // Resizing changes the pinned cell's width contract, but not its
    // sticky behavior: horizontal scrolling still leaves it anchored.
    const resizedHeader = list.shadowRoot!.querySelector(
      'th.head-cell.pin-last'
    ) as HTMLElement;
    const resizedCell = list.shadowRoot!.querySelector(
      'tr.row td.cell.pin-last'
    ) as HTMLElement;
    expect(getComputedStyle(resizedHeader).position).to.equal('sticky');
    expect(getComputedStyle(resizedCell).position).to.equal('sticky');
    const leftBeforeScroll = resizedHeader.getBoundingClientRect().left;
    const cellLeftBeforeScroll = resizedCell.getBoundingClientRect().left;
    const scroll = list.shadowRoot!.querySelector(
      '.table-scroll'
    ) as HTMLElement;
    expect(scroll.scrollWidth).to.be.greaterThan(scroll.clientWidth);
    scroll.scrollLeft = 80;
    scroll.dispatchEvent(new Event('scroll'));
    await new Promise(requestAnimationFrame);
    expect(
      Math.abs(
        (
          list.shadowRoot!.querySelector('th.head-cell.pin-last') as HTMLElement
        ).getBoundingClientRect().left - leftBeforeScroll
      )
    ).to.be.lessThan(1.5);
    expect(
      Math.abs(
        (
          list.shadowRoot!.querySelector(
            'tr.row td.cell.pin-last'
          ) as HTMLElement
        ).getBoundingClientRect().left - cellLeftBeforeScroll
      )
    ).to.be.lessThan(1.5);
  });

  it('does not sort when a resize is released over the column label', async () => {
    const list = await getList();
    list.columns = [
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        width: '140px',
        resizable: true
      },
      { key: 'details', label: 'Details', grow: true }
    ];
    await list.updateComplete;

    const header = list.shadowRoot!.querySelector(
      'th.head-cell.sortable'
    ) as HTMLElement;
    const handle = getResizeHandle(header) as HTMLElement;
    const label = header.querySelector('.label') as HTMLElement;

    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 140,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 200,
        pointerType: 'mouse'
      })
    );
    label.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        composed: true,
        clientX: 200,
        pointerType: 'mouse'
      })
    );
    label.click();

    expect((list as any).sort).to.equal('');

    // Only the synthesized post-resize click is consumed.
    label.click();
    expect((list as any).sort).to.equal('name');
  });

  it('uses a wider native table allocation as the resize floor', async () => {
    const list = await getList();
    list.columns = [
      { key: 'name', label: 'Name', width: '140px', resizable: true },
      { key: 'status', label: 'Status', width: '100px' }
    ];
    await list.updateComplete;

    const header = list.shadowRoot!.querySelector(
      'th.head-cell'
    ) as HTMLElement;
    const handle = getResizeHandle(header) as HTMLElement;
    const inner = header.querySelector('.head-inner') as HTMLElement;
    const style = getComputedStyle(header);
    const nativeWidth =
      header.getBoundingClientRect().width -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    expect(nativeWidth).to.be.greaterThan(140);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 400,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 300,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 300,
        pointerType: 'mouse'
      })
    );
    await list.updateComplete;

    // The prescribed value stays intact, so auto layout keeps the same
    // native boundary instead of feeding its extra allocation back in.
    expect(inner.style.width).to.equal('140px');
    expect(header.getBoundingClientRect().width).to.be.closeTo(
      nativeWidth +
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight),
      1
    );

    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 400,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 450,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 450,
        pointerType: 'mouse'
      })
    );
    await list.updateComplete;

    // Growing starts from the rendered boundary, not the stale 140px
    // prescription, so the handle tracks the pointer without jumping.
    expect(Number.parseFloat(inner.style.width)).to.be.closeTo(
      nativeWidth + 50,
      1
    );
  });

  it('auto-fits a column to its content within its min and max widths', async () => {
    const list = await getList();
    list.columns = [
      {
        key: 'name',
        label: 'Name',
        minWidth: '100px',
        maxWidth: '180px',
        resizable: true
      },
      { key: 'details', label: 'Details', grow: true }
    ];
    (list as any).items = [
      {
        name: 'A contact name that is much wider than the maximum column width',
        details: ''
      }
    ];
    await list.updateComplete;

    let header = list.shadowRoot!.querySelector('th.head-cell') as HTMLElement;
    let handle = getResizeHandle(header) as HTMLElement;
    handle.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, composed: true })
    );
    await list.updateComplete;
    expect(
      (header.querySelector('.head-inner') as HTMLElement).style.width
    ).to.equal('180px');

    (list as any).items = [{ name: 'A', details: '' }];
    await list.updateComplete;
    header = list.shadowRoot!.querySelector('th.head-cell') as HTMLElement;
    handle = getResizeHandle(header) as HTMLElement;
    handle.dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, composed: true })
    );
    await list.updateComplete;
    expect(
      (header.querySelector('.head-inner') as HTMLElement).style.width
    ).to.equal('100px');
  });

  it('allows a saved contact name width to shrink to its minimum', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      { endpoint: '/test/assets/content-list/contacts.json' },
      '',
      1100
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    list.historyStateKey = 'contacts';
    list.columnWidthSettings = { contacts: { name: 240 } };
    await list.updateComplete;

    const header = list.shadowRoot!.querySelector(
      'th.head-cell.pinned'
    ) as HTMLElement;
    const handle = getResizeHandle(header) as HTMLElement;
    const inner = header.querySelector('.head-inner') as HTMLElement;
    const style = getComputedStyle(header);
    const initialWidth =
      header.getBoundingClientRect().width -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);

    const handleBounds = handle.getBoundingClientRect();
    const handleX = handleBounds.left + handleBounds.width / 2;
    const handleY = handleBounds.top + handleBounds.height / 2;
    const separatorStyle = getComputedStyle(handle, '::after');
    expect(Number.parseFloat(separatorStyle.left)).to.be.closeTo(
      handleBounds.width / 2,
      0.1
    );
    expect(separatorStyle.width).to.equal('1px');
    expect(list.shadowRoot!.elementFromPoint(handleX - 3, handleY)).to.equal(
      handle
    );
    expect(list.shadowRoot!.elementFromPoint(handleX + 3, handleY)).to.equal(
      handle
    );
    await moveMouse(handleX, handleY);
    await waitForCondition(
      () => getComputedStyle(handle, '::after').width === '3px'
    );
    expect(list.shadowRoot!.elementFromPoint(handleX, handleY)).to.equal(
      handle
    );
    await mouseDown();
    expect(list.hasAttribute('column-resizing')).to.be.true;
    expect(
      list.shadowRoot!.querySelectorAll('.resize-handle.resizing').length
    ).to.equal(1);
    const otherHandle = Array.from(
      list.shadowRoot!.querySelectorAll<HTMLElement>('.resize-handle')
    ).find((candidate) => candidate !== handle)!;
    expect(getComputedStyle(otherHandle, '::after').width).to.equal('1px');
    await moveMouse(handleX - 60, handleY);
    await list.updateComplete;
    const activeHandle = list.shadowRoot!.querySelector<HTMLElement>(
      '.resize-handle.resizing'
    )!;
    expect(getComputedStyle(activeHandle, '::after').width).to.equal('3px');
    expect(
      Array.from(
        list.shadowRoot!.querySelectorAll<HTMLElement>(
          '.resize-handle:not(.resizing)'
        )
      ).every(
        (candidate) => getComputedStyle(candidate, '::after').width === '1px'
      )
    ).to.be.true;
    await mouseUp();
    await list.updateComplete;

    expect(Number.parseFloat(inner.style.width)).to.be.closeTo(
      Math.max(initialWidth - 60, 150),
      1
    );
  });

  it('keeps dragged widths when columns rebuild', async () => {
    const list = await getList({
      endpoint: '/test/assets/content-list/items.json'
    });
    list.historyStateKey = 'items';
    list.columnWidthSettings = { items: { name: 160 } };
    const buildColumns = () => [
      { key: 'name', label: 'Name', width: '140px', resizable: true },
      { key: 'value', label: 'Value', grow: true }
    ];
    list.columns = buildColumns();
    await list.updateComplete;

    const getInner = () =>
      list.shadowRoot!.querySelector('th.head-cell .head-inner') as HTMLElement;
    expect(getInner().style.width).to.equal('160px');

    const handle = getResizeHandle(
      list.shadowRoot!.querySelector('th.head-cell') as HTMLElement
    )!;
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 400,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 460, pointerType: 'mouse' })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 460, pointerType: 'mouse' })
    );
    await list.updateComplete;
    expect(getInner().style.width).to.equal('220px');

    // a columns rebuild (e.g. dynamic fields arriving) keeps the dragged
    // width even though it hasn't round-tripped into the settings attribute
    list.columns = buildColumns();
    await list.updateComplete;
    expect(getInner().style.width).to.equal('220px');

    // but a fresh settings payload replaces it outright
    list.columnWidthSettings = { items: { name: 180 } };
    await list.updateComplete;
    expect(getInner().style.width).to.equal('180px');
  });

  it('announces the rendered width when a separator gains focus', async () => {
    const list = await getList({
      endpoint: '/test/assets/content-list/items.json'
    });
    list.columns = [
      { key: 'name', label: 'Name', minWidth: '150px', resizable: true },
      { key: 'value', label: 'Value', grow: true }
    ];
    await list.updateComplete;

    const header = list.shadowRoot!.querySelector(
      'th.head-cell'
    ) as HTMLElement;
    const handle = getResizeHandle(header)!;
    // with no saved or prescribed width, the template can only render
    // the generic floor as its value
    expect(handle.getAttribute('aria-valuenow')).to.equal('80');

    handle.dispatchEvent(new FocusEvent('focus'));
    const style = getComputedStyle(header);
    const rendered =
      header.getBoundingClientRect().width -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    expect(rendered).to.be.greaterThan(140);
    expect(Number(handle.getAttribute('aria-valuenow'))).to.be.closeTo(
      Math.round(rendered),
      1
    );
  });

  it('persists resizable columns independently for each list', async () => {
    const settingsUrl = /\/user\/settings\/$/;
    mockPOST(settingsUrl, { settings: {} });
    const getPosts = () =>
      (window.fetch as any)
        .getCalls()
        .filter(
          (call: any) =>
            settingsUrl.test(String(call.args[0])) &&
            call.args[1]?.method === 'POST'
        )
        .map((call: any) => JSON.parse(call.args[1].body));
    const initialPostCount = getPosts().length;

    const list = await getList();
    list.columns = [
      { key: 'name', label: 'Name', resizable: true },
      { key: 'status', label: 'Status' },
      { key: 'details', label: 'Details', grow: true }
    ];
    list.historyStateKey = 'contacts';
    list.columnWidthSettings = {
      contacts: { name: 240 },
      msgs: { name: 360 }
    };
    list.settingsEndpoint = '/user/settings/';
    list.saveDelay = 10;
    await list.updateComplete;

    const headers = list.shadowRoot!.querySelectorAll('th.head-cell');
    expect(getResizeHandle(headers[0] as HTMLElement)).to.exist;
    expect(getResizeHandle(headers[1] as HTMLElement)).to.not.exist;
    expect(getResizeHandle(headers[2] as HTMLElement)).to.not.exist;
    expect(
      (headers[0].querySelector('.head-inner') as HTMLElement).style.width
    ).to.equal('240px');

    const handle = getResizeHandle(headers[0] as HTMLElement) as HTMLElement;
    handle.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        key: 'ArrowRight'
      })
    );
    await list.updateComplete;
    await waitForCondition(() => getPosts().length > initialPostCount);
    expect(getPosts()[initialPostCount]).to.deep.equal({
      list_columns: { contacts: { name: 250 } }
    });
    expect(list.columns[0].width).to.be.undefined;

    list.historyStateKey = 'msgs';
    await list.updateComplete;
    expect(
      (
        list.shadowRoot!.querySelector(
          'th.head-cell .head-inner'
        ) as HTMLElement
      ).style.width
    ).to.equal('360px');
  });

  it('links messages to their channel logs when the host enables them', async () => {
    const list = (await getComponent(
      'temba-msg-list',
      { 'show-logs-after': '2026-05-01T00:00:00Z' },
      '',
      700
    )) as MsgList;
    (list as any).items = [
      {
        uuid: 'msg-1',
        text: 'hello',
        contact: { uuid: 'contact-1', name: 'Bob' },
        channel: { uuid: 'chan-1', name: 'Twilio' },
        created_on: '2026-05-11T09:12:00.000000Z'
      },
      {
        uuid: 'msg-2',
        text: 'no channel',
        contact: { uuid: 'contact-1', name: 'Bob' },
        channel: null,
        created_on: '2026-05-11T09:12:00.000000Z'
      }
    ];
    list.requestUpdate();
    await list.updateComplete;

    const rows = list.shadowRoot.querySelectorAll('tr.row');
    expect(rows[0].querySelector('.log-link').getAttribute('href')).to.equal(
      '/channels/channel/logs/chan-1/msg/msg-1/'
    );
    expect(rows[1].querySelector('.log-link')).to.not.exist;

    // the link opens the log in a sheet over the list rather than being followed
    mockGET(
      /\/channels\/channel\/logs\/chan-1\/msg\/msg-1\//,
      '<div id="log">a log</div>'
    );
    const click = new MouseEvent('click', {
      bubbles: true,
      composed: true,
      cancelable: true
    });
    rows[0].querySelector('.log-link').dispatchEvent(click);
    expect(click.defaultPrevented).to.be.true;

    const sheet = document.querySelector('temba-sheet[data-shared]') as any;
    expect(sheet.current.endpoint).to.equal(
      '/channels/channel/logs/chan-1/msg/msg-1/'
    );
    expect(sheet.current.header).to.equal('Channel log');
    sheet.remove();
  });

  it('renders the messages list (screenshot)', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-msg-list',
      { searchable: true, endpoint: '/test/assets/content-list/messages.json' },
      '',
      1100
    )) as MsgList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;
    await assertScreenshot('content-list/messages', getClip(list));
  });

  it('renders a message list with no search affordance (screenshot)', async () => {
    // What the outgoing folders (Outbox / Sent / Failed) look like: same
    // header, minus the Search action, since search is opt-in.
    await loadStore();
    const list = (await getComponent(
      'temba-msg-list',
      { endpoint: '/test/assets/content-list/messages.json' },
      '',
      1100
    )) as MsgList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;
    await assertScreenshot('content-list/messages-no-search', getClip(list));
  });

  it('renders the messages list pager in cursor mode (screenshot)', async () => {
    // The message list is cursor-paginated, so its pager reports how many
    // messages the folder holds rather than a "N-M of Total" position - a
    // cursor slice has no ordinal position to report. The fixture above is
    // page-shaped (a count with no nav URLs), so it can't cover this.
    await loadStore();
    const list = (await getComponent(
      'temba-msg-list',
      {
        searchable: true,
        endpoint: '/test/assets/content-list/messages-cursor.json'
      },
      '',
      1100
    )) as MsgList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;
    expect((list as any).cursorMode).to.equal(true);
    await assertScreenshot('content-list/messages-cursor', getClip(list));
  });

  it('renders attachment thumbnails immediately after the message text', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-msg-list',
      { endpoint: '/test/assets/content-list/messages.json' },
      '',
      1100
    )) as MsgList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    const thumb = list.shadowRoot!.querySelector('.msg-thumb') as HTMLElement;
    assert.exists(thumb, 'a row should render an attachment thumbnail');
    const cell = thumb.closest('.msg-cell') as HTMLElement;
    const text = cell.querySelector('.msg-text') as HTMLElement;

    // the thumbnail trails the message text directly — separated only
    // by the cell's own gap, not pushed to the trailing edge
    const gap =
      thumb.getBoundingClientRect().left - text.getBoundingClientRect().right;
    expect(gap).to.be.greaterThan(0);
    expect(gap).to.be.lessThan(20);
  });

  it('starts an attachment-only message with the attachment', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-msg-list',
      { endpoint: '/test/assets/content-list/messages.json' },
      '',
      1100
    )) as MsgList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    // the fixture's last row (Grace Liu) carries an attachment and no text
    const cells = Array.from(
      list.shadowRoot!.querySelectorAll('.msg-cell')
    ) as HTMLElement[];
    const cell = cells[cells.length - 1];
    const thumb = cell.querySelector('.msg-thumb') as HTMLElement;
    assert.exists(thumb, 'the attachment-only row should render a thumbnail');
    assert.notExists(
      cell.querySelector('.msg-text'),
      'an attachment-only row should render no text span'
    );

    // with no text span, the thumbnail sits at the cell's leading edge
    // rather than floating after an empty text placeholder
    expect(
      thumb.getBoundingClientRect().left - cell.getBoundingClientRect().left
    ).to.be.lessThan(2);
  });

  it('aligns the bulk bar with the row text when the row has no icon', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-msg-list',
      { endpoint: '/test/assets/content-list/messages.json' },
      '',
      1100
    )) as MsgList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    (list as any).selectedIds = new Set(
      (list as any).items.map((i: any) => (list as any).rowId(i))
    );
    (list as any).requestUpdate();
    await list.updateComplete;

    const bar = list.shadowRoot!.querySelector('.bulk-bar') as HTMLElement;
    assert.exists(bar, 'bulk bar should render when rows are selected');

    // messages have no row icon, so the first chip's *left edge* (not its
    // icon) lines up with the first column's text — the bulk buttons
    // start at the contact name
    const chip = bar.querySelector('.bulk-action') as HTMLElement;
    const lead = list.shadowRoot!.querySelector(
      'tr.row td.cell .cell-inner'
    ) as HTMLElement;
    expect(
      Math.abs(
        chip.getBoundingClientRect().left - lead.getBoundingClientRect().left
      )
    ).to.be.lessThan(1.5);
  });

  it('renders the contacts list (screenshot)', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      { searchable: true, endpoint: '/test/assets/content-list/contacts.json' },
      '',
      1100
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    // ContactList loads featured fields via a separate async fetch
    // that's not gated on FetchComplete. Wait for the columns to
    // include at least one custom field so the pinned-column layout
    // is settled before snapshotting. Cap at 2s so a fixture change
    // that produces no featured fields fails fast with a clear
    // assertion instead of hanging until the mocha timeout.
    for (
      let i = 0;
      i < 200 && (list as any).featuredFields?.length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((list as any).featuredFields?.length).to.be.greaterThan(0);
    await list.updateComplete;

    const columns = (list as any).columns as Array<{
      key: string;
      grow?: boolean;
      minWidth?: string;
      resizeMinWidth?: string;
    }>;
    const createdIndex = columns.findIndex(
      (column) => column.key === 'created_on'
    );
    const customIndex = columns.findIndex((column) =>
      column.key.startsWith('field:')
    );
    const headers = list.shadowRoot!.querySelectorAll('th.head-cell');
    expect(createdIndex).to.equal(columns.length - 1);
    expect(customIndex).to.be.greaterThan(-1);
    expect(columns[customIndex].minWidth).to.equal(undefined);
    expect(columns[customIndex].resizeMinWidth).to.equal('40px');
    expect(columns.find((column) => column.key === 'name')?.minWidth).to.equal(
      '150px'
    );
    expect(
      getResizeHandle(headers[customIndex] as HTMLElement)?.getAttribute(
        'aria-valuemin'
      )
    ).to.equal('40');
    expect(columns[createdIndex].grow).to.be.true;
    expect(headers[createdIndex].classList.contains('grow')).to.be.true;
    expect(
      headers[createdIndex].getBoundingClientRect().width
    ).to.be.greaterThan(112);
    expect(getResizeHandle(headers[createdIndex] as HTMLElement)).to.equal(
      null
    );
    await assertScreenshot('content-list/contacts', getClip(list));

    const customHeader = headers[customIndex] as HTMLElement;
    const customHandle = getResizeHandle(customHeader)!;
    const customHeaderContentWidth = Math.ceil(
      Array.from(customHeader.querySelector('.head-inner')!.children).reduce(
        (width, child) =>
          width + (child as HTMLElement).getBoundingClientRect().width,
        0
      )
    );
    const expectedCustomFloor = Math.max(40, customHeaderContentWidth);
    customHandle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 500,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 0,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 0,
        pointerType: 'mouse'
      })
    );
    await list.updateComplete;
    expect(
      (customHeader.querySelector('.head-inner') as HTMLElement).style.width
    ).to.equal(`${expectedCustomFloor}px`);
    expect(expectedCustomFloor).to.be.lessThan(80);
  });

  it('gives spare contact-table width to the final Created On column', async () => {
    const list = (await getComponent(
      'temba-contact-list',
      { 'fields-endpoint': '' },
      '',
      1100
    )) as ContactList;
    await list.updateComplete;

    const columns = (list as any).columns as Array<{ key: string }>;
    const headers = Array.from(
      list.shadowRoot!.querySelectorAll('th.head-cell')
    ) as HTMLElement[];
    const createdIndex = columns.findIndex(
      (column) => column.key === 'created_on'
    );
    const createdWidth = headers[createdIndex].getBoundingClientRect().width;
    const otherWidths = headers
      .filter((_, index) => index !== createdIndex)
      .map((header) => header.getBoundingClientRect().width);

    expect(createdIndex).to.equal(columns.length - 1);
    expect(createdWidth).to.be.greaterThan(Math.max(...otherWidths));
    expect(list.shadowRoot!.querySelector('th.spacer')).to.equal(null);
  });

  it('resizes columns by dragging (screenshot)', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      { searchable: true, endpoint: '/test/assets/content-list/contacts.json' },
      '',
      1100
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    for (
      let i = 0;
      i < 200 && (list as any).featuredFields?.length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await list.updateComplete;

    const nameHeader = list.shadowRoot!.querySelector(
      'th.head-cell'
    ) as HTMLElement;
    const startWidth = nameHeader.getBoundingClientRect().width;
    const handle = getResizeHandle(nameHeader)!;
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 300,
        pointerType: 'mouse'
      })
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: 420,
        pointerType: 'mouse'
      })
    );
    await list.updateComplete;

    // mid-drag the separator is strengthened and the column tracks the
    // pointer; clip to the header region so the affordance is legible
    const dragClip = getClip(list);
    dragClip.height = 170;
    await assertScreenshot('content-list/contacts-resize-drag', dragClip);

    window.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: 420,
        pointerType: 'mouse'
      })
    );
    await list.updateComplete;
    expect(nameHeader.getBoundingClientRect().width).to.be.greaterThan(
      startWidth + 100
    );
    await assertScreenshot('content-list/contacts-resized', getClip(list));
  });

  it('shows a Ref column instead of URN for anon workspaces', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      {
        endpoint: '/test/assets/content-list/contacts-anon.json',
        anon: true
      },
      '',
      1100
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    // the urn column is replaced by a ref column...
    const colKeys = (list as any).columns.map((c: any) => c.key);
    expect(colKeys).to.include('ref');
    expect(colKeys).to.not.include('urn');
    const headers = Array.from(
      list.shadowRoot!.querySelectorAll('th .label')
    ).map((el) => el.textContent?.trim());
    expect(headers).to.include('Ref');
    expect(headers).to.not.include('URN');

    // ...whose cells render each contact's ref, not the masked urn
    const cells = Array.from(
      list.shadowRoot!.querySelectorAll('td .contact-urn')
    ).map((el) => el.textContent?.trim());
    expect(cells).to.include('S5XQ4X');
    expect(cells).to.include('WG67XY');
    expect(cells).to.not.include('********');
  });

  it('renders the primary urn display from the urn object', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      { endpoint: '/test/assets/content-list/contacts.json' },
      '',
      1100
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;

    expect((list as any).columns.map((c: any) => c.key)).to.include('urn');
    const cells = Array.from(
      list.shadowRoot!.querySelectorAll('td .contact-urn')
    ).map((el) => el.textContent?.trim());
    expect(cells).to.include('+15551112222');
  });

  it('overlays the bulk action bar on the column header when rows are selected (screenshot)', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      { searchable: true, endpoint: '/test/assets/content-list/contacts.json' },
      '',
      1100
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    for (
      let i = 0;
      i < 200 && (list as any).featuredFields?.length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // select every row so the bulk bar shows over the column headers,
    // just right of the (now all-checked) select-all checkbox
    (list as any).selectedIds = new Set(
      (list as any).items.map((i: any) => i.uuid)
    );
    (list as any).requestUpdate();
    await list.updateComplete;

    const bar = list.shadowRoot!.querySelector('.bulk-bar') as HTMLElement;
    assert.exists(bar, 'bulk bar should render when rows are selected');

    // the first action chip's left edge lines up with the row's
    // leading content (the contact silhouette icon) — same rule as the
    // message list, where it aligns with the leading text
    const chip = bar.querySelector('.bulk-action') as HTMLElement;
    const lead = list.shadowRoot!.querySelector(
      'tr.row td.lead-cell .lead-icon'
    ) as HTMLElement;
    expect(
      Math.abs(
        chip.getBoundingClientRect().left - lead.getBoundingClientRect().left
      )
    ).to.be.lessThan(1.5);
    // the page header (search/menu) is NOT replaced
    assert.exists(
      list.shadowRoot!.querySelector('temba-page-header'),
      'page header stays put'
    );
    // let the checkbox check animation settle so the capture is stable
    await new Promise((r) => setTimeout(r, 300));
    await assertScreenshot('content-list/contacts-bulk', getClip(list));
  });

  it('keeps the bulk actions above the pinned column header', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      { endpoint: '/test/assets/content-list/contacts.json' },
      '',
      1100
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    for (
      let i = 0;
      i < 200 && (list as any).featuredFields?.length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }

    // select via a real row-checkbox click, like a user would
    const checkCell = list.shadowRoot!.querySelector(
      'tr.row td.check-cell'
    ) as HTMLElement;
    checkCell.click();
    await list.updateComplete;

    const bar = list.shadowRoot!.querySelector('.bulk-bar') as HTMLElement;
    assert.exists(bar, 'bulk bar should render when rows are selected');

    // the leading chips overlap the pinned Name header, which stacks
    // above ordinary header cells for the resize handles — the bar must
    // still paint (and hit-test) above it, or the first actions are
    // hidden and unclickable under the pinned header
    const chips = Array.from(bar.querySelectorAll<HTMLElement>('.bulk-action'));
    expect(chips.length).to.be.greaterThan(0);
    chips.forEach((chip) => {
      const rect = chip.getBoundingClientRect();
      const top = list.shadowRoot!.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2
      ) as HTMLElement;
      expect(
        bar.contains(top),
        `${chip.title} chip should be on top, got ${top?.tagName}.${top?.className}`
      ).to.be.true;
    });
  });

  it('collapses the bulk action labels to icons when the bar is too narrow', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      { searchable: true, endpoint: '/test/assets/content-list/contacts.json' },
      '',
      360
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    for (
      let i = 0;
      i < 200 && (list as any).featuredFields?.length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    (list as any).selectedIds = new Set(
      (list as any).items.map((i: any) => i.uuid)
    );
    (list as any).requestUpdate();
    await list.updateComplete;
    // the collapse decision is measured in updated() and sets reactive
    // state, so let that second render settle
    await list.updateComplete;

    const bar = list.shadowRoot!.querySelector('.bulk-bar') as HTMLElement;
    expect(bar.classList.contains('collapsed')).to.be.true;
    expect((list as any).bulkCollapsed).to.be.true;
    await new Promise((r) => setTimeout(r, 300));
    await assertScreenshot(
      'content-list/contacts-bulk-collapsed',
      getClip(list)
    );
  });

  it('shows the location leaf, a created-on column, and actual dates', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-contact-list',
      { endpoint: '/test/assets/content-list/contacts.json' },
      '',
      1100
    )) as ContactList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    for (
      let i = 0;
      i < 200 && (list as any).featuredFields?.length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await list.updateComplete;

    // a created-on column is rendered alongside last-seen
    const colKeys = (list as any).columns.map((c: any) => c.key);
    expect(colKeys).to.include('created_on');
    expect(colKeys).to.include('last_seen_on');

    // location (ward) values show only the leaf, not the full hierarchy
    expect(
      (list as any).locationLeaf('Nigeria > Yobe > Nguru > Dabule')
    ).to.equal('Dabule');
    const text = list.shadowRoot!.textContent || '';
    expect(text).to.contain('Oakland');
    expect(text).to.not.contain('USA > California');

    // every date cell renders via the timedate format
    const displays = Array.from(
      list.shadowRoot!.querySelectorAll('temba-date')
    ).map((d) => d.getAttribute('display'));
    expect(displays.length).to.be.greaterThan(0);
    expect(displays.every((d) => d === 'timedate')).to.be.true;

    // empty field values render as the -- placeholder (one contact has no gender)
    expect(text).to.contain('--');

    // last-seen is no longer a pinned column
    const lastSeen = (list as any).columns.find(
      (c: any) => c.key === 'last_seen_on'
    );
    expect(lastSeen.pinned).to.be.undefined;
  });

  it('renders the flows list (screenshot)', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-flow-list',
      { searchable: true, endpoint: '/test/assets/content-list/flows.json' },
      '',
      1100
    )) as FlowList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;
    expect(list.shadowRoot!.querySelector('.resize-handle')).to.equal(null);
    await assertScreenshot('content-list/flows', getClip(list));
  });

  it('renders the triggers list (screenshot)', async () => {
    await loadStore();
    const list = (await getComponent(
      'temba-trigger-list',
      { searchable: true, endpoint: '/test/assets/content-list/triggers.json' },
      '',
      1100
    )) as TriggerList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;
    expect(list.shadowRoot!.querySelector('.resize-handle')).to.equal(null);
    await assertScreenshot('content-list/triggers', getClip(list));
  });

  it('follows cursor pagination when the response has no count', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/cursor-page1.json'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    await list.updateComplete;

    // a cursor response (no `count`) puts the list in cursor mode
    expect((list as any).cursorMode).to.equal(true);
    expect((list as any).items.length).to.equal(2);
    expect((list as any).items[0].name).to.equal('Alpha');

    // the footer drops the running total in cursor mode
    expect(list.shadowRoot!.querySelector('.pager-status')).to.equal(null);

    // previous is disabled on the first page, next is enabled
    const [prev, next] = list.shadowRoot!.querySelectorAll('.page-btn');
    expect(prev.hasAttribute('disabled')).to.equal(true);
    expect(next.hasAttribute('disabled')).to.equal(false);

    // clicking next follows the cursor URL to the second page
    const onPage2 = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    (next as HTMLElement).click();
    await onPage2;
    await list.updateComplete;
    expect((list as any).items.length).to.equal(1);
    expect((list as any).items[0].name).to.equal('Charlie');

    // on the last page next is disabled, previous is enabled
    const [prev2, next2] = list.shadowRoot!.querySelectorAll('.page-btn');
    expect(prev2.hasAttribute('disabled')).to.equal(false);
    expect(next2.hasAttribute('disabled')).to.equal(true);
  });

  it('blocks paging while a page fetch is in flight', async () => {
    clearMockGets();
    // a counted cursor endpoint (like the messages API)
    mockGET(/\/msgs\.json\?cursor=abc/, {
      next: null,
      previous: '/msgs.json?cursor=xyz',
      count: 4,
      results: [
        { uuid: 'm-3', name: 'Charlie' },
        { uuid: 'm-4', name: 'Delta' }
      ]
    });
    mockGET(/\/msgs\.json$/, {
      next: '/msgs.json?cursor=abc',
      previous: null,
      count: 4,
      results: [
        { uuid: 'm-1', name: 'Alpha' },
        { uuid: 'm-2', name: 'Bravo' }
      ]
    });

    const list = (await getList({
      endpoint: '/msgs.json'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    await list.updateComplete;

    const fetchStub = window.fetch as any;
    const countCursorFetches = () =>
      fetchStub
        .getCalls()
        .filter((c: any) => String(c.args[0]).includes('cursor=abc')).length;

    const onPage2 = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    const [, next] = list.shadowRoot!.querySelectorAll('.page-btn');
    (next as HTMLElement).click();

    // while the request is in flight further paging is blocked — a
    // repeat click can't fire a second fetch (in cursor mode it would
    // re-follow the same stale next URL and land on the wrong slice)
    expect((list as any).loading).to.equal(true);
    (next as HTMLElement).click();
    expect(countCursorFetches()).to.equal(1);

    await onPage2;
    await list.updateComplete;
    expect((list as any).items[0].name).to.equal('Charlie');

    // and the buttons themselves render disabled while loading
    (list as any).loading = true;
    await list.updateComplete;
    list.shadowRoot!.querySelectorAll('.page-btn').forEach((btn) => {
      expect(btn.hasAttribute('disabled')).to.equal(true);
    });
    (list as any).loading = false;
    await list.updateComplete;
  });

  it('keeps position out of the URL for page-counted lists too', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    // a page-counted list several pages in still bubbles a clean URL —
    // position restores from the history stash, not the query string
    (list as any).page = 3;
    expect((list as any).cursorMode).to.equal(false);
    expect((list as any).buildBrowserUrl()).to.not.contain('page=');

    // except in urlState mode, which has no history stash — there the
    // URL is the only position store, so page keeps round-tripping
    list.urlState = true;
    expect((list as any).buildBrowserUrl()).to.contain('page=3');
    list.urlState = false;
  });

  it('re-stashes its state onto the history entry after restoring from it', async () => {
    clearMockGets();
    mockGET(/\/msgs\.json\?cursor=abc/, {
      next: null,
      previous: '/msgs.json?cursor=xyz',
      count: 4,
      results: [
        { uuid: 'm-3', name: 'Charlie' },
        { uuid: 'm-4', name: 'Delta' }
      ]
    });
    mockGET(/\/msgs\.json$/, {
      next: '/msgs.json?cursor=abc',
      previous: null,
      count: 4,
      results: [
        { uuid: 'm-1', name: 'Alpha' },
        { uuid: 'm-2', name: 'Bravo' }
      ]
    });

    const list = (await getList({
      endpoint: '/msgs.json',
      'history-state-key': 'msgs'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    await list.updateComplete;

    try {
      // return to an entry whose stash points at the second slice (as
      // after a refresh, where the SPA frame's history bootstrap has
      // rebuilt the entry state around the preserved stash)
      history.replaceState(
        {
          msgs: { page: 2, sort: '', search: '', url: '/msgs.json?cursor=abc' }
        },
        ''
      );

      const events: any[] = [];
      list.addEventListener(CustomEventType.HistoryChange, (e: any) =>
        events.push(e.detail)
      );
      const onRestore = new Promise<void>((resolve) => {
        list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
          once: true
        });
      });
      window.dispatchEvent(new PopStateEvent('popstate'));
      await onRestore;

      // the restore followed the stashed cursor URL to the saved slice
      expect((list as any).items[0].name).to.equal('Charlie');

      // and re-bubbled a replacing stash so the entry carries the
      // state again — this is what lets the next refresh restore too
      const restash = events.find((e) => e.replace && e.state?.url);
      assert.exists(restash, 'restore should re-bubble a replacing stash');
      expect(restash.state.url).to.equal('/msgs.json?cursor=abc');
      // the cursor URL is the whole restoration mechanism — `page` is
      // pinned to 1 in cursor mode, where it carries no meaning
      expect(restash.state.page).to.equal(1);
    } finally {
      history.replaceState({}, '');
    }
  });

  it('shows the run-search icon and its hint only while a pending draft is uncommitted', async () => {
    const list = (await getList({
      searchable: true,
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    await list.updateComplete;

    // Open search with no draft — nothing to run, so neither the run
    // icon nor the "↵ to search" hint is rendered.
    (list as any).searchOpen = true;
    await list.updateComplete;
    expect(list.shadowRoot!.querySelector('.searchbar .search-go')).to.equal(
      null
    );
    expect(list.shadowRoot!.querySelector('.searchbar .search-hint')).to.equal(
      null
    );

    // A draft that differs from the committed search is pending — the
    // icon and the hint appear (the click/Enter equivalent).
    (list as any).searchDraft = 'a';
    (list as any).requestUpdate();
    await list.updateComplete;
    expect(
      list.shadowRoot!.querySelector('.searchbar .search-go')
    ).to.not.equal(null);
    expect(
      list.shadowRoot!.querySelector('.searchbar .search-hint')
    ).to.not.equal(null);

    // Committing the draft clears the pending state, so the icon and the
    // hint go away again.
    const onFetch = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    (list as any).commitSearch();
    await onFetch;
    await list.updateComplete;
    expect(list.shadowRoot!.querySelector('.searchbar .search-go')).to.equal(
      null
    );
    expect(list.shadowRoot!.querySelector('.searchbar .search-hint')).to.equal(
      null
    );

    // The result count is no longer in the search bar — it rides with
    // the pagination controls instead.
    expect(list.shadowRoot!.querySelector('.searchbar .result-count')).to.equal(
      null
    );
  });

  it('renders no search affordance and ignores a URL search unless searchable', async () => {
    const restore = window.location.href;
    window.history.replaceState({}, '', '/msg/sent/?search=hello');

    try {
      // search is opt-in, so a list that doesn't ask for it gets none
      const list = (await getList({
        endpoint: '/test/assets/content-list/items.json'
      })) as ContentList;
      list.columns = [{ key: 'name', label: 'Name' }];
      await list.updateComplete;

      expect(list.searchable).to.equal(false);

      // no way in from the header, and no bar even if something opens it
      expect(
        list.shadowRoot!.querySelector('.header-actions .action')
      ).to.equal(null);
      (list as any).searchOpen = true;
      await list.updateComplete;
      expect(list.shadowRoot!.querySelector('.searchbar')).to.equal(null);

      // a deep-linked search is dropped rather than silently filtering
      (list as any).readUrlState();
      expect((list as any).search).to.equal('');
    } finally {
      window.history.replaceState({}, '', restore);
    }
  });

  it('toggles the header Search button against the open search bar and cancels out', async () => {
    const list = (await getList({
      searchable: true,
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    await list.updateComplete;

    // Closed: the header Search action is the way in, the bar is absent.
    expect(
      list.shadowRoot!.querySelector('.header-actions .action')
    ).to.not.equal(null);
    expect(list.shadowRoot!.querySelector('.searchbar')).to.equal(null);

    // Opening hides the header Search action (it became the bar) and
    // surfaces the always-present Cancel control as the way out.
    (list as any).toggleSearch();
    await list.updateComplete;
    expect(list.shadowRoot!.querySelector('.header-actions .action')).to.equal(
      null
    );
    const cancel = list.shadowRoot!.querySelector(
      '.searchbar .search-cancel'
    ) as HTMLElement;
    expect(cancel).to.not.equal(null);

    // Cancel closes the bar and restores the header Search action.
    cancel.click();
    await list.updateComplete;
    expect((list as any).searchOpen).to.equal(false);
    expect(list.shadowRoot!.querySelector('.searchbar')).to.equal(null);
    expect(
      list.shadowRoot!.querySelector('.header-actions .action')
    ).to.not.equal(null);
  });

  it('shows the run-search icon whenever the draft varies from the results query, including when emptied', async () => {
    const list = (await getList({
      searchable: true,
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];

    // Results are based on a committed query and the box matches it —
    // nothing to run, so the icon isn't rendered.
    (list as any).searchOpen = true;
    (list as any).search = 'age > 30';
    (list as any).searchDraft = 'age > 30';
    (list as any).requestUpdate();
    await list.updateComplete;
    expect(list.shadowRoot!.querySelector('.searchbar .search-go')).to.equal(
      null
    );

    // Emptying the box while the results still reflect the old query is
    // a variance too — the icon appears so the user can run the now
    // empty (cleared) search.
    (list as any).searchDraft = '';
    (list as any).requestUpdate();
    await list.updateComplete;
    expect(
      list.shadowRoot!.querySelector('.searchbar .search-go')
    ).to.not.equal(null);
  });

  it('disables the search input while a search is in flight', async () => {
    const list = (await getList({
      searchable: true,
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    (list as any).searchOpen = true;
    await list.updateComplete;

    const input = () =>
      list.shadowRoot!.querySelector('.searchbar input') as HTMLInputElement;
    expect(input().disabled).to.equal(false);

    (list as any).searching = true;
    (list as any).requestUpdate();
    await list.updateComplete;
    expect(input().disabled).to.equal(true);
    // the run icon isn't rendered against the disabled box mid-search
    expect(list.shadowRoot!.querySelector('.searchbar .search-go')).to.equal(
      null
    );

    (list as any).searching = false;
    (list as any).requestUpdate();
    await list.updateComplete;
    expect(input().disabled).to.equal(false);
  });

  it('adopts a server-adjusted query, mirrors it into the box, and parks the cursor at the end', async () => {
    // The search response echoes a normalized query ("age>30" → "age > 30").
    mockGET(/items\.json\?.*search=/, {
      results: [{ uuid: 'u-1', name: 'Alpha' }],
      count: 1,
      query: 'age > 30'
    });
    try {
      const list = (await getList({
        searchable: true,
        endpoint: '/test/assets/content-list/items.json'
      })) as ContentList;
      list.columns = [{ key: 'name', label: 'Name' }];
      (list as any).searchOpen = true;
      await list.updateComplete;

      // Type an un-normalized query and run it.
      (list as any).searchDraft = 'age>30';
      const onFetch = new Promise<void>((resolve) => {
        list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
          once: true
        });
      });
      (list as any).commitSearch();
      await onFetch;
      await list.updateComplete;
      // let the post-fetch focus/caret microtask run
      await new Promise((r) => setTimeout(r, 0));

      // The box now shows the adjusted query, which is also the basis of
      // the results — so the Search button is hidden again.
      expect((list as any).searchDraft).to.equal('age > 30');
      expect((list as any).search).to.equal('age > 30');
      const input = list.shadowRoot!.querySelector(
        '.searchbar input'
      ) as HTMLInputElement;
      expect(input.value).to.equal('age > 30');
      expect(input.disabled).to.equal(false);
      expect(list.shadowRoot!.querySelector('.searchbar .search-go')).to.equal(
        null
      );

      // Caret parked at the end of the (adjusted) value.
      expect(input.selectionStart).to.equal('age > 30'.length);
      expect(input.selectionEnd).to.equal('age > 30'.length);
    } finally {
      clearMockGets();
    }
  });

  it('surfaces a query-validation error over the empty table, then clears it on a good search', async () => {
    // A bad query comes back list-shaped (empty) with an `error` message.
    mockGET(/items\.json\?.*search=/, {
      results: [],
      count: 0,
      error: "mismatched input '<EOF>'"
    });
    try {
      const list = (await getList({
        searchable: true,
        endpoint: '/test/assets/content-list/items.json'
      })) as ContentList;
      list.columns = [{ key: 'name', label: 'Name' }];
      (list as any).searchOpen = true;
      await list.updateComplete;

      (list as any).searchDraft = 'age >';
      let onFetch = new Promise<void>((resolve) => {
        list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
          once: true
        });
      });
      (list as any).commitSearch();
      await onFetch;
      await list.updateComplete;

      // The error takes over the empty-table slot (with error styling),
      // not the plain "nothing to show" copy.
      expect((list as any).searchError).to.equal("mismatched input '<EOF>'");
      const state = list.shadowRoot!.querySelector(
        '.list-state.error .state-error'
      ) as HTMLElement;
      assert.exists(state, 'error state should render');
      expect(state.textContent!.trim()).to.contain("mismatched input '<EOF>'");
      expect(list.shadowRoot!.querySelectorAll('tbody tr').length).to.equal(0);

      // A subsequent good search clears the error.
      clearMockGets();
      mockGET(/items\.json\?.*search=/, {
        results: [{ uuid: 'u-1', name: 'Alpha' }],
        count: 1
      });
      (list as any).searchDraft = 'age > 30';
      onFetch = new Promise<void>((resolve) => {
        list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
          once: true
        });
      });
      (list as any).commitSearch();
      await onFetch;
      await list.updateComplete;

      expect((list as any).searchError).to.equal('');
      expect(list.shadowRoot!.querySelector('.list-state.error')).to.equal(
        null
      );
    } finally {
      clearMockGets();
    }
  });

  it('shows the count in the pager in cursor mode', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    // Cursor list that also carries a count (e.g. the message list's
    // cheap folder count) — the pager reports how many rows exist, not
    // which of them you're looking at, because a cursor slice has no
    // ordinal position. `page` is seeded non-1 to prove it no longer
    // reaches the label.
    Object.assign(list as any, {
      cursorMode: true,
      hasCount: true,
      total: 42,
      pageSize: 10,
      page: 2,
      items: Array.from({ length: 10 }, (_, i) => ({ uuid: `u-${i}` })),
      prevCursor: '/x?cursor=a',
      nextCursor: '/x?cursor=b'
    });
    (list as any).requestUpdate();
    await list.updateComplete;

    const status = list.shadowRoot!.querySelector(
      '.pager-status'
    ) as HTMLElement;
    assert.exists(status, 'pager status should render in counted cursor mode');
    const text = status.textContent!.replace(/\s+/g, ' ').trim();
    expect(text).to.equal('42 total');
  });

  it('shows matches instead of total when the rows are a search result', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    Object.assign(list as any, {
      cursorMode: true,
      hasCount: true,
      total: 42,
      search: 'flow',
      items: Array.from({ length: 10 }, (_, i) => ({ uuid: `u-${i}` })),
      nextCursor: '/x?cursor=b'
    });
    (list as any).requestUpdate();
    await list.updateComplete;

    const status = list.shadowRoot!.querySelector(
      '.pager-status'
    ) as HTMLElement;
    expect(status.textContent!.replace(/\s+/g, ' ').trim()).to.equal(
      '42 matches'
    );
  });

  it('shows a position range on a page-counted list', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    // Page-counted lists have a real position, so the range framing
    // holds on every page — including the first.
    Object.assign(list as any, {
      cursorMode: false,
      hasCount: true,
      total: 42,
      pageSize: 10,
      page: 1,
      items: Array.from({ length: 10 }, (_, i) => ({ uuid: `u-${i}` }))
    });
    (list as any).requestUpdate();
    await list.updateComplete;

    const status = list.shadowRoot!.querySelector(
      '.pager-status'
    ) as HTMLElement;
    expect(status.textContent!.replace(/\s+/g, ' ').trim()).to.equal(
      '1–10 of 42'
    );

    (list as any).page = 2;
    (list as any).requestUpdate();
    await list.updateComplete;
    expect(status.textContent!.replace(/\s+/g, ' ').trim()).to.equal(
      '11–20 of 42'
    );

    // a searched list carries its filtered-set context in the range
    (list as any).search = 'flow';
    (list as any).requestUpdate();
    await list.updateComplete;
    expect(status.textContent!.replace(/\s+/g, ' ').trim()).to.equal(
      '11–20 of 42 matches'
    );
  });

  it('keeps cursor framing for a single-page response the server marks as cursor-paged', async () => {
    // A single-page cursor response has no nav URLs to inspect, so
    // without `paged_by` it would be mistaken for a page-counted one
    // and flip the pager into "1–N of N" framing — jarring next to a
    // bigger folder on the same endpoint showing a plain total.
    const list = (await getList({
      endpoint: '/test/assets/content-list/messages.json'
    })) as ContentList;
    expect((list as any).cursorMode).to.equal(true);

    const status = list.shadowRoot!.querySelector(
      '.pager-status'
    ) as HTMLElement;
    expect(status.textContent!.replace(/\s+/g, ' ').trim()).to.equal('7 total');
  });

  it('stays in cursor mode when a count is returned alongside cursor URLs', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    // Drive the detection directly with a synthetic cursor response.
    const cursorMode = (list as any).detectCursorMode({
      results: [],
      count: 42,
      next: '/x/?cursor=opaque-token',
      previous: null
    });
    expect(cursorMode).to.equal(true);

    // No cursor signal + count present → page mode.
    expect(
      (list as any).detectCursorMode({
        results: [],
        count: 42,
        next: '/x/?page=2',
        previous: null
      })
    ).to.equal(false);

    // `paged_by` is authoritative — it settles the single-page case
    // that has no nav URLs to inspect, in both directions.
    expect(
      (list as any).detectCursorMode({
        results: [],
        count: 7,
        paged_by: 'cursor',
        next: null,
        previous: null
      })
    ).to.equal(true);
    expect(
      (list as any).detectCursorMode({
        results: [],
        count: 7,
        paged_by: 'page',
        next: null,
        previous: null
      })
    ).to.equal(false);
  });

  it('fires temba-history-change with replace=false on page change and committed search', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/cursor-page1.json',
      'history-state-key': 'msgs'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    await list.updateComplete;

    const events: any[] = [];
    list.addEventListener(CustomEventType.HistoryChange, (e: any) =>
      events.push(e.detail)
    );

    // paging — pushes a new history entry
    const onPage2 = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    const [, next] = list.shadowRoot!.querySelectorAll('.page-btn');
    (next as HTMLElement).click();
    await onPage2;

    expect(events.length).to.be.greaterThan(0);
    const pageEvent = events[events.length - 1];
    expect(pageEvent.key).to.equal('msgs');
    expect(pageEvent.replace).to.equal(false);
    // stepping a cursor list advances the stashed cursor URL, not a page
    // number — `page` stays pinned at 1
    expect(pageEvent.state.page).to.equal(1);
    expect(pageEvent.state.url).to.contain('cursor-page2');
    // list position stays out of the address-bar URL — it restores
    // from the history stash instead
    expect(pageEvent.url).to.not.contain('page=');

    // committed search — also pushes a new entry
    events.length = 0;
    (list as any).searchDraft = 'a';
    const onSearch = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    (list as any).commitSearch();
    await onSearch;

    expect(events.length).to.be.greaterThan(0);
    const searchEvent = events[events.length - 1];
    expect(searchEvent.replace).to.equal(false);
    expect(searchEvent.state.search).to.equal('a');
    // the event carries the address-bar URL for the new state so the
    // host can reflect it when it pushes the history entry
    expect(searchEvent.url).to.contain('search=a');

    // clearing the search drops the param from the bubbled URL
    events.length = 0;
    const onClear = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    (list as any).clearSearch();
    await onClear;

    const clearEvent = events[events.length - 1];
    expect(clearEvent.state.search).to.equal('');
    expect(clearEvent.url).to.not.contain('search=');
  });

  it('restores from history.state and re-fetches on popstate', async () => {
    // Seed the active history entry as if a prior visit had stashed
    // page/sort/search for this list.
    const seeded = {
      msgs: { page: 1, sort: '-name', search: 'b' }
    };
    history.replaceState(seeded, '');

    const list = (await getList({
      searchable: true,
      endpoint: '/test/assets/content-list/items.json',
      'history-state-key': 'msgs'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    await list.updateComplete;

    expect((list as any).sort).to.equal('-name');
    expect((list as any).search).to.equal('b');

    // Simulate browser back to an entry with different list state —
    // several pages in, as a page-counted list's stash would be after
    // paging (this is the only position store; the URL carries none).
    history.replaceState({ msgs: { page: 3, sort: 'name', search: '' } }, '');
    const onFetch = new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    window.dispatchEvent(new PopStateEvent('popstate'));
    await onFetch;

    expect((list as any).sort).to.equal('name');
    expect((list as any).search).to.equal('');
    // the page came back from the stash and was re-sent to the endpoint
    expect((list as any).page).to.equal(3);
    expect((list as any).currentUrl).to.contain('page=3');
  });

  it('falls back to URL params when history has no stash for the key', async () => {
    const originalUrl = window.location.pathname + window.location.search;
    // Fresh navigation: no stash for this key yet, but the link itself
    // deep-links a search (e.g. /contact/?search=age%3E10).
    history.replaceState({}, '', '?search=age+%3E+10&sort=-name');
    try {
      const list = (await getList({
        searchable: true,
        endpoint: '/test/assets/content-list/items.json',
        'history-state-key': 'contacts'
      })) as ContentList;
      list.columns = [{ key: 'name', label: 'Name' }];
      await list.updateComplete;

      expect((list as any).search).to.equal('age > 10');
      expect((list as any).sort).to.equal('-name');
      // the search bar opens showing the active query
      expect((list as any).searchOpen).to.equal(true);
      expect((list as any).searchDraft).to.equal('age > 10');
      // and the fetch carried it to the endpoint
      expect((list as any).currentUrl).to.contain('search=');

      // Once a stash exists for the key it wins over the (now stale)
      // query string still sitting in the URL.
      history.replaceState({ contacts: { page: 1, sort: '', search: '' } }, '');
      const onFetch = new Promise<void>((resolve) => {
        list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
          once: true
        });
      });
      window.dispatchEvent(new PopStateEvent('popstate'));
      await onFetch;
      expect((list as any).search).to.equal('');
      expect((list as any).searchOpen).to.equal(false);
    } finally {
      history.replaceState({}, '', originalUrl);
    }
  });

  it('toggles sort direction on header click', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name', sortable: true, label: 'Name' }];
    await list.updateComplete;

    const head = list.shadowRoot!.querySelector(
      '.head-cell.sortable'
    ) as HTMLElement;
    assert.exists(head);
    head.click();
    expect((list as any).sort).to.equal('name');
    head.click();
    expect((list as any).sort).to.equal('-name');
    head.click();
    expect((list as any).sort).to.equal('');
  });

  it('shows the label dropdown create row and fires temba-label-create', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    const action = {
      key: 'label',
      label: 'Label',
      labelsEndpoint: '/test/assets/content-list/labels.json',
      allowCreate: true
    };
    list.bulkActions = [action];
    (list as any).selectedIds = new Set(
      (list as any).items.map((i: any) => (list as any).rowId(i))
    );
    (list as any).requestUpdate();
    await list.updateComplete;

    // before the dropdown's lazy fetch the create row isn't rendered yet
    assert.notExists(list.shadowRoot!.querySelector('.lbl-create'));

    await (list as any).handleLabelDropdownOpened(action);
    await list.updateComplete;

    const create = list.shadowRoot!.querySelector('.lbl-create') as HTMLElement;
    assert.exists(create, 'create row should render when allowCreate is set');

    let detail: any = null;
    list.addEventListener(CustomEventType.LabelCreate, ((e: CustomEvent) => {
      detail = e.detail;
    }) as EventListener);
    create.click();
    expect(detail.action).to.equal('label');
    expect(detail.ids).to.deep.equal(['u-1', 'u-2', 'u-3']);

    // a refresh (e.g. after the host's create modal submits) drops the
    // cached dropdown labels so the next open re-fetches them
    list.refresh();
    expect((list as any).labelsByActionKey).to.deep.equal({});
  });

  it('shows an empty state in the label dropdown without allowCreate', async () => {
    const list = (await getList({
      endpoint: '/test/assets/content-list/items.json'
    })) as ContentList;
    list.columns = [{ key: 'name', label: 'Name' }];
    const action = {
      key: 'label',
      label: 'Label',
      labelsEndpoint: '/test/assets/content-list/labels-empty.json'
    };
    list.bulkActions = [action];
    (list as any).selectedIds = new Set(['u-1']);
    (list as any).requestUpdate();
    await list.updateComplete;

    await (list as any).handleLabelDropdownOpened(action);
    await list.updateComplete;

    // fetched-empty with no create affordance reads as "No labels", not a
    // permanent "Loading…"
    const empty = list.shadowRoot!.querySelector(
      '.label-menu-empty'
    ) as HTMLElement;
    assert.exists(empty);
    expect(empty.textContent).to.contain('No labels');
    assert.notExists(list.shadowRoot!.querySelector('.lbl-create'));
  });

  describe('column reordering', () => {
    const PRIORITY_URL = '/fields/update_priority/';
    const priorityRegex = /\/fields\/update_priority\/$/;
    // Its own endpoint rather than a second mock on PRIORITY_URL — the
    // mock registry matches the first entry it finds, so a failing mock
    // for the same URL would leak into every other test in the block.
    const DENIED_URL = '/fields/update_priority/denied/';
    const deniedRegex = /\/fields\/update_priority\/denied\/$/;

    const fieldsFetchCount = () =>
      (window.fetch as any)
        .getCalls()
        .filter((call: any) => /\/api\/v2\/fields\.json/.test(call.args[0]))
        .length;

    const getPriorityPosts = () =>
      (window.fetch as any)
        .getCalls()
        .filter(
          (call: any) =>
            priorityRegex.test(String(call.args[0])) &&
            call.args[1]?.method === 'POST'
        )
        .map((call: any) => JSON.parse(call.args[1].body));

    const getContactList = async (attrs: any = {}) => {
      const list = (await getComponent(
        'temba-contact-list',
        {
          endpoint: '/test/assets/content-list/contacts.json',
          searchable: true,
          ...attrs
        },
        '',
        1100
      )) as ContactList;
      await new Promise<void>((resolve) => {
        list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
          once: true
        });
      });
      // featured fields arrive via their own async fetch — wait for the
      // field columns before interacting with the header
      await waitForCondition(
        () => ((list as any).featuredFields || []).length > 0
      );
      await list.updateComplete;
      return list;
    };

    const headerFor = (list: ContentList, key: string): HTMLElement =>
      list.shadowRoot!.querySelector(
        `th.head-cell[data-key="${key}"]`
      ) as HTMLElement;

    const columnKeys = (list: ContentList): string[] =>
      (list as any).columns.map((c: any) => c.key);

    /** Grab a header at its center and release the drag at clientX. */
    const dragHeader = async (
      list: ContentList,
      fromKey: string,
      clientX: number
    ) => {
      const header = headerFor(list, fromKey);
      const rect = header.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      header.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: startX,
          pointerType: 'mouse'
        })
      );
      // the first move crosses the dead zone, the second lands on target
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: startX + 10,
          pointerType: 'mouse'
        })
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX, pointerType: 'mouse' })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX, pointerType: 'mouse' })
      );
      await list.updateComplete;
    };

    /** Press a header and cross the dead zone, leaving the drag live. */
    const beginDrag = async (list: ContentList, fromKey: string) => {
      const header = headerFor(list, fromKey);
      const rect = header.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      header.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: startX,
          pointerType: 'mouse'
        })
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: startX + 30,
          pointerType: 'mouse'
        })
      );
      await list.updateComplete;
    };

    /** The ghost lives on document.body, outside the shadow root. */
    const ghostCount = () =>
      document.querySelectorAll('.column-drag-ghost').length;

    it('reorders field columns by dragging and saves the featured order', async () => {
      await loadStore();
      mockPOST(priorityRegex, { status: 'OK' });
      const initialPosts = getPriorityPosts().length;
      const list = await getContactList({ 'priority-endpoint': PRIORITY_URL });

      // the api fixture serves six featured fields, in priority order
      expect(columnKeys(list)).to.deep.equal([
        'name',
        'urn',
        'field:state',
        'field:district',
        'field:ward',
        'field:joined',
        'field:age',
        'field:gender',
        'last_seen_on',
        'created_on'
      ]);

      // only the field columns are drag targets
      expect(headerFor(list, 'field:state').classList.contains('reorderable'))
        .to.be.true;
      expect(headerFor(list, 'name').classList.contains('reorderable')).to.be
        .false;
      expect(headerFor(list, 'created_on').classList.contains('reorderable')).to
        .be.false;

      // the reorder announces itself on its own event type — the shared
      // OrderChanged carries other, incompatible payloads
      const orderEvents: any[] = [];
      list.addEventListener(CustomEventType.ColumnOrderChanged, (event: any) =>
        orderEvents.push(event.detail)
      );

      // drag State just past District's midpoint — they swap
      const district = headerFor(list, 'field:district');
      const dRect = district.getBoundingClientRect();
      await dragHeader(list, 'field:state', dRect.left + dRect.width * 0.9);

      expect(columnKeys(list)).to.deep.equal([
        'name',
        'urn',
        'field:district',
        'field:state',
        'field:ward',
        'field:joined',
        'field:age',
        'field:gender',
        'last_seen_on',
        'created_on'
      ]);

      expect(orderEvents.length).to.equal(1);
      expect(orderEvents[0].from).to.equal(2);
      expect(orderEvents[0].to).to.equal(3);

      // the floating ghost is torn down with the drag
      expect(ghostCount()).to.equal(0);

      // featuredFields follows the columns so later rebuilds keep the order
      expect(
        ((list as any).featuredFields as any[]).map((f) => f.key)
      ).to.deep.equal(['district', 'state', 'ward', 'joined', 'age', 'gender']);

      // completing a drag over a sortable header must not also sort
      expect((list as any).sort).to.equal('');

      // the full featured list is saved in column order
      await waitForCondition(() => getPriorityPosts().length > initialPosts);
      expect(getPriorityPosts()[initialPosts]).to.deep.equal({
        featured: ['district', 'state', 'ward', 'joined', 'age', 'gender']
      });

      // a save the server accepted leaves the dragged order alone — no
      // refetch of the fields, no snap back to the fixture order
      const fetchesAfterSave = fieldsFetchCount();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fieldsFetchCount()).to.equal(fetchesAfterSave);
      expect(columnKeys(list).slice(2, 4)).to.deep.equal([
        'field:district',
        'field:state'
      ]);

      // a plain click on a reorderable header — pointer never leaves
      // the dead zone — still sorts. Let the drag's one-tick click
      // suppression window lapse first, as any real click would.
      await new Promise((resolve) => setTimeout(resolve, 1));
      const header = headerFor(list, 'field:district');
      header.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 400,
          pointerType: 'mouse'
        })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 400, pointerType: 'mouse' })
      );
      header.click();
      expect((list as any).sort).to.equal('field:district');
    });

    it('reverts the column order when the save is refused', async () => {
      await loadStore();
      // a 403 resolves rather than rejects in postUrl (only 5xx rejects),
      // so this is the case a naive .catch() would sail straight past
      mockPOST(deniedRegex, { error: 'no permission' }, {}, '403');
      const warn = stub(console, 'warn');
      try {
        const list = await getContactList({ 'priority-endpoint': DENIED_URL });
        const original = columnKeys(list);

        const district = headerFor(list, 'field:district');
        const dRect = district.getBoundingClientRect();
        await dragHeader(list, 'field:state', dRect.left + dRect.width * 0.9);

        // the drop applies optimistically
        expect(columnKeys(list).slice(2, 4)).to.deep.equal([
          'field:district',
          'field:state'
        ]);

        // then the refused save refetches the fields and puts the
        // columns back the way the server still has them
        await waitForCondition(
          () => columnKeys(list).join() === original.join()
        );
        expect(
          ((list as any).featuredFields as any[]).map((f) => f.key)
        ).to.deep.equal([
          'state',
          'district',
          'ward',
          'joined',
          'age',
          'gender'
        ]);
        expect(warn.called).to.be.true;
      } finally {
        warn.restore();
      }
    });

    it('reads every page of a paginated fields endpoint', async () => {
      await loadStore();
      mockPOST(priorityRegex, { status: 'OK' });
      // The fields API is cursor paginated. The featured list posted on
      // a drop is authoritative, so a featured field stranded on page two
      // would be un-featured org-wide by the next drag.
      const PAGED_URL = '/paged-fields.json';
      // Page two is registered first: the mock registry answers with the
      // first regex that matches, and page one's would swallow it.
      mockGET(/\/paged-fields\.json\?cursor=2$/, {
        next: null,
        results: [
          {
            key: 'region',
            name: 'Region',
            featured: true,
            priority: 7,
            value_type: 'text'
          }
        ]
      });
      mockGET(/\/paged-fields\.json$/, {
        next: `${PAGED_URL}?cursor=2`,
        results: [
          {
            key: 'state',
            name: 'State',
            featured: true,
            priority: 10,
            value_type: 'text'
          },
          {
            key: 'gender',
            name: 'Gender',
            featured: true,
            priority: 5,
            value_type: 'text'
          },
          {
            key: 'born',
            name: 'Born',
            featured: false,
            priority: 0,
            value_type: 'numeric'
          }
        ]
      });
      try {
        const initialPosts = getPriorityPosts().length;
        const list = await getContactList({
          'priority-endpoint': PRIORITY_URL,
          'fields-endpoint': PAGED_URL
        });

        // both pages contribute columns, and priority orders them across
        // the page boundary rather than page-by-page
        expect(columnKeys(list)).to.deep.equal([
          'name',
          'urn',
          'field:state',
          'field:region',
          'field:gender',
          'last_seen_on',
          'created_on'
        ]);

        // dragging State past Region swaps them
        const region = headerFor(list, 'field:region');
        const rRect = region.getBoundingClientRect();
        await dragHeader(list, 'field:state', rRect.left + rRect.width * 0.9);
        expect(columnKeys(list).slice(2, 5)).to.deep.equal([
          'field:region',
          'field:state',
          'field:gender'
        ]);

        // and the saved list carries the page-two field, so nothing gets
        // un-featured behind the user's back
        await waitForCondition(() => getPriorityPosts().length > initialPosts);
        expect(getPriorityPosts()[initialPosts]).to.deep.equal({
          featured: ['region', 'state', 'gender']
        });
      } finally {
        clearMockGets();
      }
    });

    it('marks the drop slot past the last field column (screenshot)', async () => {
      await loadStore();
      mockPOST(priorityRegex, { status: 'OK' });
      const list = await getContactList({ 'priority-endpoint': PRIORITY_URL });

      await beginDrag(list, 'field:state');

      // park the drag well past every field column — a deterministic
      // spot that resolves to the slot at the tail of the reorderable
      // run, and one that leaves the pointer-tracking ghost outside the
      // clipped region so it can't obscure the insertion bar
      const parkX = list.getBoundingClientRect().right + 400;
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: parkX,
          pointerType: 'mouse'
        })
      );
      await list.updateComplete;

      // the origin header dims and the bar lands on the trailing edge of
      // the last field column, not on the system column after it
      expect(headerFor(list, 'field:state').classList.contains('dragging')).to
        .be.true;
      expect(headerFor(list, 'field:gender').classList.contains('drop-after'))
        .to.be.true;
      expect(headerFor(list, 'last_seen_on').classList.contains('drop-before'))
        .to.be.false;
      // exactly one insertion bar at a time
      expect(
        list.shadowRoot!.querySelectorAll(
          '.head-cell.drop-before, .head-cell.drop-after'
        ).length
      ).to.equal(1);
      expect(ghostCount()).to.equal(1);

      await assertScreenshot(
        'content-list/contacts-column-drag',
        getClip(list)
      );

      // tear the live drag down so nothing outlives the test
      window.dispatchEvent(
        new PointerEvent('pointercancel', {
          clientX: parkX,
          pointerType: 'mouse'
        })
      );
      await list.updateComplete;
      expect(ghostCount()).to.equal(0);
      expect(document.body.style.userSelect).to.equal('');
    });

    it('constrains drops to the field column run', async () => {
      await loadStore();
      mockPOST(priorityRegex, { status: 'OK' });
      const list = await getContactList({ 'priority-endpoint': PRIORITY_URL });

      // far left of every field header — Ward lands at the head of the
      // run; the pinned Name and URN columns stay put
      await dragHeader(list, 'field:ward', 0);
      expect(columnKeys(list).slice(0, 4)).to.deep.equal([
        'name',
        'urn',
        'field:ward',
        'field:state'
      ]);

      // far right of every header — Ward lands at the tail of the run,
      // never past Last seen / Created on
      const created = headerFor(list, 'created_on');
      await dragHeader(
        list,
        'field:ward',
        created.getBoundingClientRect().right + 50
      );
      expect(columnKeys(list)).to.deep.equal([
        'name',
        'urn',
        'field:state',
        'field:district',
        'field:joined',
        'field:age',
        'field:gender',
        'field:ward',
        'last_seen_on',
        'created_on'
      ]);
    });

    it('still sorts on a plain click and stays put without a priority endpoint', async () => {
      await loadStore();
      const list = await getContactList();

      // no endpoint to save to — the columns don't offer the drag at all
      expect(headerFor(list, 'field:state').classList.contains('reorderable'))
        .to.be.false;
      const before = columnKeys(list);
      await dragHeader(list, 'field:state', 0);
      expect(columnKeys(list)).to.deep.equal(before);

      // and a plain click (no movement past the dead zone) sorts
      const header = headerFor(list, 'field:state');
      header.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 400,
          pointerType: 'mouse'
        })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 400, pointerType: 'mouse' })
      );
      header.click();
      expect((list as any).sort).to.equal('field:state');
    });

    it('abandons the drag on pointercancel', async () => {
      await loadStore();
      mockPOST(priorityRegex, { status: 'OK' });
      const list = await getContactList({ 'priority-endpoint': PRIORITY_URL });
      const before = columnKeys(list);
      const posts = getPriorityPosts().length;

      await beginDrag(list, 'field:state');
      expect(ghostCount()).to.equal(1);
      expect(document.body.style.userSelect).to.equal('none');

      window.dispatchEvent(
        new PointerEvent('pointercancel', {
          clientX: 900,
          pointerType: 'mouse'
        })
      );
      await list.updateComplete;

      // nothing moved, nothing saved, and no ghost left on the body
      expect(columnKeys(list)).to.deep.equal(before);
      expect(getPriorityPosts().length).to.equal(posts);
      expect(ghostCount()).to.equal(0);
      expect(document.body.style.userSelect).to.equal('');

      // the drag is gone, so a stray release can't commit it either
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 900, pointerType: 'mouse' })
      );
      await list.updateComplete;
      expect(columnKeys(list)).to.deep.equal(before);
    });

    it('tears the drag down when the list disconnects mid-drag', async () => {
      await loadStore();
      mockPOST(priorityRegex, { status: 'OK' });
      const list = await getContactList({ 'priority-endpoint': PRIORITY_URL });
      const before = columnKeys(list);
      const posts = getPriorityPosts().length;

      await beginDrag(list, 'field:state');
      expect(ghostCount()).to.equal(1);

      list.remove();
      expect(ghostCount()).to.equal(0);
      expect(document.body.style.userSelect).to.equal('');

      // the window listeners went with it — these must be inert
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 900, pointerType: 'mouse' })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 900, pointerType: 'mouse' })
      );
      expect(ghostCount()).to.equal(0);
      expect(columnKeys(list)).to.deep.equal(before);
      expect(getPriorityPosts().length).to.equal(posts);
    });

    it('ignores a second pointer during a drag', async () => {
      await loadStore();
      mockPOST(priorityRegex, { status: 'OK' });
      const list = await getContactList({ 'priority-endpoint': PRIORITY_URL });
      const before = columnKeys(list);
      const posts = getPriorityPosts().length;

      await beginDrag(list, 'field:state');

      // a second touch can neither steer the drag nor commit it
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 7,
          clientX: 900,
          pointerType: 'touch'
        })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 7,
          clientX: 900,
          pointerType: 'touch'
        })
      );
      await list.updateComplete;
      expect(columnKeys(list)).to.deep.equal(before);
      expect(getPriorityPosts().length).to.equal(posts);
      expect(ghostCount()).to.equal(1);

      // the owning pointer still finishes the job
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 900, pointerType: 'mouse' })
      );
      await list.updateComplete;
      expect(ghostCount()).to.equal(0);
    });

    it('starts a resize cleanly while a drag is live', async () => {
      await loadStore();
      mockPOST(priorityRegex, { status: 'OK' });
      const list = await getContactList({ 'priority-endpoint': PRIORITY_URL });
      const before = columnKeys(list);

      await beginDrag(list, 'field:state');
      const handle = getResizeHandle(headerFor(list, 'field:district'));
      handle!.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 500,
          pointerType: 'mouse'
        })
      );
      await list.updateComplete;

      // the drag is cancelled rather than left running alongside
      expect(ghostCount()).to.equal(0);
      expect(columnKeys(list)).to.deep.equal(before);

      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 540, pointerType: 'mouse' })
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 540, pointerType: 'mouse' })
      );
      await list.updateComplete;

      // and the resize hands the body's selection style back
      expect(document.body.style.userSelect).to.equal('');
    });
  });
});
