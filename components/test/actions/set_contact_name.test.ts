import { expect } from '@open-wc/testing';
import { set_contact_name } from '../../src/flow/actions/set_contact_name';
import { SetContactName } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';

/**
 * Test suite for the set_contact_name action configuration.
 */
describe('set_contact_name action config', () => {
  const helper = new ActionTest(set_contact_name, 'set_contact_name');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(set_contact_name.name).to.equal('Update Name');
    });
  });

  describe('action scenarios', () => {
    helper.testAction(
      {
        uuid: 'test-action-1',
        type: 'set_contact_name',
        name: 'Alice Johnson'
      } as SetContactName,
      'static-name'
    );

    helper.testAction(
      {
        uuid: 'test-action-2',
        type: 'set_contact_name',
        name: '@(title(input))'
      } as SetContactName,
      'expression-name'
    );

    helper.testAction(
      {
        uuid: 'test-action-3',
        type: 'set_contact_name',
        name: ''
      } as SetContactName,
      'clear-name'
    );
  });
});
