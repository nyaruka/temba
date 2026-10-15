import '../temba-modules';
import { fixture, expect } from '@open-wc/testing';
import { NodeEditor } from '../src/flow/NodeEditor';

const createEditor = async (action?: any): Promise<NodeEditor> => {
  const editor = (await fixture(
    '<temba-node-editor></temba-node-editor>'
  )) as NodeEditor;
  if (action) {
    editor.action = action;
    await editor.updateComplete;
  }
  return editor;
};

// a fake widget event carrying whatever shape the field component exposes
const fieldEvent = (target: any): Event => {
  const event = new Event('change');
  Object.defineProperty(event, 'target', { value: target });
  return event;
};

const formData = (editor: NodeEditor) => (editor as any).formData;

describe('temba-node-editor fields', () => {
  describe('group collapse state', () => {
    it('toggles a group open and closed', async () => {
      const editor = await createEditor();
      const toggle = (label: string) =>
        (editor as any).handleGroupToggle(label);

      toggle('Advanced');
      expect((editor as any).groupCollapseState['Advanced']).to.equal(true);

      toggle('Advanced');
      expect((editor as any).groupCollapseState['Advanced']).to.equal(false);
    });

    it('tracks groups independently', async () => {
      const editor = await createEditor();
      (editor as any).handleGroupToggle('Advanced');
      (editor as any).handleGroupToggle('Other');
      (editor as any).handleGroupToggle('Other');

      expect((editor as any).groupCollapseState['Advanced']).to.equal(true);
      expect((editor as any).groupCollapseState['Other']).to.equal(false);
    });
  });

  describe('group hover state', () => {
    it('records entering and leaving a group', async () => {
      const editor = await createEditor();
      (editor as any).handleGroupMouseEnter('Advanced');
      expect((editor as any).groupHoverState['Advanced']).to.equal(true);

      (editor as any).handleGroupMouseLeave('Advanced');
      expect((editor as any).groupHoverState['Advanced']).to.equal(false);
    });

    it('keeps hover state per group', async () => {
      const editor = await createEditor();
      (editor as any).handleGroupMouseEnter('One');
      (editor as any).handleGroupMouseEnter('Two');
      (editor as any).handleGroupMouseLeave('One');

      expect((editor as any).groupHoverState['One']).to.equal(false);
      expect((editor as any).groupHoverState['Two']).to.equal(true);
    });
  });

  describe('revealOptionalField', () => {
    it('reveals a field', async () => {
      const editor = await createEditor();
      (editor as any).revealOptionalField('all_urns');
      expect((editor as any).revealedOptionalFields.has('all_urns')).to.equal(
        true
      );
    });

    it('accumulates revealed fields', async () => {
      const editor = await createEditor();
      (editor as any).revealOptionalField('one');
      (editor as any).revealOptionalField('two');
      const revealed = (editor as any).revealedOptionalFields;
      expect(revealed.has('one')).to.equal(true);
      expect(revealed.has('two')).to.equal(true);
    });

    it('is idempotent', async () => {
      const editor = await createEditor();
      (editor as any).revealOptionalField('one');
      (editor as any).revealOptionalField('one');
      expect((editor as any).revealedOptionalFields.size).to.equal(1);
    });
  });

  describe('handleFormFieldChange', () => {
    const sendMsg = () => ({
      uuid: 'action-1',
      type: 'send_msg',
      text: 'Hello'
    });

    it('reads a plain input value', async () => {
      const editor = await createEditor(sendMsg());
      (editor as any).handleFormFieldChange(
        'text',
        fieldEvent({ tagName: 'TEMBA-TEXTINPUT', value: 'Updated' })
      );
      expect(formData(editor).text).to.equal('Updated');
    });

    it('reads a checkbox as a boolean', async () => {
      const editor = await createEditor(sendMsg());
      (editor as any).handleFormFieldChange(
        'all_urns',
        fieldEvent({ tagName: 'TEMBA-CHECKBOX', checked: true, value: 'on' })
      );
      expect(formData(editor).all_urns).to.equal(true);
    });

    it('prefers the values collection of a multi widget', async () => {
      const editor = await createEditor(sendMsg());
      const values = [{ value: 'a' }, { value: 'b' }];
      (editor as any).handleFormFieldChange(
        'quick_replies',
        fieldEvent({ tagName: 'TEMBA-SELECT', values, value: 'ignored' })
      );
      expect(formData(editor).quick_replies).to.equal(values);
    });

    it('clears an existing error for the field', async () => {
      const editor = await createEditor(sendMsg());
      (editor as any).errors = { text: 'Required', other: 'Still broken' };
      (editor as any).handleFormFieldChange(
        'text',
        fieldEvent({ tagName: 'TEMBA-TEXTINPUT', value: 'Updated' })
      );
      expect((editor as any).errors.text).to.equal(undefined);
      // unrelated errors survive
      expect((editor as any).errors.other).to.equal('Still broken');
    });

    it('leaves other form values untouched', async () => {
      const editor = await createEditor(sendMsg());
      (editor as any).formData = { text: 'Hello', result_name: 'Colour' };
      (editor as any).handleFormFieldChange(
        'text',
        fieldEvent({ tagName: 'TEMBA-TEXTINPUT', value: 'Updated' })
      );
      expect(formData(editor).result_name).to.equal('Colour');
    });
  });

  describe('updateComputedFields', () => {
    // split_by_webhook recomputes headers and body when the method changes
    const webhookNode = () => ({
      uuid: 'node-1',
      actions: [],
      exits: [],
      router: { type: 'switch', categories: [] }
    });

    const createWebhookEditor = async (): Promise<NodeEditor> => {
      const editor = (await fixture(
        '<temba-node-editor></temba-node-editor>'
      )) as NodeEditor;
      editor.node = webhookNode() as any;
      editor.nodeUI = { type: 'split_by_webhook' } as any;
      await editor.updateComplete;
      return editor;
    };

    // headers come back as {key, value} or {name, value} depending on the widget
    const headerPairs = (editor: NodeEditor) =>
      (formData(editor).headers || []).map((h: any) => ({
        key: h.key ?? h.name,
        value: h.value
      }));

    const setFormData = (editor: NodeEditor, values: any) => {
      (editor as any).formData = { ...formData(editor), ...values };
    };

    it('recomputes dependent fields when the method changes', async () => {
      const editor = await createWebhookEditor();

      // start on the GET defaults, which are eligible to be replaced
      setFormData(editor, {
        method: [{ value: 'GET', name: 'GET' }],
        headers: [{ key: 'Accept', value: 'application/json' }]
      });

      setFormData(editor, { method: [{ value: 'POST', name: 'POST' }] });
      (editor as any).updateComputedFields('method');

      // POST additionally sends a Content-Type
      expect(headerPairs(editor)).to.deep.equal([
        { key: 'Accept', value: 'application/json' },
        { key: 'Content-Type', value: 'application/json' }
      ]);
    });

    it('drops back to the GET defaults when the method changes back', async () => {
      const editor = await createWebhookEditor();

      setFormData(editor, {
        method: [{ value: 'GET', name: 'GET' }],
        headers: [
          { key: 'Accept', value: 'application/json' },
          { key: 'Content-Type', value: 'application/json' }
        ]
      });
      (editor as any).updateComputedFields('method');

      expect(headerPairs(editor)).to.deep.equal([
        { key: 'Accept', value: 'application/json' }
      ]);
    });

    it('leaves headers the user has customized alone', async () => {
      const editor = await createWebhookEditor();
      const custom = [{ key: 'X-Api-Key', value: 'secret' }];

      setFormData(editor, {
        method: [{ value: 'POST', name: 'POST' }],
        headers: custom
      });
      (editor as any).updateComputedFields('method');

      expect(headerPairs(editor)).to.deep.equal(custom);
    });

    it('leaves fields alone when nothing depends on the change', async () => {
      const editor = await createWebhookEditor();
      const before = JSON.stringify(formData(editor));
      (editor as any).updateComputedFields('result_name');
      expect(JSON.stringify(formData(editor))).to.equal(before);
    });

    it('does nothing without a config', async () => {
      const editor = await createEditor();
      // no throw is the assertion here
      (editor as any).updateComputedFields('anything');
    });
  });

  describe('expandGroupsWithErrors', () => {
    // send_broadcast offers its template field as an extra
    const createBroadcastEditor = async (): Promise<NodeEditor> => {
      const editor = (await fixture(
        '<temba-node-editor></temba-node-editor>'
      )) as NodeEditor;
      editor.action = {
        uuid: 'action-1',
        type: 'send_broadcast',
        text: 'Hello'
      } as any;
      await editor.updateComplete;
      return editor;
    };

    const templateSection = {
      label: 'Use WhatsApp Template',
      items: ['template']
    };

    it('shows the extra holding the failing field', async () => {
      const editor = await createBroadcastEditor();
      expect((editor as any).isExtraShown(templateSection)).to.be.false;

      (editor as any).errors = { template: 'Required' };
      expect((editor as any).isExtraShown(templateSection)).to.be.true;
    });

    it('leaves extras offered when their fields are fine', async () => {
      const editor = await createBroadcastEditor();
      (editor as any).errors = { text: 'Required' };
      expect((editor as any).isExtraShown(templateSection)).to.be.false;
    });

    it('does nothing when there are no errors', async () => {
      const editor = await createBroadcastEditor();
      const before = { ...(editor as any).groupCollapseState };
      (editor as any).expandGroupsWithErrors({});
      expect((editor as any).groupCollapseState).to.deep.equal(before);
    });

    it('does nothing for a config with no layout', async () => {
      const editor = await createEditor();
      // no throw is the assertion here
      (editor as any).expandGroupsWithErrors({ anything: 'Required' });
    });
  });
});
