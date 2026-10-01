import { expect, fixture, html } from '@open-wc/testing';
import { render } from 'lit';
import { split_by_llm_categorize } from '../../src/flow/nodes/split_by_llm_categorize';
import { Node } from '../../src/store/flow-definition';
import { SelectFieldConfig } from '../../src/flow/types';
import { NodeTest } from '../NodeHelper';

// Helper function to create routers with proper cases and exits
function createSplitRouter(categoryNames: string[]) {
  const categories = [];
  const exits = [];
  const cases = [];

  // Add user categories
  categoryNames.forEach((categoryName) => {
    const categoryUuid = `category-${categoryName
      .toLowerCase()
      .replace(/\s+/g, '-')}`;
    const exitUuid = `exit-${categoryName.toLowerCase().replace(/\s+/g, '-')}`;
    const caseUuid = `case-${categoryName.toLowerCase().replace(/\s+/g, '-')}`;

    categories.push({
      uuid: categoryUuid,
      name: categoryName,
      exit_uuid: exitUuid
    });

    exits.push({
      uuid: exitUuid,
      destination_uuid: null
    });

    cases.push({
      uuid: caseUuid,
      type: 'has_only_text',
      arguments: [categoryName],
      category_uuid: categoryUuid
    });
  });

  // Add "Other" category (default)
  const otherCategoryUuid = 'category-other';
  const otherExitUuid = 'exit-other';

  categories.push({
    uuid: otherCategoryUuid,
    name: 'Other',
    exit_uuid: otherExitUuid
  });
  exits.push({
    uuid: otherExitUuid,
    destination_uuid: null
  });

  // Add "Failure" category
  const failureCategoryUuid = 'category-failure';
  const failureExitUuid = 'exit-failure';
  const failureCaseUuid = 'case-failure';

  categories.push({
    uuid: failureCategoryUuid,
    name: 'Failure',
    exit_uuid: failureExitUuid
  });
  exits.push({
    uuid: failureExitUuid,
    destination_uuid: null
  });

  // Add failure case for <ERROR>
  cases.push({
    uuid: failureCaseUuid,
    type: 'has_only_text',
    arguments: ['<ERROR>'],
    category_uuid: failureCategoryUuid
  });

  return {
    router: {
      type: 'switch' as const,
      categories: categories,
      default_category_uuid: otherCategoryUuid,
      operand: '@locals._llm_output',
      cases: cases
    },
    exits: exits
  };
}

/**
 * Test suite for the split_by_llm_categorize node configuration.
 */
