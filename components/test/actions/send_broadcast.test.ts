import { expect } from '@open-wc/testing';
import { send_broadcast } from '../../src/flow/actions/send_broadcast';
import { SendBroadcast } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';

/**
 * Test suite for the send_broadcast action configuration.
 */
describe('send_broadcast action config', () => {
  const helper = new ActionTest(send_broadcast, 'send_broadcast');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(send_broadcast.name).to.equal('Send Broadcast');
    });
  });

  describe('action scenarios', () => {
    helper.testAction(
      {
        uuid: 'test-action-1',
        type: 'send_broadcast',
        text: 'Important announcement for all subscribers!',
        groups: [
          { uuid: 'group-1', name: 'Subscribers' },
          { uuid: 'group-2', name: 'VIP Members' }
        ],
        contacts: []
      } as SendBroadcast,
      'groups-only'
    );

    helper.testAction(
      {
        uuid: 'test-action-2',
        type: 'send_broadcast',
        text: 'Personal message to specific contacts.',
        groups: [],
        contacts: [
          { uuid: 'contact-1', name: 'Alice Johnson' },
          { uuid: 'contact-2', name: 'Bob Smith' }
        ]
      } as SendBroadcast,
      'contacts-only'
    );

    helper.testAction(
      {
        uuid: 'test-action-3',
        type: 'send_broadcast',
        text: 'Urgent update for everyone!',
        groups: [{ uuid: 'group-1', name: 'All Members' }],
        contacts: [{ uuid: 'contact-1', name: 'Admin' }]
      } as SendBroadcast,
      'groups-and-contacts'
    );

    helper.testAction(
      {
        uuid: 'test-action-4',
        type: 'send_broadcast',
        text: 'Multi-line broadcast message.\n\nThis is the second paragraph.\n\nAnd the third.',
        groups: [{ uuid: 'group-1', name: 'Newsletter Subscribers' }],
        contacts: []
      } as SendBroadcast,
      'multiline-text'
    );

    /* TODO: flaky test having to do with attachment render times
    helper.testAction(
      {
        uuid: 'test-action-5',
        type: 'send_broadcast',
        text: 'Broadcast with attachments',
        groups: [{ uuid: 'group-1', name: 'Members' }],
        contacts: [],
        attachments: [
          'image/jpeg:https://example.com/photo.jpg',
          'application/pdf:https://example.com/document.pdf'
        ]
      } as SendBroadcast,
      'with-attachments',
      true
    );*/

    helper.testRender(
      {
        uuid: 'test-action-5',
        type: 'send_broadcast',
        text: 'Broadcast with attachments',
        groups: [{ uuid: 'group-1', name: 'Members' }],
        contacts: [],
        attachments: [
          'image/jpeg:https://example.com/photo.jpg',
          'application/pdf:https://example.com/document.pdf'
        ]
      } as SendBroadcast,
      'with-attachments-render'
    );

    helper.testAction(
      {
        uuid: 'test-action-6',
        type: 'send_broadcast',
        text: 'Message to many groups',
        groups: [
          { uuid: 'group-1', name: 'Group A' },
          { uuid: 'group-2', name: 'Group B' },
          { uuid: 'group-3', name: 'Group C' },
          { uuid: 'group-4', name: 'Group D' }
        ],
        contacts: []
      } as SendBroadcast,
      'many-groups'
    );

    helper.testAction(
      {
        uuid: 'test-action-7',
        type: 'send_broadcast',
        text: 'This is the thing.',
        groups: [],
        contacts: [],
        legacy_vars: ['@parent']
      } as SendBroadcast,
      'with-legacy-vars'
    );

    helper.testAction(
      {
        uuid: 'test-action-8',
        type: 'send_broadcast',
        text: 'Hello {{1}}, your order {{2}} is ready.',
        groups: [{ uuid: 'group-1', name: 'Customers' }],
        contacts: [],
        template: { uuid: 'template-1', name: 'order_ready' },
        template_variables: ['@contact.name', '@results.order_id']
      } as SendBroadcast,
      'with-template'
    );
  });

  describe('validate', () => {
    it('validates recipient counts against engine limits', () => {
      // more than 100 groups is rejected
      let result = send_broadcast.validate!({
        uuid: 'test-uuid',
        text: 'Hi',
        recipients: Array.from({ length: 101 }, (_, i) => ({
          id: `group-${i}`,
          name: `Group ${i}`,
          type: 'group'
        }))
      });
      expect(result.valid).to.be.false;
      expect(result.errors.recipients).to.exist;

      // an expression over 1000 chars is rejected
      result = send_broadcast.validate!({
        uuid: 'test-uuid',
        text: 'Hi',
        recipients: [
          { id: '@' + 'x'.repeat(1000), name: '', type: 'expression' }
        ]
      });
      expect(result.valid).to.be.false;
      expect(result.errors.recipients).to.exist;

      // a normal mix passes
      result = send_broadcast.validate!({
        uuid: 'test-uuid',
        text: 'Hi',
        recipients: [
          { id: 'group-1', name: 'Group 1', type: 'group' },
          { id: 'contact-1', name: 'Contact 1', type: 'contact' },
          { id: '@urns.tel', name: '@urns.tel', type: 'expression' }
        ]
      });
      expect(result.valid).to.be.true;
    });

    it('validates template variable lengths against engine limits', () => {
      const result = send_broadcast.validate!({
        uuid: 'test-uuid',
        text: 'Hi',
        recipients: [{ id: 'group-1', name: 'Group 1', type: 'group' }],
        template: { uuid: 'template-1', name: 'Template' },
        template_variables: ['v'.repeat(10001)]
      });
      expect(result.valid).to.be.false;
      expect(result.errors.template).to.exist;
    });
  });

  describe('form data conversion', () => {
    it('converts action to form data correctly', () => {
      const action: SendBroadcast = {
        uuid: 'test-uuid',
        type: 'send_broadcast',
        text: 'Test message',
        groups: [{ uuid: 'group-1', name: 'Test Group' }],
        contacts: [{ uuid: 'contact-1', name: 'Test Contact' }],
        attachments: ['image/jpeg:test.jpg']
      };

      const formData = send_broadcast.toFormData(action);

      expect(formData.uuid).to.equal('test-uuid');
      expect(formData.text).to.equal('Test message');
      expect(formData.recipients).to.have.lengthOf(2);
      expect(formData.attachments).to.deep.equal(['image/jpeg:test.jpg']);
    });

    it('converts form data to action correctly with contacts only', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [
          { id: 'contact-1', name: 'Contact 1', type: 'contact' },
          { id: 'contact-2', name: 'Contact 2', type: 'contact' }
        ],
        text: 'Test message',
        attachments: []
      };

      const action = send_broadcast.fromFormData(formData) as SendBroadcast;

      expect(action.uuid).to.equal('test-uuid');
      expect(action.type).to.equal('send_broadcast');
      expect(action.text).to.equal('Test message');
      expect(action.contacts).to.have.lengthOf(2);
      expect(action.groups).to.have.lengthOf(0);
      expect(action.attachments).to.be.undefined;
    });

    it('converts form data to action correctly with groups only', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [
          { id: 'group-1', name: 'Group 1', type: 'group' },
          { id: 'group-2', name: 'Group 2', type: 'group' }
        ],
        text: 'Test message',
        attachments: []
      };

      const action = send_broadcast.fromFormData(formData) as SendBroadcast;

      expect(action.contacts).to.have.lengthOf(0);
      expect(action.groups).to.have.lengthOf(2);
    });

    it('converts form data to action correctly with mixed recipients', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [
          { id: 'contact-1', name: 'Contact 1', type: 'contact' },
          { id: 'group-1', name: 'Group 1', type: 'group' }
        ],
        text: 'Test message',
        attachments: ['image/jpeg:test.jpg']
      };

      const action = send_broadcast.fromFormData(formData) as SendBroadcast;

      expect(action.contacts).to.have.lengthOf(1);
      expect(action.groups).to.have.lengthOf(1);
      expect(action.attachments).to.deep.equal(['image/jpeg:test.jpg']);
    });

    it('sanitizes text by trimming whitespace', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [
          { id: 'contact-1', name: 'Test Contact', type: 'contact' }
        ],
        text: '  Test message  \n  '
      };

      send_broadcast.sanitize(formData);

      expect(formData.text).to.equal('Test message');
    });

    it('converts action to form data correctly with legacy_vars', () => {
      const action: SendBroadcast = {
        uuid: 'test-uuid',
        type: 'send_broadcast',
        text: 'Test message',
        groups: [],
        contacts: [],
        legacy_vars: ['@parent', '@child']
      };

      const formData = send_broadcast.toFormData(action);

      expect(formData.recipients).to.have.lengthOf(2);
      expect(formData.recipients[0]).to.deep.equal({
        id: '@parent',
        name: '@parent',
        type: 'expression'
      });
      expect(formData.recipients[1]).to.deep.equal({
        id: '@child',
        name: '@child',
        type: 'expression'
      });
    });

    it('converts form data to action correctly with expression recipients', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [
          { id: 'group-1', name: 'Group 1', type: 'group' },
          { name: '@parent', value: '@parent', expression: true }
        ],
        text: 'Test message',
        attachments: []
      };

      const action = send_broadcast.fromFormData(formData) as SendBroadcast;

      expect(action.groups).to.have.lengthOf(1);
      expect(action.contacts).to.have.lengthOf(0);
      expect(action.legacy_vars).to.deep.equal(['@parent']);
    });

    it('omits legacy_vars when no expressions present', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [{ id: 'contact-1', name: 'Contact 1', type: 'contact' }],
        text: 'Test message',
        attachments: []
      };

      const action = send_broadcast.fromFormData(formData) as SendBroadcast;

      expect(action.legacy_vars).to.be.undefined;
    });

    it('converts action to form data correctly with template', () => {
      const action: SendBroadcast = {
        uuid: 'test-uuid',
        type: 'send_broadcast',
        text: 'Hello {{1}}',
        groups: [{ uuid: 'group-1', name: 'Test Group' }],
        contacts: [],
        template: { uuid: 'template-1', name: 'greeting' },
        template_variables: ['@contact.name']
      };

      const formData = send_broadcast.toFormData(action);

      expect(formData.template).to.deep.equal({
        uuid: 'template-1',
        name: 'greeting'
      });
      expect(formData.template_variables).to.deep.equal(['@contact.name']);
    });

    it('converts form data to action correctly with template', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [{ id: 'group-1', name: 'Group 1', type: 'group' }],
        text: 'Hello {{1}}',
        attachments: [],
        template: { uuid: 'template-1', name: 'greeting' },
        template_variables: ['@contact.name']
      };

      const action = send_broadcast.fromFormData(formData) as SendBroadcast;

      expect(action.template).to.deep.equal({
        uuid: 'template-1',
        name: 'greeting'
      });
      expect(action.template_variables).to.deep.equal(['@contact.name']);
    });

    it('omits template fields when no template selected', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [{ id: 'group-1', name: 'Group 1', type: 'group' }],
        text: 'Hello',
        attachments: [],
        template: null,
        template_variables: []
      };

      const action = send_broadcast.fromFormData(formData) as SendBroadcast;

      expect(action.template).to.be.undefined;
      expect(action.template_variables).to.be.undefined;
    });

    it('should strip superfluous API metadata from contacts and groups', () => {
      const formData = {
        uuid: 'test-uuid',
        recipients: [
          {
            id: 'contact-1',
            name: 'Alice',
            type: 'contact',
            urn: 'tel:+250788123456'
          },
          {
            id: 'group-1',
            name: 'Subscribers',
            type: 'group',
            count: 500
          }
        ],
        text: 'Hello!',
        attachments: []
      };

      const action = send_broadcast.fromFormData(formData) as SendBroadcast;

      expect(action.contacts).to.have.lengthOf(1);
      expect(action.contacts[0]).to.deep.equal({
        uuid: 'contact-1',
        name: 'Alice'
      });
      expect(action.groups).to.have.lengthOf(1);
      expect(action.groups[0]).to.deep.equal({
        uuid: 'group-1',
        name: 'Subscribers'
      });
    });
  });
});
