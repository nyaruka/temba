import { expect } from '@open-wc/testing';
import { split_by_llm } from '../../src/flow/nodes/split_by_llm';
import { Node, CallLLM } from '../../src/store/flow-definition';
import { SelectFieldConfig } from '../../src/flow/types';
import { NodeTest } from '../NodeHelper';

/**
 * Test suite for the split_by_llm node configuration.
 */
describe('split_by_llm node config', () => {
  const helper = new NodeTest(split_by_llm, 'split_by_llm');

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(split_by_llm.name).to.equal('Call AI');
    });

    it('has form configuration', () => {
      expect(split_by_llm.form).to.exist;
      expect(split_by_llm.form.llm).to.exist;
      expect(split_by_llm.form.instructions).to.exist;
      expect(split_by_llm.form.input).to.exist;
    });

    it('has layout configuration', () => {
      expect(split_by_llm.layout).to.exist;
      expect(split_by_llm.layout).to.deep.equal([
        'llm',
        'input',
        'instructions'
      ]);
    });
  });

  describe('llm shouldExclude', () => {
    const shouldExclude = (split_by_llm.form.llm as SelectFieldConfig)
      .shouldExclude!;

    it('includes options that have the generation role', () => {
      expect(shouldExclude({ roles: ['generation'] })).to.be.false;
      expect(shouldExclude({ roles: ['generation', 'translation'] })).to.be.false;
    });

    it('excludes options without the generation role', () => {
      expect(shouldExclude({ roles: ['translation'] })).to.be.true;
      expect(shouldExclude({ roles: ['classification'] })).to.be.true;
      expect(shouldExclude({ roles: [] })).to.be.true;
    });
  });

  describe('toFormData', () => {
    it('extracts data from node with call_llm action', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [
          {
            uuid: 'test-action',
            type: 'call_llm',
            llm: { uuid: 'gpt-4', name: 'GPT 4.1' },
            instructions: 'Translate to French',
            input: '@input',
            output_local: '_llm_output'
          } as CallLLM
        ],
        exits: []
      };

      const formData = split_by_llm.toFormData(node);

      expect(formData.uuid).to.equal('test-node');
      expect(formData.llm).to.deep.equal([{ uuid: 'gpt-4', name: 'GPT 4.1' }]);
      expect(formData.input).to.equal('@input');
      expect(formData.instructions).to.equal('Translate to French');
    });

    it('handles empty node', () => {
      const node: Node = {
        uuid: 'test-node',
        actions: [],
        exits: []
      };

      const formData = split_by_llm.toFormData(node);

      expect(formData.uuid).to.equal('test-node');
      expect(formData.llm).to.deep.equal([]);
      expect(formData.input).to.equal('@input');
      expect(formData.instructions).to.equal('');
    });
  });

  describe('fromFormData', () => {
    it('creates node with call_llm action and router', () => {
      const formData = {
        uuid: 'test-node',
        llm: [{ value: 'gpt-4', name: 'GPT 4.1' }],
        input: '@input',
        instructions: 'Translate to French'
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: []
      };

      const node = split_by_llm.fromFormData(formData, originalNode);

      expect(node.uuid).to.equal('test-node');
      expect(node.actions).to.have.length(1);
      expect(node.actions[0].type).to.equal('call_llm');
      expect((node.actions[0] as CallLLM).llm).to.deep.equal({
        uuid: 'gpt-4',
        name: 'GPT 4.1'
      });
      expect((node.actions[0] as CallLLM).instructions).to.equal(
        'Translate to French'
      );
      expect((node.actions[0] as CallLLM).input).to.equal('@input');
      expect((node.actions[0] as CallLLM).output_local).to.equal('_llm_output');

      expect(node.router).to.exist;
      expect(node.router.type).to.equal('switch');
      expect(node.router.operand).to.equal('@locals._llm_output');
      expect(node.router.categories).to.have.length(2);
      expect(node.router.categories[0].name).to.equal('Success');
      expect(node.router.categories[1].name).to.equal('Failure');

      expect(node.exits).to.have.length(2);
    });

    it('handles empty form data', () => {
      const formData = {
        uuid: 'test-node',
        llm: [],
        input: '',
        instructions: ''
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: []
      };

      const node = split_by_llm.fromFormData(formData, originalNode);

      const action = node.actions[0] as CallLLM;
      expect(action.llm).to.deep.equal({ uuid: '', name: '' });
      expect(action.instructions).to.equal('');
      expect(action.input).to.equal('@input');
    });
  });

  describe('node scenarios', () => {
    const createTestNode = (
      llm: any,
      instructions: string,
      input: string = '@input'
    ): Node => ({
      uuid: 'test-node',
      actions: [
        {
          uuid: 'test-action',
          type: 'call_llm',
          llm,
          instructions,
          input,
          output_local: '_llm_output'
        } as CallLLM
      ],
      router: {
        type: 'switch',
        operand: '@locals._llm_output',
        categories: [
          {
            uuid: 'success-category',
            name: 'Success',
            exit_uuid: 'success-exit'
          },
          {
            uuid: 'failure-category',
            name: 'Failure',
            exit_uuid: 'failure-exit'
          }
        ],
        default_category_uuid: 'failure-category',
        cases: [
          {
            uuid: 'success-case',
            type: 'has_text',
            arguments: [],
            category_uuid: 'success-category'
          }
        ]
      },
      exits: [
        {
          uuid: 'success-exit',
          destination_uuid: null
        },
        {
          uuid: 'failure-exit',
          destination_uuid: null
        }
      ]
    });

    const nodeUI = {
      type: 'split_by_llm',
      position: { left: 50, top: 50 }
    };

    it('renders translation task', async () => {
      await helper.testNode(
        createTestNode(
          { uuid: 'gpt-4', name: 'GPT 4.1' },
          'Translate to French'
        ),
        nodeUI,
        'translation-task'
      );
    });

    it('renders sentiment analysis', async () => {
      await helper.testNode(
        createTestNode(
          { uuid: 'gpt-5', name: 'GPT 5' },
          'Analyze the sentiment of the following message and classify it as positive, negative, or neutral. Provide a brief explanation for your classification.'
        ),
        nodeUI,
        'sentiment-analysis'
      );
    });

    it('renders summarization', async () => {
      await helper.testNode(
        createTestNode(
          { uuid: 'gpt-4', name: 'GPT 4.1' },
          'Summarize the key points from the conversation above in bullet format.'
        ),
        nodeUI,
        'summarization'
      );
    });

    it('renders information extraction', async () => {
      await helper.testNode(
        createTestNode(
          { uuid: 'gpt-5', name: 'GPT 5' },
          'Extract any contact information (phone numbers, email addresses) from the text and format them as a JSON object.'
        ),
        nodeUI,
        'information-extraction'
      );
    });
  });
});
