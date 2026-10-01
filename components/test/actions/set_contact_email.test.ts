import { expect } from '@open-wc/testing';
import { set_contact_email } from '../../src/flow/actions/set_contact_email';
import { SetContactEmail } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';

/**
 * Test suite for the set_contact_email action configuration.
 */
describe('set_contact_email action config', () => {
  const helper = new ActionTest(set_contact_email, 'set_contact_email');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(set_contact_email.name).to.equal('Update Email');
    });
  });

  describe('action scenarios', () => {
    helper.testAction(
      {
        uuid: 'test-action-1',
        type: 'set_contact_email',
        email: 'alice@example.com'
      } as SetContactEmail,
      'static-email'
    );

    helper.testAction(
      {
        uuid: 'test-action-2',
        type: 'set_contact_email',
        email: '@(lower(input))'
      } as SetContactEmail,
      'expression-email'
    );

    helper.testAction(
      {
        uuid: 'test-action-3',
        type: 'set_contact_email',
        email: ''
      } as SetContactEmail,
      'clear-email'
    );
  });
});
