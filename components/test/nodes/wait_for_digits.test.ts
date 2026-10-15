import { expect } from '@open-wc/testing';
import { wait_for_digits } from '../../src/flow/nodes/wait_for_digits';
import { Node } from '../../src/store/flow-definition';
import { NodeTest } from '../NodeHelper';
import { createOperatorOption } from '../../src/flow/operators';

/**
 * Test suite for the wait_for_digits node configuration.
 */
describe('wait_for_digits node config', () => {
  const helper = new NodeTest(wait_for_digits, 'wait_for_digits');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(wait_for_digits.name).to.equal('Wait for Digits');
    });

    it('has correct type', () => {
      expect(wait_for_digits.type).to.equal('wait_for_digits');
    });

    it('is voice-only', () => {
      expect(wait_for_digits.flowTypes).to.deep.equal(['voice']);
    });

    it('has form with rules and result_name', () => {
      expect(wait_for_digits.form).to.exist;
      expect(wait_for_digits.form!.rules).to.exist;
      expect(wait_for_digits.form!.result_name).to.exist;
    });

    it('has layout configuration', () => {
      expect(wait_for_digits.layout).to.have.lengthOf(3);
      expect(wait_for_digits.layout[0]).to.deep.equal({
        type: 'text',
        text: 'Rules match against all digits pressed by the caller followed by the # sign.'
      });
      expect(wait_for_digits.layout[1]).to.equal('rules');
      expect((wait_for_digits.layout[2] as any).type).to.equal('extras');
    });

    it('has large dialog size', () => {
      expect(wait_for_digits.dialogSize).to.equal('large');
    });
  });

  describe('node scenarios', () => {
    it('renders basic digits wait', async () => {
      await helper.testNode(
        {
          uuid: 'test-digits-node-1',
          actions: [],
          router: {
            type: 'switch',
            operand: '@input.text',
            wait: {
              type: 'msg',
              hint: {
                type: 'digits'
              }
            },
            result_name: 'digits',
            default_category_uuid: 'all-cat',
            cases: [],
            categories: [
              {
                uuid: 'all-cat',
                name: 'All Responses',
                exit_uuid: 'all-exit'
              }
            ]
          },
          exits: [{ uuid: 'all-exit', destination_uuid: null }]
        } as Node,
        { type: 'wait_for_digits' },
        'basic-digits-wait'
      );
    });

    it('renders digits with rules', async () => {
      await helper.testNode(
        {
          uuid: 'test-digits-node-2',
          actions: [],
          router: {
            type: 'switch',
            operand: '@input.text',
            wait: {
              type: 'msg',
              hint: {
                type: 'digits'
              }
            },
            result_name: 'pin',
            default_category_uuid: 'other-cat',
            cases: [
              {
                uuid: 'case-1',
                type: 'has_number_eq',
                arguments: ['1234'],
                category_uuid: 'valid-cat'
              }
            ],
            categories: [
              {
                uuid: 'valid-cat',
                name: 'Valid PIN',
                exit_uuid: 'valid-exit'
              },
              {
                uuid: 'other-cat',
                name: 'Other',
                exit_uuid: 'other-exit'
              }
            ]
          },
          exits: [
            { uuid: 'valid-exit', destination_uuid: null },
            { uuid: 'other-exit', destination_uuid: null }
          ]
        } as Node,
        { type: 'wait_for_digits' },
        'digits-with-rules'
      );
    });
  });

  describe('data transformation', () => {
    it('converts node to form data', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          result_name: 'digits',
          operand: '@input.text',
          categories: [
            {
              uuid: 'valid-cat',
              name: 'Valid',
              exit_uuid: 'valid-exit'
            },
            {
              uuid: 'other-cat',
              name: 'Other',
              exit_uuid: 'other-exit'
            }
          ],
          cases: [
            {
              uuid: 'case-1',
              type: 'has_number_eq',
              arguments: ['1234'],
              category_uuid: 'valid-cat'
            }
          ]
        },
        exits: [
          { uuid: 'valid-exit', destination_uuid: null },
          { uuid: 'other-exit', destination_uuid: null }
        ]
      };

      const formData = wait_for_digits.toFormData!(node);

      expect(formData.uuid).to.equal('test-node');
      expect(formData.result_name).to.equal('digits');
      expect(formData.rules).to.have.length(1);
      expect(formData.rules[0]).to.deep.equal({
        operator: createOperatorOption('has_number_eq'),
        value1: '1234',
        value2: '',
        category: 'Valid'
      });
    });

    it('converts node with no rules to form data', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          result_name: 'digits',
          categories: []
        },
        exits: []
      };

      const formData = wait_for_digits.toFormData!(node);
      expect(formData.rules).to.deep.equal([]);
      expect(formData.result_name).to.equal('digits');
    });

    it('converts form data to node with rules', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'digits',
        rules: [
          {
            operator: { value: 'has_number_eq', name: 'is equal to' },
            value1: '1234',
            value2: '',
            category: 'Valid PIN'
          }
        ]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [],
        router: { type: 'switch', categories: [] }
      };

      const result = wait_for_digits.fromFormData!(formData, originalNode);

      expect(result.uuid).to.equal('test-node');
      expect(result.router?.result_name).to.equal('digits');
      expect(result.router?.operand).to.equal('@input.text');
      expect(result.router?.categories).to.have.length(2); // Valid PIN, Other
      expect(result.router?.cases).to.have.length(1);
      expect(result.exits).to.have.length(2);

      // Check wait config has digits hint (without count)
      expect(result.router?.wait?.type).to.equal('msg');
      expect(result.router?.wait?.hint?.type).to.equal('digits');
      expect(result.router?.wait?.hint?.count).to.be.undefined;
    });

    it('converts form data with no rules', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'digits',
        rules: []
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [],
        router: { type: 'switch', categories: [] }
      };

      const result = wait_for_digits.fromFormData!(formData, originalNode);

      // Should have just "All Responses" default category (no user rules)
      expect(result.router?.categories).to.have.length(1);
      expect(result.router!.categories[0].name).to.equal('All Responses');
      expect(result.router?.cases).to.have.length(0);
      expect(result.router?.wait?.hint?.type).to.equal('digits');
    });

    it('preserves category UUIDs', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'digits',
        rules: [
          {
            operator: { value: 'has_number_eq', name: 'is equal to' },
            value1: '1234',
            value2: '',
            category: 'Valid'
          }
        ]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          categories: [
            {
              uuid: 'orig-valid',
              name: 'Valid',
              exit_uuid: 'orig-valid-exit'
            },
            {
              uuid: 'orig-other',
              name: 'Other',
              exit_uuid: 'orig-other-exit'
            }
          ],
          cases: [
            {
              uuid: 'orig-case',
              type: 'has_number_eq',
              arguments: ['1234'],
              category_uuid: 'orig-valid'
            }
          ]
        },
        exits: [
          { uuid: 'orig-valid-exit', destination_uuid: 'dest-1' },
          { uuid: 'orig-other-exit', destination_uuid: null }
        ]
      };

      const result = wait_for_digits.fromFormData!(formData, originalNode);

      const valid = result.router!.categories.find((c) => c.name === 'Valid');
      expect(valid?.uuid).to.equal('orig-valid');
      expect(valid?.exit_uuid).to.equal('orig-valid-exit');

      const other = result.router!.categories.find((c) => c.name === 'Other');
      expect(other?.uuid).to.equal('orig-other');
    });
  });

  describe('validation', () => {
    it('validates with no errors', () => {
      const formData = { rules: [] };
      const result = wait_for_digits.validate!(formData);
      expect(result.valid).to.be.true;
    });
  });
});
