import { expect } from '@open-wc/testing';
import { remove_contact_groups } from '../../src/flow/actions/remove_contact_groups';
import { RemoveFromGroup } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';

/**
 * Test suite for the remove_contact_groups action configuration.
 */
describe('remove_contact_groups action config', () => {
  const helper = new ActionTest(remove_contact_groups, 'remove_contact_groups');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(remove_contact_groups.name).to.equal('Remove from Group');
    });
  });

  describe('action scenarios', () => {
    helper.testAction(
      {
        uuid: 'test-action-1',
        type: 'remove_contact_groups',
        groups: [
          {
            uuid: 'group-1',
            name: 'VIP Customers',
            status: 'ready',
            system: false,
            query: '',
            count: 150
          }
        ],
        all_groups: false
      } as RemoveFromGroup,
      'single-group'
    );

    helper.testAction(
      {
        uuid: 'test-action-2',
        type: 'remove_contact_groups',
        groups: [
          {
            uuid: 'group-1',
            name: 'Newsletter Subscribers',
            status: 'ready',
            system: false,
            query: '',
            count: 1250
          },
          {
            uuid: 'group-2',
            name: 'Beta Testers',
            status: 'ready',
            system: false,
            query: '',
            count: 45
          },
          {
            uuid: 'group-3',
            name: 'Inactive Users',
            status: 'ready',
            system: false,
            query: '',
            count: 300
          }
        ],
        all_groups: false
      } as RemoveFromGroup,
      'multiple-groups'
    );

    helper.testAction(
      {
        uuid: 'test-action-3',
        type: 'remove_contact_groups',
        groups: [],
        all_groups: true
      } as RemoveFromGroup,
      'remove-from-all-groups'
    );

    helper.testAction(
      {
        uuid: 'test-action-4',
        type: 'remove_contact_groups',
        groups: [
          {
            uuid: 'group-1',
            name: 'Customers - Premium Subscription (Annual Billing)',
            status: 'ready',
            system: false,
            query: '',
            count: 89
          },
          {
            uuid: 'group-2',
            name: 'Users - Trial Period Expired (30+ Days)',
            status: 'ready',
            system: false,
            query: '',
            count: 234
          }
        ],
        all_groups: false
      } as RemoveFromGroup,
      'long-descriptive-group-names'
    );

    helper.testAction(
      {
        uuid: 'test-action-5',
        type: 'remove_contact_groups',
        groups: [
          {
            uuid: 'group-1',
            name: 'Sales Team',
            status: 'ready',
            system: false,
            query: '',
            count: 12
          },
          {
            uuid: 'group-2',
            name: 'Marketing Team',
            status: 'ready',
            system: false,
            query: '',
            count: 8
          },
          {
            uuid: 'group-3',
            name: 'Support Team',
            status: 'ready',
            system: false,
            query: '',
            count: 15
          },
          {
            uuid: 'group-4',
            name: 'Development Team',
            status: 'ready',
            system: false,
            query: '',
            count: 25
          },
          {
            uuid: 'group-5',
            name: 'QA Team',
            status: 'ready',
            system: false,
            query: '',
            count: 6
          },
          {
            uuid: 'group-6',
            name: 'Management Team',
            status: 'ready',
            system: false,
            query: '',
            count: 4
          }
        ],
        all_groups: false
      } as RemoveFromGroup,
      'many-groups'
    );

    helper.testAction(
      {
        uuid: 'test-action-6',
        type: 'remove_contact_groups',
        groups: [
          {
            uuid: 'group-1',
            name: 'Unsubscribed Users',
            status: 'ready',
            system: false,
            query: '',
            count: 567
          },
          {
            uuid: 'group-2',
            name: 'Bounced Email Addresses',
            status: 'ready',
            system: false,
            query: '',
            count: 89
          }
        ],
        all_groups: false
      } as RemoveFromGroup,
      'cleanup-groups'
    );
  });

  describe('validation edge cases', () => {
    it('fails validation when no groups selected and all_groups is false', () => {
      const action: RemoveFromGroup = {
        uuid: 'test-action',
        type: 'remove_contact_groups',
        groups: [],
        all_groups: false
      };

      const result = remove_contact_groups.validate(action);
      expect(result.valid).to.be.false;
      expect(result.errors.groups).to.equal(
        'At least one group must be selected or check "Remove from all groups"'
      );
    });

    it('fails validation when groups is undefined and all_groups is false', () => {
      const action: RemoveFromGroup = {
        uuid: 'test-action',
        type: 'remove_contact_groups',
        groups: undefined as any,
        all_groups: false
      };

      const result = remove_contact_groups.validate(action);
      expect(result.valid).to.be.false;
      expect(result.errors.groups).to.equal(
        'At least one group must be selected or check "Remove from all groups"'
      );
    });

    it('passes validation when all_groups is true even with empty groups', () => {
      const action: RemoveFromGroup = {
        uuid: 'test-action',
        type: 'remove_contact_groups',
        groups: [],
        all_groups: true
      };

      const result = remove_contact_groups.validate(action);
      expect(result.valid).to.be.true;
      expect(Object.keys(result.errors)).to.have.length(0);
    });

    it('passes validation when groups are provided and all_groups is false', () => {
      const action: RemoveFromGroup = {
        uuid: 'test-action',
        type: 'remove_contact_groups',
        groups: [
          {
            uuid: 'group-1',
            name: 'Test Group',
            status: 'ready',
            system: false,
            query: '',
            count: 10
          }
        ],
        all_groups: false
      };

      const result = remove_contact_groups.validate(action);
      expect(result.valid).to.be.true;
      expect(Object.keys(result.errors)).to.have.length(0);
    });
  });

  describe('metadata stripping', () => {
    it('should strip superfluous API metadata from groups', () => {
      const formData = {
        uuid: 'test-uuid',
        all_groups: false,
        groups: [
          {
            uuid: 'group-1',
            name: 'VIP Customers',
            query: 'status = vip',
            status: 'ready',
            count: 150,
            system: false
          }
        ]
      };

      const action = remove_contact_groups.fromFormData(
        formData
      ) as RemoveFromGroup;

      expect(action.groups).to.have.lengthOf(1);
      expect(action.groups[0]).to.deep.equal({
        uuid: 'group-1',
        name: 'VIP Customers'
      });
    });
  });
});
