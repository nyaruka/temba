import { expect } from '@open-wc/testing';
import { wait_for_response } from '../../src/flow/nodes/wait_for_response';
import { Node } from '../../src/store/flow-definition';
import { NodeTest } from '../NodeHelper';
import { createOperatorOption } from '../../src/flow/operators';

/**
 * Test suite for the wait_for_response node configuration.
 */
describe('wait_for_response node config', () => {
  const helper = new NodeTest(wait_for_response, 'wait_for_response');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(wait_for_response.name).to.equal('Wait for Response');
    });

    it('has correct type', () => {
      expect(wait_for_response.type).to.equal('wait_for_response');
    });

    it('has form configuration', () => {
      expect(wait_for_response.form).to.exist;
      expect(wait_for_response.form.result_name).to.exist;
    });

    it('has layout configuration', () => {
      expect(wait_for_response.layout).to.exist;
      expect(wait_for_response.layout).to.have.lengthOf(2);
      expect(wait_for_response.layout[0]).to.equal('rules');
      expect((wait_for_response.layout[1] as any).type).to.equal('extras');
    });

    it('offers the timeout as the last extra, toggling it on and off', () => {
      const sections = (wait_for_response.layout[1] as any).sections;
      const timeout = sections[sections.length - 1];
      expect(timeout.label).to.equal('Time Limit');
      expect(timeout.items).to.deep.equal(['timeout_duration']);
      expect(timeout.sentence()).to.equal(
        "If there's no reply after {duration} go to **No Response**"
      );
      expect(timeout.tokens).to.deep.equal({ duration: 'timeout_duration' });
      expect(timeout.hasValue({ timeout_enabled: false })).to.be.false;
      expect(timeout.hasValue({ timeout_enabled: true })).to.be.true;
      expect(timeout.onAdd({})).to.deep.equal({ timeout_enabled: true });
      expect(timeout.onRemove({})).to.deep.equal({ timeout_enabled: false });

      // there's no separate checkbox for it any more
      expect(wait_for_response.form.timeout_enabled).to.be.undefined;
      expect(wait_for_response.gutter).to.be.undefined;
    });
  });

  describe('node scenarios', () => {
    it('renders basic wait', async () => {
      await helper.testNode(
        {
          uuid: 'test-wait-node-1',
          actions: [],
          router: {
            type: 'switch',
            wait: {
              type: 'msg',
              timeout: {
                category_uuid: 'timeout-cat-1',
                seconds: 300
              }
            },
            result_name: 'response',
            categories: [
              {
                uuid: 'all-responses-cat-1',
                name: 'All Responses',
                exit_uuid: 'all-responses-exit-1'
              },
              {
                uuid: 'timeout-cat-1',
                name: 'No Response',
                exit_uuid: 'timeout-exit-1'
              }
            ],
            cases: [],
            operand: '@input.text',
            default_category_uuid: 'all-responses-cat-1'
          },
          exits: [
            { uuid: 'all-responses-exit-1', destination_uuid: null },
            { uuid: 'timeout-exit-1', destination_uuid: null }
          ]
        } as Node,
        { type: 'wait_for_response' },
        'basic-wait'
      );
    });

    it('renders custom result name', async () => {
      await helper.testNode(
        {
          uuid: 'test-wait-node-2',
          actions: [],
          router: {
            type: 'switch',
            wait: {
              type: 'msg',
              timeout: {
                category_uuid: 'timeout-cat-2',
                seconds: 1800
              }
            },
            result_name: 'user_input',
            categories: [
              {
                uuid: 'all-responses-cat-2',
                name: 'All Responses',
                exit_uuid: 'all-responses-exit-2'
              },
              {
                uuid: 'timeout-cat-2',
                name: 'No Response',
                exit_uuid: 'timeout-exit-2'
              }
            ],
            cases: [],
            operand: '@input.text',
            default_category_uuid: 'all-responses-cat-2'
          },
          exits: [
            { uuid: 'all-responses-exit-2', destination_uuid: null },
            { uuid: 'timeout-exit-2', destination_uuid: null }
          ]
        } as Node,
        { type: 'wait_for_response' },
        'custom-result-name'
      );
    });

    it('renders short timeout', async () => {
      await helper.testNode(
        {
          uuid: 'test-wait-node-3',
          actions: [],
          router: {
            type: 'switch',
            wait: {
              type: 'msg',
              timeout: {
                category_uuid: 'timeout-cat-3',
                seconds: 60
              }
            },
            result_name: 'quick_response',
            categories: [
              {
                uuid: 'all-responses-cat-3',
                name: 'All Responses',
                exit_uuid: 'all-responses-exit-3'
              },
              {
                uuid: 'timeout-cat-3',
                name: 'No Response',
                exit_uuid: 'timeout-exit-3'
              }
            ],
            cases: [],
            operand: '@input.text',
            default_category_uuid: 'all-responses-cat-3'
          },
          exits: [
            { uuid: 'all-responses-exit-3', destination_uuid: null },
            { uuid: 'timeout-exit-3', destination_uuid: null }
          ]
        } as Node,
        { type: 'wait_for_response' },
        'short-timeout'
      );
    });

    it('renders no timeout', async () => {
      await helper.testNode(
        {
          uuid: 'test-wait-node-4',
          actions: [],
          router: {
            type: 'switch',
            wait: {
              type: 'msg'
              // No timeout specified
            },
            result_name: 'response',
            categories: [
              {
                uuid: 'all-responses-cat-4',
                name: 'All Responses',
                exit_uuid: 'all-responses-exit-4'
              }
            ],
            cases: [],
            operand: '@input.text',
            default_category_uuid: 'all-responses-cat-4'
          },
          exits: [{ uuid: 'all-responses-exit-4', destination_uuid: null }]
        } as Node,
        { type: 'wait_for_response' },
        'no-timeout'
      );
    });

    it('renders long argument values without overflow', async () => {
      await helper.testNode(
        {
          uuid: 'test-wait-node-5',
          actions: [],
          router: {
            type: 'switch',
            wait: {
              type: 'msg',
              timeout: {
                category_uuid: 'timeout-cat-5',
                seconds: 300
              }
            },
            result_name: 'response',
            categories: [
              {
                uuid: 'long-val-cat',
                name: 'Long Value',
                exit_uuid: 'long-val-exit'
              },
              {
                uuid: 'other-cat-5',
                name: 'Other',
                exit_uuid: 'other-exit-5'
              },
              {
                uuid: 'timeout-cat-5',
                name: 'No Response',
                exit_uuid: 'timeout-exit-5'
              }
            ],
            cases: [
              {
                uuid: 'long-val-case',
                type: 'has_any_word',
                arguments: [
                  '@(extract(webhook.json.queryData[0], "minLengthValueThatIsVeryLongAndShouldNotOverflow"))'
                ],
                category_uuid: 'long-val-cat'
              }
            ],
            operand: '@input.text',
            default_category_uuid: 'other-cat-5'
          },
          exits: [
            { uuid: 'long-val-exit', destination_uuid: null },
            { uuid: 'other-exit-5', destination_uuid: null },
            { uuid: 'timeout-exit-5', destination_uuid: null }
          ]
        } as Node,
        { type: 'wait_for_response' },
        'long-argument'
      );
    });
  });

  describe('data transformation', () => {
    it('converts node to form data correctly', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          result_name: 'user_response',
          categories: []
        },
        exits: []
      };

      const formData = wait_for_response.toFormData!(node);

      expect(formData.uuid).to.equal('test-node');
      expect(formData.result_name).to.equal('user_response');
      expect(formData.rules).to.deep.equal([]);
    });

    it('converts node with rules to form data correctly', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          result_name: 'user_response',
          operand: '@input.text',
          categories: [
            {
              uuid: 'red-cat',
              name: 'Red',
              exit_uuid: 'red-exit'
            },
            {
              uuid: 'green-cat',
              name: 'Green',
              exit_uuid: 'green-exit'
            },
            {
              uuid: 'other-cat',
              name: 'Other',
              exit_uuid: 'other-exit'
            }
          ],
          cases: [
            {
              uuid: 'red-case',
              type: 'has_any_word',
              arguments: ['red'],
              category_uuid: 'red-cat'
            },
            {
              uuid: 'green-case',
              type: 'has_phrase',
              arguments: ['green'],
              category_uuid: 'green-cat'
            }
          ]
        },
        exits: [
          { uuid: 'red-exit', destination_uuid: null },
          { uuid: 'green-exit', destination_uuid: null },
          { uuid: 'other-exit', destination_uuid: null }
        ]
      };

      const formData = wait_for_response.toFormData!(node);

      expect(formData.uuid).to.equal('test-node');
      expect(formData.result_name).to.equal('user_response');
      expect(formData.rules).to.have.length(2);
      expect(formData.rules[0]).to.deep.equal({
        operator: createOperatorOption('has_any_word'),
        value1: 'red',
        value2: '',
        category: 'Red',
        case_uuid: 'red-case',
        category_uuid: 'red-cat'
      });
      expect(formData.rules[1]).to.deep.equal({
        operator: createOperatorOption('has_phrase'),
        value1: 'green',
        value2: '',
        category: 'Green',
        case_uuid: 'green-case',
        category_uuid: 'green-cat'
      });
    });

    it('converts form data to node correctly', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'custom_response',
        rules: []
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: []
        }
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      expect(result.uuid).to.equal('test-node');
      expect(result.router?.result_name).to.equal('custom_response');
    });

    it('converts form data with rules to node correctly', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'custom_response',
        rules: [
          {
            operator: 'has_any_word',
            value1: 'red',
            value2: '',
            category: 'Red'
          },
          {
            operator: 'has_phrase',
            value1: 'blue',
            value2: '',
            category: 'Blue'
          }
        ]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: []
        }
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      expect(result.uuid).to.equal('test-node');
      expect(result.router?.result_name).to.equal('custom_response');
      expect(result.router?.operand).to.equal('@input.text');
      expect(result.router?.categories).to.have.length(3); // Red, Blue, Other
      expect(result.router?.cases).to.have.length(2);
      expect(result.exits).to.have.length(3);

      // Check categories
      const categoryNames = result.router!.categories.map((cat) => cat.name);
      expect(categoryNames).to.include.members(['Red', 'Blue', 'Other']);

      // Check cases
      const redCase = result.router!.cases.find(
        (c) => c.type === 'has_any_word'
      );
      expect(redCase).to.exist;
      expect(redCase!.arguments).to.deep.equal(['red']);

      const blueCase = result.router!.cases.find(
        (c) => c.type === 'has_phrase'
      );
      expect(blueCase).to.exist;
      expect(blueCase!.arguments).to.deep.equal(['blue']);
    });

    it('handles default result name', () => {
      const formData = {
        uuid: 'test-node',
        rules: []
        // No result_name specified
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [],
        router: {
          type: 'switch',
          categories: []
        }
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      expect(result.uuid).to.equal('test-node');
      // When no result_name is provided, it should not be set
      expect(result.router?.result_name).to.be.undefined;
    });

    it('handles operators with no operands correctly', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'custom_response',
        rules: [
          {
            operator: 'has_text',
            value: '', // No value needed for has_text
            category: 'Has Text'
          },
          {
            operator: 'has_number',
            value: '', // No value needed for has_number
            category: 'Has Number'
          }
        ]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: []
        }
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      expect(result.uuid).to.equal('test-node');
      expect(result.router?.result_name).to.equal('custom_response');
      expect(result.router?.categories).to.have.length(3); // Has Text, Has Number, Other
      expect(result.router?.cases).to.have.length(2);
      expect(result.exits).to.have.length(3);

      // Check categories
      const categoryNames = result.router!.categories.map((cat) => cat.name);
      expect(categoryNames).to.include.members([
        'Has Text',
        'Has Number',
        'Other'
      ]);

      // Check cases - should have empty arguments for 0-operand operators
      const hasTextCase = result.router!.cases.find(
        (c) => c.type === 'has_text'
      );
      expect(hasTextCase).to.exist;
      expect(hasTextCase!.arguments).to.deep.equal([]);

      const hasNumberCase = result.router!.cases.find(
        (c) => c.type === 'has_number'
      );
      expect(hasNumberCase).to.exist;
      expect(hasNumberCase!.arguments).to.deep.equal([]);
    });

    it('preserves timeout categories when adding rules', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        timeout_enabled: true,
        timeout_duration: [{ value: '300', name: '5 minutes' }],
        rules: [
          {
            operator: 'has_text',
            value: 'yes',
            category: 'Positive'
          }
        ]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          wait: {
            type: 'msg',
            timeout: {
              category_uuid: 'timeout-cat',
              seconds: 300
            }
          },
          result_name: 'response',
          categories: [
            {
              uuid: 'timeout-cat',
              name: 'No Response',
              exit_uuid: 'timeout-exit'
            }
          ]
        },
        exits: [{ uuid: 'timeout-exit', destination_uuid: null }]
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      expect(result.router?.categories).to.have.length(3); // Positive, No Response, Other
      const categoryNames = result.router!.categories.map((cat) => cat.name);
      expect(categoryNames).to.include.members([
        'Positive',
        'No Response',
        'Other'
      ]);

      // Verify timeout configuration is preserved
      expect(result.router?.wait).to.exist;
      expect(result.router?.wait?.timeout?.category_uuid).to.equal(
        'timeout-cat'
      );
    });

    it('gives No Response its own exit when it shared one with a user category', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        timeout_enabled: true,
        timeout_duration: [{ value: '300', name: '5 minutes' }],
        rules: [{ operator: 'has_text', value: 'yes', category: 'Positive' }]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          wait: {
            type: 'msg',
            timeout: { category_uuid: 'timeout-cat', seconds: 300 }
          },
          categories: [
            {
              uuid: 'positive-cat',
              name: 'Positive',
              exit_uuid: 'shared-exit'
            },
            {
              uuid: 'timeout-cat',
              name: 'No Response',
              exit_uuid: 'shared-exit'
            }
          ]
        },
        exits: [{ uuid: 'shared-exit', destination_uuid: 'node-x' }]
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      const exitUuids = result.exits.map((exit) => exit.uuid);
      expect(new Set(exitUuids).size).to.equal(exitUuids.length);
      expect(
        result.router!.categories.map((cat) => cat.exit_uuid)
      ).to.have.members(exitUuids);

      const noResponse = result.router!.categories.find(
        (cat) => cat.name === 'No Response'
      )!;
      expect(noResponse.uuid).to.equal('timeout-cat');
      expect(noResponse.exit_uuid).to.not.equal('shared-exit');
      expect(
        result.exits.find((exit) => exit.uuid === noResponse.exit_uuid)!
          .destination_uuid
      ).to.equal('node-x');
      expect(result.router?.wait?.timeout?.category_uuid).to.equal(
        'timeout-cat'
      );
    });

    it('ensures user categories never share UUIDs with system categories', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        rules: [
          {
            operator: 'has_any_word',
            value1: 'hello',
            value2: '',
            category: 'Greeting'
          }
        ]
      };

      // Original node with existing system categories
      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [
          { uuid: 'system-other-exit', destination_uuid: null },
          { uuid: 'system-all-responses-exit', destination_uuid: null }
        ],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: [
            {
              uuid: 'system-other-uuid',
              name: 'Other',
              exit_uuid: 'system-other-exit'
            },
            {
              uuid: 'system-all-responses-uuid',
              name: 'All Responses',
              exit_uuid: 'system-all-responses-exit'
            }
          ]
        }
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      // Get all category UUIDs
      const categoryUUIDs = result.router!.categories.map((cat) => cat.uuid);
      const exitUUIDs = result.exits.map((exit) => exit.uuid);

      // Find user category (Greeting)
      const userCategory = result.router!.categories.find(
        (cat) => cat.name === 'Greeting'
      );
      const systemOtherCategory = result.router!.categories.find(
        (cat) => cat.name === 'Other'
      );

      expect(userCategory).to.exist;
      expect(systemOtherCategory).to.exist;

      // Verify that user category UUID is different from any system category UUID
      expect(userCategory!.uuid).to.not.equal('system-other-uuid');
      expect(userCategory!.uuid).to.not.equal('system-all-responses-uuid');
      expect(userCategory!.exit_uuid).to.not.equal('system-other-exit');
      expect(userCategory!.exit_uuid).to.not.equal('system-all-responses-exit');

      // Verify all UUIDs are unique
      expect(new Set(categoryUUIDs)).to.have.lengthOf(categoryUUIDs.length);
      expect(new Set(exitUUIDs)).to.have.lengthOf(exitUUIDs.length);
    });

    it('removes No Response category when timeout is disabled and no user rules', () => {
      // Start with a node that has timeout enabled and No Response category
      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [
          { uuid: 'all-responses-exit', destination_uuid: null },
          { uuid: 'no-response-exit', destination_uuid: null }
        ],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: [
            {
              uuid: 'all-responses-cat',
              name: 'All Responses',
              exit_uuid: 'all-responses-exit'
            },
            {
              uuid: 'no-response-cat',
              name: 'No Response',
              exit_uuid: 'no-response-exit'
            }
          ],
          cases: [],
          operand: '@input.text',
          default_category_uuid: 'all-responses-cat',
          wait: {
            type: 'msg',
            timeout: {
              seconds: 300,
              category_uuid: 'no-response-cat'
            }
          }
        }
      };

      // Form data with timeout disabled and no user rules
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        rules: [], // No user rules
        timeout_enabled: false, // Timeout disabled
        timeout_duration: null
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      // Should only have "All Responses" category, not "No Response"
      expect(result.router?.categories).to.have.length(1);
      expect(result.router?.categories[0].name).to.equal('All Responses');
      expect(result.exits).to.have.length(1);
      expect(result.exits[0].uuid).to.equal('all-responses-exit');

      // Should not have timeout configuration
      expect(result.router?.wait?.timeout).to.be.undefined;
    });

    it('adds No Response category when timeout is enabled and no user rules', () => {
      // Start with a node that has no timeout and only "All Responses"
      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: [{ uuid: 'all-responses-exit', destination_uuid: null }],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: [
            {
              uuid: 'all-responses-cat',
              name: 'All Responses',
              exit_uuid: 'all-responses-exit'
            }
          ],
          cases: [],
          operand: '@input.text',
          default_category_uuid: 'all-responses-cat',
          wait: {
            type: 'msg'
          }
        }
      };

      // Form data with timeout enabled and no user rules
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        rules: [], // No user rules
        timeout_enabled: true, // Timeout enabled
        timeout_duration: { value: '300', name: '5 minutes' }
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      // Should have both "All Responses" and "No Response" categories
      expect(result.router?.categories).to.have.length(2);
      const categoryNames = result.router!.categories.map((cat) => cat.name);
      expect(categoryNames).to.include.members([
        'All Responses',
        'No Response'
      ]);

      // Should have 2 exits
      expect(result.exits).to.have.length(2);

      // Should have timeout configuration
      expect(result.router?.wait?.timeout).to.exist;
      expect(result.router?.wait?.timeout?.seconds).to.equal(300);

      // Timeout should point to "No Response" category
      const noResponseCategory = result.router!.categories.find(
        (cat) => cat.name === 'No Response'
      );
      expect(result.router?.wait?.timeout?.category_uuid).to.equal(
        noResponseCategory?.uuid
      );
    });

    it('handles enabling timeout on node with non-extensible exits array', () => {
      // Create a node with a frozen/sealed exits array to simulate the error condition
      const exitArray = [
        { uuid: 'all-responses-exit', destination_uuid: null }
      ];
      Object.freeze(exitArray); // This makes the array non-extensible

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: exitArray, // This array is now frozen
        router: {
          type: 'switch',
          result_name: 'response',
          categories: [
            {
              uuid: 'all-responses-cat',
              name: 'All Responses',
              exit_uuid: 'all-responses-exit'
            }
          ],
          cases: [],
          operand: '@input.text',
          default_category_uuid: 'all-responses-cat',
          wait: {
            type: 'msg'
          }
        }
      };

      // Form data with timeout being enabled (this should trigger the error)
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        rules: [], // No user rules
        timeout_enabled: true, // Enable timeout (this is the key change)
        timeout_duration: { value: '300', name: '5 minutes' }
      };

      // This should not throw an error even with a frozen exits array
      expect(() => {
        const result = wait_for_response.fromFormData!(formData, originalNode);

        // Verify the result is correct
        expect(result.router?.categories).to.have.length(2);
        const categoryNames = result.router!.categories.map((cat) => cat.name);
        expect(categoryNames).to.include.members([
          'All Responses',
          'No Response'
        ]);
        expect(result.exits).to.have.length(2);
        expect(result.router?.wait?.timeout).to.exist;
      }).to.not.throw();
    });
  });

  describe('validation', () => {
    it('validates form data correctly with no errors', () => {
      const formData = {
        rules: [
          { operator: 'has_text', value: 'yes', category: 'Positive' },
          { operator: 'has_text', value: 'no', category: 'Negative' }
        ]
      };

      const validation = wait_for_response.validate!(formData);
      expect(validation.valid).to.be.true;
      expect(validation.errors).to.be.empty;
    });

    it('allows same category names for multiple rules', () => {
      const formData = {
        rules: [
          { operator: 'has_text', value: 'yes', category: 'Positive' },
          { operator: 'has_text', value: 'ok', category: 'positive' }, // case insensitive same category
          { operator: 'has_text', value: 'no', category: 'Negative' }
        ]
      };

      const validation = wait_for_response.validate!(formData);
      expect(validation.valid).to.be.true;
      expect(validation.errors).to.be.empty;
    });

    it('allows rules with operators that need no values', () => {
      const formData = {
        rules: [
          { operator: 'has_text', value: '', category: 'Has Text' },
          { operator: 'has_number', value: '', category: 'Has Number' },
          { operator: 'has_any_word', value: 'hello', category: 'Greeting' }
        ]
      };

      const validation = wait_for_response.validate!(formData);
      expect(validation.valid).to.be.true;
      expect(validation.errors).to.be.empty;
    });

    it('ignores empty rules in validation', () => {
      const formData = {
        rules: [
          { operator: 'has_phrase', value: 'yes', category: 'Positive' },
          { operator: '', value: '', category: '' }, // empty rule
          { operator: 'has_phrase', value: 'no', category: 'Negative' }
        ]
      };

      const validation = wait_for_response.validate!(formData);
      expect(validation.valid).to.be.true;
      expect(validation.errors).to.be.empty;
    });

    it('preserves UUIDs through the form when categories are renamed and moved', () => {
      // Create original node with specific UUIDs
      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: [
            {
              uuid: 'category-1-uuid',
              name: 'Old Name 1',
              exit_uuid: 'exit-1-uuid'
            },
            {
              uuid: 'category-2-uuid',
              name: 'Old Name 2',
              exit_uuid: 'exit-2-uuid'
            },
            {
              uuid: 'other-category-uuid',
              name: 'Other',
              exit_uuid: 'other-exit-uuid'
            }
          ],
          cases: [
            {
              uuid: 'case-1-uuid',
              type: 'has_phrase',
              arguments: ['yes'],
              category_uuid: 'category-1-uuid'
            },
            {
              uuid: 'case-2-uuid',
              type: 'has_phrase',
              arguments: ['no'],
              category_uuid: 'category-2-uuid'
            }
          ]
        },
        exits: [
          { uuid: 'exit-1-uuid', destination_uuid: null },
          { uuid: 'exit-2-uuid', destination_uuid: null },
          { uuid: 'other-exit-uuid', destination_uuid: null }
        ]
      };

      // Load the node into the form, rename both categories and swap the rules, as the editor would
      const formData = wait_for_response.toFormData!(originalNode);
      formData.rules = [
        { ...formData.rules[1], category: 'New Name 2' },
        { ...formData.rules[0], category: 'New Name 1' }
      ];

      const result = wait_for_response.fromFormData!(formData, originalNode);

      // Verify that UUIDs are preserved despite name changes
      expect(result.router?.categories).to.have.length(3); // Two rules + Other

      const category1 = result.router!.categories.find(
        (cat) => cat.name === 'New Name 1'
      );
      const category2 = result.router!.categories.find(
        (cat) => cat.name === 'New Name 2'
      );
      const otherCategory = result.router!.categories.find(
        (cat) => cat.name === 'Other'
      );

      // Verify UUIDs are preserved
      expect(category1?.uuid).to.equal('category-1-uuid');
      expect(category1?.exit_uuid).to.equal('exit-1-uuid');

      expect(category2?.uuid).to.equal('category-2-uuid');
      expect(category2?.exit_uuid).to.equal('exit-2-uuid');

      expect(otherCategory?.uuid).to.equal('other-category-uuid');
      expect(otherCategory?.exit_uuid).to.equal('other-exit-uuid');

      // Verify case UUIDs are also preserved
      const case1 = result.router!.cases.find(
        (c) => c.category_uuid === 'category-1-uuid'
      );
      const case2 = result.router!.cases.find(
        (c) => c.category_uuid === 'category-2-uuid'
      );

      expect(case1?.uuid).to.equal('case-1-uuid');
      expect(case1?.arguments).to.deep.equal(['yes']);
      expect(case2?.uuid).to.equal('case-2-uuid');
      expect(case2?.arguments).to.deep.equal(['no']);

      // the new rule order is kept
      expect(result.router!.categories.map((cat) => cat.name)).to.deep.equal([
        'New Name 2',
        'New Name 1',
        'Other'
      ]);

      // Verify exits are preserved
      expect(result.exits).to.have.length(3);
      expect(result.exits.map((e) => e.uuid)).to.include.members([
        'exit-1-uuid',
        'exit-2-uuid',
        'other-exit-uuid'
      ]);
    });

    it('merges rules with same category name into single category', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        rules: [
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'yes',
            category: 'Positive'
          },
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'ok',
            category: 'Positive' // Same category name
          },
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'no',
            category: 'Negative'
          }
        ]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: [],
          cases: []
        },
        exits: []
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      // Should have 3 categories: Positive, Negative, Other
      expect(result.router?.categories).to.have.length(3);

      const categoryNames = result.router!.categories.map((cat) => cat.name);
      expect(categoryNames).to.include.members([
        'Positive',
        'Negative',
        'Other'
      ]);

      // Should have 3 cases but only 2 user categories (+ Other)
      expect(result.router?.cases).to.have.length(3);

      // Both "yes" and "ok" rules should reference the same Positive category
      const positiveCategory = result.router!.categories.find(
        (cat) => cat.name === 'Positive'
      );
      expect(positiveCategory).to.exist;

      const positiveCases = result.router!.cases.filter(
        (case_) => case_.category_uuid === positiveCategory!.uuid
      );
      expect(positiveCases).to.have.length(2);

      // Verify the cases have the correct arguments
      const yesCase = positiveCases.find((case_) =>
        case_.arguments.includes('yes')
      );
      const okCase = positiveCases.find((case_) =>
        case_.arguments.includes('ok')
      );

      expect(yesCase).to.exist;
      expect(okCase).to.exist;

      // Should have 3 exits: Positive, Negative, Other
      expect(result.exits).to.have.length(3);
    });

    it('preserves category order when merging same category names', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        rules: [
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'yes',
            category: 'First'
          },
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'maybe',
            category: 'Second'
          },
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'ok',
            category: 'First' // Same as first rule
          }
        ]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: [],
          cases: []
        },
        exits: []
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      // Should have 3 categories: First, Second, Other (in that order)
      expect(result.router?.categories).to.have.length(3);

      const categoryNames = result.router!.categories.map((cat) => cat.name);
      expect(categoryNames).to.deep.equal(['First', 'Second', 'Other']);

      // First category should have 2 cases (yes and ok)
      const firstCategory = result.router!.categories.find(
        (cat) => cat.name === 'First'
      );
      const firstCases = result.router!.cases.filter(
        (case_) => case_.category_uuid === firstCategory!.uuid
      );
      expect(firstCases).to.have.length(2);

      // Second category should have 1 case (maybe)
      const secondCategory = result.router!.categories.find(
        (cat) => cat.name === 'Second'
      );
      const secondCases = result.router!.cases.filter(
        (case_) => case_.category_uuid === secondCategory!.uuid
      );
      expect(secondCases).to.have.length(1);
    });

    it('preserves category UUIDs when rules are reordered', () => {
      const originalNode = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch' as const,
          operand: '@input.text',
          categories: [
            {
              uuid: 'yes-category-uuid',
              name: 'Yes',
              exit_uuid: 'yes-exit-uuid'
            },
            {
              uuid: 'no-category-uuid',
              name: 'No',
              exit_uuid: 'no-exit-uuid'
            },
            {
              uuid: 'other-category-uuid',
              name: 'Other',
              exit_uuid: 'other-exit-uuid'
            }
          ],
          cases: [
            {
              uuid: 'yes-case-uuid',
              type: 'has_phrase',
              arguments: ['yes'],
              category_uuid: 'yes-category-uuid'
            },
            {
              uuid: 'no-case-uuid',
              type: 'has_phrase',
              arguments: ['no'],
              category_uuid: 'no-category-uuid'
            }
          ]
        },
        exits: [
          { uuid: 'yes-exit-uuid', destination_uuid: null },
          { uuid: 'no-exit-uuid', destination_uuid: null },
          { uuid: 'other-exit-uuid', destination_uuid: null }
        ]
      };

      // Reorder the rules - put "No" first, "Yes" second
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        rules: [
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'no',
            category: 'No' // This rule was originally second
          },
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'yes',
            category: 'Yes' // This rule was originally first
          }
        ]
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      // Verify that categories keep their original UUIDs despite reordering
      expect(result.router?.categories).to.have.length(3); // Two rules + Other

      const yesCategory = result.router!.categories.find(
        (cat) => cat.name === 'Yes'
      );
      const noCategory = result.router!.categories.find(
        (cat) => cat.name === 'No'
      );
      const otherCategory = result.router!.categories.find(
        (cat) => cat.name === 'Other'
      );

      // Categories should preserve their original UUIDs
      expect(yesCategory?.uuid).to.equal('yes-category-uuid');
      expect(yesCategory?.exit_uuid).to.equal('yes-exit-uuid');

      expect(noCategory?.uuid).to.equal('no-category-uuid');
      expect(noCategory?.exit_uuid).to.equal('no-exit-uuid');

      expect(otherCategory?.uuid).to.equal('other-category-uuid');
      expect(otherCategory?.exit_uuid).to.equal('other-exit-uuid');

      // Verify the cases are created in the new order but reference correct categories
      expect(result.router?.cases).to.have.length(2);

      const firstCase = result.router!.cases[0];
      const secondCase = result.router!.cases[1];

      // First case should be "no" and reference the No category
      expect(firstCase.arguments).to.deep.equal(['no']);
      expect(firstCase.category_uuid).to.equal('no-category-uuid');

      // Second case should be "yes" and reference the Yes category
      expect(secondCase.arguments).to.deep.equal(['yes']);
      expect(secondCase.category_uuid).to.equal('yes-category-uuid');
    });

    it('preserves rule order when rules have duplicate categories', () => {
      const formData = {
        uuid: 'test-node',
        result_name: 'response',
        rules: [
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'first',
            category: 'Shared'
          },
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'middle',
            category: 'Different'
          },
          {
            operator: { value: 'has_phrase', name: 'contains phrase' },
            value1: 'last',
            category: 'Shared' // Same as first rule
          }
        ]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        router: {
          type: 'switch',
          result_name: 'response',
          categories: [],
          cases: []
        },
        exits: []
      };

      const result = wait_for_response.fromFormData!(formData, originalNode);

      // Should have 3 cases in the same order as the input rules
      expect(result.router?.cases).to.have.length(3);

      const cases = result.router!.cases;

      // First case should be "first"
      expect(cases[0].arguments).to.deep.equal(['first']);
      expect(cases[0].type).to.equal('has_phrase');

      // Second case should be "middle"
      expect(cases[1].arguments).to.deep.equal(['middle']);
      expect(cases[1].type).to.equal('has_phrase');

      // Third case should be "last"
      expect(cases[2].arguments).to.deep.equal(['last']);
      expect(cases[2].type).to.equal('has_phrase');

      // Find the shared category
      const sharedCategory = result.router!.categories.find(
        (cat) => cat.name === 'Shared'
      );
      const differentCategory = result.router!.categories.find(
        (cat) => cat.name === 'Different'
      );

      expect(sharedCategory).to.exist;
      expect(differentCategory).to.exist;

      // First and third cases should reference the same "Shared" category
      expect(cases[0].category_uuid).to.equal(sharedCategory!.uuid);
      expect(cases[2].category_uuid).to.equal(sharedCategory!.uuid);

      // Second case should reference the "Different" category
      expect(cases[1].category_uuid).to.equal(differentCategory!.uuid);

      // Should have 3 categories: Shared, Different, Other
      expect(result.router?.categories).to.have.length(3);
      const categoryNames = result.router!.categories.map((cat) => cat.name);
      expect(categoryNames).to.deep.equal(['Shared', 'Different', 'Other']);
    });
  });

  describe('category auto-population', () => {
    it('auto-populates fixed category names for operators with no operands', () => {
      // Test with has_text operator (0 operands)
      const rulesConfig = wait_for_response.form.rules as any;
      const onItemChange = rulesConfig.onItemChange;

      const items = [
        { operator: 'has_text', value1: '', value2: '', category: '' }
      ];
      const result = onItemChange(0, 'operator', 'has_text', items);

      expect(result[0].category).to.equal('Has Text');
    });

    it('auto-populates category name for single operand operators', () => {
      const rulesConfig = wait_for_response.form.rules as any;
      const onItemChange = rulesConfig.onItemChange;

      // Test has_any_word - should capitalize first letter
      const items = [
        { operator: 'has_any_word', value1: '', value2: '', category: '' }
      ];
      let result = onItemChange(0, 'value1', 'red', items);
      expect(result[0].category).to.equal('Red');

      // Test has_number_lt - should include < symbol
      const items2 = [
        { operator: 'has_number_lt', value1: '', value2: '', category: '' }
      ];
      result = onItemChange(0, 'value1', '5', items2);
      expect(result[0].category).to.equal('< 5');

      // Test has_number_eq - should include = symbol
      const items3 = [
        { operator: 'has_number_eq', value1: '', value2: '', category: '' }
      ];
      result = onItemChange(0, 'value1', '10', items3);
      expect(result[0].category).to.equal('= 10');
    });

    it('auto-populates category name for two operand operators', () => {
      const rulesConfig = wait_for_response.form.rules as any;
      const onItemChange = rulesConfig.onItemChange;

      // Test has_number_between - should format as range
      const items = [
        { operator: 'has_number_between', value1: '', value2: '', category: '' }
      ];
      let result = onItemChange(0, 'value1', '45', items);
      // Should not populate yet (need both values)
      expect(result[0].category).to.equal('');

      result = onItemChange(0, 'value2', '85', result);
      expect(result[0].category).to.equal('45 - 85');
    });

    it('auto-populates category name for date operators with relative expressions', () => {
      const rulesConfig = wait_for_response.form.rules as any;
      const onItemChange = rulesConfig.onItemChange;

      // Test has_date_gt - should format as "After today + X days"
      let items = [
        { operator: 'has_date_gt', value1: '', value2: '', category: '' }
      ];
      let result = onItemChange(0, 'value1', 'today + 5', items);
      expect(result[0].category).to.equal('After today + 5 days');

      // Test has_date_lt with single day - should use "day" not "days"
      items = [
        { operator: 'has_date_lt', value1: '', value2: '', category: '' }
      ];
      result = onItemChange(0, 'value1', 'today + 1', items);
      expect(result[0].category).to.equal('Before today + 1 day');

      // Test has_date_eq
      items = [
        { operator: 'has_date_eq', value1: '', value2: '', category: '' }
      ];
      result = onItemChange(0, 'value1', 'today - 3', items);
      expect(result[0].category).to.equal('today - 3 days');
    });

    it('updates category name when value changes if category matches old default', () => {
      const rulesConfig = wait_for_response.form.rules as any;
      const onItemChange = rulesConfig.onItemChange;

      // Start with "red"
      const items = [
        { operator: 'has_any_word', value1: 'red', value2: '', category: 'Red' }
      ];

      // Change to "blue" - category should update since it matches old default
      const result = onItemChange(0, 'value1', 'blue', items);
      expect(result[0].category).to.equal('Blue');
    });

    it('does not update category name when value changes if user customized it', () => {
      const rulesConfig = wait_for_response.form.rules as any;
      const onItemChange = rulesConfig.onItemChange;

      // Start with "red" but custom category "Color"
      const items = [
        {
          operator: 'has_any_word',
          value1: 'red',
          value2: '',
          category: 'Color'
        }
      ];

      // Change to "blue" - category should NOT update (user customized it)
      const result = onItemChange(0, 'value1', 'blue', items);
      expect(result[0].category).to.equal('Color');
    });

    it('updates category when operator changes', () => {
      const rulesConfig = wait_for_response.form.rules as any;
      const onItemChange = rulesConfig.onItemChange;

      // Start with has_any_word
      const items = [
        {
          operator: 'has_any_word',
          value1: 'test',
          value2: '',
          category: 'Test'
        }
      ];

      // Change to has_text (0 operands) - category should update to fixed name
      const result = onItemChange(0, 'operator', 'has_text', items);
      expect(result[0].category).to.equal('Has Text');
    });
  });
});
