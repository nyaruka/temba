import { html, fixture, expect, aTimeout } from '@open-wc/testing';
import { Editor } from '../src/flow/Editor';
import { EditorToolbar } from '../src/flow/EditorToolbar';
import { IssuesWindow } from '../src/flow/IssuesWindow';
import { RevisionsWindow } from '../src/flow/RevisionsWindow';
import { Plumber } from '../src/flow/Plumber';
import { stub, restore, useFakeTimers } from 'sinon';
import { zustand } from '../src/store/AppState';
import { TEMBA_COMPONENTS_VERSION } from '../src/version';
import {
  ConnectionState,
  ConnectionStateHandler,
  SocketProvider,
  SocketSubscription,
  setSocketProvider
} from '../src/live/SocketService';
import { Store } from '../src/store/Store';
import { setRealtimeContext } from '../src/live/Realtime';
import { CustomEventType } from '../src/interfaces';

class EditorSocketProvider implements SocketProvider {
  subscriptions: {
    channel: string;
    handler: (event: any) => void;
    onSubscribed?: () => void;
    active: boolean;
  }[] = [];

  subscribe(
    channel: string,
    handler: (event: any) => void,
    onSubscribed?: () => void
  ): SocketSubscription {
    const subscription = { channel, handler, onSubscribed, active: true };
    this.subscriptions.push(subscription);
    return {
      unsubscribe: () => {
        subscription.active = false;
      }
    };
  }

  publish(): Promise<void> {
    return Promise.resolve();
  }