describe('split_by_llm_categorize node config', () => {
  const helper = new NodeTest(
    split_by_llm_categorize,
    'split_by_llm_categorize'
  );

  describe('basic properties', () => {
    helper.testBasicProperties();

    it('has correct name', () => {
      expect(split_by_llm_categorize.name).to.equal('Split by AI');
    });

    it('has correct type', () => {
      expect(split_by_llm_categorize.type).to.equal('split_by_llm_categorize');
    });
  });

  describe('model shouldExclude', () => {
    const shouldExclude = (
      split_by_llm_categorize.form.model as SelectFieldConfig
    ).shouldExclude!;

    it('includes options that have the classification role', () => {
      expect(shouldExclude({ roles: ['classification'] })).to.be.false;
      expect(shouldExclude({ roles: ['classification', 'generation'] })).to.be
        .false;
    });

    it('excludes options without the classification role', () => {
      expect(shouldExclude({ roles: ['translation'] })).to.be.true;
      expect(shouldExclude({ roles: ['generation'] })).to.be.true;
      expect(shouldExclude({ roles: [] })).to.be.true;
    });
  });

  describe('node scenarios', () => {
    it('renders basic categorization', async () => {
      const basicRouter = createSplitRouter(['Greeting', 'Question']);
      await helper.testNode(
        {
          uuid: 'test-node-1',
          actions: [
            {
              uuid: 'call-llm-uuid',
              type: 'call_classifier',
              model: { uuid: 'llm-123', name: 'Claude' },
              input: '@input',
              options: [{ name: 'Greeting' }, { name: 'Question' }],
              required_confidence: 'medium',
              output_local: '_llm_output'
            } as any
          ],
          router: basicRouter.router,
          exits: basicRouter.exits
        } as Node,
        { type: 'split_by_llm_categorize' },
        'basic-categorization'
      );
    });

    it('renders custom input and result name', async () => {
      const premiumRouter = createSplitRouter(['Premium', 'Regular', 'VIP']);
      await helper.testNode(
        {
          uuid: 'test-node-2',
          actions: [
            {
              uuid: 'call-llm-uuid-2',
              type: 'call_classifier',
              model: { uuid: 'llm-456', name: 'GPT-4' },
              input: '@contact.name',
              options: [
                { name: 'Premium' },
                { name: 'Regular' },
                { name: 'VIP' }
              ],
              required_confidence: 'medium',
              output_local: '_llm_output'
            } as any
          ],
          router: premiumRouter.router,
          exits: premiumRouter.exits
        } as Node,
        { type: 'split_by_llm_categorize' },
        'custom-input-and-result-name'
      );
    });

    it('renders many categories', async () => {
      const priorityRouter = createSplitRouter([
        'High',
        'Medium',
        'Low',
        'Critical',
        'Urgent'
      ]);
      await helper.testNode(
        {
          uuid: 'test-node-3',
          actions: [
            {
              uuid: 'call-llm-uuid-3',
              type: 'call_classifier',
              model: { uuid: 'llm-789', name: 'Gemini' },
              input: '@fields.priority',
              options: [
                { name: 'High' },
                { name: 'Medium' },
                { name: 'Low' },
                { name: 'Critical' },
                { name: 'Urgent' }
              ],
              required_confidence: 'medium',
              output_local: '_llm_output'
            } as any
          ],
          router: priorityRouter.router,
          exits: priorityRouter.exits
        } as Node,
        { type: 'split_by_llm_categorize' },
        'many-categories'
      );
    });

    it('renders minimal categories', async () => {
      const minimalRouter = createSplitRouter(['Yes']);
      await helper.testNode(
        {
          uuid: 'test-node-4',
          actions: [
            {
              uuid: 'call-llm-uuid-4',
              type: 'call_classifier',
              model: { uuid: 'llm-minimal', name: 'Basic LLM' },
              input: '@input',
              options: [{ name: 'Yes' }],
              required_confidence: 'medium',
              output_local: '_llm_output'
            } as any
          ],
          router: minimalRouter.router,
          exits: minimalRouter.exits
        } as Node,
        { type: 'split_by_llm_categorize' },
        'minimal-categories'
      );
    });

    it('renders feedback categorization', async () => {
      const feedbackRouter = createSplitRouter([
        'Bug Report',
        'Feature Request',
        'General Feedback',
        'Support Request'
      ]);
      await helper.testNode(
        {
          uuid: 'test-node-5',
          actions: [
            {
              uuid: 'call-llm-uuid-5',
              type: 'call_classifier',
              model: { uuid: 'llm-special', name: 'Special Characters LLM' },
              input: '@contact.fields.feedback',
              options: [
                {
                  name: 'Bug Report',
                  description: 'Something is broken or not working as expected'
                },
                {
                  name: 'Feature Request',
                  description: 'Asking for something new'
                },
                { name: 'General Feedback' },
                { name: 'Support Request' }
              ],
              required_confidence: 'medium',
              output_local: '_llm_output'
            } as any
          ],
          router: feedbackRouter.router,
          exits: feedbackRouter.exits
        } as Node,
        { type: 'split_by_llm_categorize' },
        'feedback-categorization'
      );
    });
  });

  describe('round-trip conversion validation', () => {
    it('converts to form data correctly', () => {
      const testRouter = createSplitRouter(['Greeting', 'Question']);
      const node: Node = {
        uuid: 'test-node',
        actions: [
          {
            uuid: 'call-llm-uuid',
            type: 'call_classifier',
            model: { uuid: 'llm-123', name: 'Test LLM' },
            input: '@input',
            options: [
              { name: 'Greeting', description: 'Saying hello' },
              { name: 'Question' }
            ],
            required_confidence: 'high',
            output_local: '_llm_output'
          } as any
        ],
        router: testRouter.router,
        exits: testRouter.exits
      };

      const formData = split_by_llm_categorize.toFormData!(node);

      expect(formData.uuid).to.equal('test-node');
      expect(formData.model).to.deep.equal([
        { uuid: 'llm-123', name: 'Test LLM' }
      ]);
      expect(formData.input).to.equal('@input');
      expect(formData.options).to.deep.equal([
        { name: 'Greeting', description: 'Saying hello' },
        { name: 'Question', description: '' }
      ]);
      expect(formData.required_confidence).to.deep.equal([
        { value: 'high', name: 'High' }
      ]);
    });

    it('creates new nodes without an Other category', () => {
      const blank: Node = { uuid: 'new-node', actions: [], exits: [] };
      const formData = split_by_llm_categorize.toFormData!(blank);
      formData.model = [{ value: 'llm-123', name: 'Claude' }];
      formData.options = [{ name: 'Yes' }, { name: 'No' }];

      const result = split_by_llm_categorize.fromFormData!(formData, blank);
      expect((result.actions[0] as any).required_confidence).to.equal('none');
      expect(result.router!.categories.map((c) => c.name)).to.deep.equal([
        'Yes',
        'No',
        'Failure'
      ]);
    });

    it('treats a missing required_confidence as none', () => {
      const testRouter = createSplitRouter(['Greeting']);
      const formData = split_by_llm_categorize.toFormData!({
        uuid: 'test-node',
        actions: [
          {
            uuid: 'classifier-uuid',
            type: 'call_classifier',
            model: { uuid: 'llm-123', name: 'Test LLM' },
            input: '@input',
            options: [{ name: 'Greeting' }],
            output_local: '_classification'
          } as any
        ],
        router: testRouter.router,
        exits: testRouter.exits
      });

      expect(formData.required_confidence).to.deep.equal([
        { value: 'none', name: 'Always pick a category' }
      ]);
    });

    it('reads each saved level', () => {
      const testRouter = createSplitRouter(['Greeting']);
      const levels = {
        none: 'Always pick a category',
        low: 'Low',
        medium: 'Medium',
        high: 'High'
      };
      Object.entries(levels).forEach(([value, name]) => {
        const formData = split_by_llm_categorize.toFormData!({
          uuid: 'test-node',
          actions: [
            {
              uuid: 'classifier-uuid',
              type: 'call_classifier',
              model: { uuid: 'llm-123', name: 'Test LLM' },
              input: '@input',
              options: [{ name: 'Greeting' }],
              required_confidence: value,
              output_local: '_classification'
            } as any
          ],
          router: testRouter.router,
          exits: testRouter.exits
        });
        expect(formData.required_confidence).to.deep.equal([{ value, name }]);
      });
    });

    it('defaults new nodes to always picking a category', () => {
      const formData = split_by_llm_categorize.toFormData!({
        uuid: 'test-node',
        actions: [],
        exits: []
      });

      expect(formData.required_confidence).to.deep.equal([
        { value: 'none', name: 'Always pick a category' }
      ]);
      expect(formData.options).to.deep.equal([]);
    });

    it('converts from form data correctly', () => {
      const formData = {
        uuid: 'test-node',
        model: [{ value: 'llm-456', name: 'GPT-4' }],
        input: '@contact.name',
        options: [{ name: 'Premium' }, { name: 'Regular' }],
        required_confidence: [{ value: 'medium', name: 'Medium' }]
      };

      const originalNode: Node = {
        uuid: 'test-node',
        actions: [],
        exits: []
      };

      const result = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      expect(result.uuid).to.equal('test-node');
      expect(result.actions).to.have.length(1);
      expect(result.actions[0].type).to.equal('call_classifier');
      expect((result.actions[0] as any).model.uuid).to.equal('llm-456');
      expect((result.actions[0] as any).model.name).to.equal('GPT-4');
      expect((result.actions[0] as any).input).to.equal('@contact.name');

      // Should have user categories plus Other and Failure
      expect(result.router!.categories).to.have.length(4);
      const categoryNames = result.router!.categories.map((cat) => cat.name);
      expect(categoryNames).to.include.members([
        'Premium',
        'Regular',
        'Other',
        'Failure'
      ]);

      // Should have corresponding exits
      expect(result.exits).to.have.length(4);
    });
  });

  describe('edge cases and validation', () => {
    it('handles categories with empty names correctly', () => {
      const formData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [
          { name: 'Valid Category' },
          { name: '' }, // empty name
          { name: '   ' }, // only whitespace
          { name: 'Another Valid' }
        ],
        result_name: 'Intent'
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        exits: []
      };

      const result = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      // Should only include non-empty categories
      const userCategories = result.router!.categories.filter(
        (cat) => cat.name !== 'Other' && cat.name !== 'Failure'
      );
      expect(userCategories).to.have.length(2);
      expect(userCategories.map((cat) => cat.name)).to.deep.equal([
        'Valid Category',
        'Another Valid'
      ]);
    });

    it('handles categories with special characters', () => {
      const formData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [
          { name: 'Category-1' },
          { name: 'Category_2' },
          { name: 'Category@3' },
          { name: 'Category with spaces' }
        ],
        result_name: 'Intent'
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        exits: []
      };

      const result = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      // Should preserve all special characters in category names
      const userCategories = result.router!.categories.filter(
        (cat) => cat.name !== 'Other' && cat.name !== 'Failure'
      );
      expect(userCategories).to.have.length(4);
      expect(userCategories.map((cat) => cat.name)).to.include.members([
        'Category-1',
        'Category_2',
        'Category@3',
        'Category with spaces'
      ]);

      // Verify cases also have correct names
      const caseNames = result
        .router!.cases.filter((c) => c.arguments[0] !== '<ERROR>')
        .map((c) => c.arguments[0]);
      expect(caseNames).to.include.members([
        'Category-1',
        'Category_2',
        'Category@3',
        'Category with spaces'
      ]);
    });

    it('maintains UUID consistency between categories, cases, and exits', () => {
      const formData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [{ name: 'Test Category' }],
        result_name: 'Intent'
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        exits: []
      };

      const result = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      // Find the test category
      const testCategory = result.router!.categories.find(
        (cat) => cat.name === 'Test Category'
      );
      const testCase = result.router!.cases.find(
        (c) => c.arguments[0] === 'Test Category'
      );
      const testExit = result.exits.find(
        (exit) => exit.uuid === testCategory!.exit_uuid
      );

      // Verify UUID consistency
      expect(testCase!.category_uuid).to.equal(testCategory!.uuid);
      expect(testExit!.uuid).to.equal(testCategory!.exit_uuid);
    });

    it('generates unique UUIDs for each run', () => {
      const formData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [{ name: 'Test' }],
        result_name: 'Intent'
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        exits: []
      };

      const result1 = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );
      const result2 = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      // UUIDs should be different for each generation
      expect(result1.actions[0].uuid).to.not.equal(result2.actions[0].uuid);
      expect(result1.router!.categories[0].uuid).to.not.equal(
        result2.router!.categories[0].uuid
      );
      expect(result1.exits[0].uuid).to.not.equal(result2.exits[0].uuid);
    });

    it('roundtrip conversion (fromFormData -> toFormData) works correctly', () => {
      const originalFormData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@custom.input',
        options: [
          { name: 'Category1', description: 'The first one' },
          { name: 'Category2', description: '' }
        ],
        required_confidence: [{ value: 'high', name: 'High' }],
        result_name: 'CustomResult'
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        exits: []
      };

      // Convert form data to node
      const node = split_by_llm_categorize.fromFormData!(
        originalFormData,
        originalNode
      );

      // Convert back to form data
      const recoveredFormData = split_by_llm_categorize.toFormData!(node);

      // Should match original data
      expect(recoveredFormData.uuid).to.equal(originalFormData.uuid);
      expect(recoveredFormData.model).to.deep.equal([
        { uuid: 'llm-uuid-123', name: 'Claude' }
      ]);
      expect(recoveredFormData.input).to.equal(originalFormData.input);
      expect(recoveredFormData.options).to.deep.equal(originalFormData.options);
      expect(recoveredFormData.required_confidence).to.deep.equal(
        originalFormData.required_confidence
      );
      expect(recoveredFormData.result_name).to.equal('CustomResult');
    });

    it('treats an unknown level as none', () => {
      const testRouter = createSplitRouter(['Greeting']);
      const formData = split_by_llm_categorize.toFormData!({
        uuid: 'test-node',
        actions: [
          {
            uuid: 'classifier-uuid',
            type: 'call_classifier',
            model: { uuid: 'llm-123', name: 'Test LLM' },
            input: '@input',
            options: [{ name: 'Greeting' }],
            required_confidence: 'any',
            output_local: '_classification'
          } as any
        ],
        router: testRouter.router,
        exits: testRouter.exits
      });

      expect(formData.required_confidence).to.deep.equal([
        { value: 'none', name: 'Always pick a category' }
      ]);
    });

    it('drops the Other category when always picking a category', () => {
      const testRouter = createSplitRouter(['Greeting', 'Question']);
      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [
          {
            uuid: 'existing-action-uuid',
            type: 'call_classifier',
            model: { uuid: 'llm-123', name: 'Claude' },
            input: '@input',
            options: [{ name: 'Greeting' }, { name: 'Question' }],
            required_confidence: 'medium',
            output_local: '_classification'
          } as any
        ],
        router: testRouter.router,
        exits: testRouter.exits
      };

      const formData = split_by_llm_categorize.toFormData!(originalNode);
      formData.required_confidence = [
        { value: 'none', name: 'Always pick a category' }
      ];
      const result = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      expect((result.actions[0] as any).required_confidence).to.equal('none');
      expect(result.router!.categories.map((c) => c.name)).to.deep.equal([
        'Greeting',
        'Question',
        'Failure'
      ]);
      expect(result.router!.default_category_uuid).to.equal('category-failure');
      expect(result.exits.map((e) => e.uuid)).to.deep.equal([
        'exit-greeting',
        'exit-question',
        'exit-failure'
      ]);

      // and reading it back keeps the level and the same categories
      const recovered = split_by_llm_categorize.toFormData!(result);
      expect(recovered.required_confidence).to.deep.equal([
        { value: 'none', name: 'Always pick a category' }
      ]);
      expect(recovered.options.map((o: any) => o.name)).to.deep.equal([
        'Greeting',
        'Question'
      ]);

      // switching back to a real confidence brings Other back as the default
      recovered.required_confidence = [{ value: 'high', name: 'High' }];
      const restored = split_by_llm_categorize.fromFormData!(recovered, result);
      expect((restored.actions[0] as any).required_confidence).to.equal('high');
      const other = restored.router!.categories.find((c) => c.name === 'Other');
      expect(other).to.exist;
      expect(restored.router!.default_category_uuid).to.equal(other!.uuid);
      expect(restored.exits).to.have.length(4);
    });

    it('explains the missing Other category when always picking a category', () => {
      const helpText = split_by_llm_categorize.form!.required_confidence
        .helpText as (formData: any) => string;
      expect(
        helpText({
          required_confidence: [
            { value: 'none', name: 'Always pick a category' }
          ]
        })
      ).to.include('no **Other** category');
      expect(
        helpText({ required_confidence: [{ value: 'medium', name: 'Medium' }] })
      ).to.include('go to **Other**');
    });

    it('puts confidence in the accordion, flagged when a minimum is set', () => {
      const accordion = split_by_llm_categorize.layout!.find(
        (item: any) => item.type === 'accordion'
      ) as any;
      const section = accordion.sections[0];
      expect(section.label).to.equal('Confidence');
      expect(section.items).to.deep.equal(['required_confidence']);
      expect(
        section.getValueCount({
          required_confidence: [
            { value: 'none', name: 'Always pick a category' }
          ]
        })
      ).to.be.false;
      expect(
        section.getValueCount({
          required_confidence: [{ value: 'high', name: 'High' }]
        })
      ).to.be.true;
    });

    it('preserves the output local of an existing action', () => {
      const testRouter = createSplitRouter(['Greeting']);
      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [
          {
            uuid: 'existing-action-uuid',
            type: 'call_classifier',
            model: { uuid: 'llm-123', name: 'Claude' },
            input: '@input',
            options: [{ name: 'Greeting' }],
            required_confidence: 'medium',
            output_local: '_llm_output'
          } as any
        ],
        router: testRouter.router,
        exits: testRouter.exits
      };

      const result = split_by_llm_categorize.fromFormData!(
        split_by_llm_categorize.toFormData!(originalNode),
        originalNode
      );

      expect(result.actions[0].uuid).to.equal('existing-action-uuid');
      expect((result.actions[0] as any).output_local).to.equal('_llm_output');
      expect(result.router!.operand).to.equal('@locals._llm_output');
      expect(result.router!.categories.map((c) => c.uuid)).to.deep.equal(
        testRouter.router.categories.map((c) => c.uuid)
      );
    });

    it('handles max 10 categories requirement', () => {
      // Create 12 categories to test the limit
      const categories = Array.from({ length: 12 }, (_, i) => ({
        name: `Category${i + 1}`
      }));

      const formData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: categories,
        result_name: 'Intent'
      };

      const originalNode: Node = {
        uuid: 'test-node-uuid',
        actions: [],
        exits: []
      };

      const result = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      // Should process all categories provided (fromFormData doesn't enforce the limit, validation should)
      const userCategories = result.router!.categories.filter(
        (cat) => cat.name !== 'Other' && cat.name !== 'Failure'
      );
      expect(userCategories).to.have.length(12);

      // Note: The actual 10-category limit should be enforced by the UI validation
      // which uses the maxItems: 10 property in the form configuration
    });

    it('preserves original node UUID', () => {
      const formData = {
        uuid: 'should-be-ignored',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [{ name: 'Test' }],
        result_name: 'Intent'
      };

      const originalNode: Node = {
        uuid: 'original-node-uuid',
        actions: [],
        exits: []
      };

      const result = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      // Should use original node UUID, not the one from form data
      expect(result.uuid).to.equal('original-node-uuid');
    });
  });

  describe('validation', () => {
    it('should validate duplicate category names', () => {
      const formData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [
          { name: 'Category1' },
          { name: 'Category2' },
          { name: 'Category1' }, // duplicate
          { name: 'category2' }, // case insensitive duplicate
          { name: 'Category3' }
        ]
      };

      const validationResult = split_by_llm_categorize.validate!(formData);

      expect(validationResult.valid).to.be.false;
      expect(validationResult.errors.options).to.include(
        'Duplicate category names found'
      );
      expect(validationResult.errors.options).to.include('Category1');
      expect(validationResult.errors.options).to.include('Category2');
      expect(validationResult.errors.options).to.include('category2');
    });

    it('should pass validation with unique category names', () => {
      const formData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [
          { name: 'Category1' },
          { name: 'Category2' },
          { name: 'Category3' }
        ]
      };

      const validationResult = split_by_llm_categorize.validate!(formData);

      expect(validationResult.valid).to.be.true;
      expect(Object.keys(validationResult.errors)).to.have.length(0);
    });

    it('should reject reserved category names', () => {
      const validationResult = split_by_llm_categorize.validate!({
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [{ name: 'Yes' }, { name: '<none>' }]
      });

      expect(validationResult.valid).to.be.false;
      expect(validationResult.errors.options).to.include('<none>');
    });

    it('should require a name for categories with descriptions', () => {
      const validationResult = split_by_llm_categorize.validate!({
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [{ name: 'Yes' }, { name: '', description: 'Agreeing' }]
      });

      expect(validationResult.valid).to.be.false;
      expect(validationResult.errors.options).to.equal(
        'Every category with a description needs a name'
      );
    });

    it('should ignore empty categories in validation', () => {
      const formData = {
        uuid: 'test-node-uuid',
        model: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        options: [
          { name: 'Category1' },
          { name: '' }, // empty
          { name: '   ' }, // whitespace only
          { name: 'Category2' }
        ]
      };

      const validationResult = split_by_llm_categorize.validate!(formData);

      expect(validationResult.valid).to.be.true;
      expect(Object.keys(validationResult.errors)).to.have.length(0);
    });
  });

  describe('JSON output verification', () => {
    it('generates JSON matching the exact format from the issue', () => {
      const formData = {
        uuid: '145eb3d3-b841-4e66-abac-297ae525c7ad',
        model: [
          { value: '1c06c884-39dd-4ce4-ad9f-9a01cbe6c000', name: 'Claude' }
        ],
        input: '@input',
        options: [
          { name: 'Flights', description: 'Booking or changing flights' },
          { name: 'Hotels', description: '  ' }
        ],
        required_confidence: [{ value: 'medium', name: 'Medium' }],
        result_name: 'Intent'
      };

      const originalNode: Node = {
        uuid: '145eb3d3-b841-4e66-abac-297ae525c7ad',
        actions: [],
        exits: []
      };

      const result = split_by_llm_categorize.fromFormData!(
        formData,
        originalNode
      );

      // Verify the call_classifier action
      expect(result.actions[0]).to.deep.equal({
        type: 'call_classifier',
        uuid: result.actions[0].uuid,
        model: { uuid: '1c06c884-39dd-4ce4-ad9f-9a01cbe6c000', name: 'Claude' },
        input: '@input',
        options: [
          { name: 'Flights', description: 'Booking or changing flights' },
          { name: 'Hotels' }
        ],
        required_confidence: 'medium',
        output_local: '_classification'
      });

      // Verify the router structure
      const router = result.router!;
      expect(router.type).to.equal('switch');
      expect(router.operand).to.equal('@locals._classification');

      // Verify categories structure
      expect(router.categories).to.have.length(4);
      const categoryNames = router.categories.map((cat) => cat.name);
      expect(categoryNames).to.include.members([
        'Flights',
        'Hotels',
        'Other',
        'Failure'
      ]);

      // Verify cases structure
      expect(router.cases).to.have.length(3);
      const caseArguments = router.cases.map((c) => c.arguments[0]);
      expect(caseArguments).to.include.members([
        'Flights',
        'Hotels',
        '<ERROR>'
      ]);

      // Verify all cases use has_only_text
      router.cases.forEach((caseItem) => {
        expect(caseItem.type).to.equal('has_only_text');
      });

      // Verify exits match categories
      expect(result.exits).to.have.length(4);
      router.categories.forEach((category) => {
        const matchingExit = result.exits.find(
          (exit) => exit.uuid === category.exit_uuid
        );
        expect(matchingExit).to.exist;
      });

      // Verify default category is "Other"
      const otherCategory = router.categories.find(
        (cat) => cat.name === 'Other'
      );
      expect(router.default_category_uuid).to.equal(otherCategory!.uuid);
    });
  });

  // runs last since the model types it loads are cached for the rest of the page
  describe('render', () => {
    const renderToText = async (model: any) => {
      const router = createSplitRouter(['Yes']);
      const container = document.createElement('div');
      render(
        split_by_llm_categorize.render!({
          uuid: 'render-node',
          actions: [
            {
              uuid: 'render-action',
              type: 'call_classifier',
              model,
              input: '@input',
              options: [{ name: 'Yes' }],
              output_local: '_classification'
            } as any
          ],
          router: router.router,
          exits: router.exits
        }),
        container
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      return container.textContent.trim();
    };

    it('renders nothing without a model', async () => {
      expect(await renderToText(undefined)).to.equal('');
      expect(await renderToText({ uuid: '', name: '' })).to.equal('');
    });

    it('hides the built-in model but names others', async () => {
      const store: any = await fixture(html`<temba-store></temba-store>`);
      store.getResults = async () => [
        { uuid: 'builtin-uuid', name: 'Included', type: 'builtin' },
        { uuid: 'claude-uuid', name: 'Claude', type: 'anthropic' }
      ];

      expect(
        await renderToText({ uuid: 'builtin-uuid', name: 'Included' })
      ).to.equal('');
      expect(
        await renderToText({ uuid: 'claude-uuid', name: 'Claude' })
      ).to.equal('Classify with Claude');
      // a model the workspace no longer has still gets named
      expect(
        await renderToText({ uuid: 'deleted-uuid', name: 'Old Model' })
      ).to.equal('Classify with Old Model');
    });
  });
});
