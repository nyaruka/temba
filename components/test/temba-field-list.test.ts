import { expect } from '@open-wc/testing';
import { SinonStub } from 'sinon';
import { FieldList } from '../src/list/FieldList';
import {
  assertScreenshot,
  clearMockGets,
  clearMockPosts,
  getClip,
  getComponent,
  loadStore,
  mockGET,
  mockPOST,
  waitForCondition
} from './utils.test';

const TAG = 'temba-field-list';

const PRIORITY_URL = /\/contactfield\/update_priority\//;

const DETAIL = {
  field: {
    key: 'age',
    name: 'Age',
    value_type: 'numeric',
    featured: false,
    agent_access: 'view'
  },
  usages: {
    flows: [
      { uuid: 'flow-1', name: 'Registration', url: '/flow/editor/flow-1/' }
    ],
    groups: [
      { uuid: 'group-1', name: 'Adults', url: '/contact/group/group-1/' }
    ],
    campaign_events: [
      {
        id: 1,
        campaign: {
          uuid: 'camp-1',
          name: 'Reminders',
          url: '/campaign/read/camp-1/'
        },
        offset_display: '1 week after Joined On'
      }
    ]
  },
  counts: { flows: 3, groups: 1, campaign_events: 1 },
  can_edit: true,
  can_delete: true
};

// the fields fixture has two featured fields (Rating, Ward) and six
// others, alphabetized as Age, Conversion, District, Gender, Joined
// On, State
const FIELDS = [
  { key: 'rating', label: 'Rating', value_type: 'text' },
  { key: 'conversion', label: 'Conversion', value_type: 'text' },
  { key: 'district', label: 'District', value_type: 'district' },
  { key: 'ward', label: 'Ward', value_type: 'ward' },
  { key: 'state', label: 'State', value_type: 'state' },
  { key: 'joined', label: 'Joined On', value_type: 'datetime' },
  { key: 'age', label: 'Age', value_type: 'numeric' },
  { key: 'gender', label: 'Gender', value_type: 'text' }
];

// saving triggers store.refreshFields() - serve the post-save state for
// that refetch so it confirms (rather than reverts) the optimistic update,
// the way the real server would
const mockFieldsRefresh = (featured: string[]) => {
  mockGET(/test\/assets\/store\/fields\.json/, {
    next: null,
    previous: null,
    results: FIELDS.map((f) => ({
      ...f,
      featured: featured.includes(f.key),
      priority: featured.includes(f.key)
        ? featured.length - featured.indexOf(f.key)
        : 0,
      usages: { campaign_events: 0, flows: 0, groups: 0 }
    }))
  });
};

const getList = async (): Promise<FieldList> => {
  const list = (await getComponent(
    TAG,
    {
      'header-title': 'Fields',
      'priority-endpoint': '/contactfield/update_priority/',
      'detail-endpoint': '/contactfield/detail/'
    },
    '',
    800
  )) as FieldList;
  await waitForCondition(() => !!list.featuredFields);
  await list.updateComplete;
  return list;
};

const getRow = (list: FieldList, key: string): HTMLElement => {
  return list.shadowRoot.querySelector(`.field[id="${key}"]`) as HTMLElement;
};

const getRowStar = (list: FieldList, key: string): HTMLElement => {
  return getRow(list, key).querySelector('.star') as HTMLElement;
};

const dragRow = async (
  list: FieldList,
  key: string,
  toX: number,
  toY: number,
  release = true
) => {
  // drags can only start from the row's drag handle
  const bounds = getRow(list, key).getBoundingClientRect();
  await moveMouse(bounds.left + 18, bounds.top + bounds.height / 2);
  await mouseDown();
  // clear the drag threshold before heading to the target
  await moveMouse(bounds.left + 23, bounds.top + bounds.height / 2 + 5);
  await moveMouse(toX, toY);
  if (release) {
    await mouseUp();
  }
  await list.updateComplete;
};

// the fetch stub's call history spans the whole test run, so each test
// tracks a baseline and only looks at its own posts
let postBaseline = 0;

