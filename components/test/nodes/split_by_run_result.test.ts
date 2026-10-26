import { expect } from '@open-wc/testing';
import { split_by_run_result } from '../../src/flow/nodes/split_by_run_result';
import { Node } from '../../src/store/flow-definition';
import { NodeTest } from '../NodeHelper';
import { zustand } from '../../src/store/AppState';
import { NODE_CONFIG } from '../../src/flow/config';

/**
 * Test suite for the split_by_run_result node configuration.
 */
describe('split_by_run_result node config', () => {
  const helper = new NodeTest(split_by_run_result, 'split_by_run_result');

  // Setup mock flow results in the store before each test
  beforeEach(() => {
    // Mock the store with flow results
    zustand.setState({
      flowInfo: {
        results: [
          {
            key: 'favorite_color',
            name: 'Favorite Color',
            categories: ['Red', 'Blue', 'Green'],
            node_uuids: ['node-1']
          },
          {
            key: 'age',
            name: 'Age',
            categories: ['Adult', 'Teen', 'Child'],
            node_uuids: ['node-2']
          }
        ],
        dependencies: [],
        counts: { nodes: 0, languages: 0 },
        locals: []
      }
    } as any);
  });

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(split_by_run_result.name).to.equal('Split by Result');
    });

    it('has correct type', () => {
      expect(split_by_run_result.type).to.equal('split_by_run_result');
    });

    it('has correct dialog size', () => {
      expect(split_by_run_result.dialogSize).to.equal('large');
    });
  });

  describe('toFormData', () => {
    it('should transform node with rules to form data correctly', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.favorite_color',
          cases: [
            {
              uuid: 'case-1',
              type: 'has_phrase',
              arguments: ['red'],
              category_uuid: 'cat-1'
            },
            {
              uuid: 'case-2',
              type: 'has_any_word',
              arguments: ['blue', 'azure'],
              category_uuid: 'cat-2'
            }
          ],
          categories: [
            { uuid: 'cat-1', name: 'Red', exit_uuid: 'exit-1' },
            { uuid: 'cat-2', name: 'Blue', exit_uuid: 'exit-2' },
            { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
          ],
          default_category_uuid: 'cat-other',
          result_name: 'color_category'
        },
        exits: [
          { uuid: 'exit-1', destination_uuid: null },
          { uuid: 'exit-2', destination_uuid: null },
          { uuid: 'exit-other', destination_uuid: null }
        ]
      };

      const nodeUI = {
        config: {
          operand: {
            value: 'favorite_color',
            name: 'Favorite Color'
          }
        }
      };

      const formData = split_by_run_result.toFormData!(node, nodeUI);

      expect(formData.uuid).to.equal('test-node-uuid');
      expect(formData.result).to.be.an('array');
      expect(formData.result[0].value).to.equal('favorite_color');
      expect(formData.result[0].name).to.equal('Favorite Color');
      expect(formData.rules).to.have.lengthOf(2);

      // Check first rule
      expect(formData.rules[0].operator.value).to.equal('has_phrase');
      expect(formData.rules[0].value1).to.equal('red');
      expect(formData.rules[0].category).to.equal('Red');

      // Check second rule
      expect(formData.rules[1].operator.value).to.equal('has_any_word');
      expect(formData.rules[1].value1).to.equal('blue azure');
      expect(formData.rules[1].category).to.equal('Blue');

      expect(formData.result_name).to.equal('color_category');
    });

    it('should transform node with no rules to form data correctly', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.age',
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

      const nodeUI = {
        config: {
          operand: {
            value: 'age',
            name: 'Age'
          }
        }
      };

      const formData = split_by_run_result.toFormData!(node, nodeUI);

      expect(formData.uuid).to.equal('test-node-uuid');
      expect(formData.result).to.be.an('array');
      expect(formData.result[0].value).to.equal('age');
      expect(formData.result[0].name).to.equal('Age');
      expect(formData.rules).to.have.lengthOf(0);
      expect(formData.result_name).to.equal('');
    });

    it('should handle missing nodeUI config gracefully', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.favorite_color',
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

      const formData = split_by_run_result.toFormData!(node);

      expect(formData.uuid).to.equal('test-node-uuid');
      expect(formData.result).to.be.an('array');
      expect(formData.result).to.have.lengthOf(0);
    });

    it('should transform node with two-operand operators correctly', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.age',
          cases: [
            {
              uuid: 'case-1',
              type: 'has_number_between',
              arguments: ['13', '17'],
              category_uuid: 'cat-1'
            }
          ],
          categories: [
            { uuid: 'cat-1', name: 'Teen', exit_uuid: 'exit-1' },
            { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
          ],
          default_category_uuid: 'cat-other'
        },
        exits: [
          { uuid: 'exit-1', destination_uuid: null },
          { uuid: 'exit-other', destination_uuid: null }
        ]
      };

      const nodeUI = {
        config: {
          operand: {
            value: 'age',
            name: 'Age'
          }
        }
      };

      const formData = split_by_run_result.toFormData!(node, nodeUI);

      expect(formData.rules).to.have.lengthOf(1);
      expect(formData.rules[0].operator.value).to.equal('has_number_between');
      expect(formData.rules[0].value1).to.equal('13');
      expect(formData.rules[0].value2).to.equal('17');
      expect(formData.rules[0].category).to.equal('Teen');
    });

    it('should transform node with zero-operand operators correctly', () => {
      const node: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.age',
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

      const nodeUI = {
        config: {
          operand: {
            value: 'age',
            name: 'Age'
          }
        }
      };

      const formData = split_by_run_result.toFormData!(node, nodeUI);

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
        result: [{ value: 'favorite_color', name: 'Favorite Color' }],
        rules: [
          {
            operator: { value: 'has_phrase', name: 'has the phrase' },
            value1: 'red',
            value2: '',
            category: 'Red'
          },
          {
            operator: { value: 'has_any_word', name: 'has any of the words' },
            value1: 'blue azure',
            value2: '',
            category: 'Blue'
          }
        ],
        result_name: 'color_category'
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.old_result',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.uuid).to.equal('test-node-uuid');
      expect(resultNode.router).to.exist;
      expect(resultNode.router!.type).to.equal('switch');
      expect(resultNode.router!.operand).to.equal('@results.favorite_color');
      expect(resultNode.router!.result_name).to.equal('color_category');

      // Verify cases
      expect(resultNode.router!.cases).to.have.lengthOf(2);
      expect(resultNode.router!.cases![0].type).to.equal('has_phrase');
      expect(resultNode.router!.cases![0].arguments).to.deep.equal(['red']);
      expect(resultNode.router!.cases![1].type).to.equal('has_any_word');
      expect(resultNode.router!.cases![1].arguments).to.deep.equal([
        'blue azure'
      ]);

      // Verify categories
      expect(resultNode.router!.categories).to.have.lengthOf(3); // Red, Blue, Other
      expect(resultNode.router!.categories[0].name).to.equal('Red');
      expect(resultNode.router!.categories[1].name).to.equal('Blue');
      expect(resultNode.router!.categories[2].name).to.equal('Other');

      // Verify exits
      expect(resultNode.exits).to.have.lengthOf(3);
    });

    it('should transform form data without rules to node correctly', () => {
      const formData = {
        uuid: 'test-node-uuid',
        result: [{ value: 'age', name: 'Age' }],
        rules: [],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.old_result',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.uuid).to.equal('test-node-uuid');
      expect(resultNode.router).to.exist;
      expect(resultNode.router!.type).to.equal('switch');
      expect(resultNode.router!.operand).to.equal('@results.age');
      expect(resultNode.router!.result_name).to.be.undefined;

      // Should have only the default 'All Responses' category (no rules means "All Responses")
      expect(resultNode.router!.categories).to.have.lengthOf(1);
      expect(resultNode.router!.categories[0].name).to.equal('All Responses');

      // Should have one exit
      expect(resultNode.exits).to.have.lengthOf(1);
    });

    it('should not set result_name if empty', () => {
      const formData = {
        uuid: 'test-node-uuid',
        result: [{ value: 'favorite_color', name: 'Favorite Color' }],
        rules: [],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.old_result',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router!.result_name).to.be.undefined;
    });

    it('should preserve existing UUIDs when updating categories', () => {
      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.favorite_color',
          cases: [
            {
              uuid: 'existing-case-uuid',
              type: 'has_phrase',
              arguments: ['red'],
              category_uuid: 'existing-cat-uuid'
            }
          ],
          categories: [
            {
              uuid: 'existing-cat-uuid',
              name: 'Red',
              exit_uuid: 'existing-exit-uuid'
            },
            {
              uuid: 'existing-other-uuid',
              name: 'Other',
              exit_uuid: 'existing-other-exit-uuid'
            }
          ],
          default_category_uuid: 'existing-other-uuid'
        },
        exits: [
          { uuid: 'existing-exit-uuid', destination_uuid: 'some-node' },
          { uuid: 'existing-other-exit-uuid', destination_uuid: null }
        ]
      };

      // load the node into the form and rename its category, as the editor would
      const formData = split_by_run_result.toFormData!(originalNode, {
        position: { left: 0, top: 0 },
        config: {
          operand: { id: 'favorite_color', name: 'Favorite Color' }
        }
      } as any);
      formData.rules[0].category = 'Crimson';

      const resultNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );

      // Should preserve existing category UUIDs
      const redCategory = resultNode.router!.categories.find(
        (cat) => cat.name === 'Crimson'
      );
      expect(redCategory!.uuid).to.equal('existing-cat-uuid');
      expect(redCategory!.exit_uuid).to.equal('existing-exit-uuid');
      expect(resultNode.router!.cases[0].uuid).to.equal('existing-case-uuid');

      const otherCategory = resultNode.router!.categories.find(
        (cat) => cat.name === 'Other'
      );
      expect(otherCategory!.uuid).to.equal('existing-other-uuid');
      expect(otherCategory!.exit_uuid).to.equal('existing-other-exit-uuid');

      // Should preserve exit destinations
      const redExit = resultNode.exits.find(
        (exit) => exit.uuid === 'existing-exit-uuid'
      );
      expect(redExit!.destination_uuid).to.equal('some-node');
    });

    it('should handle form data without result selection', () => {
      const formData = {
        uuid: 'test-node-uuid',
        result: [],
        rules: [],
        result_name: ''
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.old_result',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );

      // Should return the original node unchanged
      expect(resultNode).to.equal(originalNode);
    });

    it('should handle incomplete rules gracefully', () => {
      const formData = {
        uuid: 'test-node-uuid',
        result: [{ value: 'age', name: 'Age' }],
        rules: [
          {
            operator: { value: 'has_number_gte', name: 'has a number above' },
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
          operand: '@results.age',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );

      // Only the first complete rule should be included
      expect(resultNode.router!.cases).to.have.lengthOf(1);
      expect(resultNode.router!.cases![0].type).to.equal('has_number_gte');

      // Should have Adult category and Other
      expect(resultNode.router!.categories).to.have.lengthOf(2);
      expect(resultNode.router!.categories[0].name).to.equal('Adult');
      expect(resultNode.router!.categories[1].name).to.equal('Other');
    });

    it('should handle two-operand operators correctly', () => {
      const formData = {
        uuid: 'test-node-uuid',
        result: [{ value: 'age', name: 'Age' }],
        rules: [
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
          operand: '@results.age',
          cases: [],
          categories: [],
          default_category_uuid: ''
        },
        exits: []
      };

      const resultNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );

      expect(resultNode.router!.cases).to.have.lengthOf(1);
      expect(resultNode.router!.cases![0].type).to.equal('has_number_between');
      expect(resultNode.router!.cases![0].arguments).to.deep.equal([
        '13',
        '17'
      ]);
    });
  });

  describe('validation', () => {
    it('should validate that a result is required', () => {
      const formData = {
        result: [],
        rules: [],
        result_name: ''
      };

      const validation = split_by_run_result.validate!(formData);

      expect(validation.valid).to.be.false;
      expect(validation.errors).to.have.property('result');
      expect(validation.errors.result).to.equal('A flow result is required');
    });

    it('should pass validation with valid result', () => {
      const formData = {
        result: [{ value: 'favorite_color', name: 'Favorite Color' }],
        rules: [],
        result_name: ''
      };

      const validation = split_by_run_result.validate!(formData);

      expect(validation.valid).to.be.true;
      expect(validation.errors).to.deep.equal({});
    });

    it('should pass validation with result and rules', () => {
      const formData = {
        result: [{ value: 'age', name: 'Age' }],
        rules: [
          {
            operator: { value: 'has_number_gte', name: 'has a number above' },
            value1: '18',
            value2: '',
            category: 'Adult'
          }
        ],
        result_name: 'age_category'
      };

      const validation = split_by_run_result.validate!(formData);

      expect(validation.valid).to.be.true;
      expect(validation.errors).to.deep.equal({});
    });
  });

  describe('delimiter functionality', () => {
    describe('toFormData', () => {
      it('should extract delimiter configuration when enabled', () => {
        const node: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@(field(results.favorite_color, 2, "."))',
            cases: [
              {
                uuid: 'case-1',
                type: 'has_phrase',
                arguments: ['red'],
                category_uuid: 'cat-1'
              }
            ],
            categories: [
              { uuid: 'cat-1', name: 'Red', exit_uuid: 'exit-1' },
              { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
            ],
            default_category_uuid: 'cat-other',
            result_name: 'color_category'
          },
          exits: [
            { uuid: 'exit-1', destination_uuid: null },
            { uuid: 'exit-other', destination_uuid: null }
          ]
        };

        const nodeUI = {
          config: {
            operand: {
              value: 'favorite_color',
              name: 'Favorite Color'
            },
            index: 2,
            delimiter: '.'
          }
        };

        const formData = split_by_run_result.toFormData!(node, nodeUI);

        expect(formData.delimit_by).to.be.an('array');
        expect(formData.delimit_by[0].value).to.equal('.');
        expect(formData.delimit_by[0].name).to.equal('Delimited by periods');
        expect(formData.delimit_index).to.be.an('array');
        expect(formData.delimit_index[0].value).to.equal('2');
        expect(formData.delimit_index[0].name).to.equal('third result');
      });

      it('should handle delimiter not enabled', () => {
        const node: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@results.favorite_color',
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

        const nodeUI = {
          config: {
            operand: {
              value: 'favorite_color',
              name: 'Favorite Color'
            }
          }
        };

        const formData = split_by_run_result.toFormData!(node, nodeUI);

        expect(formData.delimit_by).to.be.an('array');
        expect(formData.delimit_by[0].value).to.equal('');
        expect(formData.delimit_by[0].name).to.equal("Don't delimit result");
        expect(formData.delimit_index).to.be.an('array');
        expect(formData.delimit_index[0].value).to.equal('0');
      });
    });

    describe('fromFormData', () => {
      it('should generate operand with field() function when delimiter enabled', () => {
        const formData = {
          uuid: 'test-node-uuid',
          result: [{ value: 'favorite_color', name: 'Favorite Color' }],
          delimit_by: [{ value: '+', name: 'plusses' }],
          delimit_index: [{ value: '1', name: 'second' }],
          rules: [
            {
              operator: { value: 'has_phrase', name: 'has the phrase' },
              value1: 'red',
              value2: '',
              category: 'Red'
            }
          ],
          result_name: 'color_category'
        };

        const originalNode: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@results.old_result',
            cases: [],
            categories: [],
            default_category_uuid: ''
          },
          exits: []
        };

        const resultNode = split_by_run_result.fromFormData!(
          formData,
          originalNode
        );

        expect(resultNode.router!.operand).to.equal(
          '@(field(results.favorite_color, 1, "+"))'
        );
      });

      it('should generate standard operand when delimiter not enabled', () => {
        const formData = {
          uuid: 'test-node-uuid',
          result: [{ value: 'favorite_color', name: 'Favorite Color' }],
          delimit_by: [{ value: '', name: "Don't delimit" }],
          delimit_index: [{ value: '0', name: 'first' }],
          rules: [],
          result_name: ''
        };

        const originalNode: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@results.old_result',
            cases: [],
            categories: [],
            default_category_uuid: ''
          },
          exits: []
        };

        const resultNode = split_by_run_result.fromFormData!(
          formData,
          originalNode
        );

        expect(resultNode.router!.operand).to.equal('@results.favorite_color');
      });

      it('should handle different field numbers correctly', () => {
        const formData = {
          uuid: 'test-node-uuid',
          result: [{ value: 'age', name: 'Age' }],
          delimit_by: [{ value: '.', name: 'periods' }],
          delimit_index: [{ value: '9', name: 'tenth' }],
          rules: [],
          result_name: ''
        };

        const originalNode: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@results.age',
            cases: [],
            categories: [],
            default_category_uuid: ''
          },
          exits: []
        };

        const resultNode = split_by_run_result.fromFormData!(
          formData,
          originalNode
        );

        expect(resultNode.router!.operand).to.equal(
          '@(field(results.age, 9, "."))'
        );
      });

      it('should use default values when delimiter fields missing', () => {
        const formData = {
          uuid: 'test-node-uuid',
          result: [{ value: 'favorite_color', name: 'Favorite Color' }],
          delimit_by: [{ value: ' ', name: 'spaces' }],
          rules: [],
          result_name: ''
        };

        const originalNode: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@results.old_result',
            cases: [],
            categories: [],
            default_category_uuid: ''
          },
          exits: []
        };

        const resultNode = split_by_run_result.fromFormData!(
          formData,
          originalNode
        );

        expect(resultNode.router!.operand).to.equal(
          '@(field(results.favorite_color, 0, " "))'
        );
      });
    });

    describe('toUIConfig', () => {
      it('should persist delimiter configuration when enabled', () => {
        const formData = {
          result: [{ value: 'favorite_color', name: 'Favorite Color' }],
          delimit_by: [{ value: '+', name: 'plusses' }],
          delimit_index: [{ value: '3', name: 'fourth' }],
          rules: [],
          result_name: ''
        };

        const config = split_by_run_result.toUIConfig!(formData);

        expect(config.operand).to.exist;
        expect(config.operand.id).to.equal('favorite_color');
        expect(config.index).to.equal(3);
        expect(config.delimiter).to.equal('+');
      });

      it('should not include delimiter config when not enabled', () => {
        const formData = {
          result: [{ value: 'favorite_color', name: 'Favorite Color' }],
          delimit_by: [{ value: '', name: "Don't delimit" }],
          delimit_index: [{ value: '0', name: 'first' }],
          rules: [],
          result_name: ''
        };

        const config = split_by_run_result.toUIConfig!(formData);

        expect(config.operand).to.exist;
        expect(config.operand.id).to.equal('favorite_color');
        expect(config.index).to.be.undefined;
        expect(config.delimiter).to.be.undefined;
      });

      it('should set type to split_by_run_result_delimited when delimiter is enabled', () => {
        const formData = {
          result: [{ value: 'favorite_color', name: 'Favorite Color' }],
          delimit_by: [{ value: '+', name: 'plusses' }],
          delimit_index: [{ value: '3', name: 'fourth' }],
          rules: [],
          result_name: ''
        };

        const config = split_by_run_result.toUIConfig!(formData);

        expect(config.type).to.equal('split_by_run_result_delimited');
      });

      it('should set type to split_by_run_result when delimiter is not enabled', () => {
        const formData = {
          result: [{ value: 'favorite_color', name: 'Favorite Color' }],
          delimit_by: [{ value: '', name: "Don't delimit" }],
          delimit_index: [{ value: '0', name: 'first' }],
          rules: [],
          result_name: ''
        };

        const config = split_by_run_result.toUIConfig!(formData);

        expect(config.type).to.equal('split_by_run_result');
      });
    });

    describe('round-trip tests', () => {
      it('should preserve delimiter configuration through toFormData and fromFormData', () => {
        const originalNode: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@(field(results.favorite_color, 5, "."))',
            cases: [
              {
                uuid: 'case-1',
                type: 'has_phrase',
                arguments: ['red'],
                category_uuid: 'cat-1'
              }
            ],
            categories: [
              { uuid: 'cat-1', name: 'Red', exit_uuid: 'exit-1' },
              { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
            ],
            default_category_uuid: 'cat-other',
            result_name: 'color_category'
          },
          exits: [
            { uuid: 'exit-1', destination_uuid: null },
            { uuid: 'exit-other', destination_uuid: null }
          ]
        };

        const nodeUI = {
          config: {
            operand: {
              value: 'favorite_color',
              name: 'Favorite Color'
            },
            index: 5,
            delimiter: '.'
          }
        };

        // Convert to form data
        const formData = split_by_run_result.toFormData!(originalNode, nodeUI);

        // Convert back to node
        const resultNode = split_by_run_result.fromFormData!(
          formData,
          originalNode
        );

        // Verify operand is preserved
        expect(resultNode.router!.operand).to.equal(
          '@(field(results.favorite_color, 5, "."))'
        );
      });

      it('should handle toggling delimiter on and off', () => {
        const originalNode: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@results.favorite_color',
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

        // Start with delimiter disabled
        const nodeUI = {
          config: {
            operand: {
              value: 'favorite_color',
              name: 'Favorite Color'
            }
          }
        };

        // Convert to form data
        const formData = split_by_run_result.toFormData!(originalNode, nodeUI);
        expect(formData.delimit_by[0].value).to.equal('');

        // Enable delimiter
        formData.delimit_by = [{ value: '+', name: 'plusses' }];
        formData.delimit_index = [{ value: '2', name: 'third' }];

        // Convert to node
        const resultNode = split_by_run_result.fromFormData!(
          formData,
          originalNode
        );

        expect(resultNode.router!.operand).to.equal(
          '@(field(results.favorite_color, 2, "+"))'
        );

        // Get UI config and verify it persists delimiter settings
        const config = split_by_run_result.toUIConfig!(formData);
        expect(config.index).to.equal(2);
        expect(config.delimiter).to.equal('+');
      });

      it('should properly remove delimiter when switching from delimited to non-delimited', () => {
        // Start with a node that has delimiter enabled
        const nodeWithDelimiter: Node = {
          uuid: 'test-node-uuid',
          actions: [],
          router: {
            type: 'switch',
            operand: '@(field(results.favorite_color, 2, "."))',
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

        const nodeUI = {
          config: {
            operand: {
              value: 'favorite_color',
              name: 'Favorite Color'
            }
          }
        };

        // Convert to form data - should show delimiter is enabled
        const formData = split_by_run_result.toFormData!(
          nodeWithDelimiter,
          nodeUI
        );
        expect(formData.delimit_by[0].value).to.equal('.');
        expect(formData.delimit_index[0].value).to.equal('2');

        // Now remove the delimiter by selecting "Don't delimit result"
        formData.delimit_by = [{ value: '', name: "Don't delimit result" }];

        // Convert back to node
        const resultNode = split_by_run_result.fromFormData!(
          formData,
          nodeWithDelimiter
        );

        // Operand should now be standard without field() function
        expect(resultNode.router!.operand).to.equal('@results.favorite_color');

        // Get UI config - should NOT have index or delimiter
        const config = split_by_run_result.toUIConfig!(formData);
        expect(config.index).to.be.undefined;
        expect(config.delimiter).to.be.undefined;

        // Re-open the dialog - toFormData should show no delimiter
        const formDataReopened = split_by_run_result.toFormData!(
          resultNode,
          nodeUI
        );
        expect(formDataReopened.delimit_by[0].value).to.equal('');
        expect(formDataReopened.delimit_by[0].name).to.equal(
          "Don't delimit result"
        );
      });
    });
  });

  describe('toFormData normalizes operand from toUIConfig', () => {
    it('should handle round-trip when operand has only id (no value)', () => {
      // Reproduces the bug: toUIConfig saves { id, name, type } without 'value',
      // then toFormData loads it, and fromFormData must still produce a valid operand.
      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@results.favorite_color',
          cases: [
            {
              uuid: 'case-1',
              type: 'has_phrase',
              arguments: ['red'],
              category_uuid: 'cat-1'
            }
          ],
          categories: [
            { uuid: 'cat-1', name: 'Red', exit_uuid: 'exit-1' },
            { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
          ],
          default_category_uuid: 'cat-other',
          result_name: ''
        },
        exits: [
          { uuid: 'exit-1', destination_uuid: null },
          { uuid: 'exit-other', destination_uuid: null }
        ]
      };

      // nodeUI as saved by toUIConfig - note: NO 'value' property, only 'id'
      const nodeUI = {
        config: {
          operand: {
            id: 'favorite_color',
            name: 'Favorite Color',
            type: 'result'
          }
        }
      };

      // Step 1: toFormData (opening the editor)
      const formData = split_by_run_result.toFormData!(originalNode, nodeUI);

      // The result should have 'value' normalized from 'id'
      expect(formData.result[0].value).to.equal('favorite_color');

      // Step 2: fromFormData (saving without re-selecting the result)
      const updatedNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );

      // The operand must NOT be @results.undefined
      expect(updatedNode.router!.operand).to.equal('@results.favorite_color');
    });

    it('should handle round-trip with delimiter when operand has only id', () => {
      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@(field(results.favorite_color, 2, "."))',
          cases: [],
          categories: [
            { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
          ],
          default_category_uuid: 'cat-other',
          result_name: ''
        },
        exits: [{ uuid: 'exit-other', destination_uuid: null }]
      };

      const nodeUI = {
        config: {
          operand: {
            id: 'favorite_color',
            name: 'Favorite Color',
            type: 'result'
          },
          index: 2,
          delimiter: '.'
        }
      };

      const formData = split_by_run_result.toFormData!(originalNode, nodeUI);
      expect(formData.result[0].value).to.equal('favorite_color');

      const updatedNode = split_by_run_result.fromFormData!(
        formData,
        originalNode
      );
      expect(updatedNode.router!.operand).to.equal(
        '@(field(results.favorite_color, 2, "."))'
      );
    });
  });

  describe('backwards compatibility', () => {
    it('should support split_by_run_result_delimited type from old flows', () => {
      // Verify that split_by_run_result_delimited points to the same config as split_by_run_result
      expect(NODE_CONFIG['split_by_run_result_delimited']).to.equal(
        NODE_CONFIG['split_by_run_result']
      );
      expect(NODE_CONFIG['split_by_run_result_delimited']).to.equal(
        split_by_run_result
      );

      // Verify we can look up the config with the old type name
      const config = NODE_CONFIG['split_by_run_result_delimited'];
      expect(config).to.not.be.undefined;
      expect(config.name).to.equal('Split by Result');
    });

    it('should correctly process old flow with split_by_run_result_delimited type', () => {
      // Simulate a node from an old flow with the delimited type
      const oldNode: Node = {
        uuid: 'old-node-uuid',
        actions: [],
        router: {
          type: 'switch',
          operand: '@(field(results.bloop, 0, "+"))',
          cases: [
            {
              uuid: 'case-1',
              type: 'has_any_word',
              arguments: ['red'],
              category_uuid: 'cat-1'
            }
          ],
          categories: [
            { uuid: 'cat-1', name: 'Red', exit_uuid: 'exit-1' },
            { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
          ],
          default_category_uuid: 'cat-other'
        },
        exits: [
          { uuid: 'exit-1', destination_uuid: null },
          { uuid: 'exit-other', destination_uuid: null }
        ]
      };

      const oldNodeUI = {
        type: 'split_by_run_result_delimited',
        config: {
          operand: {
            id: 'bloop',
            name: 'Bloop',
            type: 'result'
          },
          index: 0,
          delimiter: '+'
        }
      };

      // Get config using the old type name - this should work due to backwards compatibility
      const config = NODE_CONFIG[oldNodeUI.type];
      expect(config).to.not.be.undefined;

      // Verify we can convert to form data
      const formData = config.toFormData!(oldNode, oldNodeUI);
      expect(formData.result[0].id).to.equal('bloop');
      expect(formData.result[0].name).to.equal('Bloop');
      expect(formData.delimit_by[0].value).to.equal('+');
      expect(formData.delimit_index[0].value).to.equal('0');
    });
  });
});
