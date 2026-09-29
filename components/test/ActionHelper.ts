import { fixture, expect } from '@open-wc/testing';
import { html } from 'lit';
import { Action, Node } from '../src/store/flow-definition';
import { assertScreenshot, getClip } from './utils.test';
import { Editor } from '../src/flow/Editor';
import '../temba-modules';

/**
 * Generic action test framework
 * Tests the complete action lifecycle: render → edit → save → validate
 *
 * For node configuration testing, see NodeHelper.ts
 */
export class ActionTest<T extends Action> {
  constructor(
    private actionConfig: any,
    private actionName: string
  ) {}

  /**
   * Renders an action in the flow editor and returns the flow node
   */
  private async renderAction(action: T): Promise<HTMLElement> {
    const node: Node = {
      uuid: 'test-node',
      actions: [action],
      exits: []
    };

    const mockDefinition = {
      nodes: [node],
      _ui: {
        nodes: {
          [node.uuid]: {
            type: 'execute_actions',
            position: { left: 50, top: 50 }
          }
        }
      }
    };

    const editor = (await fixture(html`
      <temba-flow-editor>
        <div id="canvas"></div>
      </temba-flow-editor>
    `)) as Editor;

    (editor as any).definition = mockDefinition;
    (editor as any).canvasSize = { width: 400, height: 300 };
    await editor.updateComplete;

    const flowNode = editor.querySelector('temba-flow-node') as HTMLElement;
    expect(flowNode).to.exist;

    return flowNode;
  }

  /**
   * Opens the node editor for an action and returns the editor element
   */
  private async openNodeEditor(action: T): Promise<HTMLElement> {
    const nodeEditor = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as HTMLElement;

    await (nodeEditor as any).updateComplete;
    expect(nodeEditor).to.exist;

    return nodeEditor;
  }

  /**
   * Takes a screenshot of the dialog container within a node editor
   */
  private async assertDialogScreenshot(
    el: HTMLElement,
    screenshotName: string,
    waitForNetwork: boolean = false
  ) {
    const dialog = el.shadowRoot
      .querySelector('temba-dialog')
      .shadowRoot.querySelector('.dialog-container') as HTMLElement;
    await assertScreenshot(screenshotName, getClip(dialog), waitForNetwork);
  }

  /**
   * Complete test for an action configuration
   * 1. Renders the action in a flow node (with screenshot)
   * 2. Opens the node editor (with screenshot)
   * 3. Simulates save and validates round-trip conversion
   * @param waitForNetwork - If true, waits longer for network idle (useful for slow loading resources)
   */
  async testAction(
    action: T,
    testName: string,
    waitForNetwork: boolean = false
  ) {
    it(`${testName}`, async () => {
      // Step 1: Render action in flow node
      const flowNode = await this.renderAction(action);
      expect(flowNode.querySelector('.body')).to.exist;
      await assertScreenshot(
        `actions/${this.actionName}/render/${testName}`,
        getClip(flowNode),
        waitForNetwork
      );

      // Step 2: Open node editor
      const nodeEditor = await this.openNodeEditor(action);
      await this.assertDialogScreenshot(
        nodeEditor,
        `actions/${this.actionName}/editor/${testName}`,
        waitForNetwork
      );

      // Step 3: Test round-trip conversion (simulates save workflow)
      if (this.actionConfig.toFormData && this.actionConfig.fromFormData) {
        const formData = this.actionConfig.toFormData(action);
        const convertedAction = this.actionConfig.fromFormData(formData) as T;

        // Validate the round trip worked
        expect(convertedAction.uuid).to.equal(action.uuid);
        expect(convertedAction.type).to.equal(action.type);

        // Validate the form data
        if (this.actionConfig.validate) {
          const validation = this.actionConfig.validate(formData);
          expect(validation.valid).to.be.true;
        }
      }
    });
  }

  /**
   * Renders the action in a flow node and screenshots it, without opening the
   * editor - for canvas-only rendering such as attachments, whose editor
   * previews load remote media
   */
  async testRender(action: T, testName: string) {
    it(`${testName}`, async () => {
      const flowNode = await this.renderAction(action);
      await assertScreenshot(
        `actions/${this.actionName}/render/${testName}`,
        getClip(flowNode)
      );
    });
  }

  /**
   * Run basic property tests
   */
  testBasicProperties() {
    it('has correct basic properties', () => {
      expect(this.actionConfig.name).to.be.a('string');
      expect(this.actionConfig.group).to.exist;

      // toFormData and fromFormData are optional - only needed for complex data transformations
      if (this.actionConfig.toFormData) {
        expect(this.actionConfig.toFormData).to.be.a('function');
      }
      if (this.actionConfig.fromFormData) {
        expect(this.actionConfig.fromFormData).to.be.a('function');
      }

      if (this.actionConfig.validate) {
        expect(this.actionConfig.validate).to.be.a('function');
      }
    });
  }
}
