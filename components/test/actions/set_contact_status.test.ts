import { expect } from '@open-wc/testing';
import { set_contact_status } from '../../src/flow/actions/set_contact_status';
import { SetContactStatus } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';

/**
 * Test suite for the set_contact_status action configuration.
 */
describe('set_contact_status action config', () => {
  const helper = new ActionTest(set_contact_status, 'set_contact_status');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(set_contact_status.name).to.equal('Update Status');
    });
  });

  describe('action scenarios', () => {
    helper.testAction(
      {
        uuid: 'test-action-1',
        type: 'set_contact_status',
        status: 'active'
      } as SetContactStatus,
      'active'
    );

    helper.testAction(
      {
        uuid: 'test-action-2',
        type: 'set_contact_status',
        status: 'blocked'
      } as SetContactStatus,
      'blocked'
    );

    helper.testAction(
      {
        uuid: 'test-action-3',
        type: 'set_contact_status',
        status: 'archived'
      } as SetContactStatus,
      'archived'
    );
  });

  describe('round-trip', () => {
    it('keeps a status it has no option for', () => {
      const action = {
        uuid: 'test-uuid',
        type: 'set_contact_status',
        status: 'paused'
      } as any;

      const formData = set_contact_status.toFormData(action);
      expect(formData.status).to.deep.equal([
        { value: 'paused', name: 'Paused' }
      ]);
      expect(
        (set_contact_status.fromFormData(formData) as SetContactStatus).status
      ).to.equal('paused');
    });

    it('should extract status value from select option', () => {
      const formData = {
        uuid: 'test-uuid',
        status: [{ value: 'stopped', name: 'Stopped' }]
      };

      const action = set_contact_status.fromFormData(
        formData
      ) as SetContactStatus;

      expect(action.status).to.equal('stopped');
      expect(action.type).to.equal('set_contact_status');
    });
  });
});
