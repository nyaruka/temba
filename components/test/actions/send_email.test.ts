import { expect } from '@open-wc/testing';
import { send_email } from '../../src/flow/actions/send_email';
import { SendEmail } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';

/**
 * Test suite for the send_email action configuration.
 */
describe('send_email action config', () => {
  const helper = new ActionTest(send_email, 'send_email');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(send_email.name).to.equal('Send Email');
    });
  });

  describe('action scenarios', () => {
    helper.testEditor(
      {
        uuid: 'test-action-1',
        type: 'send_email',
        addresses: ['user@example.com'],
        subject: 'Welcome!',
        body: 'Thank you for signing up.'
      } as SendEmail,
      'missing-feature',
      []
    );

    helper.testAction(
      {
        uuid: 'test-action-1',
        type: 'send_email',
        addresses: ['user@example.com'],
        subject: 'Welcome!',
        body: 'Thank you for signing up.'
      } as SendEmail,
      'simple-email'
    );

    helper.testAction(
      {
        uuid: 'test-action-2',
        type: 'send_email',
        addresses: [
          'user1@example.com',
          'user2@example.com',
          'user3@example.com'
        ],
        subject: 'Multiple Recipients',
        body: 'This email is sent to multiple recipients.'
      } as SendEmail,
      'multiple-recipients'
    );

    helper.testAction(
      {
        uuid: 'test-action-3',
        type: 'send_email',
        addresses: ['admin@company.com'],
        subject: 'Multi-line Email Content',
        body: 'Dear User,\n\nThis is a multi-line email body.\n\nIt contains multiple paragraphs and line breaks.\n\nBest regards,\nThe Team'
      } as SendEmail,
      'multiline-body'
    );

    helper.testAction(
      {
        uuid: 'test-action-4',
        type: 'send_email',
        addresses: ['support@company.com'],
        subject: 'Email with expressions',
        body: 'Hello @contact.name,\n\nYour order @run.results.order_id has been processed.\n\nThank you!'
      } as SendEmail,
      'with-expressions'
    );

    helper.testAction(
      {
        uuid: 'test-action-5',
        type: 'send_email',
        addresses: ['notification@company.com'],
        subject:
          'Very Long Subject Line That Could Potentially Exceed Normal Length Limits To Test Subject Field Handling',
        body: 'Short body content.'
      } as SendEmail,
      'long-subject'
    );

    helper.testAction(
      {
        uuid: 'test-action-6',
        type: 'send_email',
        addresses: [
          'customer.service@department.company.com',
          'technical.support@department.company.com',
          'billing.inquiries@department.company.com'
        ],
        subject: 'Customer Support Escalation',
        body: 'Customer Name: @contact.name\nTicket ID: @run.results.ticket_id\n\nIssue Description:\n@run.results.issue_description\n\nPriority: High\nCategory: @run.results.category\n\nPlease respond within 2 hours.'
      } as SendEmail,
      'complex-business-email'
    );

    helper.testAction(
      {
        uuid: 'test-action-7',
        type: 'send_email',
        addresses: ['alerts@company.com'],
        subject: '',
        body: 'Email with empty subject'
      } as SendEmail,
      'empty-subject'
    );

    helper.testAction(
      {
        uuid: 'test-action-8',
        type: 'send_email',
        addresses: ['test@company.com'],
        subject: 'Empty body test',
        body: ''
      } as SendEmail,
      'empty-body'
    );
  });

  describe('validation edge cases', () => {
    it('fails validation for empty addresses array', () => {
      const formData = {
        uuid: 'test-action',
        addresses: [],
        subject: 'Test Subject',
        body: 'Test Body'
      };

      const result = send_email.validate(formData);
      expect(result.valid).to.be.false;
      expect(result.errors.addresses).to.equal(
        'At least one recipient email address is required'
      );
    });

    it('fails validation for null addresses', () => {
      const formData = {
        uuid: 'test-action',
        addresses: null as any,
        subject: 'Test Subject',
        body: 'Test Body'
      };

      const result = send_email.validate(formData);
      expect(result.valid).to.be.false;
      expect(result.errors.addresses).to.equal(
        'At least one recipient email address is required'
      );
    });

    it('fails validation for undefined addresses', () => {
      const formData = {
        uuid: 'test-action',
        addresses: undefined as any,
        subject: 'Test Subject',
        body: 'Test Body'
      };

      const result = send_email.validate(formData);
      expect(result.valid).to.be.false;
      expect(result.errors.addresses).to.equal(
        'At least one recipient email address is required'
      );
    });

    it('passes validation with valid email addresses', () => {
      const formData = {
        uuid: 'test-action',
        addresses: [{ name: 'valid@example.com', value: 'valid@example.com' }],
        subject: 'Test Subject',
        body: 'Test Body'
      };

      const result = send_email.validate(formData);
      expect(result.valid).to.be.true;
      expect(Object.keys(result.errors)).to.have.length(0);
    });

    it('passes validation with multiple email addresses', () => {
      const formData = {
        uuid: 'test-action',
        addresses: [
          { name: 'user1@example.com', value: 'user1@example.com' },
          { name: 'user2@example.com', value: 'user2@example.com' },
          { name: 'user3@example.com', value: 'user3@example.com' }
        ],
        subject: 'Test Subject',
        body: 'Test Body'
      };

      const result = send_email.validate(formData);
      expect(result.valid).to.be.true;
      expect(Object.keys(result.errors)).to.have.length(0);
    });

    it('passes validation with empty subject and body', () => {
      const formData = {
        uuid: 'test-action',
        addresses: [{ name: 'test@example.com', value: 'test@example.com' }],
        subject: '',
        body: ''
      };

      const result = send_email.validate(formData);
      expect(result.valid).to.be.true;
      expect(Object.keys(result.errors)).to.have.length(0);
    });
  });
});
