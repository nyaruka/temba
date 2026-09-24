import { aTimeout, expect, fixture, html } from '@open-wc/testing';
import { Editor } from '../src/flow/Editor';
import { NodeEditor } from '../src/flow/NodeEditor';
import { SendMsg, FlowDefinition } from '../src/store/flow-definition';
import { zustand } from '../src/store/AppState';
import { send_msg } from '../src/flow/actions/send_msg';
import '../temba-modules';

describe('Localization Editing', () => {
  let editor: Editor;
  let storeElement: HTMLElement;

  const setupWorkspace = () => {
    zustand.setState({
      workspace: {
        uuid: 'test-workspace',
        name: 'Test Workspace',
        languages: ['eng', 'fra', 'spa'],
        primary_language: 'eng',
        timezone: 'UTC',
        date_style: 'day_first',
        country: 'US',
        anon: false
      }
    });
  };

  const buildCategoryFlowDefinition = (
    localization: Record<string, any> = {}
  ): FlowDefinition => ({
    uuid: 'category-flow',
    name: 'Category Flow',
    language: 'eng',
    type: 'messaging',
    revision: 1,
    spec_version: '14.3',
    localization,
    nodes: [
      {
        uuid: 'split-node',
        actions: [],
        exits: [
          { uuid: 'split-exit-1', destination_uuid: null },
          { uuid: 'split-exit-2', destination_uuid: null }
        ],
        router: {
          type: 'random',
          categories: [
            {
              uuid: 'cat-1',
              name: 'First bucket',
              exit_uuid: 'split-exit-1'
            },
            {
              uuid: 'cat-2',
              name: 'Second bucket',
              exit_uuid: 'split-exit-2'
            }
          ]
        }
      }
    ],
    _ui: {
      nodes: {
        'split-node': {
          position: { left: 0, top: 0 },
          type: 'split_by_random'
        }
      },
      languages: []
    }
  });

  const getToolbar = async (flowEditor: Editor) => {
    const toolbar = flowEditor.querySelector('temba-editor-toolbar') as any;
    if (toolbar) await toolbar.updateComplete;
    return toolbar;
  };

  const selectLanguageInToolbar = async (
    flowEditor: Editor,
    languageName: string,
    languageCode: string
  ): Promise<void> => {
    const toolbar = await getToolbar(flowEditor);
    // Open language options dropdown
    const languageBtn = toolbar.shadowRoot.querySelector(
      '#language-btn'
    ) as HTMLElement;
    languageBtn.click();
    await toolbar.updateComplete;

    // Select the language via the toolbar's handler
    (toolbar as any).handleLanguageOptionSelected(
      new CustomEvent('temba-selection', {
        detail: { selected: { name: languageName, value: languageCode } }
      })
    );
    await flowEditor.updateComplete;
  };

  // Mounts an editor on a flow of `count` send_msg actions, each with a
  // unique ~600 char text so dedup doesn't collapse them, and selects French
  // so auto translate has something to do. Three such texts fit in a batch.
  const setupBatchFlow = async (
    uuid: string,
    count: number,
    filler: string
  ): Promise<void> => {
    editor?.remove();
    setupWorkspace();

    const nodes = [];
    for (let i = 0; i < count; i++) {
      nodes.push({
        uuid: `node-${i}`,
        actions: [
          {
            type: 'send_msg',
            uuid: `action-${i}`,
            text: `${i} ${filler.repeat(600)}`
          } as SendMsg
        ],
        exits: [{ uuid: `exit-${i}` }]
      });
    }

    const flowDefinition: FlowDefinition = {
      uuid,
      name: uuid,
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {},
      nodes,
      _ui: {
        nodes: Object.fromEntries(
          nodes.map((n) => [n.uuid, { position: { left: 0, top: 0 } }])
        ),
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: count, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
  };

  before(() => {
    storeElement = document.createElement('temba-store');
    document.body.appendChild(storeElement);
  });

  after(() => {
    storeElement?.remove();
  });

  afterEach(() => {
    editor?.remove();
  });

  beforeEach(async () => {
    // Set workspace with languages
    setupWorkspace();

    // Create a flow definition with localization data
    const flowDefinition: FlowDefinition = {
      uuid: 'test-flow',
      name: 'Test Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        spa: {
          'action-1': {
            text: ['Hola mundo'],
            quick_replies: ['Sí', 'No']
          }
        }
      },
      nodes: [
        {
          uuid: 'node-1',
          actions: [
            {
              type: 'send_msg',
              uuid: 'action-1',
              text: 'Hello world',
              quick_replies: ['Yes', 'No']
            } as SendMsg
          ],
          exits: [{ uuid: 'exit-1' }]
        }
      ],
      _ui: {
        nodes: {
          'node-1': {
            position: { left: 100, top: 100 }
          }
        },
        languages: []
      }
    };

    // Initialize store with flow definition
    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 1, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
  });

  it('should render language controls in toolbar when translations exist', async () => {
    const toolbar = await getToolbar(editor);
    const languageBtn = toolbar.shadowRoot.querySelector('#language-btn');
    expect(languageBtn).to.exist;
  });

  it('should hide language controls when flow has no nodes', async () => {
    editor?.remove();

    setupWorkspace();

    const emptyFlowDefinition: FlowDefinition = {
      uuid: 'empty-flow',
      name: 'Empty Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {},
      nodes: [],
      _ui: {
        nodes: {},
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: emptyFlowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 0, languages: 0 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;

    const toolbar = await getToolbar(editor);
    const languageBtn = toolbar.shadowRoot.querySelector('#language-btn');
    expect(languageBtn).to.be.null;
  });

  it('should show language options with non-base languages', async () => {
    const toolbar = await getToolbar(editor);
    // Open language dropdown
    const languageBtn = toolbar.shadowRoot.querySelector(
      '#language-btn'
    ) as HTMLElement;
    languageBtn.click();
    await toolbar.updateComplete;

    // The options should contain non-base languages
    const options = toolbar.shadowRoot.querySelector('temba-options');
    expect(options).to.exist;
  });

  it('should include category translations when per-node localizeCategories is set', async () => {
    editor?.remove();

    setupWorkspace();

    const categoryFlowDefinition: FlowDefinition =
      buildCategoryFlowDefinition();
    // Set localizeCategories on the node's UI config
    categoryFlowDefinition._ui.nodes['split-node'].config = {
      localizeCategories: true
    };

    zustand.getState().setFlowContents({
      definition: categoryFlowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 1, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;

    // Switch to a non-base language
    await selectLanguageInToolbar(editor, 'French', 'fra');

    // Check that progress includes the 2 categories
    const progress = (editor as any).getLocalizationProgress('fra');
    expect(progress.total).to.equal(2);
  });

  it('should allow switching translation languages via toolbar', async () => {
    await selectLanguageInToolbar(editor, 'Spanish', 'spa');

    const state = zustand.getState();
    expect(state.languageCode).to.equal('spa');
  });

  it('should exclude categories from progress when localizeCategories is not set', async () => {
    editor?.remove();

    setupWorkspace();

    // Flow with categories but no localizeCategories config
    const categoryFlowDefinition: FlowDefinition =
      buildCategoryFlowDefinition();

    zustand.getState().setFlowContents({
      definition: categoryFlowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 1, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;

    // Switch to a non-base language
    await selectLanguageInToolbar(editor, 'French', 'fra');

    // Without localizeCategories, progress should not include categories
    const progress = (editor as any).getLocalizationProgress('fra');
    expect(progress.total).to.equal(0);
  });

  it('should open auto translate dialog when clicking auto translate', async () => {
    await selectLanguageInToolbar(editor, 'French', 'fra');

    // Includes an engine-only model that should be filtered out of the
    // auto-translate picker, plus two valid editing models.
    (storeElement as any).getResults = async () => [
      { uuid: 'llm-1', name: 'GPT-4', roles: ['editing'] },
      { uuid: 'llm-2', name: 'Claude', roles: ['editing', 'engine'] },
      { uuid: 'llm-engine', name: 'EngineOnly', roles: ['engine'] }
    ];

    const autoTranslateBtn = editor
      .querySelector('temba-editor-toolbar')
      ?.shadowRoot?.querySelector(
        '.toolbar-btn[aria-label="Auto translate"]'
      ) as HTMLButtonElement;
    expect(autoTranslateBtn).to.exist;
    expect(autoTranslateBtn.disabled).to.be.false;

    autoTranslateBtn.click();
    await editor.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    const at = editor.querySelector('temba-auto-translate') as any;
    await at.updateComplete;

    expect(at.dialogOpen).to.be.true;
    // loadModels should have dropped the engine-only model
    expect(at.models.map((m: any) => m.uuid)).to.deep.equal(['llm-1', 'llm-2']);

    const dialog = at.shadowRoot.querySelector('.auto-translate-body');
    expect(dialog).to.exist;
    const modelSelect = dialog?.querySelector(
      '.auto-translate-model-select'
    ) as HTMLElement;
    expect(modelSelect).to.exist;
    expect(modelSelect.getAttribute('endpoint')).to.equal(
      '/api/internal/llms.json'
    );
    // and the temba-select shouldExclude predicate also rejects engine-only
    const shouldExclude = (modelSelect as any).shouldExclude;
    expect(shouldExclude({ roles: ['engine'] })).to.be.true;
    expect(shouldExclude({ roles: ['editing'] })).to.be.false;
  });

  it('should keep auto translate visible when everything is translated', async () => {
    await selectLanguageInToolbar(editor, 'Spanish', 'spa');
    await editor.updateComplete;

    const toolbar = editor.querySelector('temba-editor-toolbar') as any;
    const autoTranslateBtn = toolbar?.shadowRoot?.querySelector(
      '.toolbar-btn[aria-label="Auto translate"]'
    );
    // spa is fully translated, but the button stays so users can update
    // existing translations via the dialog
    expect(autoTranslateBtn).to.exist;
  });

  it('should auto-skip picker when only one LLM is available', async () => {
    await selectLanguageInToolbar(editor, 'French', 'fra');

    // Engine-only model is present but should be filtered out, leaving a
    // single editing-capable model — the picker should still auto-skip.
    (storeElement as any).getResults = async () => [
      { uuid: 'llm-only', name: 'SoloGPT', roles: ['editing'] },
      { uuid: 'llm-engine', name: 'EngineOnly', roles: ['engine'] }
    ];

    const autoTranslateBtn = editor
      .querySelector('temba-editor-toolbar')
      ?.shadowRoot?.querySelector(
        '.toolbar-btn[aria-label="Auto translate"]'
      ) as HTMLButtonElement;
    autoTranslateBtn.click();
    await editor.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    const at = editor.querySelector('temba-auto-translate') as any;
    await at.updateComplete;

    expect(at.selectedModel?.uuid).to.equal('llm-only');
    const dialog = at.shadowRoot.querySelector('.auto-translate-body');
    expect(dialog?.querySelector('.auto-translate-model-select')).to.not.exist;
    expect(dialog?.textContent).to.not.contain('SoloGPT');
  });

  it('should include the brand name in the dialog copy when set', async () => {
    zustand.setState({ brand: 'TextIt' });
    try {
      await selectLanguageInToolbar(editor, 'French', 'fra');

      (storeElement as any).getResults = async () => [
        { uuid: 'llm-only', name: 'SoloGPT', roles: ['editing'] }
      ];

      const autoTranslateBtn = editor
        .querySelector('temba-editor-toolbar')
        ?.shadowRoot?.querySelector(
          '.toolbar-btn[aria-label="Auto translate"]'
        ) as HTMLButtonElement;
      autoTranslateBtn.click();
      await editor.updateComplete;
      await new Promise((r) => setTimeout(r, 0));
      const at = editor.querySelector('temba-auto-translate') as any;
      await at.updateComplete;

      const dialog = at.shadowRoot.querySelector('.auto-translate-body');
      expect(dialog?.textContent).to.contain(
        'TextIt uses AI for automatic translation'
      );
    } finally {
      zustand.setState({ brand: '' });
    }
  });

  it('should fall back to a generic AI clause when no brand is set', async () => {
    await selectLanguageInToolbar(editor, 'French', 'fra');

    (storeElement as any).getResults = async () => [
      { uuid: 'llm-only', name: 'SoloGPT', roles: ['editing'] }
    ];

    const autoTranslateBtn = editor
      .querySelector('temba-editor-toolbar')
      ?.shadowRoot?.querySelector(
        '.toolbar-btn[aria-label="Auto translate"]'
      ) as HTMLButtonElement;
    autoTranslateBtn.click();
    await editor.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    const at = editor.querySelector('temba-auto-translate') as any;
    await at.updateComplete;

    const dialog = at.shadowRoot.querySelector('.auto-translate-body');
    expect(dialog?.textContent).to.contain('Automatic translation uses AI');
  });

  it('should show empty state when no LLMs are configured', async () => {
    await selectLanguageInToolbar(editor, 'French', 'fra');

    (storeElement as any).getResults = async () => [];

    const autoTranslateBtn = editor
      .querySelector('temba-editor-toolbar')
      ?.shadowRoot?.querySelector(
        '.toolbar-btn[aria-label="Auto translate"]'
      ) as HTMLButtonElement;
    autoTranslateBtn.click();
    await editor.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    const at = editor.querySelector('temba-auto-translate') as any;
    await at.updateComplete;

    const dialog = at.shadowRoot.querySelector('.auto-translate-body');
    expect(dialog?.querySelector('.auto-translate-empty')).to.exist;
    const link = dialog?.querySelector(
      '.auto-translate-empty a'
    ) as HTMLAnchorElement;
    expect(link).to.exist;
    expect(link.getAttribute('href')).to.equal('/ai/');
  });

  it('should batch translation requests by serialized payload size', async () => {
    editor?.remove();

    setupWorkspace();

    // build a flow with enough send_msg actions that the total serialized
    // payload exceeds the 2,000-char batch threshold. Each text needs to
    // be unique or dedup will collapse them into a single payload entry.
    const nodes = [];
    for (let i = 0; i < 8; i++) {
      nodes.push({
        uuid: `node-${i}`,
        actions: [
          {
            type: 'send_msg',
            uuid: `action-${i}`,
            text: `${i} ${'x'.repeat(700)}`
          } as SendMsg
        ],
        exits: [{ uuid: `exit-${i}` }]
      });
    }

    const flowDefinition: FlowDefinition = {
      uuid: 'batch-flow',
      name: 'Batch Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {},
      nodes,
      _ui: {
        nodes: Object.fromEntries(
          nodes.map((n) => [n.uuid, { position: { left: 0, top: 0 } }])
        ),
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 8, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;

    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    const calls: any[] = [];
    (storeElement as any).postJSON = async (url: string, body: any) => {
      calls.push({ url, body });
      return { status: 200, json: { items: body.items } };
    };

    await at.runAutoTranslation();

    // 8 texts of ~700 chars pack two to a batch
    expect(calls.length).to.equal(4);
    for (const c of calls) {
      const itemKeys = Object.keys(c.body.items as Record<string, string[]>);
      expect(itemKeys.length).to.equal(2);
      // each batch's full serialized payload stays within the limit
      const serialized = JSON.stringify(c.body).length;
      expect(serialized).to.be.at.most(2000);
    }

    // every text was translated exactly once
    const localization = zustand.getState().flowDefinition?.localization?.fra;
    expect(Object.keys(localization || {}).length).to.equal(8);
  });

  it('should interrupt translation between batches', async () => {
    editor?.remove();

    setupWorkspace();

    // Each text is unique so dedup doesn't collapse them — we want enough
    // distinct entries (8 batches of 3) to span well beyond the number of
    // batches sent concurrently.
    await setupBatchFlow('interrupt-flow', 24, 'y');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    // each worker reaches postJSON before any of these timeouts resolve, so
    // the first three calls are always in flight together
    let callCount = 0;
    (storeElement as any).postJSON = async (url: string, body: any) => {
      const call = (callCount += 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (call === 1) {
        // request interrupt while the first batches are in flight
        at.interrupt = true;
      }
      return { status: 200, json: { items: body.items } };
    };

    await at.runAutoTranslation();

    // the batches already in flight (one per concurrent worker) complete
    // and land, but no more are sent
    expect(callCount).to.equal(3);
    expect(at.running).to.be.false;
    expect(at.progress.done).to.equal(3);
    const localization = zustand.getState().flowDefinition?.localization?.fra;
    expect(Object.keys(localization || {}).length).to.equal(9);
  });

  it('should stop sending batches after one fails', async () => {
    await setupBatchFlow('error-flow', 24, 'z');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    let callCount = 0;
    const errorsSeenInFlight: (string | null)[] = [];
    (storeElement as any).postJSON = async (url: string, body: any) => {
      const call = (callCount += 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // the failure isn't surfaced while other batches are still in flight
      errorsSeenInFlight.push(at.error);
      if (call === 1) {
        // the first batch fails while the others are still in flight
        return { status: 400, json: { error: 'rate limit exceeded' } };
      }
      return { status: 200, json: { items: body.items } };
    };

    await at.runAutoTranslation();

    // the other batches in flight still land, but no more are sent
    expect(callCount).to.equal(3);
    expect(errorsSeenInFlight).to.deep.equal([null, null, null]);
    expect(at.error).to.equal('rate limit exceeded');
    expect(at.running).to.be.false;
    expect(at.progress.done).to.equal(2);
    const localization = zustand.getState().flowDefinition?.localization?.fra;
    expect(Object.keys(localization || {}).length).to.equal(6);

    // a subsequent run starts afresh rather than being blocked by the old error
    (storeElement as any).postJSON = async (url: string, body: any) => {
      callCount += 1;
      return { status: 200, json: { items: body.items } };
    };
    await at.runAutoTranslation();

    expect(at.error).to.be.null;
    expect(callCount).to.equal(9);
    expect(
      Object.keys(zustand.getState().flowDefinition?.localization?.fra || {})
        .length
    ).to.equal(24);
  });

  it('should split a batch the LLM could not translate in time', async () => {
    // 2 batches of 3
    await setupBatchFlow('timeout-flow', 6, 'w');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    // the model only manages one entry at a time
    const calls: number[] = [];
    (storeElement as any).postJSON = async (url: string, body: any) => {
      const size = Object.keys(body.items).length;
      calls.push(size);
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (size > 1) {
        return {
          status: 400,
          json: {
            error: 'LLM took longer than 20s to respond',
            code: 'timeout'
          }
        };
      }
      return { status: 200, json: { items: body.items } };
    };

    await at.runAutoTranslation();

    // each batch of 3 splits into 2 + 1, and each 2 into 1 + 1
    expect(calls.filter((s) => s === 3).length).to.equal(2);
    expect(calls.filter((s) => s === 2).length).to.equal(2);
    expect(calls.filter((s) => s === 1).length).to.equal(6);
    expect(at.error).to.be.null;
    expect(at.running).to.be.false;
    expect(at.progress).to.deep.equal({ done: 6, total: 6 });
    const localization = zustand.getState().flowDefinition?.localization?.fra;
    expect(Object.keys(localization || {}).length).to.equal(6);
  });

  it('should report a single entry the LLM could not translate in time', async () => {
    await setupBatchFlow('timeout-flow', 1, 'v');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    let callCount = 0;
    (storeElement as any).postJSON = async () => {
      callCount += 1;
      return {
        status: 400,
        json: { error: 'LLM took longer than 20s to respond', code: 'timeout' }
      };
    };

    await at.runAutoTranslation();

    // nothing left to split so the failure is reported
    expect(callCount).to.equal(1);
    expect(at.error).to.equal('LLM took longer than 20s to respond');
    expect(at.running).to.be.false;
  });

  it('should preserve all attributes when one uuid spans multiple batches', async () => {
    editor?.remove();
    setupWorkspace();

    // send_email has two localizable attributes (subject + body) on the
    // same action uuid. Inflate them so they fall into separate batches.
    const longSubject = 's'.repeat(2500);
    const longBody = 'b'.repeat(8000);

    const flowDefinition: FlowDefinition = {
      uuid: 'multi-attr-flow',
      name: 'Multi Attr Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {},
      nodes: [
        {
          uuid: 'node-email',
          actions: [
            {
              type: 'send_email',
              uuid: 'email-1',
              subject: longSubject,
              body: longBody,
              addresses: ['x@y.com']
            } as any
          ],
          exits: [{ uuid: 'exit-1' }]
        }
      ],
      _ui: {
        nodes: { 'node-email': { position: { left: 0, top: 0 } } },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 1, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    const calls: any[] = [];
    (storeElement as any).postJSON = async (url: string, body: any) => {
      calls.push(body);
      return { status: 200, json: { items: body.items } };
    };

    await at.runAutoTranslation();

    // sanity check: subject and body landed in different batches
    expect(calls.length).to.be.greaterThan(1);
    const allKeys = new Set(calls.flatMap((c) => Object.keys(c.items)));
    expect(allKeys.has('email-1:subject')).to.be.true;
    expect(allKeys.has('email-1:body')).to.be.true;

    // both attributes should be present in the final localization, not
    // overwritten by the later batch
    const localized =
      zustand.getState().flowDefinition?.localization?.['fra']?.['email-1'];
    expect(localized?.subject).to.deep.equal([longSubject]);
    expect(localized?.body).to.deep.equal([longBody]);
  });

  it('should reuse existing translations for matching source content', async () => {
    editor?.remove();
    setupWorkspace();

    // action-a is already translated to French; action-b shares the same
    // source text but is not yet translated. Auto-translate should reuse
    // action-a's translation for action-b without sending it to the LLM.
    const flowDefinition: FlowDefinition = {
      uuid: 'reuse-flow',
      name: 'Reuse Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'action-a': { text: ['Bonjour le monde'] }
        }
      },
      nodes: [
        {
          uuid: 'node-a',
          actions: [
            {
              type: 'send_msg',
              uuid: 'action-a',
              text: 'Hello world'
            } as SendMsg
          ],
          exits: [{ uuid: 'exit-a' }]
        },
        {
          uuid: 'node-b',
          actions: [
            {
              type: 'send_msg',
              uuid: 'action-b',
              text: 'Hello world'
            } as SendMsg
          ],
          exits: [{ uuid: 'exit-b' }]
        }
      ],
      _ui: {
        nodes: {
          'node-a': { position: { left: 0, top: 0 } },
          'node-b': { position: { left: 0, top: 100 } }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 2, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    let callCount = 0;
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      callCount += 1;
      return { status: 200, json: { items: body.items } };
    };

    await at.runAutoTranslation();

    // no LLM call needed: the only pending entry's source matches an
    // existing translation already in the flow
    expect(callCount).to.equal(0);
    const localized = zustand.getState().flowDefinition?.localization?.['fra'];
    expect(localized?.['action-b']?.text).to.deep.equal(['Bonjour le monde']);
  });

  it('should dedupe identical source arrays in the translation payload', async () => {
    editor?.remove();
    setupWorkspace();

    // Three pending actions share the same source text and one has a
    // distinct text. The payload should contain two unique arrays, and
    // the duplicate source's translation should propagate to all keys
    // sharing that source.
    const flowDefinition: FlowDefinition = {
      uuid: 'dedupe-flow',
      name: 'Dedupe Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {},
      nodes: [
        {
          uuid: 'node-a',
          actions: [
            { type: 'send_msg', uuid: 'action-a', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-a' }]
        },
        {
          uuid: 'node-b',
          actions: [
            { type: 'send_msg', uuid: 'action-b', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-b' }]
        },
        {
          uuid: 'node-c',
          actions: [
            { type: 'send_msg', uuid: 'action-c', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-c' }]
        },
        {
          uuid: 'node-d',
          actions: [
            { type: 'send_msg', uuid: 'action-d', text: 'Goodbye' } as SendMsg
          ],
          exits: [{ uuid: 'exit-d' }]
        }
      ],
      _ui: {
        nodes: {
          'node-a': { position: { left: 0, top: 0 } },
          'node-b': { position: { left: 0, top: 100 } },
          'node-c': { position: { left: 0, top: 200 } },
          'node-d': { position: { left: 0, top: 300 } }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 4, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    const calls: any[] = [];
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      calls.push(body);
      const translated: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(
        body.items as Record<string, string[]>
      )) {
        translated[k] = v.map((s) => `${s}!fr`);
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    // payload should contain only two keys (one canonical per unique
    // source array) — duplicates are not sent
    expect(calls).to.have.lengthOf(1);
    const sentKeys = Object.keys(calls[0].items as Record<string, string[]>);
    expect(sentKeys).to.have.lengthOf(2);

    // every action including duplicates should be translated
    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    expect(localized['action-a']?.text).to.deep.equal(['Hello!fr']);
    expect(localized['action-b']?.text).to.deep.equal(['Hello!fr']);
    expect(localized['action-c']?.text).to.deep.equal(['Hello!fr']);
    expect(localized['action-d']?.text).to.deep.equal(['Goodbye!fr']);
  });

  it('should not seed reuse from a stored translation that contains only empty strings', async () => {
    editor?.remove();
    setupWorkspace();

    // action-a's stored translation is just empty strings — a leftover
    // from a save that didn't actually translate anything. action-b
    // shares the same source and is genuinely untranslated. Default
    // (non-update) mode should still send action-b to the LLM, not
    // pre-translate it with the empty stored value.
    const flowDefinition: FlowDefinition = {
      uuid: 'empty-stored-flow',
      name: 'Empty Stored Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'action-a': { text: [''] }
        }
      },
      nodes: [
        {
          uuid: 'node-a',
          actions: [
            { type: 'send_msg', uuid: 'action-a', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-a' }]
        },
        {
          uuid: 'node-b',
          actions: [
            { type: 'send_msg', uuid: 'action-b', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-b' }]
        }
      ],
      _ui: {
        nodes: {
          'node-a': { position: { left: 0, top: 0 } },
          'node-b': { position: { left: 0, top: 100 } }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 2, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    const calls: any[] = [];
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      calls.push(body);
      const translated: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(
        body.items as Record<string, string[]>
      )) {
        translated[k] = v.map((s) => `${s}!fr`);
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    // a real LLM round-trip happens (action-a's empty stored translation
    // must NOT be reused for action-b)
    expect(calls).to.have.lengthOf(1);
    const sentItems = calls[0].items as Record<string, string[]>;
    expect(Object.values(sentItems)[0]).to.deep.equal(['Hello']);

    // action-b ends up with a real translation rather than the empty
    // pre-translation that the old reuse logic would have produced
    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    expect(localized['action-b']?.text).to.deep.equal(['Hello!fr']);
  });

  it('should not splice stale per-item values when source array length grew', async () => {
    editor?.remove();
    setupWorkspace();

    // The stored arguments translation is shorter than the current
    // source array — a sign that the rule grew after it was last
    // translated. If the LLM returns blanks for the new positions, the
    // merge must NOT splice the old single value into position 0 of the
    // new array (which would mix English into a translated row).
    const flowDefinition: FlowDefinition = {
      uuid: 'grew-args-flow',
      name: 'Grew Args Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'case-A': { arguments: ['Red'] }
        }
      },
      nodes: [
        {
          uuid: 'node-A',
          actions: [],
          router: {
            type: 'switch',
            operand: '@input.text',
            cases: [
              {
                uuid: 'case-A',
                type: 'has_any_word',
                arguments: ['red', 'green', 'blue'],
                category_uuid: 'cat-A1'
              }
            ],
            categories: [
              { uuid: 'cat-A1', name: 'Match', exit_uuid: 'exit-A1' },
              { uuid: 'cat-A-other', name: 'Other', exit_uuid: 'exit-A-other' }
            ],
            default_category_uuid: 'cat-A-other'
          },
          exits: [
            { uuid: 'exit-A1', destination_uuid: null },
            { uuid: 'exit-A-other', destination_uuid: null }
          ]
        }
      ],
      _ui: {
        nodes: {
          'node-A': {
            position: { left: 0, top: 0 },
            type: 'wait_for_response',
            config: { localizeRules: true }
          }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 1, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };
    at.updateExisting = true;

    (storeElement as any).postJSON = async (_url: string, _body: any) => {
      return {
        status: 200,
        json: { items: { 'case-A:arguments': ['', 'vert', 'bleu'] } }
      };
    };

    await at.runAutoTranslation();

    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    // because the lengths don't align, the LLM result is taken as-is —
    // the stored 'Red' must NOT leak into position 0
    expect(localized['case-A']?.arguments).to.deep.equal(['', 'vert', 'bleu']);
  });

  it('should not translate already-translated entries by default', async () => {
    editor?.remove();
    setupWorkspace();

    // action-a is already translated, action-b is not. The default flow
    // should send only action-b to the LLM.
    const flowDefinition: FlowDefinition = {
      uuid: 'update-default-flow',
      name: 'Update Default Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'action-a': { text: ['Bonjour'] }
        }
      },
      nodes: [
        {
          uuid: 'node-a',
          actions: [
            { type: 'send_msg', uuid: 'action-a', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-a' }]
        },
        {
          uuid: 'node-b',
          actions: [
            { type: 'send_msg', uuid: 'action-b', text: 'Goodbye' } as SendMsg
          ],
          exits: [{ uuid: 'exit-b' }]
        }
      ],
      _ui: {
        nodes: {
          'node-a': { position: { left: 0, top: 0 } },
          'node-b': { position: { left: 0, top: 100 } }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 2, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };

    const calls: any[] = [];
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      calls.push(body);
      const translated: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(
        body.items as Record<string, string[]>
      )) {
        translated[k] = v.map((s) => `${s}!fr`);
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    expect(calls).to.have.lengthOf(1);
    const sentKeys = Object.keys(calls[0].items as Record<string, string[]>);
    // only action-b should have been sent
    expect(sentKeys).to.deep.equal(['action-b:text']);

    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    // existing translation for action-a is unchanged
    expect(localized['action-a']?.text).to.deep.equal(['Bonjour']);
    // action-b is now translated
    expect(localized['action-b']?.text).to.deep.equal(['Goodbye!fr']);
  });

  it('should re-translate already-translated entries when updateExisting is true', async () => {
    editor?.remove();
    setupWorkspace();

    const flowDefinition: FlowDefinition = {
      uuid: 'update-existing-flow',
      name: 'Update Existing Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'action-a': { text: ['Bonjour'] }
        }
      },
      nodes: [
        {
          uuid: 'node-a',
          actions: [
            { type: 'send_msg', uuid: 'action-a', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-a' }]
        },
        {
          uuid: 'node-b',
          actions: [
            { type: 'send_msg', uuid: 'action-b', text: 'Goodbye' } as SendMsg
          ],
          exits: [{ uuid: 'exit-b' }]
        }
      ],
      _ui: {
        nodes: {
          'node-a': { position: { left: 0, top: 0 } },
          'node-b': { position: { left: 0, top: 100 } }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 2, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };
    at.updateExisting = true;

    const calls: any[] = [];
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      calls.push(body);
      const translated: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(
        body.items as Record<string, string[]>
      )) {
        translated[k] = v.map((s) => `${s}!fr`);
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    // both already-translated and pending entries should have been sent
    expect(calls).to.have.lengthOf(1);
    const sentKeys = Object.keys(calls[0].items as Record<string, string[]>);
    expect(sentKeys).to.include('action-a:text');
    expect(sentKeys).to.include('action-b:text');

    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    // existing translation has been replaced with the new response
    expect(localized['action-a']?.text).to.deep.equal(['Hello!fr']);
    expect(localized['action-b']?.text).to.deep.equal(['Goodbye!fr']);
  });

  it('should re-translate multi-argument rules and propagate to duplicates in update mode', async () => {
    editor?.remove();
    setupWorkspace();

    // Two wait-for-response style nodes that each have a single rule
    // with 3 arguments [red, green, blue]. Node A is "translated" to
    // matching English values; node B has no localization. Update mode
    // should hand a 3-item source array to the LLM, get back a 3-item
    // translated array, and write that array to both nodes' localization.
    const flowDefinition: FlowDefinition = {
      uuid: 'multi-arg-flow',
      name: 'Multi Arg Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'case-A': { arguments: ['red', 'green', 'blue'] }
        }
      },
      nodes: [
        {
          uuid: 'node-A',
          actions: [],
          router: {
            type: 'switch',
            operand: '@input.text',
            cases: [
              {
                uuid: 'case-A',
                type: 'has_any_word',
                arguments: ['red', 'green', 'blue'],
                category_uuid: 'cat-A1'
              }
            ],
            categories: [
              { uuid: 'cat-A1', name: 'Match', exit_uuid: 'exit-A1' },
              { uuid: 'cat-A-other', name: 'Other', exit_uuid: 'exit-A-other' }
            ],
            default_category_uuid: 'cat-A-other'
          },
          exits: [
            { uuid: 'exit-A1', destination_uuid: null },
            { uuid: 'exit-A-other', destination_uuid: null }
          ]
        },
        {
          uuid: 'node-B',
          actions: [],
          router: {
            type: 'switch',
            operand: '@input.text',
            cases: [
              {
                uuid: 'case-B',
                type: 'has_any_word',
                arguments: ['red', 'green', 'blue'],
                category_uuid: 'cat-B1'
              }
            ],
            categories: [
              { uuid: 'cat-B1', name: 'Match', exit_uuid: 'exit-B1' },
              { uuid: 'cat-B-other', name: 'Other', exit_uuid: 'exit-B-other' }
            ],
            default_category_uuid: 'cat-B-other'
          },
          exits: [
            { uuid: 'exit-B1', destination_uuid: null },
            { uuid: 'exit-B-other', destination_uuid: null }
          ]
        }
      ],
      _ui: {
        nodes: {
          'node-A': {
            position: { left: 0, top: 0 },
            type: 'wait_for_response',
            config: { localizeRules: true }
          },
          'node-B': {
            position: { left: 0, top: 200 },
            type: 'wait_for_response',
            config: { localizeRules: true }
          }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 2, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };
    at.updateExisting = true;

    const calls: any[] = [];
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      calls.push(body);
      const items = body.items as Record<string, string[]>;
      const dictionary: Record<string, string> = {
        red: 'rouge',
        green: 'vert',
        blue: 'bleu'
      };
      const translated: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(items)) {
        translated[k] = v.map((s) => dictionary[s] ?? s);
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    // single canonical request for the duplicated argument set
    expect(calls).to.have.lengthOf(1);
    const sentItems = calls[0].items as Record<string, string[]>;
    expect(Object.keys(sentItems)).to.have.lengthOf(1);
    const [sentValues] = Object.values(sentItems);
    expect(sentValues).to.deep.equal(['red', 'green', 'blue']);

    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    // both nodes' rules end up with the per-item translated array
    expect(localized['case-A']?.arguments).to.deep.equal([
      'rouge',
      'vert',
      'bleu'
    ]);
    expect(localized['case-B']?.arguments).to.deep.equal([
      'rouge',
      'vert',
      'bleu'
    ]);
  });

  it('should re-translate rules even when an existing translation matches the source', async () => {
    editor?.remove();
    setupWorkspace();

    // Two wait-for-response style nodes share the same set of rule
    // arguments. Node A has been "translated" to the same English values
    // as the source; node B has no localization. Update mode should
    // discard the English-matching translation, ask the LLM for fresh
    // translations, and apply them to every matching rule.
    const flowDefinition: FlowDefinition = {
      uuid: 'rules-flow',
      name: 'Rules Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'case-A1': { arguments: ['red'] },
          'case-A2': { arguments: ['green'] },
          'case-A3': { arguments: ['blue'] }
        }
      },
      nodes: [
        {
          uuid: 'node-A',
          actions: [],
          router: {
            type: 'switch',
            operand: '@input.text',
            cases: [
              {
                uuid: 'case-A1',
                type: 'has_only_phrase',
                arguments: ['red'],
                category_uuid: 'cat-A1'
              },
              {
                uuid: 'case-A2',
                type: 'has_only_phrase',
                arguments: ['green'],
                category_uuid: 'cat-A2'
              },
              {
                uuid: 'case-A3',
                type: 'has_only_phrase',
                arguments: ['blue'],
                category_uuid: 'cat-A3'
              }
            ],
            categories: [
              { uuid: 'cat-A1', name: 'Red', exit_uuid: 'exit-A1' },
              { uuid: 'cat-A2', name: 'Green', exit_uuid: 'exit-A2' },
              { uuid: 'cat-A3', name: 'Blue', exit_uuid: 'exit-A3' },
              { uuid: 'cat-A-other', name: 'Other', exit_uuid: 'exit-A-other' }
            ],
            default_category_uuid: 'cat-A-other'
          },
          exits: [
            { uuid: 'exit-A1', destination_uuid: null },
            { uuid: 'exit-A2', destination_uuid: null },
            { uuid: 'exit-A3', destination_uuid: null },
            { uuid: 'exit-A-other', destination_uuid: null }
          ]
        },
        {
          uuid: 'node-B',
          actions: [],
          router: {
            type: 'switch',
            operand: '@input.text',
            cases: [
              {
                uuid: 'case-B1',
                type: 'has_only_phrase',
                arguments: ['red'],
                category_uuid: 'cat-B1'
              },
              {
                uuid: 'case-B2',
                type: 'has_only_phrase',
                arguments: ['green'],
                category_uuid: 'cat-B2'
              },
              {
                uuid: 'case-B3',
                type: 'has_only_phrase',
                arguments: ['blue'],
                category_uuid: 'cat-B3'
              }
            ],
            categories: [
              { uuid: 'cat-B1', name: 'Red', exit_uuid: 'exit-B1' },
              { uuid: 'cat-B2', name: 'Green', exit_uuid: 'exit-B2' },
              { uuid: 'cat-B3', name: 'Blue', exit_uuid: 'exit-B3' },
              { uuid: 'cat-B-other', name: 'Other', exit_uuid: 'exit-B-other' }
            ],
            default_category_uuid: 'cat-B-other'
          },
          exits: [
            { uuid: 'exit-B1', destination_uuid: null },
            { uuid: 'exit-B2', destination_uuid: null },
            { uuid: 'exit-B3', destination_uuid: null },
            { uuid: 'exit-B-other', destination_uuid: null }
          ]
        }
      ],
      _ui: {
        nodes: {
          'node-A': {
            position: { left: 0, top: 0 },
            type: 'wait_for_response',
            config: { localizeRules: true }
          },
          'node-B': {
            position: { left: 0, top: 200 },
            type: 'wait_for_response',
            config: { localizeRules: true }
          }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 2, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };
    at.updateExisting = true;

    const calls: any[] = [];
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      calls.push(body);
      const items = body.items as Record<string, string[]>;
      const dictionary: Record<string, string> = {
        red: 'rouge',
        green: 'vert',
        blue: 'bleu'
      };
      const translated: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(items)) {
        translated[k] = v.map((s) => dictionary[s] ?? s);
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    // node A's existing English-like translations are replaced with French
    expect(localized['case-A1']?.arguments).to.deep.equal(['rouge']);
    expect(localized['case-A2']?.arguments).to.deep.equal(['vert']);
    expect(localized['case-A3']?.arguments).to.deep.equal(['bleu']);
    // node B picks up the same fresh translations
    expect(localized['case-B1']?.arguments).to.deep.equal(['rouge']);
    expect(localized['case-B2']?.arguments).to.deep.equal(['vert']);
    expect(localized['case-B3']?.arguments).to.deep.equal(['bleu']);
  });

  it('should replace all matching translations with a fresh value when updateExisting is true', async () => {
    editor?.remove();
    setupWorkspace();

    // three actions share the same source. All are already translated,
    // including some with different translations. Update mode should
    // fetch one fresh translation and apply it to every instance.
    const flowDefinition: FlowDefinition = {
      uuid: 'replace-all-flow',
      name: 'Replace All Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'action-a': { text: ['Salut'] },
          'action-b': { text: ['Bonjour'] },
          'action-c': { text: ['Allo'] }
        }
      },
      nodes: [
        {
          uuid: 'node-a',
          actions: [
            { type: 'send_msg', uuid: 'action-a', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-a' }]
        },
        {
          uuid: 'node-b',
          actions: [
            { type: 'send_msg', uuid: 'action-b', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-b' }]
        },
        {
          uuid: 'node-c',
          actions: [
            { type: 'send_msg', uuid: 'action-c', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-c' }]
        }
      ],
      _ui: {
        nodes: {
          'node-a': { position: { left: 0, top: 0 } },
          'node-b': { position: { left: 0, top: 100 } },
          'node-c': { position: { left: 0, top: 200 } }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 3, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };
    at.updateExisting = true;

    const calls: any[] = [];
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      calls.push(body);
      const translated: Record<string, string[]> = {};
      for (const k of Object.keys(body.items as Record<string, string[]>)) {
        translated[k] = ['Coucou'];
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    // only one canonical entry should be sent for the duplicated source
    expect(calls).to.have.lengthOf(1);
    const sentKeys = Object.keys(calls[0].items as Record<string, string[]>);
    expect(sentKeys).to.have.lengthOf(1);

    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    // every existing translation, regardless of its prior value, gets the
    // new translation
    expect(localized['action-a']?.text).to.deep.equal(['Coucou']);
    expect(localized['action-b']?.text).to.deep.equal(['Coucou']);
    expect(localized['action-c']?.text).to.deep.equal(['Coucou']);
  });

  it('should propagate updates to entries sharing the same source when updateExisting is true', async () => {
    editor?.remove();
    setupWorkspace();

    // action-a is already translated; action-b shares the same source.
    // With updateExisting true, the new response should update both.
    const flowDefinition: FlowDefinition = {
      uuid: 'update-dedupe-flow',
      name: 'Update Dedupe Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'action-a': { text: ['Salut'] }
        }
      },
      nodes: [
        {
          uuid: 'node-a',
          actions: [
            { type: 'send_msg', uuid: 'action-a', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-a' }]
        },
        {
          uuid: 'node-b',
          actions: [
            { type: 'send_msg', uuid: 'action-b', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-b' }]
        }
      ],
      _ui: {
        nodes: {
          'node-a': { position: { left: 0, top: 0 } },
          'node-b': { position: { left: 0, top: 100 } }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 2, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };
    at.updateExisting = true;

    const calls: any[] = [];
    (storeElement as any).postJSON = async (_url: string, body: any) => {
      calls.push(body);
      const translated: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(
        body.items as Record<string, string[]>
      )) {
        translated[k] = v.map(() => 'Bonjour');
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    // only one canonical entry should be sent for the duplicate source
    expect(calls).to.have.lengthOf(1);
    const sentKeys = Object.keys(calls[0].items as Record<string, string[]>);
    expect(sentKeys).to.have.lengthOf(1);

    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    // both entries get the same updated translation
    expect(localized['action-a']?.text).to.deep.equal(['Bonjour']);
    expect(localized['action-b']?.text).to.deep.equal(['Bonjour']);
  });

  it('should never replace an existing translation with an empty value', async () => {
    editor?.remove();
    setupWorkspace();

    // action-a and action-b are both already translated. The LLM returns
    // an empty string for action-a's text — the existing translation
    // should be preserved.
    const flowDefinition: FlowDefinition = {
      uuid: 'preserve-empty-flow',
      name: 'Preserve Empty Flow',
      language: 'eng',
      type: 'messaging',
      revision: 1,
      spec_version: '14.3',
      localization: {
        fra: {
          'action-a': { text: ['Bonjour'] },
          'action-b': { text: ['Au revoir'] }
        }
      },
      nodes: [
        {
          uuid: 'node-a',
          actions: [
            { type: 'send_msg', uuid: 'action-a', text: 'Hello' } as SendMsg
          ],
          exits: [{ uuid: 'exit-a' }]
        },
        {
          uuid: 'node-b',
          actions: [
            { type: 'send_msg', uuid: 'action-b', text: 'Goodbye' } as SendMsg
          ],
          exits: [{ uuid: 'exit-b' }]
        }
      ],
      _ui: {
        nodes: {
          'node-a': { position: { left: 0, top: 0 } },
          'node-b': { position: { left: 0, top: 100 } }
        },
        languages: []
      }
    };

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 2, languages: 2 },
        locals: []
      }
    });

    editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);
    await editor.updateComplete;
    await selectLanguageInToolbar(editor, 'French', 'fra');
    const at = editor.querySelector('temba-auto-translate') as any;
    at.selectedModel = { uuid: 'llm-1', name: 'GPT-4' };
    at.updateExisting = true;

    (storeElement as any).postJSON = async (_url: string, body: any) => {
      const items = body.items as Record<string, string[]>;
      const translated: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(items)) {
        if (k === 'action-a:text') {
          // simulate the LLM returning an empty value for this entry
          translated[k] = [''];
        } else {
          translated[k] = v.map((s) => `${s}!fr`);
        }
      }
      return { status: 200, json: { items: translated } };
    };

    await at.runAutoTranslation();

    const localized =
      zustand.getState().flowDefinition?.localization?.['fra'] || {};
    // empty response keeps the prior translation
    expect(localized['action-a']?.text).to.deep.equal(['Bonjour']);
    // a non-empty response replaces the prior translation as expected
    expect(localized['action-b']?.text).to.deep.equal(['Goodbye!fr']);
  });

  it('should render an unchecked update-existing checkbox in the picker', async () => {
    await selectLanguageInToolbar(editor, 'French', 'fra');

    (storeElement as any).getResults = async () => [
      { uuid: 'llm-only', name: 'SoloGPT', roles: ['editing'] }
    ];

    const autoTranslateBtn = editor
      .querySelector('temba-editor-toolbar')
      ?.shadowRoot?.querySelector(
        '.toolbar-btn[aria-label="Auto translate"]'
      ) as HTMLButtonElement;
    autoTranslateBtn.click();
    await editor.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    const at = editor.querySelector('temba-auto-translate') as any;
    await at.updateComplete;

    const dialog = at.shadowRoot.querySelector('.auto-translate-body');
    const checkbox = dialog?.querySelector(
      '.auto-translate-update-existing'
    ) as any;
    expect(checkbox).to.exist;
    expect(checkbox.checked).to.not.be.true;
    expect(at.updateExisting).to.be.false;
  });

  it('should preserve selected language across renders', async () => {
    await selectLanguageInToolbar(editor, 'Spanish', 'spa');

    expect(zustand.getState().languageCode).to.equal('spa');

    // Trigger a re-render
    await editor.requestUpdate();
    await editor.updateComplete;

    // Language should remain as Spanish
    const state = zustand.getState();
    expect(state.languageCode).to.equal('spa');
  });

  it('should load base language values when in English', () => {
    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello world',
      quick_replies: ['Yes', 'No']
    };

    const formData = send_msg.toFormData(action);

    expect(formData.text).to.equal('Hello world');
    expect(formData.quick_replies).to.have.lengthOf(2);
    expect(formData.quick_replies[0].value).to.equal('Yes');
    expect(formData.quick_replies[1].value).to.equal('No');
  });

  it('should load localized values when in Spanish', () => {
    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello world',
      quick_replies: ['Yes', 'No']
    };

    const localization = {
      text: ['Hola mundo'],
      quick_replies: ['Sí', 'No']
    };

    const formData = send_msg.toLocalizationFormData(action, localization);

    expect(formData.text).to.equal('Hola mundo');
    expect(formData.quick_replies).to.have.lengthOf(2);
    expect(formData.quick_replies[0].value).to.equal('Sí');
    expect(formData.quick_replies[1].value).to.equal('No');
  });

  it('should fall back to base language if no localization exists', () => {
    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello world',
      quick_replies: ['Yes', 'No']
    };

    const localization = {}; // Empty localization

    const formData = send_msg.toLocalizationFormData(action, localization);

    // Should show base language values (but empty since localization is empty)
    expect(formData.text).to.equal('');
    expect(formData.quick_replies).to.be.undefined;
  });

  it('should convert form data to localization format', () => {
    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello world',
      quick_replies: ['Yes', 'No']
    };

    const formData = {
      uuid: 'action-1',
      text: 'Bonjour le monde',
      quick_replies: [
        { name: 'Oui', value: 'Oui' },
        { name: 'Non', value: 'Non' }
      ]
    };

    const localization = send_msg.fromLocalizationFormData(formData, action);

    expect(localization.text).to.deep.equal(['Bonjour le monde']);
    expect(localization.quick_replies).to.deep.equal(['Oui', 'Non']);
  });

  it('should not include unchanged values in localization', () => {
    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello world',
      quick_replies: ['Yes', 'No']
    };

    const formData = {
      uuid: 'action-1',
      text: 'Hello world', // Same as base
      quick_replies: [
        { name: 'Yes', value: 'Yes' },
        { name: 'No', value: 'No' }
      ] // Same as base
    };

    const localization = send_msg.fromLocalizationFormData(formData, action);

    // should not include unchanged values
    expect(localization.text).to.be.undefined;
    expect(localization.quick_replies).to.be.undefined;
  });

  it('should include language name in dialog header when translating', async () => {
    // Switch to Spanish
    zustand.getState().setLanguageCode('spa');

    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello world',
      quick_replies: []
    };

    const nodeEditor: NodeEditor = await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}> </temba-node-editor>
    `);

    await nodeEditor.updateComplete;

    // Check dialog header
    const dialog = nodeEditor.shadowRoot.querySelector('temba-dialog');
    expect(dialog).to.exist;
    expect(dialog.getAttribute('header')).to.equal('Spanish - Send Message');
  });

  it('should handle attachments in localization', () => {
    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello',
      attachments: ['image/jpeg:http://example.com/image.jpg']
    };

    const localization = {
      text: ['Hola'],
      attachments: ['image/jpeg:http://example.com/imagen.jpg']
    };

    const formData = send_msg.toLocalizationFormData(action, localization);

    expect(formData.text).to.equal('Hola');
    expect(formData.attachments).to.have.lengthOf(1);
    expect(formData.attachments[0]).to.equal(
      'image/jpeg:http://example.com/imagen.jpg'
    );
  });

  it('should handle runtime attachments in localization', () => {
    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello',
      attachments: ['image:@fields.profile_pic']
    };

    const localization = {
      text: ['Hola'],
      attachments: ['image:@fields.foto_perfil']
    };

    const formData = send_msg.toLocalizationFormData(action, localization);

    expect(formData.text).to.equal('Hola');
    expect(formData.runtime_attachments).to.have.lengthOf(1);
    expect(formData.runtime_attachments[0].expression).to.equal(
      '@fields.foto_perfil'
    );
  });

  it('should identify localizable fields', () => {
    expect(send_msg.localizable).to.exist;
    expect(send_msg.localizable).to.include('text');
    expect(send_msg.localizable).to.include('quick_replies');
    expect(send_msg.localizable).to.include('attachments');
  });

  it('should save empty localization when all values match base', () => {
    const action: SendMsg = {
      type: 'send_msg',
      uuid: 'action-1',
      text: 'Hello world',
      quick_replies: []
    };

    const formData = {
      uuid: 'action-1',
      text: 'Hello world' // Same as base, so shouldn't be saved
    };

    const localization = send_msg.fromLocalizationFormData(formData, action);

    // empty localization when nothing changed
    expect(Object.keys(localization)).to.have.lengthOf(0);
  });

  it('should remove category localization when translation is cleared', async () => {
    editor?.remove();
    editor = null;

    setupWorkspace();

    const flowDefinition = buildCategoryFlowDefinition({
      fra: {
        'cat-1': { name: ['Premier choix'] },
        'cat-2': { name: ['Deuxième choix'] }
      }
    });

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 1, languages: 2 },
        locals: []
      }
    });
    zustand.getState().setLanguageCode('fra');

    const state = zustand.getState();
    const node = state.flowDefinition.nodes[0];
    const nodeUI = state.flowDefinition._ui.nodes[node.uuid];

    const nodeEditor: NodeEditor = await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `);
    await nodeEditor.updateComplete;

    const formData = (nodeEditor as any).formData;
    formData.categories['cat-1'].localizedName = '';

    (nodeEditor as any).handleSave();

    const localization =
      zustand.getState().flowDefinition.localization?.fra || {};
    expect(localization['cat-1']).to.be.undefined;
    expect(localization['cat-2']).to.deep.equal({ name: ['Deuxième choix'] });

    nodeEditor.remove();
  });

  it('should remove empty localization entries when all category translations are cleared', async () => {
    editor?.remove();
    editor = null;

    setupWorkspace();

    const flowDefinition = buildCategoryFlowDefinition({
      fra: {
        'cat-1': { name: ['Premier choix'] }
      }
    });

    zustand.getState().setFlowContents({
      definition: flowDefinition,
      info: {
        results: [],
        dependencies: [],
        counts: { nodes: 1, languages: 2 },
        locals: []
      }
    });
    zustand.getState().setLanguageCode('fra');

    const state = zustand.getState();
    const node = state.flowDefinition.nodes[0];
    const nodeUI = state.flowDefinition._ui.nodes[node.uuid];

    const nodeEditor: NodeEditor = await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `);
    await nodeEditor.updateComplete;

    const formData = (nodeEditor as any).formData;
    formData.categories['cat-1'].localizedName = '';

    (nodeEditor as any).handleSave();

    const localization = zustand.getState().flowDefinition.localization;
    expect(localization).to.be.undefined;

    nodeEditor.remove();
  });

  describe('Default language switching', () => {
    let originalFetchRevision: any;
    let reloadCount: number;
    let reloadEndpoint: string | null;

    const getMakeDefaultButton = (toolbar: any): HTMLElement | null =>
      toolbar.shadowRoot.querySelector('.toolbar-btn.make-default');

    const clickMakeDefaultAndConfirm = async (): Promise<any> => {
      const toolbar = await getToolbar(editor);
      getMakeDefaultButton(toolbar)!.click();
      await editor.updateComplete;

      const dialog = document.body.querySelector('temba-dialog') as any;
      dialog.dispatchEvent(
        new CustomEvent('temba-button-clicked', {
          detail: {
            button: { name: 'Update' },
            detail: { name: 'Update', type: 'primary' }
          }
        })
      );
      await aTimeout(10);
      return dialog;
    };

    beforeEach(async () => {
      // stub the reload so promoting doesn't hit the network
      originalFetchRevision = zustand.getState().fetchRevision;
      reloadCount = 0;
      reloadEndpoint = null;
      zustand.setState({
        fetchRevision: async (endpoint: string) => {
          reloadCount += 1;
          reloadEndpoint = endpoint;
        }
      } as any);

      // give the editor a flow id so endpoint URLs are well-formed
      editor.flow = 'test-flow';
      await editor.updateComplete;
    });

    afterEach(() => {
      zustand.setState({ fetchRevision: originalFetchRevision } as any);
    });

    it('hides the make-default control on the base language', async () => {
      const toolbar = await getToolbar(editor);
      expect(getMakeDefaultButton(toolbar)).to.be.null;
    });

    it('shows the make-default control for a fully-translated language', async () => {
      await selectLanguageInToolbar(editor, 'Spanish', 'spa');
      const toolbar = await getToolbar(editor);
      expect(toolbar.canMakeDefault).to.be.true;
      expect(getMakeDefaultButton(toolbar)).to.exist;
    });

    it('hides the make-default control for a partially-translated language', async () => {
      await selectLanguageInToolbar(editor, 'French', 'fra');
      const toolbar = await getToolbar(editor);
      expect(toolbar.canMakeDefault).to.be.false;
      expect(getMakeDefaultButton(toolbar)).to.be.null;
    });

    it('promotes a fully-translated language to the flow default', async () => {
      const calls: Array<{ url: string; body: any }> = [];
      (storeElement as any).postJSON = async (url: string, body: any) => {
        calls.push({ url, body });
        return {
          status: 200,
          json: { status: 'success', revision: { revision: 2 } }
        };
      };

      await selectLanguageInToolbar(editor, 'Spanish', 'spa');
      reloadCount = 0;
      const dialog = await clickMakeDefaultAndConfirm();

      const changeCall = calls.find((c) => c.url.includes('change_language'));
      expect(changeCall, 'change_language endpoint should be called').to.exist;
      expect(changeCall!.body).to.deep.equal({ language: 'spa' });
      expect(reloadCount).to.equal(1);
      expect(reloadEndpoint).to.equal('/flow/revisions/test-flow');
      expect(dialog.open).to.be.false;

      dialog.remove();
    });

    it('keeps the dialog open and shows an error when the change fails', async () => {
      (storeElement as any).postJSON = async () => ({
        status: 400,
        json: { status: 'failure', description: 'Not a valid language.' }
      });

      await selectLanguageInToolbar(editor, 'Spanish', 'spa');
      reloadCount = 0;
      const dialog = await clickMakeDefaultAndConfirm();

      expect(dialog.open).to.be.true;
      expect(dialog.textContent).to.contain('Not a valid language.');
      expect(reloadCount).to.equal(0);

      dialog.open = false;
      dialog.remove();
    });

    it('blocks cancel while the swap request is in flight', async () => {
      let resolvePost: (value: any) => void = () => {};
      (storeElement as any).postJSON = (url: string) => {
        if (url.includes('change_language')) {
          return new Promise((resolve) => {
            resolvePost = resolve;
          });
        }
        return Promise.resolve({ status: 200, json: {} });
      };

      await selectLanguageInToolbar(editor, 'Spanish', 'spa');
      reloadCount = 0;

      const toolbar = await getToolbar(editor);
      getMakeDefaultButton(toolbar)!.click();
      await editor.updateComplete;

      const dialog = document.body.querySelector('temba-dialog') as any;
      dialog.dispatchEvent(
        new CustomEvent('temba-button-clicked', {
          detail: {
            button: { name: 'Update' },
            detail: { name: 'Update', type: 'primary' }
          }
        })
      );
      await aTimeout(0);

      // mid-flight the Cancel affordance is removed so the (un-recallable)
      // request can't be abandoned, and a stray cancel event is ignored
      expect(dialog.cancelButtonName).to.equal('');
      dialog.dispatchEvent(
        new CustomEvent('temba-button-clicked', {
          detail: {
            button: { name: 'Cancel' },
            detail: { name: 'Cancel', type: 'secondary', closes: true }
          }
        })
      );
      await aTimeout(0);
      expect(dialog.open, 'dialog stays open during the swap').to.be.true;
      expect(reloadCount).to.equal(0);

      // once the request resolves the swap completes and the dialog closes
      resolvePost({
        status: 200,
        json: { status: 'success', revision: { revision: 2 } }
      });
      await aTimeout(10);

      expect(dialog.cancelButtonName).to.equal('Cancel');
      expect(dialog.open).to.be.false;
      expect(reloadCount).to.equal(1);

      dialog.remove();
    });
  });
});
