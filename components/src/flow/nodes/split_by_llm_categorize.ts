import { FormData, NodeConfig, ACTION_GROUPS, FlowTypes } from '../types';
import { CallLLM, Node } from '../../store/flow-definition';
import { generateUUID, createMultiCategoryRouter } from '../../utils';
import { html } from 'lit';
import { msg, str } from '@lit/localize';
import { validateWith } from '../utils';
import { LLMModel, hasLLMRole } from '../flow-utils';
import {
  resultNameField,
  localizeCategoriesField,
  nodeOptionsAccordionCategoriesOnly
} from './shared';

export const split_by_llm_categorize: NodeConfig = {
  type: 'split_by_llm_categorize',
  name: 'Split by AI',
  group: ACTION_GROUPS.services,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  form: {
    llm: {
      type: 'select',
      label: 'LLM',
      helpText: 'Select the LLM to use for categorization',
      required: true,
      endpoint: '/api/internal/llms.json',
      valueKey: 'uuid',
      nameKey: 'name',
      placeholder: 'Select an LLM...',
      shouldExclude: (option: LLMModel) => !hasLLMRole(option, 'generation')
    },
    input: {
      type: 'text',
      label: 'Input',
      helpText: 'The input to categorize (usually @input)',
      required: true,
      evaluated: true,
      maxLength: 10000,
      placeholder: '@input'
    },
    categories: {
      type: 'array',
      helpText: 'Define the categories for classification',
      required: true,
      sortable: true,
      itemLabel: 'Category',
      minItems: 1,
      maxItems: 10,
      isEmptyItem: (item: any) => {
        return !item.name || item.name.trim() === '';
      },
      itemConfig: {
        name: {
          type: 'text',
          placeholder: 'Category name',
          required: true,
          maxLength: 36
        }
      }
    },
    result_name: resultNameField,
    localizeCategories: localizeCategoriesField
  },
  layout: ['llm', 'input', 'categories', nodeOptionsAccordionCategoriesOnly],
  validate: validateWith((formData, errors) => {
    if (!formData.categories || !Array.isArray(formData.categories)) return;

    const categories = formData.categories.filter(
      (item: any) => item?.name && item.name.trim() !== ''
    );

    const duplicateCategories: string[] = [];
    const lowerCaseMap = new Map<string, string[]>();

    categories.forEach((category) => {
      const lowerName = category.name.trim().toLowerCase();
      if (!lowerCaseMap.has(lowerName)) {
        lowerCaseMap.set(lowerName, []);
      }
      lowerCaseMap.get(lowerName).push(category.name.trim());
    });

    lowerCaseMap.forEach((originalNames) => {
      if (originalNames.length > 1) {
        duplicateCategories.push(...originalNames);
      }
    });

    if (duplicateCategories.length > 0) {
      const uniqueDuplicates = [...new Set(duplicateCategories)];
      errors.categories = msg(
        str`Duplicate category names found: ${uniqueDuplicates.join(', ')}`
      );
    }
  }),
  render: (node: Node) => {
    const callLlmAction = node.actions?.find(
      (action) => action.type === 'call_llm'
    ) as CallLLM;
    return html`
      <div class="body">
        ${msg(str`Categorize with ${callLlmAction.llm.name}`)}
      </div>
    `;
  },
  toFormData: (node: Node, nodeUI?: any) => {
    // Extract data from the existing node structure
    const callLlmAction = node.actions?.find(
      (action) => action.type === 'call_llm'
    ) as any;
    const categories =
      node.router?.categories
        ?.filter((cat) => cat.name !== 'Other' && cat.name !== 'Failure')
        .map((cat) => ({ name: cat.name })) || [];

    return {
      uuid: node.uuid,
      llm: callLlmAction?.llm ? [callLlmAction.llm] : [],
      input: callLlmAction?.input || '@input',
      categories: categories,
      result_name: node.router?.result_name || '',
      localizeCategories: nodeUI?.config?.localizeCategories || false
    };
  },
  toUIConfig: (formData: FormData) => {
    const config: Record<string, any> = {};
    config.localizeCategories = formData.result_name
      ? !!formData.localizeCategories
      : false;
    return config;
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Get LLM selection
    const llmSelection =
      Array.isArray(formData.llm) && formData.llm.length > 0
        ? formData.llm[0]
        : null;

    // Get user categories
    const userCategories = (formData.categories || [])
      .filter((item: any) => item?.name?.trim())
      .map((item: any) => item.name.trim());

    // Find existing call_llm action to preserve its UUID
    const existingCallLlmAction = originalNode.actions?.find(
      (action) => action.type === 'call_llm'
    );
    const callLlmUuid = existingCallLlmAction?.uuid || generateUUID();

    // Create call_llm action (using any type to match the example format)
    const callLlmAction: CallLLM = {
      type: 'call_llm',
      uuid: callLlmUuid,
      llm: llmSelection
        ? {
            uuid: llmSelection.uuid || llmSelection.value,
            name: llmSelection.name
          }
        : { uuid: '', name: '' },
      instructions: `@(prompt("categorize", slice(node.categories, 0, -2)))`,
      input: formData.input || '@input',
      output_local: '_llm_output'
    };

    // Create categories and exits
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const { router, exits } = createMultiCategoryRouter(
      '@locals._llm_output',
      userCategories,
      (categoryName) => ({
        type: 'has_only_text',
        arguments: [categoryName]
      }),
      existingCategories,
      existingExits,
      existingCases
    );

    const finalRouter: any = { ...router };
    if (formData.result_name && formData.result_name.trim() !== '') {
      finalRouter.result_name = formData.result_name.trim();
    }

    // Return the complete node
    return {
      uuid: originalNode.uuid,
      actions: [callLlmAction],
      router: finalRouter,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: ['Failure']
};
