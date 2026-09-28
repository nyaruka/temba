import { expect } from '@open-wc/testing';
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

  describe('llm shouldExclude', () => {
    const shouldExclude = (
      split_by_llm_categorize.form.llm as SelectFieldConfig
    ).shouldExclude!;

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

  describe('node scenarios', () => {
    it('renders basic categorization', async () => {
      const basicRouter = createSplitRouter(['Greeting', 'Question']);
      await helper.testNode(
        {
          uuid: 'test-node-1',
          actions: [
            {
              uuid: 'call-llm-uuid',
              type: 'call_llm',
              llm: { uuid: 'llm-123', name: 'Claude' },
              input: '@input',
              instructions:
                '@(prompt("categorize", slice(node.categories, 0, -2)))',
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
              type: 'call_llm',
              llm: { uuid: 'llm-456', name: 'GPT-4' },
              input: '@contact.name',
              instructions:
                '@(prompt("categorize", slice(node.categories, 0, -2)))',
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
              type: 'call_llm',
              llm: { uuid: 'llm-789', name: 'Gemini' },
              input: '@fields.priority',
              instructions:
                '@(prompt("categorize", slice(node.categories, 0, -2)))',
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
              type: 'call_llm',
              llm: { uuid: 'llm-minimal', name: 'Basic LLM' },
              input: '@input',
              instructions:
                '@(prompt("categorize", slice(node.categories, 0, -2)))',
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
              type: 'call_llm',
              llm: { uuid: 'llm-special', name: 'Special Characters LLM' },
              input: '@contact.fields.feedback',
              instructions:
                '@(prompt("categorize", slice(node.categories, 0, -2)))',
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
            type: 'call_llm',
            llm: { uuid: 'llm-123', name: 'Test LLM' },
            input: '@input',
            instructions:
              '@(prompt("categorize", slice(node.categories, 0, -2)))',
            output_local: '_llm_output'
          } as any
        ],
        router: testRouter.router,
        exits: testRouter.exits
      };

      const formData = split_by_llm_categorize.toFormData!(node);

      expect(formData.uuid).to.equal('test-node');
      expect(formData.llm).to.deep.equal([
        { uuid: 'llm-123', name: 'Test LLM' }
      ]);
      expect(formData.input).to.equal('@input');
      expect(formData.categories).to.deep.equal([
        { name: 'Greeting' },
        { name: 'Question' }
      ]);
    });

    it('converts from form data correctly', () => {
      const formData = {
        uuid: 'test-node',
        llm: [{ value: 'llm-456', name: 'GPT-4' }],
        input: '@contact.name',
        categories: [{ name: 'Premium' }, { name: 'Regular' }]
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
      expect(result.actions[0].type).to.equal('call_llm');
      expect((result.actions[0] as any).llm.uuid).to.equal('llm-456');
      expect((result.actions[0] as any).llm.name).to.equal('GPT-4');
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
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: [
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
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: [
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
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: [{ name: 'Test Category' }],
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
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: [{ name: 'Test' }],
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
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@custom.input',
        categories: [{ name: 'Category1' }, { name: 'Category2' }],
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
      expect(recoveredFormData.llm).to.deep.equal([
        { uuid: 'llm-uuid-123', name: 'Claude' }
      ]);
      expect(recoveredFormData.input).to.equal(originalFormData.input);
      expect(recoveredFormData.categories).to.deep.equal(
        originalFormData.categories
      );
    });

    it('handles max 10 categories requirement', () => {
      // Create 12 categories to test the limit
      const categories = Array.from({ length: 12 }, (_, i) => ({
        name: `Category${i + 1}`
      }));

      const formData = {
        uuid: 'test-node-uuid',
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: categories,
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
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: [{ name: 'Test' }],
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
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: [
          { name: 'Category1' },
          { name: 'Category2' },
          { name: 'Category1' }, // duplicate
          { name: 'category2' }, // case insensitive duplicate
          { name: 'Category3' }
        ]
      };

      const validationResult = split_by_llm_categorize.validate!(formData);

      expect(validationResult.valid).to.be.false;
      expect(validationResult.errors.categories).to.include(
        'Duplicate category names found'
      );
      expect(validationResult.errors.categories).to.include('Category1');
      expect(validationResult.errors.categories).to.include('Category2');
      expect(validationResult.errors.categories).to.include('category2');
    });

    it('should pass validation with unique category names', () => {
      const formData = {
        uuid: 'test-node-uuid',
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: [
          { name: 'Category1' },
          { name: 'Category2' },
          { name: 'Category3' }
        ]
      };

      const validationResult = split_by_llm_categorize.validate!(formData);

      expect(validationResult.valid).to.be.true;
      expect(Object.keys(validationResult.errors)).to.have.length(0);
    });

    it('should ignore empty categories in validation', () => {
      const formData = {
        uuid: 'test-node-uuid',
        llm: [{ value: 'llm-uuid-123', name: 'Claude' }],
        input: '@input',
        categories: [
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
        llm: [
          { value: '1c06c884-39dd-4ce4-ad9f-9a01cbe6c000', name: 'Claude' }
        ],
        input: '@input',
        categories: [{ name: 'Flights' }, { name: 'Hotels' }],
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

      // Verify the call_llm action
      const callLlmAction = result.actions[0] as any;
      expect(callLlmAction.type).to.equal('call_llm');
      expect(callLlmAction.llm.uuid).to.equal(
        '1c06c884-39dd-4ce4-ad9f-9a01cbe6c000'
      );
      expect(callLlmAction.llm.name).to.equal('Claude');
      expect(callLlmAction.instructions).to.equal(
        '@(prompt("categorize", slice(node.categories, 0, -2)))'
      );
      expect(callLlmAction.input).to.equal('@input');
      expect(callLlmAction.output_local).to.equal('_llm_output');

      // Verify the router structure
      const router = result.router!;
      expect(router.type).to.equal('switch');
      expect(router.operand).to.equal('@locals._llm_output');

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
});
