import { msg } from '@lit/localize';
import { SPLIT_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node } from '../../store/flow-definition';
import { createRulesRouter } from '../../utils';
import {
  getWaitForResponseOperators,
  operatorsToSelectOptions,
  getOperatorConfig
} from '../operators';
import {
  resultNameField,
  localizeRulesField,
  localizeCategoriesField,
  nodeOptions
} from './shared';
import {
  createRulesArrayConfig,
  extractUserRules,
  casesToFormRules
} from './shared-rules';
import { validateWith } from '../utils';

export const split_by_expression: NodeConfig = {
  type: 'split_by_expression',
  name: 'Split by Expression',
  subtitle: 'Branch on any value you can build, like a date or a calculation.',
  group: SPLIT_GROUPS.split,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  dialogSize: 'large',
  form: {
    operand: {
      type: 'text',
      label: 'Expression',
      required: true,
      evaluated: true,
      maxLength: 10000,
      placeholder: 'e.g. @fields.age'
    },
    rules: createRulesArrayConfig(
      operatorsToSelectOptions(getWaitForResponseOperators()),
      ''
    ),
    result_name: resultNameField,
    localizeRules: localizeRulesField,
    localizeCategories: localizeCategoriesField
  },
  layout: ['operand', 'rules', nodeOptions],
  validate: validateWith((formData, errors) => {
    if (!formData.operand || formData.operand.trim() === '') {
      errors.operand = msg('Expression is required');
    }
  }),
  toFormData: (node: Node, nodeUI?: any) => {
    // Extract rules from router cases using shared function
    const rules = casesToFormRules(node);

    return {
      uuid: node.uuid,
      operand: node.router?.operand || '@input.text',
      rules: rules,
      result_name: node.router?.result_name || '',
      localizeRules: nodeUI?.config?.localizeRules || false,
      localizeCategories: nodeUI?.config?.localizeCategories || false
    };
  },
  toUIConfig: (formData: FormData) => {
    const config: Record<string, any> = {};
    config.localizeRules = !!formData.localizeRules;
    config.localizeCategories = formData.result_name
      ? !!formData.localizeCategories
      : false;
    return config;
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Get user rules using shared extraction function
    const userRules = extractUserRules(formData);

    // Get operand from form data
    const operand = formData.operand?.trim() || '@input.text';

    // Get existing router data for preservation
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    // Create router and exits using existing data when possible
    const { router, exits } = createRulesRouter(
      operand,
      userRules,
      getOperatorConfig,
      existingCategories,
      existingExits,
      existingCases
    );

    // Build final router with result_name
    const finalRouter: any = {
      ...router
    };

    // Only set result_name if provided
    if (formData.result_name && formData.result_name.trim() !== '') {
      finalRouter.result_name = formData.result_name.trim();
    }

    return {
      ...originalNode,
      router: finalRouter,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories'
};
