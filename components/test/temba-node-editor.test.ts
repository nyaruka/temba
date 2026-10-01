import '../temba-modules';
import { html, fixture, expect } from '@open-wc/testing';
import * as sinon from 'sinon';
import { assertScreenshot, getClip } from './utils.test';
import { Dialog } from '../src/layout/Dialog';
import { zustand } from '../src/store/AppState';

// Define interface for NodeEditor component
interface NodeEditorElement extends HTMLElement {
  action?: any;
  node?: any;
  nodeUI?: any;
  isOpen?: boolean;
  updateComplete: Promise<boolean>;
}

const assertDialogScreenshot = async (
  el: NodeEditorElement,
  screenshotName: string
) => {
  const dialog = el.shadowRoot
    .querySelector('temba-dialog')
    .shadowRoot.querySelector('.dialog-container') as HTMLElement;
  const clip = getClip(dialog);
  // Adjust width to show full dialog with proper padding
  const dialogRect = dialog.getBoundingClientRect();
  // Use scrollWidth to get the actual content width (including overflow)
  const contentWidth = Math.max(dialogRect.width, dialog.scrollWidth);
  clip.width = contentWidth + 20; // 10px padding on each side
  await assertScreenshot(screenshotName, clip);
};

describe('temba-node-editor', () => {
  it('can be created', async () => {
    const el = (await fixture(html`
      <temba-node-editor .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    expect(el).to.exist;
    expect(el.tagName).to.equal('TEMBA-NODE-EDITOR');
  });

  it('renders send_msg action', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'send_msg',
      text: 'Hello world',
      quick_replies: []
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.action).to.equal(action);
  });

  it('renders send_msg action with message editor', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'send_msg',
      text: 'Hello @contact.name, check this out!',
      attachments: [
        'image/jpeg:http://example.com/photo.jpg',
        'image:@fields.profile_pic'
      ],
      quick_replies: ['Yes', 'No']
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.action).to.equal(action);

    // Check that the message editor component is rendered
    const messageEditor = el.shadowRoot.querySelector(
      'temba-message-editor'
    ) as any;
    expect(messageEditor).to.not.be.null;
    expect(messageEditor.value).to.equal(action.text);
  });

  it('renders set_run_result action', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'set_run_result',
      name: 'result_name',
      value: 'result_value'
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.action).to.equal(action);
  });

  it('renders set_contact_field action', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'set_contact_field',
      field: { key: 'age', name: 'Age' },
      value: '25'
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.action).to.equal(action);
  });

  it('renders add_contact_groups action', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'add_contact_groups',
      groups: [{ uuid: 'group-1', name: 'Test Group' }]
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.action).to.equal(action);
  });

  it('renders enter_flow action', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'enter_flow',
      flow: { uuid: 'flow-1', name: 'Sub Flow' }
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.action).to.equal(action);
  });

  it('renders node with router configuration', async () => {
    const node = {
      uuid: 'test-node-uuid',
      actions: [],
      exits: [{ uuid: 'exit-1', name: 'Default' }],
      router: {
        type: 'switch',
        result_name: 'result',
        categories: [{ uuid: 'cat-1', name: 'Category 1', exit_uuid: 'exit-1' }]
      }
    };

    const nodeUI = {
      type: 'split_by_expression',
      position: { left: 100, top: 100 }
    };

    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.node).to.equal(node);
    expect(el.nodeUI).to.equal(nodeUI);

    await assertDialogScreenshot(el, 'editor/router');
  });

  it('renders node with wait configuration', async () => {
    const node = {
      uuid: 'test-node-uuid',
      actions: [],
      exits: [{ uuid: 'exit-1', name: 'Default' }],
      wait: {
        type: 'msg'
      }
    };

    const nodeUI = {
      type: 'wait_for_response',
      position: { left: 100, top: 100 }
    };

    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.node).to.equal(node);
    expect(el.nodeUI).to.equal(nodeUI);

    await assertDialogScreenshot(el, 'editor/wait');
  });

  it('handles different button actions', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'send_msg',
      text: 'Hello world',
      quick_replies: []
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    let saveEventFired = false;
    let cancelEventFired = false;

    el.addEventListener('temba-action-saved', () => {
      saveEventFired = true;
    });

    el.addEventListener('temba-node-edit-cancelled', () => {
      cancelEventFired = true;
    });

    // Get the dialog element inside the node editor
    const dialog = el.shadowRoot!.querySelector('temba-dialog');
    expect(dialog).to.not.be.null;

    // Test Save button by dispatching event on the dialog
    const saveEvent = new CustomEvent('temba-button-clicked', {
      detail: {
        button: { name: 'Save' },
        detail: { name: 'Save', type: 'primary' }
      },
      bubbles: true
    });
    dialog!.dispatchEvent(saveEvent);
    expect(saveEventFired).to.equal(true);

    // Reset for cancel test
    saveEventFired = false;

    // Test Cancel button
    const cancelEvent = new CustomEvent('temba-button-clicked', {
      detail: {
        button: { name: 'Cancel' },
        detail: { name: 'Cancel', type: 'secondary', closes: true }
      },
      bubbles: true
    });
    dialog!.dispatchEvent(cancelEvent);
    expect(cancelEventFired).to.equal(true);
  });

  it('saves rule arguments updated via keyboard completion', async () => {
    const node = {
      uuid: 'test-node-uuid',
      actions: [],
      router: {
        type: 'switch',
        operand: '@input.text',
        cases: [
          {
            uuid: 'case-1',
            type: 'has_phrase',
            arguments: ['@con'],
            category_uuid: 'cat-1'
          }
        ],
        categories: [
          { uuid: 'cat-1', name: 'Matched', exit_uuid: 'exit-1' },
          { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
        ],
        default_category_uuid: 'cat-other'
      },
      exits: [
        { uuid: 'exit-1', destination_uuid: null },
        { uuid: 'exit-other', destination_uuid: null }
      ]
    };

    const nodeUI = {
      type: 'split_by_expression',
      position: { left: 100, top: 100 }
    };

    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;

    const rulesEditor = el.shadowRoot?.querySelector(
      'temba-array-editor[name="rules"]'
    ) as any;
    const valueEditor = rulesEditor.shadowRoot?.querySelector(
      'temba-rich-edit[name="value1"]'
    ) as any;
    const editableDiv = valueEditor.shadowRoot?.querySelector(
      '.highlight-editor'
    ) as any;

    valueEditor.query = 'con';
    valueEditor.options = [{ name: 'contact.name' }];
    await valueEditor.updateComplete;

    editableDiv.focus();
    editableDiv.setSelectionRange(4, 4);

    editableDiv.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        composed: true
      })
    );

    let savedNode: any = null;
    el.addEventListener('temba-node-saved', (e: any) => {
      savedNode = e.detail.node;
    });

    const dialog = el.shadowRoot!.querySelector('temba-dialog');
    dialog!.dispatchEvent(
      new CustomEvent('temba-button-clicked', {
        detail: {
          button: { name: 'Save' },
          detail: { name: 'Save', type: 'primary' }
        },
        bubbles: true
      })
    );

    const savedCase = savedNode.router.cases.find(
      (case_: any) => case_.type === 'has_phrase'
    );
    expect(savedCase.arguments[0]).to.equal('@contact.name');
  });

  it('saves rule arguments updated via enter completion', async () => {
    const node = {
      uuid: 'test-node-uuid',
      actions: [],
      router: {
        type: 'switch',
        operand: '@input.text',
        cases: [
          {
            uuid: 'case-1',
            type: 'has_phrase',
            arguments: ['@con'],
            category_uuid: 'cat-1'
          }
        ],
        categories: [
          { uuid: 'cat-1', name: 'Matched', exit_uuid: 'exit-1' },
          { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
        ],
        default_category_uuid: 'cat-other'
      },
      exits: [
        { uuid: 'exit-1', destination_uuid: null },
        { uuid: 'exit-other', destination_uuid: null }
      ]
    };

    const nodeUI = {
      type: 'split_by_expression',
      position: { left: 100, top: 100 }
    };

    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await el.updateComplete;

    const rulesEditor = el.shadowRoot?.querySelector(
      'temba-array-editor[name="rules"]'
    ) as any;
    const valueEditor = rulesEditor.shadowRoot?.querySelector(
      'temba-rich-edit[name="value1"]'
    ) as any;
    const editableDiv = valueEditor.shadowRoot?.querySelector(
      '.highlight-editor'
    ) as any;

    valueEditor.query = 'con';
    valueEditor.options = [{ name: 'contact.name' }];
    await valueEditor.updateComplete;

    editableDiv.focus();
    editableDiv.setSelectionRange(4, 4);

    editableDiv.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        composed: true
      })
    );

    let savedNode: any = null;
    el.addEventListener('temba-node-saved', (e: any) => {
      savedNode = e.detail.node;
    });

    const dialog = el.shadowRoot!.querySelector('temba-dialog');
    dialog!.dispatchEvent(
      new CustomEvent('temba-button-clicked', {
        detail: {
          button: { name: 'Save' },
          detail: { name: 'Save', type: 'primary' }
        },
        bubbles: true
      })
    );

    const savedCase = savedNode.router.cases.find(
      (case_: any) => case_.type === 'has_phrase'
    );
    expect(savedCase.arguments[0]).to.equal('@contact.name');
  });

  it('handles property updates', async () => {
    const el = (await fixture(html`
      <temba-node-editor .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    // Test action property update
    const action = {
      uuid: 'test-action-uuid',
      type: 'send_msg',
      text: 'Hello world',
      quick_replies: []
    };

    el.action = action;
    await el.updateComplete;
    expect(el.action).to.equal(action);

    // Test node property update
    const node = {
      uuid: 'test-node-uuid',
      actions: [],
      exits: []
    };

    el.node = node;
    await el.updateComplete;
    expect(el.node).to.equal(node);

    // Test nodeUI property update
    const nodeUI = {
      type: 'execute_actions',
      position: { left: 100, top: 100 }
    };

    el.nodeUI = nodeUI;
    await el.updateComplete;
    expect(el.nodeUI).to.equal(nodeUI);
  });

  it('handles form submission events', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'send_msg',
      text: 'Hello world',
      quick_replies: []
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    // Since the form submission handling is complex and involves internal components,
    // we'll just verify the component renders without errors and has the expected structure
    const shadowRoot = el.shadowRoot;
    expect(shadowRoot).to.not.be.null;

    // Verify dialog is present
    const dialog = shadowRoot!.querySelector('temba-dialog');
    expect(dialog).to.not.be.null;
  });

  it('handles form validation', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'send_msg',
      text: 'Hello world',
      quick_replies: []
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    // Test that the component renders form elements
    const shadowRoot = el.shadowRoot;
    expect(shadowRoot).to.not.be.null;
  });

  it('enforces goflow length limits on select/tag item values', async () => {
    // goflow caps quick replies at 1000 chars (send_msg)
    let el = (await fixture(html`
      <temba-node-editor
        .action=${{
          uuid: 'len-1',
          type: 'send_msg',
          text: 'Hi',
          quick_replies: []
        }}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;
    await el.updateComplete;

    // a normal quick reply passes
    (el as any).formData = {
      uuid: 'len-1',
      text: 'Hi',
      quick_replies: [{ value: 'Yes', name: 'Yes' }]
    };
    expect((el as any).validateForm().valid).to.be.true;

    // one longer than 1000 chars is rejected
    const longReply = 'x'.repeat(1001);
    (el as any).formData = {
      uuid: 'len-1',
      text: 'Hi',
      quick_replies: [{ value: longReply, name: longReply }]
    };
    let result = (el as any).validateForm();
    expect(result.valid).to.be.false;
    expect(result.errors.quick_replies).to.exist;

    // goflow caps result names at 64 chars (set_run_result)
    el = (await fixture(html`
      <temba-node-editor
        .action=${{
          uuid: 'len-2',
          type: 'set_run_result',
          name: 'Age',
          value: '@input',
          category: ''
        }}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;
    await el.updateComplete;

    const longName = 'n'.repeat(65);
    (el as any).formData = {
      uuid: 'len-2',
      name: [{ value: longName, name: longName }],
      value: '@input',
      category: ''
    };
    result = (el as any).validateForm();
    expect(result.valid).to.be.false;
    expect(result.errors.name).to.exist;
  });

  it('enforces goflow length limits on array item sub-fields', async () => {
    // goflow caps case arguments at 10000 chars and category names at 64 (the
    // editor's own category limit is stricter at 36)
    const node = {
      uuid: 'len-3',
      actions: [],
      exits: [{ uuid: 'exit-1', name: 'Default' }],
      router: {
        type: 'switch',
        operand: '@input.text',
        categories: [{ uuid: 'cat-1', name: 'All', exit_uuid: 'exit-1' }]
      }
    };
    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${{
          type: 'split_by_expression',
          position: { left: 0, top: 0 }
        }}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;
    await el.updateComplete;

    const rule = (value1: string, category: string) => ({
      operator: { value: 'has_any_word', name: 'has any of the words' },
      value1,
      value2: '',
      category
    });

    // a normal rule passes
    (el as any).formData = {
      uuid: 'len-3',
      operand: '@input.text',
      rules: [rule('yes', 'Yes')]
    };
    expect((el as any).validateForm().valid).to.be.true;

    // an over-long rule value is rejected
    (el as any).formData = {
      uuid: 'len-3',
      operand: '@input.text',
      rules: [rule('x'.repeat(10001), 'Yes')]
    };
    let result = (el as any).validateForm();
    expect(result.valid).to.be.false;
    expect(result.errors.rules).to.exist;

    // an over-long category name is rejected
    (el as any).formData = {
      uuid: 'len-3',
      operand: '@input.text',
      rules: [rule('yes', 'c'.repeat(37))]
    };
    result = (el as any).validateForm();
    expect(result.valid).to.be.false;
    expect(result.errors.rules).to.exist;

    // an over-long value hidden by its operator's visibility condition is ignored
    (el as any).formData = {
      uuid: 'len-3',
      operand: '@input.text',
      rules: [
        {
          operator: { value: 'has_text', name: 'has some text' },
          value1: 'x'.repeat(10001),
          value2: '',
          category: 'Has Text'
        }
      ]
    };
    expect((el as any).validateForm().valid).to.be.true;
  });

  it('enforces goflow limits on webhook headers', async () => {
    // goflow caps webhook headers at 100 entries, names at 100 chars and
    // values at 8192 chars
    const node = {
      uuid: 'len-4',
      actions: [
        {
          type: 'call_webhook',
          uuid: 'webhook-1',
          method: 'GET',
          url: 'https://example.com',
          headers: {}
        }
      ],
      exits: [{ uuid: 'exit-1', name: 'Default' }],
      router: {
        type: 'switch',
        categories: [{ uuid: 'cat-1', name: 'Success', exit_uuid: 'exit-1' }]
      }
    };
    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${{ type: 'split_by_webhook', position: { left: 0, top: 0 } }}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;
    await el.updateComplete;

    const base = {
      uuid: 'len-4',
      method: [{ value: 'GET', name: 'GET' }],
      url: 'https://example.com',
      body: '',
      result_name: ''
    };

    // a normal header passes
    (el as any).formData = {
      ...base,
      headers: [{ key: 'Accept', value: 'application/json' }]
    };
    expect((el as any).validateForm().valid).to.be.true;

    // more than 100 headers is rejected
    (el as any).formData = {
      ...base,
      headers: Array.from({ length: 101 }, (_, i) => ({
        key: `X-Header-${i}`,
        value: 'v'
      }))
    };
    let result = (el as any).validateForm();
    expect(result.valid).to.be.false;
    expect(result.errors.headers).to.exist;

    // an over-long header name is rejected
    (el as any).formData = {
      ...base,
      headers: [{ key: 'H'.repeat(101), value: 'v' }]
    };
    result = (el as any).validateForm();
    expect(result.valid).to.be.false;
    expect(result.errors.headers).to.exist;

    // an over-long header value is rejected
    (el as any).formData = {
      ...base,
      headers: [{ key: 'X-Data', value: 'v'.repeat(8193) }]
    };
    result = (el as any).validateForm();
    expect(result.valid).to.be.false;
    expect(result.errors.headers).to.exist;
  });

  it('treats a whitespace-only required field as empty', async () => {
    // a required field containing only whitespace must fail validation - otherwise
    // it slips through and is emitted (e.g. trimmed to "") and rejected by the backend
    const el = (await fixture(html`
      <temba-node-editor
        .action=${{
          uuid: 'ws-1',
          type: 'send_email',
          addresses: ['help@nyaruka.com'],
          subject: 'Hello',
          body: 'Body'
        }}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;
    await el.updateComplete;

    (el as any).formData = {
      uuid: 'ws-1',
      addresses: [{ value: 'help@nyaruka.com', name: 'help@nyaruka.com' }],
      subject: '   ',
      body: 'Body'
    };
    const result = (el as any).validateForm();
    expect(result.valid).to.be.false;
    expect(result.errors.subject).to.exist;
  });

  it('displays bubble count for accordion value counts', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'send_msg',
      text: 'Hello world',
      quick_replies: ['Yes', 'No', 'Maybe'],
      attachments: ['image:@contact.photo', 'application:@contact.resume']
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    // Wait for form data to be fully initialized and re-render to complete
    await new Promise((resolve) => setTimeout(resolve, 200));
    await el.updateComplete;

    // Check that bubble counts are displayed in accordion sections
    // Bubbles are now inside temba-accordion-section shadow DOMs
    const sections = el.shadowRoot.querySelectorAll('temba-accordion-section');
    const bubbles: Element[] = [];
    sections.forEach((section) => {
      const sectionBubbles =
        section.shadowRoot.querySelectorAll('.count-bubble');
      sectionBubbles.forEach((b) => bubbles.push(b));
    });

    // Should have bubbles for sections with values
    expect(bubbles.length).to.be.greaterThan(0);

    // Check specific bubble values (trim to handle whitespace in rendered text)
    const bubbleTexts = bubbles.map((bubble) => bubble.textContent?.trim());

    // Runtime attachments section should show bubble when collapsed and has values
    expect(bubbleTexts).to.include('2'); // 2 runtime attachments
  });

  it('shows arrow when accordion section has no values', async () => {
    const action = {
      uuid: 'test-action-uuid',
      type: 'send_msg',
      text: 'Hello world'
      // No quick_replies or attachments provided
    };

    const el = (await fixture(html`
      <temba-node-editor .action=${action} .isOpen=${true}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    // Wait for form data initialization
    await new Promise((resolve) => setTimeout(resolve, 200));
    await el.updateComplete;

    // Check that arrows are displayed instead of bubbles
    // Elements are now inside temba-accordion-section shadow DOMs
    const sections = el.shadowRoot.querySelectorAll('temba-accordion-section');
    const bubbles: Element[] = [];
    const arrows: Element[] = [];
    sections.forEach((section) => {
      section.shadowRoot
        .querySelectorAll('.count-bubble')
        .forEach((b) => bubbles.push(b));
      section.shadowRoot
        .querySelectorAll('.toggle-icon')
        .forEach((a) => arrows.push(a));
    });

    // Should have no bubbles when counts are 0
    expect(bubbles.length).to.equal(0);

    // Should have arrows for accordion sections
    expect(arrows.length).to.be.greaterThan(0);
  });

  it('renders split_by_llm_categorize node', async () => {
    const node = {
      uuid: 'test-node-uuid',
      actions: [
        {
          uuid: 'call-llm-uuid',
          type: 'call_classifier',
          model: { uuid: 'llm-123', name: 'Test LLM' },
          input: '@input',
          options: [{ name: 'Greeting' }, { name: 'Question' }],
          required_confidence: 'medium',
          output_local: '_llm_output'
        }
      ],
      router: {
        type: 'switch',
        operand: '@locals._llm_output',
        result_name: 'Intent',
        categories: [
          { uuid: 'cat-1', name: 'Greeting', exit_uuid: 'exit-1' },
          { uuid: 'cat-2', name: 'Question', exit_uuid: 'exit-2' },
          { uuid: 'cat-3', name: 'Other', exit_uuid: 'exit-3' },
          { uuid: 'cat-4', name: 'Failure', exit_uuid: 'exit-4' }
        ]
      },
      exits: [
        { uuid: 'exit-1', destination_uuid: null },
        { uuid: 'exit-2', destination_uuid: null },
        { uuid: 'exit-3', destination_uuid: null },
        { uuid: 'exit-4', destination_uuid: null }
      ]
    };

    const nodeUI = { type: 'split_by_llm_categorize' };

    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;
    expect(el.shadowRoot).to.not.be.null;
    expect(el.node).to.equal(node);
    expect(el.nodeUI).to.equal(nodeUI);

    // Wait for form data initialization
    await new Promise((resolve) => setTimeout(resolve, 200));
    await el.updateComplete;

    // Check if the dialog is rendered with correct header
    const dialog = el.shadowRoot.querySelector('temba-dialog');
    expect(dialog).to.not.be.null;
    expect(dialog.getAttribute('header')).to.equal('Split by AI');

    // Check that the form is rendered
    const form = el.shadowRoot.querySelector('.node-editor-form');
    expect(form).to.not.be.null;

    // Check that all expected form components are rendered
    const selectComponents = el.shadowRoot.querySelectorAll('temba-select');
    const arrayComponents =
      el.shadowRoot.querySelectorAll('temba-array-editor');
    const richEditComponents =
      el.shadowRoot.querySelectorAll('temba-rich-edit');

    // Should have model and confidence select fields
    expect(selectComponents.length).to.equal(2);
    expect(selectComponents[0].getAttribute('label')).to.equal('Model');
    expect(selectComponents[1].getAttribute('name')).to.equal(
      'required_confidence'
    );

    // Should have input rich edit field
    expect(richEditComponents.length).to.equal(1);
    expect(richEditComponents[0].getAttribute('label')).to.equal('Input');

    // Should have categories array editor
    expect(arrayComponents.length).to.equal(1);
  });

  it('renders wait_for_response node', async () => {
    const node = {
      uuid: 'test-wait-node-uuid',
      actions: [],
      router: {
        type: 'switch',
        wait: {
          type: 'msg',
          timeout: 300 // 5 minutes in seconds
        },
        result_name: 'response',
        categories: []
      },
      exits: []
    };

    const nodeUI = { type: 'wait_for_response' };

    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    // Wait for form data initialization
    await new Promise((resolve) => setTimeout(resolve, 200));
    await el.updateComplete;

    // Check that the dialog is rendered with correct header
    const dialog = el.shadowRoot.querySelector('temba-dialog');
    expect(dialog).to.not.be.null;
    expect(dialog.getAttribute('header')).to.equal('Wait for Response');

    // Check that result name field is rendered inside accordion
    const accordion = el.shadowRoot.querySelector('temba-accordion');
    expect(accordion).to.not.be.null;
    const textInput = el.shadowRoot.querySelector('temba-textinput');
    expect(textInput).to.not.be.null;
  });

  it('prioritizes node config over action config for non-execute_actions nodes', async () => {
    // Create a split_by_llm_categorize node that has both actions and should use node config
    const node = {
      uuid: 'test-node-uuid',
      actions: [
        {
          uuid: 'call-llm-uuid',
          type: 'call_classifier',
          model: { uuid: 'llm-123', name: 'Test LLM' },
          input: '@input',
          options: [{ name: 'Greeting' }, { name: 'Question' }],
          required_confidence: 'medium',
          output_local: '_llm_output'
        }
      ],
      router: {
        type: 'switch',
        operand: '@locals._llm_output',
        result_name: 'Intent',
        categories: [
          { uuid: 'cat-1', name: 'Greeting', exit_uuid: 'exit-1' },
          { uuid: 'cat-2', name: 'Question', exit_uuid: 'exit-2' }
        ]
      },
      exits: [
        { uuid: 'exit-1', destination_uuid: null },
        { uuid: 'exit-2', destination_uuid: null }
      ]
    };

    const nodeUI = { type: 'split_by_llm_categorize' };

    // Simulate having both node and action set (which happens when editing from flow)
    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .action=${node.actions[0]}
        .isOpen=${true}
      >
      </temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    // Wait for form data initialization
    await new Promise((resolve) => setTimeout(resolve, 200));
    await el.updateComplete;

    // Should show node editor (Split by AI Categorize), not action editor (Call LLM)
    const dialog = el.shadowRoot.querySelector('temba-dialog');
    expect(dialog.getAttribute('header')).to.equal('Split by AI');

    // Should have node config fields (LLM, Input, Categories, Result Name)
    const selectComponents = el.shadowRoot.querySelectorAll('temba-select');
    const arrayComponents =
      el.shadowRoot.querySelectorAll('temba-array-editor');

    // Should have model and confidence selects and categories array (node config fields)
    expect(selectComponents.length).to.equal(2);
    expect(arrayComponents.length).to.equal(1);
  });

  it('initializes categories correctly for split_by_llm_categorize', async () => {
    const node = {
      uuid: 'test-node-uuid',
      actions: [
        {
          uuid: 'call-llm-uuid',
          type: 'call_classifier',
          model: { uuid: 'llm-123', name: 'Test LLM' },
          input: '@input',
          options: [{ name: 'Greeting' }, { name: 'Question' }],
          required_confidence: 'medium',
          output_local: '_llm_output'
        }
      ],
      router: {
        type: 'switch',
        operand: '@locals._llm_output',
        result_name: 'Intent',
        categories: [
          { uuid: 'cat-1', name: 'Greeting', exit_uuid: 'exit-1' },
          { uuid: 'cat-2', name: 'Question', exit_uuid: 'exit-2' },
          { uuid: 'cat-3', name: 'Other', exit_uuid: 'exit-3' },
          { uuid: 'cat-4', name: 'Failure', exit_uuid: 'exit-4' }
        ]
      },
      exits: [
        { uuid: 'exit-1', destination_uuid: null },
        { uuid: 'exit-2', destination_uuid: null },
        { uuid: 'exit-3', destination_uuid: null },
        { uuid: 'exit-4', destination_uuid: null }
      ]
    };

    const nodeUI = { type: 'split_by_llm_categorize' };

    const el = (await fixture(html`
      <temba-node-editor
        .node=${node}
        .nodeUI=${nodeUI}
        .isOpen=${true}
      ></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    // Wait for form data initialization
    await new Promise((resolve) => setTimeout(resolve, 200));
    await el.updateComplete;

    // Access the component's formData directly to check initialization
    const formData = (el as any).formData;

    // Should have 2 categories (Greeting and Question, excluding Other and Failure)
    expect(formData.options).to.be.an('array');
    expect(formData.options.length).to.equal(2);
    expect(formData.options[0].name).to.equal('Greeting');
    expect(formData.options[1].name).to.equal('Question');

    // Check that the array editor component receives the correct value
    const arrayEditor = el.shadowRoot.querySelector('temba-array-editor');
    expect(arrayEditor).to.not.be.null;

    // Wait a bit more for the array editor to fully render
    await new Promise((resolve) => setTimeout(resolve, 500));
    await el.updateComplete;

    // Check the values of the textinput components within the array items
    const nameInputs = arrayEditor.shadowRoot?.querySelectorAll(
      'temba-textinput[name="name"]'
    );

    if (nameInputs && nameInputs.length >= 2) {
      // The first two name inputs should have the category names
      expect((nameInputs[0] as any).value).to.equal('Greeting');
      expect((nameInputs[1] as any).value).to.equal('Question');
    }
  });

  it('properly initializes categories when node is set after component creation', async () => {
    // First create the component without any data
    const el = (await fixture(html`
      <temba-node-editor .isOpen=${false}></temba-node-editor>
    `)) as NodeEditorElement;

    await el.updateComplete;

    // Then set the node data (simulating real usage)
    const node = {
      uuid: 'test-node-uuid',
      actions: [
        {
          uuid: 'call-llm-uuid',
          type: 'call_classifier',
          model: { uuid: 'llm-123', name: 'Test LLM' },
          input: '@input',
          options: [{ name: 'Greeting' }, { name: 'Question' }],
          required_confidence: 'medium',
          output_local: '_llm_output'
        }
      ],
      router: {
        type: 'switch',
        operand: '@locals._llm_output',
        result_name: 'Intent',
        categories: [
          { uuid: 'cat-1', name: 'Greeting', exit_uuid: 'exit-1' },
          { uuid: 'cat-2', name: 'Question', exit_uuid: 'exit-2' },
          { uuid: 'cat-3', name: 'Other', exit_uuid: 'exit-3' },
          { uuid: 'cat-4', name: 'Failure', exit_uuid: 'exit-4' }
        ]
      },
      exits: [
        { uuid: 'exit-1', destination_uuid: null },
        { uuid: 'exit-2', destination_uuid: null },
        { uuid: 'exit-3', destination_uuid: null },
        { uuid: 'exit-4', destination_uuid: null }
      ]
    };

    const nodeUI = { type: 'split_by_llm_categorize' };

    // Set the properties (this should trigger updated() and openDialog())
    el.node = node;
    el.nodeUI = nodeUI;

    await el.updateComplete;

    // Wait for dialog to open and form data to initialize
    await new Promise((resolve) => setTimeout(resolve, 300));
    await el.updateComplete;

    // Check that the form data is properly initialized
    const formData = (el as any).formData;

    expect(formData.options).to.be.an('array');
    expect(formData.options.length).to.equal(2);
    expect(formData.options[0].name).to.equal('Greeting');
    expect(formData.options[1].name).to.equal('Question');

    // Check that array editor gets the correct values
    const arrayEditor = el.shadowRoot.querySelector('temba-array-editor');
    expect(arrayEditor).to.not.be.null;

    const nameInputs = arrayEditor.shadowRoot?.querySelectorAll(
      'temba-textinput[name="name"]'
    );
    if (nameInputs && nameInputs.length >= 2) {
      expect((nameInputs[0] as any).value).to.equal('Greeting');
      expect((nameInputs[1] as any).value).to.equal('Question');
    }
  });

  it('preserves UUIDs for unchanged categories in split_by_llm_categorize', async () => {
    const originalNode: any = {
      uuid: 'test-node-uuid',
      actions: [
        {
          uuid: 'existing-call-llm-uuid',
          type: 'call_classifier',
          model: { uuid: 'llm-123', name: 'Test LLM' },
          input: '@input',
          options: [{ name: 'Greeting' }, { name: 'Question' }],
          required_confidence: 'medium',
          output_local: '_llm_output'
        }
      ],
      router: {
        type: 'switch',
        operand: '@locals._llm_output',
        result_name: 'Intent',
        categories: [
          {
            uuid: 'existing-cat-1',
            name: 'Greeting',
            exit_uuid: 'existing-exit-1'
          },
          {
            uuid: 'existing-cat-2',
            name: 'Question',
            exit_uuid: 'existing-exit-2'
          },
          {
            uuid: 'existing-cat-other',
            name: 'Other',
            exit_uuid: 'existing-exit-other'
          },
          {
            uuid: 'existing-cat-failure',
            name: 'Failure',
            exit_uuid: 'existing-exit-failure'
          }
        ],
        cases: [
          {
            uuid: 'existing-case-1',
            type: 'has_only_text',
            arguments: ['Greeting'],
            category_uuid: 'existing-cat-1'
          },
          {
            uuid: 'existing-case-2',
            type: 'has_only_text',
            arguments: ['Question'],
            category_uuid: 'existing-cat-2'
          },
          {
            uuid: 'existing-case-error',
            type: 'has_only_text',
            arguments: ['<ERROR>'],
            category_uuid: 'existing-cat-failure'
          }
        ]
      },
      exits: [
        { uuid: 'existing-exit-1', destination_uuid: 'some-destination-1' },
        { uuid: 'existing-exit-2', destination_uuid: 'some-destination-2' },
        { uuid: 'existing-exit-other', destination_uuid: null },
        { uuid: 'existing-exit-failure', destination_uuid: null }
      ]
    };

    // Import the node config to test fromFormData directly
    const { split_by_llm_categorize } =
      await import('../src/flow/nodes/split_by_llm_categorize');

    // Test with same categories - should preserve UUIDs
    const formDataSame = {
      model: [{ value: 'llm-123', name: 'Test LLM' }],
      input: '@input',
      required_confidence: [{ value: 'medium', name: 'Medium' }],
      options: [{ name: 'Greeting' }, { name: 'Question' }],
      result_name: 'Intent'
    };

    const resultSame = split_by_llm_categorize.fromFormData(
      formDataSame,
      originalNode
    );

    // Should preserve existing UUIDs for unchanged categories
    expect(resultSame.actions[0].uuid).to.equal('existing-call-llm-uuid');

    const greetingCategory = resultSame.router.categories.find(
      (cat) => cat.name === 'Greeting'
    );
    const questionCategory = resultSame.router.categories.find(
      (cat) => cat.name === 'Question'
    );
    const otherCategory = resultSame.router.categories.find(
      (cat) => cat.name === 'Other'
    );
    const failureCategory = resultSame.router.categories.find(
      (cat) => cat.name === 'Failure'
    );

    expect(greetingCategory.uuid).to.equal('existing-cat-1');
    expect(greetingCategory.exit_uuid).to.equal('existing-exit-1');
    expect(questionCategory.uuid).to.equal('existing-cat-2');
    expect(questionCategory.exit_uuid).to.equal('existing-exit-2');
    expect(otherCategory.uuid).to.equal('existing-cat-other');
    expect(failureCategory.uuid).to.equal('existing-cat-failure');

    // Should preserve destination UUIDs for exits
    const greetingExit = resultSame.exits.find(
      (exit) => exit.uuid === 'existing-exit-1'
    );
    const questionExit = resultSame.exits.find(
      (exit) => exit.uuid === 'existing-exit-2'
    );
    expect(greetingExit.destination_uuid).to.equal('some-destination-1');
    expect(questionExit.destination_uuid).to.equal('some-destination-2');

    // Test with changed categories - should generate new UUIDs for new categories
    const formDataChanged = {
      model: [{ value: 'llm-123', name: 'Test LLM' }],
      input: '@input',
      required_confidence: [{ value: 'medium', name: 'Medium' }],
      options: [
        { name: 'Greeting' }, // unchanged - should keep UUID
        { name: 'NewCategory' } // new - should get new UUID
      ],
      result_name: 'Intent'
    };

    const resultChanged = split_by_llm_categorize.fromFormData(
      formDataChanged,
      originalNode
    );

    const greetingCategoryChanged = resultChanged.router.categories.find(
      (cat) => cat.name === 'Greeting'
    );
    const newCategory = resultChanged.router.categories.find(
      (cat) => cat.name === 'NewCategory'
    );

    // Greeting should keep its existing UUID
    expect(greetingCategoryChanged.uuid).to.equal('existing-cat-1');
    expect(greetingCategoryChanged.exit_uuid).to.equal('existing-exit-1');

    // NewCategory should get a new UUID (not one of the existing ones)
    expect(newCategory.uuid).to.not.equal('existing-cat-1');
    expect(newCategory.uuid).to.not.equal('existing-cat-2');
    expect(newCategory.uuid).to.not.equal('existing-cat-other');
    expect(newCategory.uuid).to.not.equal('existing-cat-failure');
    expect(newCategory.uuid).to.have.length.greaterThan(0);
  });

  describe('default result name for new wait_for_response nodes', () => {
    const setupStore = (results: { name: string; key: string }[]) => {
      const state = zustand.getState();
      zustand.setState({
        ...state,
        flowDefinition: {
          language: 'en',
          localization: {},
          name: 'Test Flow',
          nodes: [],
          uuid: 'test-uuid',
          type: 'messaging' as const,
          revision: 1,
          spec_version: '14.3',
          _ui: { nodes: {}, languages: [] }
        },
        flowInfo: {
          results: results.map((r) => ({
            ...r,
            categories: [],
            node_uuids: ['some-node']
          })),
          dependencies: [],
          counts: { nodes: 0, languages: 0 },
          locals: []
        }
      });
    };

    const createNewWaitNode = async () => {
      const node = {
        uuid: 'new-node-uuid',
        actions: [],
        exits: [],
        router: {
          type: 'switch',
          categories: [],
          cases: [],
          operand: '@input.text',
          default_category_uuid: undefined
        }
      };

      const nodeUI = {
        type: 'wait_for_response',
        position: { left: 100, top: 100 }
      };

      const el = (await fixture(html`
        <temba-node-editor
          .node=${node}
          .nodeUI=${nodeUI}
          .isOpen=${true}
        ></temba-node-editor>
      `)) as NodeEditorElement;

      await el.updateComplete;
      return el;
    };

    it('defaults to "Result" when no results exist', async () => {
      setupStore([]);
      const el = await createNewWaitNode();
      expect((el as any).formData.result_name).to.equal('Result');
    });

    it('defaults to "Result 2" when "Result" exists', async () => {
      setupStore([{ name: 'Result', key: 'result' }]);
      const el = await createNewWaitNode();
      expect((el as any).formData.result_name).to.equal('Result 2');
    });

    it('fills gaps in numbering', async () => {
      setupStore([
        { name: 'Result', key: 'result' },
        { name: 'Result 3', key: 'result_3' }
      ]);
      const el = await createNewWaitNode();
      expect((el as any).formData.result_name).to.equal('Result 2');
    });

    it('skips all existing names', async () => {
      setupStore([
        { name: 'Result', key: 'result' },
        { name: 'Result 2', key: 'result_2' },
        { name: 'Result 3', key: 'result_3' }
      ]);
      const el = await createNewWaitNode();
      expect((el as any).formData.result_name).to.equal('Result 4');
    });
  });

  describe('escape with unsaved changes', () => {
    let confirmStub: sinon.SinonStub;

    beforeEach(() => {
      confirmStub = sinon.stub(window, 'confirm');
    });

    afterEach(() => {
      confirmStub.restore();
    });

    const openSendMsgEditor = async () => {
      const action = {
        uuid: 'test-action-uuid',
        type: 'send_msg',
        text: 'Hello world',
        quick_replies: []
      };

      const el = (await fixture(html`
        <temba-node-editor
          .action=${action}
          .isOpen=${true}
        ></temba-node-editor>
      `)) as NodeEditorElement;

      await el.updateComplete;
      return el;
    };

    const pressEscape = () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
    };

    it('cancels without confirming when nothing was modified', async () => {
      const el = await openSendMsgEditor();

      let cancelled = false;
      el.addEventListener('temba-node-edit-cancelled', () => {
        cancelled = true;
      });

      pressEscape();
      await el.updateComplete;

      expect(confirmStub.called).to.equal(false);
      expect(cancelled).to.equal(true);
    });

    it('keeps editing when the confirm is declined', async () => {
      const el = await openSendMsgEditor();
      confirmStub.returns(false);

      let cancelled = false;
      el.addEventListener('temba-node-edit-cancelled', () => {
        cancelled = true;
      });

      (el as any).formData = { ...(el as any).formData, text: 'Changed text' };
      await el.updateComplete;

      pressEscape();
      await el.updateComplete;

      expect(confirmStub.calledOnce).to.equal(true);
      expect(confirmStub.firstCall.args[0]).to.equal(
        Dialog.UNSAVED_CHANGES_MESSAGE
      );
      expect(cancelled).to.equal(false);

      // still dirty, so a second escape asks again
      pressEscape();
      await el.updateComplete;
      expect(confirmStub.calledTwice).to.equal(true);
      expect(cancelled).to.equal(false);
    });

    it('discards changes when the confirm is accepted', async () => {
      const el = await openSendMsgEditor();
      confirmStub.returns(true);

      let cancelled = false;
      el.addEventListener('temba-node-edit-cancelled', () => {
        cancelled = true;
      });

      (el as any).formData = { ...(el as any).formData, text: 'Changed text' };
      await el.updateComplete;

      pressEscape();
      await el.updateComplete;

      expect(confirmStub.calledOnce).to.equal(true);
      expect(cancelled).to.equal(true);
    });

    it('does not confirm when reverted back to the original values', async () => {
      const el = await openSendMsgEditor();

      let cancelled = false;
      el.addEventListener('temba-node-edit-cancelled', () => {
        cancelled = true;
      });

      const original = (el as any).formData;
      (el as any).formData = { ...original, text: 'Changed text' };
      (el as any).formData = { ...original };
      await el.updateComplete;

      pressEscape();
      await el.updateComplete;

      // matches the original, so no warning
      expect(confirmStub.called).to.equal(false);
      expect(cancelled).to.equal(true);
    });

    it('leaves escapes aimed at an open select dropdown alone', async () => {
      const el = await openSendMsgEditor();
      confirmStub.returns(false);

      let cancelled = false;
      el.addEventListener('temba-node-edit-cancelled', () => {
        cancelled = true;
      });

      // escape whose path passes through a select with an open dropdown
      // should only close the dropdown, not touch the editor
      const select = document.createElement('temba-select') as any;
      select.isOpen = () => true;
      el.appendChild(select);
      select.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          composed: true
        })
      );
      await el.updateComplete;

      expect(confirmStub.called).to.equal(false);
      expect(cancelled).to.equal(false);
    });

    it('leaves escapes belonging to a nested dialog alone', async () => {
      const el = await openSendMsgEditor();
      confirmStub.returns(false);

      let cancelled = false;
      el.addEventListener('temba-node-edit-cancelled', () => {
        cancelled = true;
      });

      // escape routed through a dialog other than the editor's own belongs
      // to that dialog
      const nested = document.createElement('temba-dialog');
      const content = document.createElement('div');
      nested.appendChild(content);
      document.body.appendChild(nested);
      try {
        content.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            composed: true
          })
        );
        await el.updateComplete;

        expect(confirmStub.called).to.equal(false);
        expect(cancelled).to.equal(false);
      } finally {
        nested.remove();
      }
    });

    it('does not apply a stale resolve over a concurrent edit', async () => {
      const el = await openSendMsgEditor();

      // a resolve that only completes after the user has edited
      let release: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const realConfig = (el as any).getConfig();
      (el as any).getConfig = () => ({
        ...realConfig,
        resolveFormData: async (formData: any) => {
          await gate;
          return { ...formData, text: 'resolved late' };
        }
      });

      const pending = (el as any).resolveFormData();
      (el as any).formData = { ...(el as any).formData, text: 'user edit' };
      release!();
      await pending;

      // the stale resolve must not overwrite the edit or rebase the baseline
      expect((el as any).formData.text).to.equal('user edit');
      expect((el as any).hasUnsavedChanges()).to.equal(true);
    });

    it('stops escape keyups from reaching the dialog', async () => {
      const el = await openSendMsgEditor();
      confirmStub.returns(false);

      let cancelled = false;
      el.addEventListener('temba-node-edit-cancelled', () => {
        cancelled = true;
      });

      (el as any).formData = { ...(el as any).formData, text: 'Changed text' };
      await el.updateComplete;

      // temba-dialog handles escape keyups from within itself, which would
      // prompt a second time after the editor's keydown handler already has;
      // the editor's capture listener must stop them
      const form = el.shadowRoot!.querySelector('.node-editor-form');
      form!.dispatchEvent(
        new KeyboardEvent('keyup', {
          key: 'Escape',
          bubbles: true,
          composed: true
        })
      );
      await el.updateComplete;

      expect(confirmStub.called).to.equal(false);
      expect(cancelled).to.equal(false);
      const dialog = el.shadowRoot!.querySelector('temba-dialog') as any;
      expect(dialog.open).to.equal(true);
    });
  });
});
