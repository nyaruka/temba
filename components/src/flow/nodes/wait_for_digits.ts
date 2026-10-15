import { SPLIT_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node } from '../../store/flow-definition';
import { createRulesRouter } from '../../utils';
import {
  getDigitOperators,
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

export const wait_for_digits: NodeConfig = {
  type: 'wait_for_digits',
  name: 'Wait for Digits',
  subtitle: 'Collect a number from the keypad, like a PIN or account number.',
  group: SPLIT_GROUPS.wait,
  flowTypes: [FlowTypes.VOICE],
  dialogSize: 'large',
  form: {
    rules: createRulesArrayConfig(
      operatorsToSelectOptions(getDigitOperators()),
      ''
    ),
    result_name: resultNameField,
    localizeRules: localizeRulesField,
    localizeCategories: localizeCategoriesField
  },
  layout: [
    {
      type: 'text',
      text: 'Rules match against all digits pressed by the caller followed by the # sign.'
    },
    'rules',
    nodeOptions
  ],
  validate: (_formData: FormData) => {
    return {
      valid: true,
      errors: {}
    };
  },
  toFormData: (node: Node, nodeUI?: any) => {
    const rules = casesToFormRules(node);
    return {
      uuid: node.uuid,
      rules,
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
    const userRules = extractUserRules(formData);
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const { router, exits } = createRulesRouter(
      '@input.text',
      userRules,
      getOperatorConfig,
      existingCategories,
      existingExits,
      existingCases
    );

    const finalRouter: any = {
      ...router,
      wait: {
        type: 'msg',
        hint: {
          type: 'digits'
        }
      }
    };

    if (formData.result_name && formData.result_name.trim() !== '') {
      finalRouter.result_name = formData.result_name.trim();
    }

    return {
      ...originalNode,
      router: finalRouter,
      exits
    };
  },
  localizable: 'categories'
};