const allPriorityPosts = (): string[][] => {
  return (window.fetch as SinonStub)
    .getCalls()
    .filter(
      (call) =>
        PRIORITY_URL.test(String(call.args[0])) &&
        call.args[1]?.method === 'POST'
    )
    .map((call) => JSON.parse(call.args[1].body).featured);
};

const getPriorityPosts = (): string[][] => {
  return allPriorityPosts().slice(postBaseline);
};

const openDetail = async (list: FieldList, key: string) => {
  getRow(list, key).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await list.updateComplete;
  await waitForCondition(
    () => !!list.shadowRoot.querySelector('.detail-actions')
  );
  await list.updateComplete;
};

describe(TAG, () => {
  beforeEach(async () => {
    clearMockGets();
    clearMockPosts();
    mockPOST(PRIORITY_URL, { status: 'OK' });
    mockGET(/\/contactfield\/detail\//, DETAIL);
    await loadStore();
    postBaseline = allPriorityPosts().length;
  });

  it('renders the header and both panels', async () => {
    const list = await getList();

    const header = list.shadowRoot.querySelector('temba-page-header');
    expect(header).to.exist;

    expect(list.featuredFields.length).to.equal(2);
    expect(list.otherFieldKeys.length).to.equal(6);

    // featured rows are sortable with drag handles; every row carries
    // its featured-toggle star
    expect(list.shadowRoot.querySelector('#featured-list')).to.exist;
    expect(
      list.shadowRoot.querySelectorAll('.field .drag-handle').length
    ).to.equal(2);
    expect(list.shadowRoot.querySelectorAll('.field .star').length).to.equal(8);

    // the other list is not draggable
    expect(list.shadowRoot.querySelector('#other-panel temba-sortable-list')).to
      .not.exist;

    await assertScreenshot('list/field-list', getClip(list));
  });

  it('filters with live search', async () => {
    const list = await getList();

    (
      list.shadowRoot.querySelector('.header-actions .action') as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;

    const input = list.shadowRoot.querySelector(
      '.searchbar input'
    ) as HTMLInputElement;
    expect(input).to.exist;

    input.value = 'at';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await list.updateComplete;

    expect(
      list.shadowRoot.querySelectorAll('#featured-panel .field').length
    ).to.equal(1);
    expect(list.otherFieldKeys.length).to.equal(2);

    // the full featured set is kept regardless of the filter
    expect(list.featuredFields.length).to.equal(2);

    // searching disables featured reordering
    expect(list.shadowRoot.querySelector('#featured-list')).to.not.exist;

    await assertScreenshot('list/field-list-filtered', getClip(list));
  });

  it('reorders featured fields and posts the new order', async () => {
    const list = await getList();
    mockFieldsRefresh(['ward', 'rating']);
    const second = getRow(list, list.featuredFields[1].key);
    const target = second.getBoundingClientRect();

    // drag the first featured row below the second, pausing mid-drag to
    // check the ghost treatment
    await dragRow(
      list,
      list.featuredFields[0].key,
      target.left + 30,
      target.bottom + 2,
      false
    );
    await assertScreenshot('list/field-list-dragging', getClip(list));

    await mouseUp();
    await list.updateComplete;

    await waitForCondition(() => getPriorityPosts().length > 0);
    expect(getPriorityPosts()[0]).to.deep.equal(['ward', 'rating']);
    expect(list.featuredFields.map((f) => f.key)).to.deep.equal([
      'ward',
      'rating'
    ]);
  });

  it('features a field with its row star', async () => {
    const list = await getList();
    mockFieldsRefresh(['rating', 'ward', 'age']);

    // an unfeatured row shows the hollow star
    expect((getRowStar(list, 'age') as any).name).to.equal('star-01');

    getRowStar(list, 'age').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await list.updateComplete;

    // appended to the end of the featured list, without opening the
    // row's detail modal
    await waitForCondition(() => getPriorityPosts().length > 0);
    expect(getPriorityPosts()[0]).to.deep.equal(['rating', 'ward', 'age']);
    expect(list.otherFieldKeys).to.not.contain('age');
    expect((getRowStar(list, 'age') as any).name).to.equal('star-filled');
    expect(
      (list.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.not.equal(true);

    await assertScreenshot('list/field-list-starred', getClip(list));
  });

  it('keeps featured fields hidden by search when featuring', async () => {
    const list = await getList();
    mockFieldsRefresh(['rating', 'ward', 'age']);

    (
      list.shadowRoot.querySelector('.header-actions .action') as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;

    // neither featured field matches, so the featured panel is empty
    const input = list.shadowRoot.querySelector(
      '.searchbar input'
    ) as HTMLInputElement;
    input.value = 'age';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await list.updateComplete;
    expect(
      list.shadowRoot.querySelectorAll('#featured-panel .field').length
    ).to.equal(0);

    getRowStar(list, 'age').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await list.updateComplete;

    // the save carries the full featured set, not just the visible one
    await waitForCondition(() => getPriorityPosts().length > 0);
    expect(getPriorityPosts()[0]).to.deep.equal(['rating', 'ward', 'age']);
  });

  it('features a field with the keyboard', async () => {
    const list = await getList();
    mockFieldsRefresh(['rating', 'ward', 'age']);

    getRowStar(list, 'age').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    await list.updateComplete;

    // the star toggles without also activating the row
    await waitForCondition(() => getPriorityPosts().length > 0);
    expect(getPriorityPosts()[0]).to.deep.equal(['rating', 'ward', 'age']);
    expect(
      (list.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.not.equal(true);

    // activating the row itself opens the detail modal
    getRow(list, 'gender').dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true })
    );
    await list.updateComplete;
    await waitForCondition(
      () => (list.shadowRoot.querySelector('temba-dialog') as any).open === true
    );
  });

  it('reconciles a failed save back to server truth', async () => {
    const list = await getList();

    // the save fails - the store refetch (still the original state)
    // should snap the optimistic change back
    clearMockPosts();
    mockPOST(PRIORITY_URL, { status: 'ERROR' }, {}, '500');

    getRowStar(list, 'age').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await list.updateComplete;

    // optimistically featured, then reverted once the refresh lands
    expect(list.otherFieldKeys).to.not.contain('age');
    await waitForCondition(() => list.otherFieldKeys.includes('age'));
    expect(list.featuredFields.map((f) => f.key)).to.deep.equal([
      'rating',
      'ward'
    ]);
  });

  it('unfeatures a field with its row star', async () => {
    const list = await getList();
    mockFieldsRefresh(['ward']);

    // a featured row shows the filled star
    expect((getRowStar(list, 'rating') as any).name).to.equal('star-filled');

    getRowStar(list, 'rating').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await list.updateComplete;

    await waitForCondition(() => getPriorityPosts().length > 0);
    expect(getPriorityPosts()[0]).to.deep.equal(['ward']);

    // it rejoins the other list alphabetically
    expect(list.otherFieldKeys).to.deep.equal([
      'age',
      'conversion',
      'district',
      'gender',
      'joined',
      'rating',
      'state'
    ]);
  });

  it('opens a detail modal with usages when a row is clicked', async () => {
    const list = await getList();
    await openDetail(list, 'age');

    const dialog = list.shadowRoot.querySelector('temba-dialog') as any;
    expect(dialog.open).to.equal(true);

    const detail = list.shadowRoot.querySelector('.detail');
    expect(detail.querySelector('.detail-title').textContent).to.contain('Age');
    expect(detail.querySelector('.detail-meta').textContent).to.contain(
      '@fields.age'
    );

    // usages render as sections with pills, capped counts noted
    const pills = detail.querySelectorAll('.usage-rows temba-label');
    expect(pills.length).to.equal(3);
    expect(detail.textContent).to.contain('and 2 more');

    await assertScreenshot('list/field-list-detail', getClip(list));
  });

  it('navigates from a usage pill, closing the detail first', async () => {
    const list = await getList();

    let selected = null;
    list.addEventListener('temba-selection', (e: CustomEvent) => {
      selected = e.detail;
    });

    await openDetail(list, 'age');
    (
      list.shadowRoot.querySelector('.usage-rows temba-label') as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;

    expect(selected).to.deep.equal({
      uuid: 'flow-1',
      name: 'Registration',
      url: '/flow/editor/flow-1/'
    });
    expect(
      (list.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.equal(false);
  });

  it('closes search with escape and with the cancel icon', async () => {
    const list = await getList();

    const openSearch = async () => {
      (
        list.shadowRoot.querySelector('.header-actions .action') as HTMLElement
      ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await list.updateComplete;
    };

    await openSearch();
    const input = list.shadowRoot.querySelector(
      '.searchbar input'
    ) as HTMLInputElement;
    input.value = 'at';
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await list.updateComplete;
    expect(list.otherFieldKeys.length).to.equal(2);

    // escape closes the search and clears the filter
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    await list.updateComplete;
    expect(list.shadowRoot.querySelector('.searchbar')).to.not.exist;
    expect(list.otherFieldKeys.length).to.equal(6);

    // as does the cancel icon
    await openSearch();
    (
      list.shadowRoot.querySelector('.search-cancel') as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;
    expect(list.shadowRoot.querySelector('.searchbar')).to.not.exist;
  });

  it('fires selection events for edit and delete from the detail', async () => {
    const list = await getList();

    let selected = null;
    list.addEventListener('temba-selection', (e: CustomEvent) => {
      selected = e.detail;
    });

    await openDetail(list, 'age');
    (
      list.shadowRoot.querySelector(
        '.detail-actions .menu-button.destructive'
      ) as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;

    expect(selected).to.deep.equal({ key: 'age', action: 'delete' });
    expect(
      (list.shadowRoot.querySelector('temba-dialog') as any).open
    ).to.equal(false);

    await openDetail(list, 'age');
    (
      list.shadowRoot.querySelector(
        '.detail-actions .menu-button:not(.destructive)'
      ) as HTMLElement
    ).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;

    expect(selected).to.deep.equal({ key: 'age', action: 'update' });
  });

  it('toggles featured with the star from the detail modal', async () => {
    const list = await getList();
    mockFieldsRefresh(['rating', 'ward', 'age']);
    await openDetail(list, 'age');

    // an unfeatured field shows the hollow star
    const star = list.shadowRoot.querySelector(
      '.detail-actions .featured-toggle'
    ) as any;
    expect(star.name).to.equal('star-01');

    star.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await list.updateComplete;

    // appended to the end of the featured list, star now filled
    await waitForCondition(() => getPriorityPosts().length > 0);
    expect(getPriorityPosts()[0]).to.deep.equal(['rating', 'ward', 'age']);
    expect(list.otherFieldKeys).to.not.contain('age');
    expect(
      (list.shadowRoot.querySelector('.detail-actions .featured-toggle') as any)
        .name
    ).to.equal('star-filled');
  });

  it('hides detail actions without permissions', async () => {
    clearMockGets();
    mockGET(/\/contactfield\/detail\//, {
      ...DETAIL,
      can_edit: false,
      can_delete: false
    });

    const list = await getList();
    getRow(list, 'age').dispatchEvent(
      new MouseEvent('click', { bubbles: true })
    );
    await list.updateComplete;
    await waitForCondition(
      () => !!list.shadowRoot.querySelector('.usage-rows')
    );
    await list.updateComplete;

    expect(list.shadowRoot.querySelector('.detail-actions .menu-button')).to.not
      .exist;
    expect(list.shadowRoot.querySelector('.detail-actions .featured-toggle')).to
      .not.exist;
  });

  it('shows a hint when nothing is featured', async () => {
    const list = await getList();

    // unfeature both fields
    list.featuredFields = [];
    list.otherFieldKeys = [
      'age',
      'conversion',
      'district',
      'gender',
      'joined',
      'rating',
      'state',
      'ward'
    ];
    await list.updateComplete;

    const note = list.shadowRoot.querySelector('#featured-panel .empty-note');
    expect(note).to.exist;
    expect(note.textContent).to.contain('Star a field');

    await assertScreenshot('list/field-list-empty-featured', getClip(list));
  });
});