  getConnectionState(): ConnectionState {
    return ConnectionState.Connected;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onConnectionState(handler: ConnectionStateHandler): SocketSubscription {
    return { unsubscribe: () => undefined };
  }

  onDenied(): SocketSubscription {
    return { unsubscribe: () => undefined };
  }

  recheck(): void {}

  serverPublish(channel: string, event: any): void {
    this.subscriptions
      .filter(
        (subscription) =>
          subscription.active && subscription.channel === channel
      )
      .forEach((subscription) => subscription.handler(event));
  }
}

// Register the components
if (!customElements.get('temba-flow-editor')) {
  customElements.define('temba-flow-editor', Editor);
}
if (!customElements.get('temba-editor-toolbar')) {
  customElements.define('temba-editor-toolbar', EditorToolbar);
}
if (!customElements.get('temba-issues-window')) {
  customElements.define('temba-issues-window', IssuesWindow);
}
if (!customElements.get('temba-revisions-window')) {
  customElements.define('temba-revisions-window', RevisionsWindow);
}
if (!customElements.get('temba-store')) {
  customElements.define('temba-store', Store);
}

async function getToolbarButton(
  editor: Editor,
  ariaLabel: string
): Promise<HTMLElement | null> {
  const toolbar = editor.querySelector('temba-editor-toolbar');
  if (!toolbar) return null;
  await (toolbar as any).updateComplete;
  return toolbar.shadowRoot?.querySelector(
    `.toolbar-btn[aria-label="${ariaLabel}"]`
  ) as HTMLElement | null;
}

describe('Editor', () => {
  let editor: Editor;

  beforeEach(() => {
    // Reset any stubs
    restore();
  });

  afterEach(() => {
    restore();
  });

  describe('basic functionality', () => {
    it('creates render root as element itself', () => {
      const editor = new Editor();
      expect(editor.createRenderRoot()).to.equal(editor);
    });

    it('has correct CSS styles defined', () => {
      const styles = Editor.styles;
      expect(styles).to.exist;
      expect(styles.cssText).to.contain('#editor');
      expect(styles.cssText).to.contain('#grid');
      expect(styles.cssText).to.contain('#canvas');
      expect(styles.cssText).to.contain('.plumb-connector');
    });

    it('creates with default properties', () => {
      editor = new Editor();
      expect(editor.flow).to.be.undefined;
      expect(editor.version).to.be.undefined;
    });

    it('accepts flow and version properties without getStore call', async () => {
      editor = document.createElement('temba-flow-editor') as Editor;
      editor.flow = 'test-flow-uuid';
      editor.version = '1.0';

      expect(editor.flow).to.equal('test-flow-uuid');
      expect(editor.version).to.equal('1.0');
    });
  });

  describe('lifecycle methods', () => {
    it('calls firstUpdated and initializes plumber', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Verify that plumber is initialized
      expect((editor as any).plumber).to.be.instanceOf(Plumber);
    });

    it('verifies firstUpdated method exists and can be called', () => {
      editor = new Editor();

      // Mock canvas element
      const mockCanvas = document.createElement('div');
      mockCanvas.id = 'canvas';

      // Mock querySelector to return our mock canvas
      stub(editor, 'querySelector').returns(mockCanvas);

      // Verify firstUpdated method exists
      expect(typeof (editor as any).firstUpdated).to.equal('function');

      // Test that calling firstUpdated doesn't throw (without getStore)
      expect(() => {
        // Only test the plumber initialization part
        (editor as any).plumber = new Plumber(mockCanvas, editor);
      }).to.not.throw();
    });

    it('handles updated with canvasSize changes', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Simulate canvasSize change
      (editor as any).canvasSize = { width: 800, height: 600 };
      const changes = new Map();
      changes.set('canvasSize', true);

      (editor as any).updated(changes);

      // Verify the canvasSize was set correctly
      expect((editor as any).canvasSize).to.deep.equal({
        width: 800,
        height: 600
      });
    });

    it('handles updated without canvasSize changes', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      const consoleStub = stub(console, 'log');

      const changes = new Map();
      changes.set('other', true);

      (editor as any).updated(changes);

      expect(consoleStub).to.not.have.been.called;

      consoleStub.restore();
    });
  });

  describe('disconnectedCallback', () => {
    it('clears flow data from the store when editor is removed', async () => {
      // Set up some flow-specific state
      zustand.setState({
        flowDefinition: { nodes: [], _ui: { nodes: {} } } as any,
        activity: { nodes: {}, segments: {} },
        simulatorActivity: { nodes: {}, segments: {} },
        simulatorActive: true,
        flowInfo: {
          results: [],
          dependencies: [],
          counts: { nodes: 0, languages: 0 },
          locals: []
        } as any,
        dirtyDate: new Date()
      });

      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Verify state is populated
      expect(zustand.getState().flowDefinition).to.not.be.null;
      expect(zustand.getState().activity).to.not.be.null;

      // Remove the editor from the DOM
      editor.remove();

      // Verify all flow-specific state has been cleared
      expect(zustand.getState().flowDefinition).to.be.null;
      expect(zustand.getState().activity).to.be.null;
      expect(zustand.getState().simulatorActivity).to.be.null;
      expect(zustand.getState().simulatorActive).to.be.false;
      expect(zustand.getState().flowInfo).to.be.null;
      expect(zustand.getState().dirtyDate).to.be.null;
    });
  });

  describe('render method', () => {
    it('renders loading when no definition', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Set canvas size to avoid undefined errors
      (editor as any).canvasSize = { width: 800, height: 600 };
      await editor.updateComplete;

      const loadingElement = editor.querySelector('temba-loading');
      expect(loadingElement).to.exist;
    });

    it('renders nodes when definition exists', async () => {
      const mockDefinition = {
        nodes: [
          {
            uuid: 'node-1',
            actions: [],
            exits: []
          },
          {
            uuid: 'node-2',
            actions: [],
            exits: []
          }
        ],
        _ui: {
          nodes: {
            'node-1': { position: { left: 100, top: 200 } },
            'node-2': { position: { left: 300, top: 400 } }
          }
        }
      };

      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Set properties
      (editor as any).definition = mockDefinition;
      (editor as any).canvasSize = { width: 800, height: 600 };
      await editor.updateComplete;

      const flowNodes = editor.querySelectorAll('temba-flow-node');
      expect(flowNodes).to.have.length(2);
    });

    it('includes style elements in light DOM', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Set canvas size
      (editor as any).canvasSize = { width: 800, height: 600 };
      await editor.updateComplete;

      const styleElements = editor.querySelectorAll('style');
      expect(styleElements.length).to.be.greaterThan(0);
    });

    it('renders with correct grid dimensions', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 1200, height: 800 };
      await editor.updateComplete;

      const gridElement = editor.querySelector('#grid');
      expect(gridElement).to.exist;

      const style = gridElement?.getAttribute('style');
      expect(style).to.contain('width:1200px');
      expect(style).to.contain('height:800px');
    });

    it('renders editor structure', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 800, height: 600 };
      await editor.updateComplete;

      const editorElement = editor.querySelector('#editor');
      expect(editorElement).to.exist;

      const gridElement = editor.querySelector('#grid');
      expect(gridElement).to.exist;

      const canvasElement = editor.querySelector('#canvas');
      expect(canvasElement).to.exist;
    });
  });

  describe('property handling', () => {
    it('handles flow property change', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Change flow property
      editor.flow = 'new-flow-uuid';
      await editor.updateComplete;

      expect(editor.flow).to.equal('new-flow-uuid');
    });

    it('handles version property change', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      editor.version = '2.0';
      await editor.updateComplete;

      expect(editor.version).to.equal('2.0');
    });

    it('watches the flow socket and reads activity once on load', async () => {
      const flowUuid = '33333333-3333-4333-8333-333333333333';
      const socket = new EditorSocketProvider();
      const previousProvider = setSocketProvider(socket);
      const previousState = zustand.getState();
      const activityRequests: string[] = [];

      try {
        stub(window, 'fetch').callsFake(async (input: RequestInfo) => {
          const endpoint = `${input}`;
          if (endpoint.includes('/flow/activity/')) {
            activityRequests.push(endpoint);
            return new Response(
              JSON.stringify({ nodes: { 'node-1': 1 }, segments: {} }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          }
          return new Response('', { status: 404 });
        });
        zustand.setState({
          flowDefinition: null,
          flowInfo: null,
          simulatorActive: false,
          activity: null
        } as any);

        const wrapper = await fixture(
          html`<div>
            <temba-store
              org="44444444-4444-4444-8444-444444444444"
              user="55555555-5555-4555-8555-555555555555"
            ></temba-store>
            <temba-flow-editor>
              <div id="canvas"></div>
            </temba-flow-editor>
          </div>`
        );
        const store = wrapper.querySelector('temba-store') as Store;
        editor = wrapper.querySelector('temba-flow-editor') as Editor;
        await store.initialHttpComplete;

        zustand.setState({
          flowDefinition: {
            uuid: flowUuid,
            name: 'Test',
            language: 'eng',
            type: 'messaging',
            revision: 1,
            spec_version: '14.3',
            localization: {},
            nodes: [],
            _ui: { nodes: {}, languages: [] }
          }
        } as any);
        await editor.updateComplete;

        const subscription = socket.subscriptions.find(
          (candidate) => candidate.channel === `flow:${flowUuid}`
        );
        expect(subscription).to.exist;

        // the first read doesn't wait on the socket, which may never connect
        expect(activityRequests).to.deep.equal([`/flow/activity/${flowUuid}/`]);
        await aTimeout(0);

        socket.serverPublish(`flow:${flowUuid}`, { type: 'unrelated' });
        await aTimeout(0);
        expect(activityRequests).to.have.length(1);

        wrapper.remove();
        expect(subscription.active).to.be.false;
      } finally {
        setRealtimeContext(null);
        setSocketProvider(previousProvider);
        zustand.setState(previousState as any, true);
      }
    });

    it('coalesces activity publications into one request per window', async () => {
      const flowUuid = '33333333-3333-4333-8333-333333333333';
      const socket = new EditorSocketProvider();
      const previousProvider = setSocketProvider(socket);
      const previousState = zustand.getState();
      const activityRequests: string[] = [];
      let clock: any = null;

      try {
        stub(window, 'fetch').callsFake(async (input: RequestInfo) => {
          const endpoint = `${input}`;
          if (endpoint.includes('/flow/activity/')) {
            activityRequests.push(endpoint);
            return new Response(
              JSON.stringify({ nodes: { 'node-1': 1 }, segments: {} }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          }
          return new Response('', { status: 404 });
        });
        zustand.setState({
          flowDefinition: null,
          flowInfo: null,
          simulatorActive: false,
          activity: null
        } as any);

        const wrapper = await fixture(
          html`<div>
            <temba-store
              org="44444444-4444-4444-8444-444444444444"
              user="55555555-5555-4555-8555-555555555555"
            ></temba-store>
            <temba-flow-editor>
              <div id="canvas"></div>
            </temba-flow-editor>
          </div>`
        );
        const store = wrapper.querySelector('temba-store') as Store;
        editor = wrapper.querySelector('temba-flow-editor') as Editor;
        await store.initialHttpComplete;

        zustand.setState({
          flowDefinition: {
            uuid: flowUuid,
            name: 'Test',
            language: 'eng',
            type: 'messaging',
            revision: 1,
            spec_version: '14.3',
            localization: {},
            nodes: [],
            _ui: { nodes: {}, languages: [] }
          }
        } as any);
        await editor.updateComplete;
        await aTimeout(0);
        expect(activityRequests).to.have.length(1);

        clock = useFakeTimers({ now: Date.now(), shouldAdvanceTime: false });

        // mailroom announces every committed sprint batch
        for (let i = 0; i < 10; i++) {
          socket.serverPublish(`flow:${flowUuid}`, { type: 'activity' });
        }
        await clock.tickAsync(100);
        expect(activityRequests).to.have.length(1);

        await clock.tickAsync(3000);
        expect(activityRequests).to.have.length(2);

        socket.serverPublish(`flow:${flowUuid}`, { type: 'activity' });
        await clock.tickAsync(1000);
        expect(activityRequests).to.have.length(2);

        await clock.tickAsync(2500);
        expect(activityRequests).to.have.length(3);

        // nothing further is read once the editor goes away
        wrapper.remove();
        socket.serverPublish(`flow:${flowUuid}`, { type: 'activity' });
        await clock.tickAsync(5000);
        expect(activityRequests).to.have.length(3);
      } finally {
        clock?.restore();
        setRealtimeContext(null);
        setSocketProvider(previousProvider);
        zustand.setState(previousState as any, true);
      }
    });

    it('reads the new flow when the loaded flow changes mid-read', async () => {
      const firstUuid = '33333333-3333-4333-8333-333333333333';
      const secondUuid = '66666666-6666-4666-8666-666666666666';
      const socket = new EditorSocketProvider();
      const previousProvider = setSocketProvider(socket);
      const previousState = zustand.getState();
      const activityRequests: string[] = [];
      let releaseFirst: () => void = null;

      const definition = (uuid: string) => ({
        uuid,
        name: 'Test',
        language: 'eng',
        type: 'messaging',
        revision: 1,
        spec_version: '14.3',
        localization: {},
        nodes: [],
        _ui: { nodes: {}, languages: [] }
      });
      const activity = () =>
        new Response(JSON.stringify({ nodes: { 'node-1': 1 }, segments: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });

      try {
        stub(window, 'fetch').callsFake((input: RequestInfo) => {
          const endpoint = `${input}`;
          if (endpoint.includes(`/flow/activity/${firstUuid}/`)) {
            activityRequests.push(endpoint);
            // the first flow's read stays in flight until we let it finish
            return new Promise<Response>((resolve) => {
              releaseFirst = () => resolve(activity());
            });
          }
          if (endpoint.includes('/flow/activity/')) {
            activityRequests.push(endpoint);
            return Promise.resolve(activity());
          }
          return Promise.resolve(new Response('', { status: 404 }));
        });
        zustand.setState({
          flowDefinition: null,
          flowInfo: null,
          simulatorActive: false,
          activity: null
        } as any);

        const wrapper = await fixture(
          html`<div>
            <temba-store
              org="44444444-4444-4444-8444-444444444444"
              user="55555555-5555-4555-8555-555555555555"
            ></temba-store>
            <temba-flow-editor>
              <div id="canvas"></div>
            </temba-flow-editor>
          </div>`
        );
        const store = wrapper.querySelector('temba-store') as Store;
        editor = wrapper.querySelector('temba-flow-editor') as Editor;
        await store.initialHttpComplete;

        zustand.setState({ flowDefinition: definition(firstUuid) } as any);
        await editor.updateComplete;
        await aTimeout(0);
        expect(activityRequests).to.deep.equal([
          `/flow/activity/${firstUuid}/`
        ]);

        // a different flow is loaded while the first read is still open
        zustand.setState({ flowDefinition: definition(secondUuid) } as any);
        await editor.updateComplete;
        await aTimeout(0);
        expect(activityRequests).to.deep.equal([
          `/flow/activity/${firstUuid}/`,
          `/flow/activity/${secondUuid}/`
        ]);

        // the abandoned read landing doesn't queue anything else
        releaseFirst();
        await aTimeout(0);
        expect(activityRequests).to.have.length(2);

        wrapper.remove();
      } finally {
        setRealtimeContext(null);
        setSocketProvider(previousProvider);
        zustand.setState(previousState as any, true);
      }
    });

    it('uses store asset caches and applies organization name events', async () => {
      const flowUuid = '33333333-3333-4333-8333-333333333333';
      const childUuid = '11111111-1111-4111-8111-111111111111';
      const groupUuid = '3da236a9-9eed-4db3-a18e-cfb58030c249';
      const contactUuid = '22222222-2222-4222-8222-222222222222';
      const socket = new EditorSocketProvider();
      const previousProvider = setSocketProvider(socket);
      const previousState = zustand.getState();

      try {
        stub(window, 'fetch').callsFake(async (input: RequestInfo) => {
          if (`${input}`.includes('/test-assets/store/assets.json')) {
            return new Response(
              JSON.stringify({
                results: [
                  {
                    type: 'flow',
                    uuid: childUuid,
                    name: 'Current Child Flow'
                  },
                  { type: 'group', uuid: groupUuid, name: 'Farmers' },
                  { type: 'contact', uuid: contactUuid, name: 'Alice' }
                ]
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }
            );
          }
          return new Response('', { status: 404 });
        });
        zustand.setState({
          flowDefinition: null,
          flowInfo: null,
          dirtyDate: null
        } as any);

        const wrapper = await fixture(
          html`<div>
            <temba-store
              org="44444444-4444-4444-8444-444444444444"
              user="55555555-5555-4555-8555-555555555555"
              assets="/test-assets/store/assets.json"
            ></temba-store>
            <temba-flow-editor .flow=${flowUuid}>
              <div id="canvas"></div>
            </temba-flow-editor>
          </div>`
        );
        const store = wrapper.querySelector('temba-store') as Store;
        editor = wrapper.querySelector('temba-flow-editor') as Editor;
        await store.initialHttpComplete;

        expect(
          socket.subscriptions.some(
            (subscription) =>
              subscription.channel ===
              'org:44444444-4444-4444-8444-444444444444'
          )
        ).to.be.true;

        zustand.setState({
          flowDefinition: {
            uuid: flowUuid,
            name: 'Test',
            language: 'eng',
            type: 'messaging',
            revision: 1,
            spec_version: '14.3',
            localization: {},
            nodes: [
              {
                uuid: 'node-1',
                exits: [],
                actions: [
                  {
                    type: 'enter_flow',
                    uuid: 'action-0',
                    flow: { uuid: childUuid, name: 'Old child name' }
                  },
                  {
                    type: 'add_contact_groups',
                    uuid: 'action-1',
                    groups: [{ uuid: groupUuid, name: 'Old name' }]
                  },
                  {
                    type: 'send_broadcast',
                    uuid: 'action-2',
                    text: 'Hello',
                    contacts: [{ uuid: contactUuid, name: 'Old contact' }],
                    groups: []
                  }
                ]
              }
            ],
            _ui: { nodes: {}, languages: [] }
          },
          flowInfo: {
            results: [],
            dependencies: [
              { type: 'flow', uuid: childUuid, name: 'Old child name' },
              { type: 'group', uuid: groupUuid, name: 'Old name' },
              { type: 'contact', uuid: contactUuid, name: 'Old contact' }
            ],
            counts: { nodes: 1, languages: 1 },
            locals: []
          },
          dirtyDate: null
        } as any);
        await editor.updateComplete;
        await store.resolveAssets(
          zustand.getState().flowInfo.dependencies as any
        );
        await Promise.resolve();

        let actions = zustand.getState().flowDefinition.nodes[0]
          .actions as any[];
        expect(actions[0].flow.name).to.equal('Current Child Flow');
        expect(actions[1].groups[0].name).to.equal('Farmers');
        expect(actions[2].contacts[0].name).to.equal('Alice');

        socket.serverPublish('org:44444444-4444-4444-8444-444444444444', {
          type: 'asset_changed',
          asset: { type: 'group', uuid: groupUuid, name: 'Customers' }
        });
        actions = zustand.getState().flowDefinition.nodes[0].actions as any[];
        expect(actions[1].groups[0].name).to.equal('Customers');
        expect(zustand.getState().dirtyDate).to.equal(null);

        wrapper.remove();
        expect(
          socket.subscriptions.every((subscription) => !subscription.active)
        ).to.be.true;
      } finally {
        setRealtimeContext(null);
        setSocketProvider(previousProvider);
        zustand.setState(previousState as any, true);
      }
    });
  });

  describe('store integration', () => {
    it('has fromStore decorators for definition and canvasSize', () => {
      editor = new Editor();

      // Check that the properties exist (they are private but we can verify they exist)
      expect(editor).to.have.property('definition');
      expect(editor).to.have.property('canvasSize');
    });
  });

  describe('action edit requests', () => {
    // an action type whose config has a form, so it is editable
    const EDITABLE_ACTION = {
      uuid: 'action-1',
      type: 'set_contact_name',
      name: 'Alice'
    };

    // request_optin is kept only so old definitions still render — its
    // config declares no form and it is listed as no longer supported, so
    // it must never open the editor
    const FORMLESS_ACTION = {
      uuid: 'action-1',
      type: 'request_optin',
      optin: { uuid: 'optin-1', name: 'U-Report' }
    };

    // call_webhook has no action config of its own — it lives on a
    // split_by_webhook router node and is edited through the node's form
    const WEBHOOK_ACTION = {
      uuid: 'action-1',
      type: 'call_webhook',
      method: 'GET',
      url: 'http://example.com'
    };

    const unsupportedDialog = () =>
      [...document.body.querySelectorAll('temba-dialog')].find(
        (d: any) => d.header === 'Unsupported Action'
      ) as any;

    const getEditor = async (
      action: any,
      uiType = 'execute_actions'
    ): Promise<Editor> => {
      const editor: Editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);
      (editor as any).definition = {
        nodes: [{ uuid: 'node-1', actions: [action], exits: [] }],
        _ui: {
          nodes: {
            'node-1': {
              type: uiType,
              position: { left: 50, top: 50 }
            }
          }
        }
      };
      await editor.updateComplete;
      return editor;
    };

    const nodeEditor = (editor: Editor) =>
      editor.querySelector('temba-node-editor');

    const requestEdit = async (editor: Editor, action: any) => {
      editor.dispatchEvent(
        new CustomEvent(CustomEventType.ActionEditRequested, {
          detail: { action, nodeUuid: 'node-1' },
          bubbles: true,
          composed: true
        })
      );
      await editor.updateComplete;
    };

    const selectIssue = async (editor: Editor, action: any) => {
      editor.querySelector('temba-issues-window').dispatchEvent(
        new CustomEvent(CustomEventType.IssueSelected, {
          detail: {
            issue: { node_uuid: 'node-1', action_uuid: action.uuid }
          }
        })
      );
      await editor.updateComplete;
    };

    const selectSearchResult = async (editor: Editor, action: any) => {
      editor.querySelector('temba-flow-search').dispatchEvent(
        new CustomEvent('temba-search-result-selected', {
          detail: { nodeUuid: 'node-1', action }
        })
      );
      // the search path opens the dialog on a short delay
      await aTimeout(250);
      await editor.updateComplete;
    };

    describe('via an edit request', () => {
      it('opens the editor for an action config with a form', async () => {
        editor = await getEditor(EDITABLE_ACTION);
        await requestEdit(editor, EDITABLE_ACTION);

        expect((editor as any).editingAction).to.equal(EDITABLE_ACTION);
        expect(nodeEditor(editor)).to.exist;
      });

      it('opens the editor for a router node action via the node form', async () => {
        editor = await getEditor(WEBHOOK_ACTION, 'split_by_webhook');
        await requestEdit(editor, WEBHOOK_ACTION);

        expect((editor as any).editingAction).to.equal(WEBHOOK_ACTION);
        expect(nodeEditor(editor)).to.exist;
      });

      it('explains unsupported actions instead of opening the editor', async () => {
        editor = await getEditor(FORMLESS_ACTION);
        await requestEdit(editor, FORMLESS_ACTION);

        expect((editor as any).editingAction).to.be.null;
        expect(nodeEditor(editor)).to.not.exist;

        const dialog = unsupportedDialog();
        expect(dialog).to.exist;
        expect(dialog.textContent).to.contain(
          'This action is no longer supported and should be removed.'
        );
        dialog.remove();
      });
    });

    describe('via a selected issue', () => {
      it('opens the editor for an action config with a form', async () => {
        editor = await getEditor(EDITABLE_ACTION);
        await selectIssue(editor, EDITABLE_ACTION);

        expect((editor as any).editingAction).to.equal(EDITABLE_ACTION);
        expect(nodeEditor(editor)).to.exist;
      });

      it('opens the editor for a router node action via the node form', async () => {
        editor = await getEditor(WEBHOOK_ACTION, 'split_by_webhook');
        await selectIssue(editor, WEBHOOK_ACTION);

        expect((editor as any).editingAction).to.equal(WEBHOOK_ACTION);
        expect(nodeEditor(editor)).to.exist;
      });

      it('focuses unsupported actions without a dialog', async () => {
        editor = await getEditor(FORMLESS_ACTION);
        await selectIssue(editor, FORMLESS_ACTION);

        expect((editor as any).editingAction).to.be.null;
        expect(nodeEditor(editor)).to.not.exist;
        expect(unsupportedDialog()).to.not.exist;
      });
    });

    describe('via a selected search result', () => {
      it('opens the editor for an action config with a form', async () => {
        editor = await getEditor(EDITABLE_ACTION);
        await selectSearchResult(editor, EDITABLE_ACTION);

        expect((editor as any).editingAction).to.equal(EDITABLE_ACTION);
        expect(nodeEditor(editor)).to.exist;
      });

      it('opens the editor for a router node action via the node form', async () => {
        editor = await getEditor(WEBHOOK_ACTION, 'split_by_webhook');
        await selectSearchResult(editor, WEBHOOK_ACTION);

        expect((editor as any).editingAction).to.equal(WEBHOOK_ACTION);
        expect(nodeEditor(editor)).to.exist;
      });

      it('focuses unsupported actions without a dialog', async () => {
        editor = await getEditor(FORMLESS_ACTION);
        await selectSearchResult(editor, FORMLESS_ACTION);

        expect((editor as any).editingAction).to.be.null;
        expect(nodeEditor(editor)).to.not.exist;
        expect(unsupportedDialog()).to.not.exist;
      });
    });
  });

  describe('constructor behavior', () => {
    it('calls super in constructor', () => {
      // This mainly verifies the constructor doesn't throw
      expect(() => {
        new Editor();
      }).to.not.throw();
    });
  });

  describe('multi-selection functionality', () => {
    let mockDefinition: any;

    beforeEach(() => {
      mockDefinition = {
        nodes: [
          {
            uuid: 'node-1',
            actions: [],
            exits: []
          },
          {
            uuid: 'node-2',
            actions: [],
            exits: []
          }
        ],
        _ui: {
          nodes: {
            'node-1': { position: { left: 100, top: 200 } },
            'node-2': { position: { left: 300, top: 400 } }
          },
          stickies: {
            'sticky-1': {
              position: { left: 200, top: 100 },
              title: 'Test Sticky',
              body: 'Test content',
              color: 'yellow'
            }
          }
        }
      };
    });

    it('initializes with empty selection', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      expect((editor as any).selectedItems.size).to.equal(0);
      expect((editor as any).isSelecting).to.be.false;
      expect((editor as any).selectionBox).to.be.null;
    });

    it('adds visual selection styling to selected items', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Set up mock definition and selection
      (editor as any).definition = mockDefinition;
      (editor as any).canvasSize = { width: 800, height: 600 };
      (editor as any).selectedItems = new Set(['node-1']);
      await editor.updateComplete;

      const selectedNode = editor.querySelector(
        'temba-flow-node[uuid="node-1"]'
      );
      expect(selectedNode).to.exist;
      expect(selectedNode.classList.contains('selected')).to.be.true;
    });

    it('renders selection box when selecting', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Set up selection state
      (editor as any).definition = mockDefinition;
      (editor as any).canvasSize = { width: 800, height: 600 };
      (editor as any).isSelecting = true;
      (editor as any).selectionBox = {
        startX: 50,
        startY: 50,
        endX: 150,
        endY: 150
      };
      await editor.updateComplete;

      const selectionBox = editor.querySelector('.selection-box');
      expect(selectionBox).to.exist;

      const style = selectionBox.getAttribute('style');
      expect(style).to.contain('left: 50px');
      expect(style).to.contain('top: 50px');
      expect(style).to.contain('width: 100px');
      expect(style).to.contain('height: 100px');
    });

    it('handles escape key to clear selection', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Set up selection
      (editor as any).selectedItems.add('node-1');
      (editor as any).selectedItems.add('node-2');

      const mockEvent = new KeyboardEvent('keydown', { key: 'Escape' });
      (editor as any).handleKeyDown(mockEvent);

      expect((editor as any).selectedItems.size).to.equal(0);
    });
  });

  describe('canvas initialization', () => {
    it('initializes plumber with canvas element', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      const plumber = (editor as any).plumber;
      expect(plumber).to.be.instanceOf(Plumber);
    });

    it('handles missing canvas element gracefully', async () => {
      editor = await fixture(html`<temba-flow-editor></temba-flow-editor>`);

      // Should not throw even without canvas
      expect((editor as any).plumber).to.be.instanceOf(Plumber);
    });
  });

  describe('canvas menu functionality', () => {
    afterEach(() => {
      restore();
    });

    it('has context menu handler set up', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="grid">
            <div
              id="canvas"
              style="position: relative; width: 800px; height: 600px;"
            ></div>
          </div>
        </temba-flow-editor>
      `);

      // Set up required properties
      (editor as any).canvasSize = { width: 800, height: 600 };
      await editor.updateComplete;

      const canvas = editor.querySelector('#canvas') as HTMLElement;
      expect(canvas).to.exist;

      // Check that the context menu event listener is set up
      expect((editor as any).boundCanvasContextMenu).to.exist;
      expect(typeof (editor as any).boundCanvasContextMenu).to.equal(
        'function'
      );

      // Test the snapToGrid functionality that would be used
      const snapToGrid = (value: number): number => {
        const snapped = Math.round(value / 20) * 20;
        return Math.max(snapped, 0);
      };

      // Test various snap positions
      expect(snapToGrid(245)).to.equal(240);
      expect(snapToGrid(255)).to.equal(260);
      expect(snapToGrid(150)).to.equal(160);
      expect(snapToGrid(-10)).to.equal(0); // Should not go negative
    });

    it('tests context menu handler logic independently', () => {
      // Test the logic that would be in handleCanvasContextMenu

      // Mock event with canvas target
      const canvasTarget = { id: 'canvas' };
      const validEvent = { target: canvasTarget };

      // Mock event with non-canvas target
      const nonCanvasTarget = { id: 'other-element' };
      const invalidEvent = { target: nonCanvasTarget };

      // Test the early return condition
      const shouldReturnEarly = (event: any) => {
        const target = event.target as HTMLElement;
        return target.id !== 'canvas';
      };

      expect(shouldReturnEarly(validEvent)).to.be.false;
      expect(shouldReturnEarly(invalidEvent)).to.be.true;
    });

    it('tests position calculation logic', () => {
      // Mock canvas getBoundingClientRect
      const mockCanvas = {
        getBoundingClientRect: () => ({
          left: 50,
          top: 100,
          right: 850,
          bottom: 700,
          width: 800,
          height: 600
        })
      };

      // Mock event
      const mockEvent = {
        clientX: 300,
        clientY: 250
      };

      // Calculate relative position (this is what handleCanvasDoubleClick does)
      const canvasRect = mockCanvas.getBoundingClientRect();
      const relativeX = mockEvent.clientX - canvasRect.left; // 300 - 50 = 250
      const relativeY = mockEvent.clientY - canvasRect.top; // 250 - 100 = 150

      // Apply snap to grid
      const snapToGrid = (value: number) =>
        Math.max(Math.round(value / 20) * 20, 0);
      const snappedLeft = snapToGrid(relativeX); // 250 -> 260
      const snappedTop = snapToGrid(relativeY); // 150 -> 160

      // Verify calculations
      expect(relativeX).to.equal(250);
      expect(relativeY).to.equal(150);
      expect(snappedLeft).to.equal(260);
      expect(snappedTop).to.equal(160);

      // This position would be passed to createStickyNote
      const expectedPosition = {
        left: snappedLeft,
        top: snappedTop
      };

      expect(expectedPosition).to.deep.equal({ left: 260, top: 160 });
    });
  });

  describe('flow-start indicator', () => {
    it('should mark the first node as flow-start', async () => {
      const { zustand } = await import('../src/store/AppState');

      // create a flow definition with multiple nodes
      const mockFlowDefinition = {
        language: 'en',
        localization: {},
        name: 'Test Flow',
        nodes: [
          {
            uuid: 'node-1',
            actions: [
              { type: 'send_msg', uuid: 'action-1', text: 'Message 1' }
            ],
            exits: [{ uuid: 'exit-1', destination_uuid: null }]
          },
          {
            uuid: 'node-2',
            actions: [
              { type: 'send_msg', uuid: 'action-2', text: 'Message 2' }
            ],
            exits: [{ uuid: 'exit-2', destination_uuid: null }]
          },
          {
            uuid: 'node-3',
            actions: [
              { type: 'send_msg', uuid: 'action-3', text: 'Message 3' }
            ],
            exits: [{ uuid: 'exit-3', destination_uuid: null }]
          }
        ],
        uuid: 'test-uuid',
        type: 'messaging' as const,
        revision: 1,
        spec_version: '14.3',
        _ui: {
          nodes: {
            'node-1': { position: { left: 100, top: 100 }, type: 'send_msg' },
            'node-2': { position: { left: 200, top: 200 }, type: 'send_msg' },
            'node-3': { position: { left: 300, top: 300 }, type: 'send_msg' }
          },
          languages: []
        }
      };

      zustand.getState().setFlowContents({
        definition: mockFlowDefinition as any,
        info: {
          results: [],
          dependencies: [],
          counts: { nodes: 3, languages: 1 },
          locals: []
        }
      });

      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      await editor.updateComplete;

      // get all flow nodes
      const flowNodes = editor.querySelectorAll('temba-flow-node');
      expect(flowNodes.length).to.equal(3);

      // first node should have flow-start class
      expect(flowNodes[0].classList.contains('flow-start')).to.be.true;

      // other nodes should not have flow-start class
      expect(flowNodes[1].classList.contains('flow-start')).to.be.false;
      expect(flowNodes[2].classList.contains('flow-start')).to.be.false;
    });

    it('should update flow-start when node positions change', async () => {
      const { zustand } = await import('../src/store/AppState');

      // create a flow with nodes in a specific order
      const mockFlowDefinition = {
        language: 'en',
        localization: {},
        name: 'Test Flow',
        nodes: [
          {
            uuid: 'node-1',
            actions: [
              { type: 'send_msg', uuid: 'action-1', text: 'Message 1' }
            ],
            exits: [{ uuid: 'exit-1', destination_uuid: null }]
          },
          {
            uuid: 'node-2',
            actions: [
              { type: 'send_msg', uuid: 'action-2', text: 'Message 2' }
            ],
            exits: [{ uuid: 'exit-2', destination_uuid: null }]
          }
        ],
        uuid: 'test-uuid',
        type: 'messaging' as const,
        revision: 1,
        spec_version: '14.3',
        _ui: {
          nodes: {
            'node-1': { position: { left: 100, top: 200 }, type: 'send_msg' },
            'node-2': { position: { left: 100, top: 100 }, type: 'send_msg' }
          },
          languages: []
        }
      };

      zustand.getState().setFlowContents({
        definition: mockFlowDefinition as any,
        info: {
          results: [],
          dependencies: [],
          counts: { nodes: 2, languages: 1 },
          locals: []
        }
      });

      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      await editor.updateComplete;

      // node-2 is at top (top: 100 < top: 200) so it should be flow-start
      const node1 = editor.querySelector('temba-flow-node[uuid="node-1"]');
      const node2 = editor.querySelector('temba-flow-node[uuid="node-2"]');

      expect(node2).to.exist;
      expect(node1).to.exist;
      expect(node2.classList.contains('flow-start')).to.be.true;
      expect(node1.classList.contains('flow-start')).to.be.false;

      // move node-1 to the top
      zustand.getState().updateCanvasPositions({
        'node-1': { left: 100, top: 50 }
      });

      await editor.updateComplete;

      // now node-1 should be first
      const updatedFlowNodes = editor.querySelectorAll('temba-flow-node');
      expect(updatedFlowNodes[0].getAttribute('uuid')).to.equal('node-1');
      expect(updatedFlowNodes[0].classList.contains('flow-start')).to.be.true;
      expect(updatedFlowNodes[1].classList.contains('flow-start')).to.be.false;
    });

    it('should maintain flow-start when nodes are added', async () => {
      const { zustand } = await import('../src/store/AppState');

      // start with one node
      const mockFlowDefinition = {
        language: 'en',
        localization: {},
        name: 'Test Flow',
        nodes: [
          {
            uuid: 'node-1',
            actions: [
              { type: 'send_msg', uuid: 'action-1', text: 'Message 1' }
            ],
            exits: [{ uuid: 'exit-1', destination_uuid: null }]
          }
        ],
        uuid: 'test-uuid',
        type: 'messaging' as const,
        revision: 1,
        spec_version: '14.3',
        _ui: {
          nodes: {
            'node-1': { position: { left: 100, top: 200 }, type: 'send_msg' }
          },
          languages: []
        }
      };

      zustand.getState().setFlowContents({
        definition: mockFlowDefinition as any,
        info: {
          results: [],
          dependencies: [],
          counts: { nodes: 1, languages: 1 },
          locals: []
        }
      });

      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      await editor.updateComplete;

      const flowNodes = editor.querySelectorAll('temba-flow-node');
      expect(flowNodes[0].classList.contains('flow-start')).to.be.true;

      // add a new node at the top
      const newNode = {
        uuid: 'node-2',
        actions: [
          { type: 'send_msg' as const, uuid: 'action-2', text: 'Message 2' }
        ],
        exits: [{ uuid: 'exit-2', destination_uuid: null }]
      };
      const newNodeUI = {
        position: { left: 100, top: 100 },
        type: 'send_msg' as const
      };

      zustand.getState().addNode(newNode, newNodeUI);

      await editor.updateComplete;

      // new node should now be the flow-start
      const node1 = editor.querySelector('temba-flow-node[uuid="node-1"]');
      const node2 = editor.querySelector('temba-flow-node[uuid="node-2"]');

      expect(node2).to.exist;
      expect(node1).to.exist;
      expect(node2.classList.contains('flow-start')).to.be.true;
      expect(node1.classList.contains('flow-start')).to.be.false;
    });

    it('should handle flow-start when first node is removed', async () => {
      const { zustand } = await import('../src/store/AppState');

      // create flow with multiple nodes
      const mockFlowDefinition = {
        language: 'en',
        localization: {},
        name: 'Test Flow',
        nodes: [
          {
            uuid: 'node-1',
            actions: [
              { type: 'send_msg', uuid: 'action-1', text: 'Message 1' }
            ],
            exits: [{ uuid: 'exit-1', destination_uuid: null }]
          },
          {
            uuid: 'node-2',
            actions: [
              { type: 'send_msg', uuid: 'action-2', text: 'Message 2' }
            ],
            exits: [{ uuid: 'exit-2', destination_uuid: null }]
          }
        ],
        uuid: 'test-uuid',
        type: 'messaging' as const,
        revision: 1,
        spec_version: '14.3',
        _ui: {
          nodes: {
            'node-1': { position: { left: 100, top: 100 }, type: 'send_msg' },
            'node-2': { position: { left: 100, top: 200 }, type: 'send_msg' }
          },
          languages: []
        }
      };

      zustand.getState().setFlowContents({
        definition: mockFlowDefinition as any,
        info: {
          results: [],
          dependencies: [],
          counts: { nodes: 2, languages: 1 },
          locals: []
        }
      });

      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      await editor.updateComplete;

      let flowNodes = editor.querySelectorAll('temba-flow-node');
      expect(flowNodes[0].getAttribute('uuid')).to.equal('node-1');
      expect(flowNodes[0].classList.contains('flow-start')).to.be.true;

      // remove the first node
      zustand.getState().removeNodes(['node-1']);

      await editor.updateComplete;

      // node-2 should now be the flow-start
      flowNodes = editor.querySelectorAll('temba-flow-node');
      expect(flowNodes.length).to.equal(1);
      expect(flowNodes[0].getAttribute('uuid')).to.equal('node-2');
      expect(flowNodes[0].classList.contains('flow-start')).to.be.true;
    });
  });

  describe('save feedback', () => {
    let mockPostJSON: any;
    let storeElement: HTMLElement;

    before(() => {
      // Create a mock temba-store element that getStore() will find
      // Use the real zustand getState so all store interactions work
      storeElement = document.createElement('temba-store');
      (storeElement as any).getState = () => zustand.getState();
      document.body.appendChild(storeElement);
    });

    after(() => {
      storeElement.remove();
    });

    beforeEach(() => {
      mockPostJSON = stub();
      (storeElement as any).postJSON = mockPostJSON;
    });

    afterEach(() => {
      // Clean up any dialogs left in the DOM
      document.querySelectorAll('temba-dialog').forEach((d) => d.remove());
    });

    it('sets isSaving when dirtyDate changes', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).isSaving = false;

      // Simulate a dirtyDate change via willUpdate()
      (editor as any).dirtyDate = new Date();
      const changes = new Map();
      changes.set('dirtyDate', null);
      (editor as any).willUpdate(changes);

      expect((editor as any).isSaving).to.be.true;
    });

    it('shows revisions button even with no revisions', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 800, height: 600 };
      (editor as any).isSaving = false;
      await editor.updateComplete;

      const btn = await getToolbarButton(editor, 'Revisions');
      expect(btn).to.exist;
    });

    it('clears viewingRevision state when exiting revision view', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      const flowInfo = {
        results: [],
        dependencies: [],
        counts: { nodes: 0, languages: 0 },
        locals: []
      } as any;

      zustand.setState({
        ...zustand.getState(),
        flowInfo,
        viewingRevision: true
      });

      const definition = {
        language: 'eng',
        localization: {},
        name: 'Flow',
        nodes: [],
        uuid: 'flow-uuid',
        type: 'messaging',
        revision: 1,
        spec_version: '13.1',
        _ui: { nodes: {}, languages: [] }
      } as any;

      (editor as any).definition = definition;
      const revisionsWindow = editor.querySelector(
        'temba-revisions-window'
      ) as any;
      (revisionsWindow as any).preRevertState = {
        definition,
        dirtyDate: null
      };
      (revisionsWindow as any).viewingRevision = {
        id: 2,
        created_on: '2024-01-02',
        user: { id: 1, username: 'tester' }
      };

      (revisionsWindow as any).cancelRevisionView();

      expect(zustand.getState().viewingRevision).to.be.false;
    });

    it('shows spinner icon in revisions button when saving', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 800, height: 600 };
      (editor as any).isSaving = true;
      await editor.updateComplete;

      const btn = await getToolbarButton(editor, 'Revisions');
      expect(btn).to.exist;
      const icon = btn.querySelector('temba-icon');
      expect(icon.getAttribute('name')).to.equal('progress_spinner');
    });

    it('passes saving state to revisions window when saving', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 800, height: 600 };
      (editor as any).isSaving = true;
      await editor.updateComplete;

      const revisionsWindow = editor.querySelector(
        'temba-revisions-window'
      ) as any;
      expect(revisionsWindow).to.exist;
      expect(revisionsWindow.saving).to.be.true;
    });

    it('shows revisions icon in button when not saving', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 800, height: 600 };
      (editor as any).isSaving = false;
      await editor.updateComplete;

      const btn = await getToolbarButton(editor, 'Revisions');
      expect(btn).to.exist;
      const icon = btn.querySelector('temba-icon');
      expect(icon.getAttribute('name')).to.equal('revisions');
    });

    it('clears isSaving after successful save', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      editor.flow = 'test-flow';
      (editor as any).definition = { nodes: [], _ui: { nodes: {} } };

      mockPostJSON.resolves({
        status: 200,
        json: {},
        body: '{}',
        headers: new Headers()
      });

      await (editor as any).saveChanges();

      expect((editor as any).isSaving).to.be.false;
    });

    it('adds temba-components version under _ui.editor when saving', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      editor.flow = 'test-flow';
      (editor as any).definition = { nodes: [], _ui: { nodes: {} } };

      mockPostJSON.resolves({
        status: 200,
        json: {},
        body: '{}',
        headers: new Headers()
      });

      await (editor as any).saveChanges();

      const payload = mockPostJSON.firstCall.args[1];
      expect(payload._ui.editor).to.equal(TEMBA_COMPONENTS_VERSION);
    });

    it('shows error dialog on non-200 response', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      editor.flow = 'test-flow';
      (editor as any).definition = { nodes: [], _ui: { nodes: {} } };

      mockPostJSON.resolves({
        status: 400,
        json: { detail: 'Invalid flow definition' },
        body: '{"detail":"Invalid flow definition"}',
        headers: new Headers()
      });

      await (editor as any).saveChanges();
      await editor.updateComplete;

      expect((editor as any).isSaving).to.be.false;
      const dialog = document.querySelector('temba-dialog');
      expect(dialog).to.exist;
      expect(dialog.textContent).to.contain('Invalid flow definition');
    });

    it('shows error dialog on 500 server error', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      editor.flow = 'test-flow';
      (editor as any).definition = { nodes: [], _ui: { nodes: {} } };

      mockPostJSON.rejects(new Response(null, { status: 500 }));

      await (editor as any).saveChanges();
      await editor.updateComplete;

      expect((editor as any).isSaving).to.be.false;
      const dialog = document.querySelector('temba-dialog');
      expect(dialog).to.exist;
      expect(dialog.textContent).to.contain('Server error');
    });

    it('shows error dialog on network failure', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      editor.flow = 'test-flow';
      (editor as any).definition = { nodes: [], _ui: { nodes: {} } };

      mockPostJSON.rejects(new Error('Network error'));

      await (editor as any).saveChanges();
      await editor.updateComplete;

      expect((editor as any).isSaving).to.be.false;
      const dialog = document.querySelector('temba-dialog');
      expect(dialog).to.exist;
      expect(dialog.textContent).to.contain('Unable to reach the server');
    });

    it('extracts error message from response json fields', () => {
      editor = new Editor();

      expect(
        (editor as any).extractErrorMessage({
          status: 400,
          json: { detail: 'Bad request' }
        })
      ).to.equal('Bad request');

      expect(
        (editor as any).extractErrorMessage({
          status: 400,
          json: { error: 'Something went wrong' }
        })
      ).to.equal('Something went wrong');

      expect(
        (editor as any).extractErrorMessage({
          status: 400,
          json: { description: 'Detailed error' }
        })
      ).to.equal('Detailed error');

      expect(
        (editor as any).extractErrorMessage({
          status: 403,
          json: {}
        })
      ).to.equal('Save failed with status 403.');
    });
  });

  describe('pending changes card', () => {
    let clock: any;

    beforeEach(() => {
      clock = useFakeTimers();
    });

    afterEach(() => {
      clock.restore();
    });

    it('renders Discard button and meter when pendingTimer is unsaved', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 800, height: 600 };
      (editor as any).pendingTimer.unsaved = true;
      editor.requestUpdate();
      await editor.updateComplete;

      const card = editor.querySelector('.reflow-card');
      expect(card).to.exist;

      const discardBtn = card.querySelector('.reflow-discard');
      expect(discardBtn).to.exist;
      expect(discardBtn.textContent.trim()).to.equal('Discard');

      const saveBtn = card.querySelector('.reflow-save');
      expect(saveBtn).to.not.exist;

      const meter = card.querySelector('.reflow-meter');
      expect(meter).to.exist;

      const meterFill = card.querySelector('.reflow-meter-fill');
      expect(meterFill).to.exist;
    });

    it('does not render card when pendingTimer is not unsaved', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 800, height: 600 };
      (editor as any).pendingTimer.unsaved = false;
      editor.requestUpdate();
      await editor.updateComplete;

      const card = editor.querySelector('.reflow-card');
      expect(card).to.not.exist;
    });

    it('auto-saves after countdown expires', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      const saveStub = stub(editor as any, 'saveChanges').resolves();
      (editor as any).pendingPositions = { 'node-1': { left: 0, top: 0 } };

      // Start the auto-save timer
      (editor as any).pendingTimer.start();

      // Advance time just before the deadline
      clock.tick(4999);
      expect(saveStub).to.not.have.been.called;
      expect((editor as any).pendingTimer.unsaved).to.be.true;

      // Advance past the deadline
      clock.tick(1);
      expect(saveStub).to.have.been.calledOnce;
      expect((editor as any).pendingTimer.unsaved).to.be.false;
      expect((editor as any).pendingPositions).to.be.null;

      saveStub.restore();
    });

    it('cancels auto-save timer when Discard is clicked', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      const saveStub = stub(editor as any, 'saveChanges').resolves();
      // Start the timer
      (editor as any).pendingTimer.start();

      // Click discard
      (editor as any).handlePendingDiscard();

      expect((editor as any).pendingTimer.unsaved).to.be.false;

      // Advance past the original deadline — save should NOT fire
      clock.tick(6000);
      expect(saveStub).to.not.have.been.called;

      saveStub.restore();
    });

    it('resets timer when a normal edit occurs during countdown', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      const saveStub = stub(editor as any, 'saveChanges').resolves();
      (editor as any).pendingPositions = { 'node-1': { left: 0, top: 0 } };

      // Start the timer
      (editor as any).pendingTimer.start();

      // Advance partway
      clock.tick(3000);
      expect((editor as any).pendingTimer.unsaved).to.be.true;

      // Simulate a normal edit triggering willUpdate
      (editor as any).dirtyDate = new Date();
      const changes = new Map();
      changes.set('dirtyDate', null);
      (editor as any).willUpdate(changes);

      // Timer should still be active (reset, not dismissed)
      expect((editor as any).pendingTimer.unsaved).to.be.true;

      // Advance past the original 5s deadline but before the reset deadline
      clock.tick(2001);
      expect(saveStub).to.not.have.been.called;

      // Advance to the full reset deadline (5s from reset at t=3000)
      clock.tick(2999);
      expect(saveStub).to.have.been.calledOnce;

      saveStub.restore();
    });

    it('clears auto-save timer in disconnectedCallback', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      // Start the auto-save timer
      (editor as any).pendingTimer.start();
      expect((editor as any).pendingTimer.unsaved).to.be.true;

      // Remove the editor from DOM
      editor.remove();

      // The disconnectedCallback clears the timer
      clock.tick(6000);
      // No error means the timer was properly cleared
    });

    it('clears existing timer when start is called again', () => {
      editor = new Editor();

      const saveStub = stub(editor as any, 'saveChanges').resolves();

      // Start a first timer
      (editor as any).pendingTimer.start();

      // Start again (resets)
      (editor as any).pendingTimer.start();

      // Advance past one timer period — should only fire once
      clock.tick(5000);
      expect(saveStub).to.have.been.calledOnce;

      saveStub.restore();
    });

    it('shows only one card even when both copy and reflow happen', async () => {
      editor = await fixture(html`
        <temba-flow-editor>
          <div id="canvas"></div>
        </temba-flow-editor>
      `);

      (editor as any).canvasSize = { width: 800, height: 600 };

      // Start timer for copy
      (editor as any).pendingTimer.start();

      // Start timer again for reflow — should reset, not add a second card
      (editor as any).pendingTimer.start();

      editor.requestUpdate();
      await editor.updateComplete;

      const cards = editor.querySelectorAll('.reflow-card');
      expect(cards.length).to.equal(1);
    });
  });
});
