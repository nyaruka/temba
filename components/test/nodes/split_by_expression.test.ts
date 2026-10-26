import { expect } from '@open-wc/testing';
import { split_by_expression } from '../../src/flow/nodes/split_by_expression';
import { Node } from '../../src/store/flow-definition';
import { NodeTest } from '../NodeHelper';

/**
 * Test suite for the split_by_expression node configuration.
 */
describe('split_by_expression node config', () => {
  const helper = new NodeTest(split_by_expression, 'split_by_expression');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(split_by_expression.name).to.equal('Split by Expression');
    });

    it('has correct type', () => {
      expect(split_by_expression.type).to.equal('split_by_expression');
    });
  });

  describe('toFormData', () => {
    it('should transform node with rules to form data correctly', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@fields.age',
          cases: [
            {
              uuid: 'case-1',
              type: 'has_number_gte',
              arguments: ['18'],
              category_uuid: 'cat-1'
            },
            {
              uuid: 'case-2',
              type: 'has_number_between',
              arguments: ['13', '17'],
              category_uuid: 'cat-2'
            },
            {
              uuid: 'case-3',
              type: 'has_number_lt',
              arguments: ['13'],
              category_uuid: 'cat-3'
            }
          ],
          categories: [
            { uuid: 'cat-1', name: 'Adult', exit_uuid: 'exit-1' },
            { uuid: 'cat-2', name: 'Teen', exit_uuid: 'exit-2' },
            { uuid: 'cat-3', name: 'Child', exit_uuid: 'exit-3' },
            { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
          ],
          default_category_uuid: 'cat-other'
        },
        exits: [
          { uuid: 'exit-1', destination_uuid: null },
          { uuid: 'exit-2', destination_uuid: null },
          { uuid: 'exit-3', destination_uuid: null },
          { uuid: 'exit-other', destination_uuid: null }
        ]
      };

      const formData = split_by_expression.toFormData!(node);

      expect(formData.uuid).to.equal('test-node-uuid');
      expect(formData.operand).to.equal('@fields.age');
      expect(formData.rules).to.have.lengthOf(3);

      // Check first rule
      expect(formData.rules[0].operator.value).to.equal('has_number_gte');
      expect(formData.rules[0].value1).to.equal('18');
      expect(formData.rules[0].category).to.equal('Adult');

      // Check second rule (two operands)
      expect(formData.rules[1].operator.value).to.equal('has_number_between');
      expect(formData.rules[1].value1).to.equal('13');
      expect(formData.rules[1].value2).to.equal('17');
      expect(formData.rules[1].category).to.equal('Teen');

      // Check third rule
      expect(formData.rules[2].operator.value).to.equal('has_number_lt');
      expect(formData.rules[2].value1).to.equal('13');
      expect(formData.rules[2].category).to.equal('Child');
    });

    it('should transform node with no rules to form data correctly', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [
            {
              uuid: 'cat-all',
              name: 'All Responses',
              exit_uuid: 'exit-all'
            }
          ],
          default_category_uuid: 'cat-all'
        },
        exits: [{ uuid: 'exit-all', destination_uuid: null }]
      };

      const formData = split_by_expression.toFormData!(node);

      expect(formData.uuid).to.equal('test-node-uuid');
      expect(formData.operand).to.equal('@input.text');
      expect(formData.rules).to.have.lengthOf(0);
    });

    it('should handle result_name in toFormData', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@fields.color',
          result_name: 'Color Choice',
          cases: [],
          categories: [
            {
              uuid: 'cat-all',
              name: 'All Responses',
              exit_uuid: 'exit-all'
            }
          ],
          default_category_uuid: 'cat-all'
        },
        exits: [{ uuid: 'exit-all', destination_uuid: null }]
      };

      const formData = split_by_expression.toFormData!(node);

      expect(formData.result_name).to.equal('Color Choice');
    });

    it('should handle zero-operand operators', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [
            {
              uuid: 'case-1',
              type: 'has_number',
              arguments: [],
              category_uuid: 'cat-1'
            }
          ],
          categories: [
            { uuid: 'cat-1', name: 'Has Number', exit_uuid: 'exit-1' },
            { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
          ],
          default_category_uuid: 'cat-other'
        },
        exits: [
          { uuid: 'exit-1', destination_uuid: null },
          { uuid: 'exit-other', destination_uuid: null }
        ]
      };

      const formData = split_by_expression.toFormData!(node);

      expect(formData.rules).to.have.lengthOf(1);
      expect(formData.rules[0].operator.value).to.equal('has_number');
      expect(formData.rules[0].value1).to.equal('');
      expect(formData.rules[0].value2).to.equal('');
    });
  });

  describe('fromFormData', () => {
    it('should transform form data with rules to node correctly', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@fields.age',
        rules: [
          {
            operator: {
              value: 'has_number_gte',
              name: 'has a number at or above'
            },
            value1: '18',
            value2: '',
            category: 'Adult'
          },
          {
            operator: {
              value: 'has_number_between',
              name: 'has a number between'
            },
            value1: '13',
            value2: '17',
            category: 'Teen'
          }
        ],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.uuid).to.equal('test-node-uuid');
      expect(resultNode.router).to.exist;
      expect(resultNode.router!.operand).to.equal('@fields.age');
      expect(resultNode.router!.type).to.equal('switch');
      expect(resultNode.router!.cases).to.have.lengthOf(2);
      expect(resultNode.router!.categories).to.have.lengthOf(3); // 2 rules + Other

      // Check first case
      const case1 = resultNode.router!.cases![0];
      expect(case1.type).to.equal('has_number_gte');
      expect(case1.arguments).to.deep.equal(['18']);

      // Check second case (should split into two arguments)
      const case2 = resultNode.router!.cases![1];
      expect(case2.type).to.equal('has_number_between');
      expect(case2.arguments).to.deep.equal(['13', '17']);

      // Check categories
      const adultCategory = resultNode.router!.categories!.find(
        (cat) => cat.name === 'Adult'
      );
      expect(adultCategory).to.exist;

      const teenCategory = resultNode.router!.categories!.find(
        (cat) => cat.name === 'Teen'
      );
      expect(teenCategory).to.exist;

      const otherCategory = resultNode.router!.categories!.find(
        (cat) => cat.name === 'Other'
      );
      expect(otherCategory).to.exist;

      // Check exits match categories
      expect(resultNode.exits).to.have.lengthOf(3);
    });

    it('should preserve expression operands with spaces for has_number_between', () => {
      const minExpression =
        '@(extract(webhook.json.queryData[0], "minLength"))';
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@fields.value',
        rules: [
          {
            operator: {
              value: 'has_number_between',
              name: 'has a number between'
            },
            value1: minExpression,
            value2: '20',
            category: 'In Range'
          }
        ],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router!.cases![0].type).to.equal('has_number_between');
      expect(resultNode.router!.cases![0].arguments).to.deep.equal([
        minExpression,
        '20'
      ]);

      const roundTripFormData = split_by_expression.toFormData!(resultNode);
      expect(roundTripFormData.rules[0].value1).to.equal(minExpression);
      expect(roundTripFormData.rules[0].value2).to.equal('20');
    });

    it('should handle empty rules', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@fields.status',
        rules: [],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router).to.exist;
      expect(resultNode.router!.operand).to.equal('@fields.status');
      expect(resultNode.router!.cases).to.have.lengthOf(0);
      expect(resultNode.router!.categories).to.have.lengthOf(1);
      expect(resultNode.router!.categories![0].name).to.equal('All Responses');
    });

    it('should preserve UUIDs when editing existing node', () => {
      const existingNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@fields.age',
          cases: [
            {
              uuid: 'existing-case-1',
              type: 'has_number_gte',
              arguments: ['18'],
              category_uuid: 'existing-cat-1'
            }
          ],
          categories: [
            {
              uuid: 'existing-cat-1',
              name: 'Adult',
              exit_uuid: 'existing-exit-1'
            },
            {
              uuid: 'existing-cat-other',
              name: 'Other',
              exit_uuid: 'existing-exit-other'
            }
          ],
          default_category_uuid: 'existing-cat-other'
        },
        exits: [
          { uuid: 'existing-exit-1', destination_uuid: 'next-node-1' },
          { uuid: 'existing-exit-other', destination_uuid: 'next-node-2' }
        ]
      };

      // load the node into the form and rename its category, as the editor would
      const formData = split_by_expression.toFormData!(existingNode);
      formData.rules[0].category = 'Grown Up';

      const resultNode = split_by_expression.fromFormData!(
        formData,
        existingNode
      );

      // Check that UUIDs are preserved
      const adultCategory = resultNode.router!.categories!.find(
        (cat) => cat.name === 'Grown Up'
      );
      expect(adultCategory!.uuid).to.equal('existing-cat-1');
      expect(adultCategory!.exit_uuid).to.equal('existing-exit-1');
      expect(resultNode.router!.cases![0].uuid).to.equal('existing-case-1');

      // Check that destination_uuid is preserved
      const adultExit = resultNode.exits!.find(
        (exit) => exit.uuid === 'existing-exit-1'
      );
      expect(adultExit!.destination_uuid).to.equal('next-node-1');

      // Check Other category UUID is preserved
      const otherCategory = resultNode.router!.categories!.find(
        (cat) => cat.name === 'Other'
      );
      expect(otherCategory!.uuid).to.equal('existing-cat-other');
    });

    it('should handle multiple rules with same category', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@fields.color',
        rules: [
          {
            operator: { value: 'has_any_word', name: 'has any of the words' },
            value1: 'red',
            value2: '',
            category: 'Warm'
          },
          {
            operator: { value: 'has_any_word', name: 'has any of the words' },
            value1: 'orange',
            value2: '',
            category: 'Warm'
          },
          {
            operator: { value: 'has_any_word', name: 'has any of the words' },
            value1: 'blue',
            value2: '',
            category: 'Cool'
          }
        ],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      // Should have 3 cases but only 3 categories (Warm, Cool, Other)
      expect(resultNode.router!.cases).to.have.lengthOf(3);
      expect(resultNode.router!.categories).to.have.lengthOf(3);

      // Check that both "Warm" rules point to the same category
      const warmCategory = resultNode.router!.categories!.find(
        (cat) => cat.name === 'Warm'
      );
      expect(warmCategory).to.exist;

      const warmCases = resultNode.router!.cases!.filter(
        (case_) => case_.category_uuid === warmCategory!.uuid
      );
      expect(warmCases).to.have.lengthOf(2);

      // Should only have 3 exits (Warm, Cool, Other)
      expect(resultNode.exits).to.have.lengthOf(3);
    });

    it('should handle result_name in fromFormData', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@fields.priority',
        rules: [],
        result_name: 'Priority Level'
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router!.result_name).to.equal('Priority Level');
    });

    it('should not set result_name if empty', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@fields.status',
        rules: [],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router!.result_name).to.be.undefined;
    });

    it('should handle zero-operand operators in fromFormData', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@input.text',
        rules: [
          {
            operator: { value: 'has_number', name: 'has a number' },
            value1: '',
            value2: '',
            category: 'Has Number'
          }
        ],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router!.cases).to.have.lengthOf(1);
      expect(resultNode.router!.cases![0].type).to.equal('has_number');
      expect(resultNode.router!.cases![0].arguments).to.deep.equal([]);
    });

    it('should filter out incomplete rules', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@fields.age',
        rules: [
          {
            operator: {
              value: 'has_number_gte',
              name: 'has a number at or above'
            },
            value1: '18',
            value2: '',
            category: 'Adult'
          },
          {
            operator: { value: 'has_number_lt', name: 'has a number below' },
            value1: '', // Missing value1
            value2: '',
            category: 'Child'
          },
          {
            operator: {
              value: 'has_number_between',
              name: 'has a number between'
            },
            value1: '10',
            value2: '', // Missing value2 for 2-operand operator
            category: 'Teen'
          }
        ],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      // Only the first complete rule should be included
      expect(resultNode.router!.cases).to.have.lengthOf(1);
      expect(resultNode.router!.cases![0].type).to.equal('has_number_gte');
      expect(resultNode.router!.categories).to.have.lengthOf(2); // Adult + Other
    });

    it('should handle string operator format', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '@fields.name',
        rules: [
          {
            operator: 'has_any_word', // String format instead of object
            value1: 'john',
            value2: '',
            category: 'Name'
          }
        ],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router!.cases).to.have.lengthOf(1);
      expect(resultNode.router!.cases![0].type).to.equal('has_any_word');
      expect(resultNode.router!.cases![0].arguments).to.deep.equal(['john']);
    });

    it('should default operand to @input.text if not provided', () => {
      const formData = {
        uuid: 'test-node-uuid',
        operand: '', // Empty operand
        rules: [],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@input.text',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router!.operand).to.equal('@input.text');
    });
  });

  describe('validate', () => {
    it('should validate that operand is required', () => {
      const formData = {
        operand: '',
        rules: []
      };

      const result = split_by_expression.validate!(formData);

      expect(result.valid).to.be.false;
      expect(result.errors.operand).to.exist;
    });

    it('should validate successfully with operand', () => {
      const formData = {
        operand: '@fields.age',
        rules: []
      };

      const result = split_by_expression.validate!(formData);

      expect(result.valid).to.be.true;
      expect(Object.keys(result.errors)).to.have.lengthOf(0);
    });
  });

  describe('round-trip transformation', () => {
    it('should preserve node structure through toFormData -> fromFormData', () => {
      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@fields.temperature',
          result_name: 'Temp Category',
          cases: [
            {
              uuid: 'case-hot',
              type: 'has_number_gt',
              arguments: ['30'],
              category_uuid: 'cat-hot'
            },
            {
              uuid: 'case-cold',
              type: 'has_number_lt',
              arguments: ['10'],
              category_uuid: 'cat-cold'
            }
          ],
          categories: [
            { uuid: 'cat-hot', name: 'Hot', exit_uuid: 'exit-hot' },
            { uuid: 'cat-cold', name: 'Cold', exit_uuid: 'exit-cold' },
            { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
          ],
          default_category_uuid: 'cat-other'
        },
        exits: [
          { uuid: 'exit-hot', destination_uuid: 'next-1' },
          { uuid: 'exit-cold', destination_uuid: 'next-2' },
          { uuid: 'exit-other', destination_uuid: 'next-3' }
        ]
      };

      const formData = split_by_expression.toFormData!(originalNode);
      const resultNode = split_by_expression.fromFormData!(
        formData,
        originalNode
      );

      // Check basic structure
      expect(resultNode.uuid).to.equal(originalNode.uuid);
      expect(resultNode.router!.operand).to.equal(originalNode.router!.operand);
      expect(resultNode.router!.result_name).to.equal(
        originalNode.router!.result_name
      );

      // Check that all UUIDs are preserved
      expect(resultNode.router!.categories).to.have.lengthOf(3);
      expect(resultNode.exits).to.have.lengthOf(3);

      const hotCategory = resultNode.router!.categories!.find(
        (cat) => cat.name === 'Hot'
      );
      expect(hotCategory!.uuid).to.equal('cat-hot');
      expect(hotCategory!.exit_uuid).to.equal('exit-hot');

      // Check destinations are preserved
      const hotExit = resultNode.exits!.find(
        (exit) => exit.uuid === 'exit-hot'
      );
      expect(hotExit!.destination_uuid).to.equal('next-1');
    });
  });
});
