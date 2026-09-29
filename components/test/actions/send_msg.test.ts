import { expect } from '@open-wc/testing';
import { send_msg } from '../../src/flow/actions/send_msg';
import { SendMsg } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';

/**
 * Test suite for the send_msg action configuration.
 */
describe('send_msg action config', () => {
  const helper = new ActionTest(send_msg, 'send_msg');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(send_msg.name).to.equal('Send Message');
    });
  });

  describe('action scenarios', () => {
    helper.testAction(
      {
        uuid: 'test-action-1',
        type: 'send_msg',
        text: 'Hello world!',
        quick_replies: []
      } as SendMsg,
      'simple-text'
    );

    helper.testAction(
      {
        uuid: 'test-action-2',
        type: 'send_msg',
        text: 'Hello\nworld!\nHow are you?',
        quick_replies: []
      } as SendMsg,
      'text-with-linebreaks'
    );

    helper.testAction(
      {
        uuid: 'test-action-3',
        type: 'send_msg',
        text: 'Choose an option:',
        quick_replies: ['Yes', 'No', 'Maybe']
      } as SendMsg,
      'text-with-quick-replies'
    );

    helper.testAction(
      {
        uuid: 'test-action-4',
        type: 'send_msg',
        text: 'Rate our service:',
        quick_replies: [
          '⭐',
          '⭐⭐',
          '⭐⭐⭐',
          '⭐⭐⭐⭐',
          '⭐⭐⭐⭐⭐',
          'Not applicable'
        ]
      } as SendMsg,
      'text-with-many-quick-replies'
    );

    helper.testAction(
      {
        uuid: 'test-action-5',
        type: 'send_msg',
        text: 'Welcome to our service!\n\nPlease choose from the following options:\n- Option A: Basic plan\n- Option B: Premium plan\n- Option C: Enterprise plan',
        quick_replies: ['Basic', 'Premium', 'Enterprise']
      } as SendMsg,
      'multiline-text-with-replies'
    );

    helper.testAction(
      {
        uuid: 'test-action-6',
        type: 'send_msg',
        text: 'Which department would you like to contact?',
        quick_replies: [
          'Customer Support Department',
          'Technical Support Team',
          'Billing and Accounts Department',
          'Sales and Marketing Division'
        ]
      } as SendMsg,
      'long-quick-replies'
    );

    helper.testAction(
      {
        uuid: 'test-action-7',
        type: 'send_msg',
        text: 'This action definition is missing quick_replies altogether.'
      } as SendMsg,
      'text-without-quick-replies'
    );

    helper.testRender(
      {
        uuid: 'test-action-8',
        type: 'send_msg',
        text: 'Here is your receipt',
        attachments: [
          'image/jpeg:https://example.com/media/photo%20one.jpg',
          'application/pdf:https://example.com/media/receipt.pdf',
          'image:@contact.photo'
        ],
        quick_replies: ['Thanks']
      } as SendMsg,
      'text-with-attachments'
    );

    helper.testRender(
      {
        uuid: 'test-action-9',
        type: 'send_msg',
        text: 'This message is long enough that it will be split into more than one SMS when it is sent, so the node shows a character count below everything else in the message.',
        attachments: ['image/jpeg:https://example.com/media/photo.jpg'],
        quick_replies: ['Yes', 'No']
      } as SendMsg,
      'multipart-with-attachments'
    );

    helper.testRender(
      {
        uuid: 'test-action-10',
        type: 'send_msg',
        text: 'This message is long enough that it will be split into more than one SMS when it is sent, and it also has enough attachments that their icons wrap onto a second row.',
        attachments: Array(9).fill('image/jpeg:https://example.com/photo.jpg'),
        quick_replies: ['red', 'blue', 'green']
      } as SendMsg,
      'multipart-with-many-attachments'
    );
  });

  describe('validation edge cases', () => {
    it('passes validation with valid text', () => {
      const formData = {
        uuid: 'test-action',
        text: 'Hello world',
        attachments: [],
        runtime_attachments: []
      };

      const result = send_msg.validate(formData);
      expect(result.valid).to.be.true;
      expect(Object.keys(result.errors)).to.have.length(0);
    });

    it('fails validation when total attachments exceed 10', () => {
      const formData = {
        uuid: 'test-action',
        text: 'Hello world',
        attachments: Array(6).fill('image/jpeg:http://example.com/image.jpg'),
        runtime_attachments: Array(5).fill({
          type: [{ name: 'Image', value: 'image' }],
          expression: '@contact.photo'
        })
      };

      const result = send_msg.validate(formData);
      expect(result.valid).to.be.false;
      expect(result.errors.text).to.equal(
        'Each message can only have up to 10 total attachments'
      );
      expect(result.errors.runtime_attachments).to.equal(
        'Each message can only have up to 10 attachments'
      );
    });

    it('fails validation when a template variable exceeds 10000 chars', () => {
      const formData = {
        uuid: 'test-action',
        text: 'Hello world',
        attachments: [],
        runtime_attachments: [],
        template: { uuid: 'template-1', name: 'Template' },
        template_variables: ['v'.repeat(10001)]
      };

      const result = send_msg.validate(formData);
      expect(result.valid).to.be.false;
      expect(result.errors.template).to.exist;
    });

    it('passes validation with exactly 10 attachments', () => {
      const formData = {
        uuid: 'test-action',
        text: 'Hello world',
        attachments: Array(5).fill('image/jpeg:http://example.com/image.jpg'),
        runtime_attachments: Array(5).fill({
          type: [{ name: 'Image', value: 'image' }],
          expression: '@contact.photo'
        })
      };

      const result = send_msg.validate(formData);
      expect(result.valid).to.be.true;
      expect(Object.keys(result.errors)).to.have.length(0);
    });
  });
});
