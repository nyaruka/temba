import { expect } from '@open-wc/testing';
import { enter_flow } from '../../src/flow/actions/enter_flow';
import { EnterFlow } from '../../src/store/flow-definition';
import { ActionTest } from '../ActionHelper';

/**
 * Test suite for the enter_flow action configuration.
 */
describe('enter_flow action config', () => {
  const helper = new ActionTest(enter_flow, 'enter_flow');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(enter_flow.name).to.equal('Enter a Flow');
    });

    it('only offers flows that are not archived', () => {
      expect((enter_flow.form.flow as any).endpoint).to.equal(
        '/api/v2/flows.json?archived=false'
      );
    });
  });

  describe('action scenarios', () => {
    helper.testAction(
      {
        uuid: 'test-action-1',
        type: 'enter_flow',
        terminal: true,
        flow: { uuid: 'flow-1', name: 'Registration Flow' }
      } as EnterFlow,
      'basic-flow'
    );

    helper.testAction(
      {
        uuid: 'test-action-2',
        type: 'enter_flow',
        terminal: true,
        flow: {
          uuid: 'flow-2',
          name: 'Very Long Flow Name That Tests Layout Wrapping'
        }
      } as EnterFlow,
      'long-flow-name'
    );
  });

  describe('metadata stripping', () => {
    it('should strip superfluous API metadata from flow', () => {
      const formData = {
        uuid: 'test-uuid',
        flow: [
          {
            uuid: 'flow-1',
            name: 'Registration Flow',
            type: 'message',
            archived: false,
            labels: [],
            expires: 720,
            runs: { active: 0, waiting: 5, completed: 100 },
            results: [],
            parent_refs: [],
            created_on: '2024-01-01T00:00:00.000Z',
            modified_on: '2024-06-15T12:00:00.000Z'
          }
        ]
      };

      const action = enter_flow.fromFormData(formData) as EnterFlow;

      expect(action.flow).to.deep.equal({
        uuid: 'flow-1',
        name: 'Registration Flow'
      });
    });

    it('should handle flow selected via value key', () => {
      const formData = {
        uuid: 'test-uuid',
        flow: [{ value: 'flow-1', name: 'Test Flow' }]
      };

      const action = enter_flow.fromFormData(formData) as EnterFlow;

      expect(action.flow).to.deep.equal({
        uuid: 'flow-1',
        name: 'Test Flow'
      });
    });
  });
});
