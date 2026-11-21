import { assert, expect } from '@open-wc/testing';
import { CustomEventType } from '../src/interfaces';
import { LLMList } from '../src/list/LLMList';
import {
  assertScreenshot,
  getClip,
  getComponent,
  loadStore
} from './utils.test';

const TAG = 'temba-llm-list';
const getLLMList = async (attrs: any = {}, width = 700, height = 0) => {
  return (await getComponent(TAG, attrs, '', width, height)) as LLMList;
};

const llm = (over: any = {}) => ({
  uuid: 'llm-1',
  name: 'Flow Assistant',
  type: 'openai',
  icon: 'ai_openai',
  model: 'gpt-5.4-mini',
  usages: 2,
  ...over
});

const renderRows = async (list: LLMList, items: any[]) => {
  (list as any).items = items;
  list.requestUpdate();
  await list.updateComplete;
};

const click = (el: Element) =>
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));

describe('temba-llm-list', () => {
  it('can be created', async () => {
    const list: LLMList = await getLLMList();
    assert.instanceOf(list, LLMList);
    expect(list.valueKey).to.equal('uuid');
    // the endpoint has no search
    expect(list.searchable).to.be.false;
  });

  it('leads each row with its provider icon', async () => {
    const list: LLMList = await getLLMList();
    expect((list as any).getRowIcon(llm())).to.equal('ai_openai');
    expect((list as any).getRowIcon(llm({ icon: '' }))).to.equal('stars-02');
  });

  it('only has a delete column when deletable', async () => {
    const list: LLMList = await getLLMList();
    expect(list.columns.map((c) => c.key)).to.deep.equal([
      'name',
      'model',
      'usages'
    ]);

    list.deletable = true;
    await list.updateComplete;
    expect(list.columns.map((c) => c.key)).to.deep.equal([
      'name',
      'model',
      'usages',
      'delete'
    ]);
  });

  it('renders the model and usages', async () => {
    const list: LLMList = await getLLMList();
    await renderRows(list, [
      llm(),
      llm({ uuid: 'llm-2', usages: 1 }),
      llm({ uuid: 'llm-3', usages: 0 })
    ]);

    const rows = list.shadowRoot.querySelectorAll('tr.row');
    expect(rows).to.have.length(3);
    expect(rows[0].querySelector('.model').textContent.trim()).to.equal(
      'gpt-5.4-mini'
    );
    expect(rows[0].querySelector('.usages').textContent.trim()).to.equal(
      '2 uses'
    );
    expect(rows[1].querySelector('.usages').textContent.trim()).to.equal(
      '1 use'
    );
    expect(rows[2].querySelector('.usages')).to.not.exist;
  });

  it('only reads as clickable when editable', async () => {
    const list: LLMList = await getLLMList();
    await renderRows(list, [llm()]);
    let row = list.shadowRoot.querySelector('tr.row');
    expect(row.classList.contains('clickable')).to.be.false;

    list.editable = true;
    await list.updateComplete;
    row = list.shadowRoot.querySelector('tr.row');
    expect(row.classList.contains('clickable')).to.be.true;
  });

  it('fires events for the usages link and delete icon without opening the row', async () => {
    const list: LLMList = await getLLMList({ deletable: true });
    await renderRows(list, [llm()]);

    const fired: string[] = [];
    list.addEventListener(CustomEventType.RowClick, () => fired.push('row'));
    list.addEventListener(CustomEventType.LLMUsages, (e: any) =>
      fired.push(`usages:${e.detail.item.uuid}`)
    );
    list.addEventListener(CustomEventType.LLMDelete, (e: any) =>
      fired.push(`delete:${e.detail.item.uuid}`)
    );

    click(list.shadowRoot.querySelector('.usages'));
    click(list.shadowRoot.querySelector('.delete'));
    expect(fired).to.deep.equal(['usages:llm-1', 'delete:llm-1']);

    click(list.shadowRoot.querySelector('tr.row'));
    expect(fired).to.deep.equal(['usages:llm-1', 'delete:llm-1', 'row']);
  });

  it('renders the models list (screenshot)', async () => {
    await loadStore();
    const list = (await getComponent(
      TAG,
      {
        endpoint: '/test/assets/content-list/llms.json',
        'list-title': 'Artificial Intelligence',
        subtitle:
          'Add Large Language Models (LLMs) to your workspace to unlock AI assisted features.',
        editable: true,
        deletable: true
      },
      '',
      900
    )) as LLMList;
    await new Promise<void>((resolve) => {
      list.addEventListener(CustomEventType.FetchComplete, () => resolve(), {
        once: true
      });
    });
    await list.updateComplete;
    await assertScreenshot('content-list/llms', getClip(list));
  });
});
