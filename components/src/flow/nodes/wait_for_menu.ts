import { SPLIT_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node, Category, Exit } from '../../store/flow-definition';
import { generateUUID } from '../../utils';
import {
  resultNameField,
  localizeRulesField,
  localizeCategoriesField,
  nodeOptions
} from './shared';

// Menu digits in display order: 1-9 then 0
const MENU_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

function digitFieldKey(digit: string): string {
  return `digit_${digit}`;
}

export const wait_for_menu: NodeConfig = {
  type: 'wait_for_menu',
  name: 'Wait for Menu',
  subtitle:
    'Offer keypad options, like "press 1 for sales", and branch on the choice.',
  group: SPLIT_GROUPS.wait,
  flowTypes: [FlowTypes.VOICE],
  form: {
    ...Object.fromEntries(
      MENU_DIGITS.map((digit) => [
        digitFieldKey(digit),
        {
          type: 'text' as const,
          required: false,
          placeholder: '',
          flavor: 'xsmall' as const
        }
      ])
    ),
    result_name: resultNameField,
    localizeRules: localizeRulesField,
    localizeCategories: localizeCategoriesField
  },
  layout: [
    {
      type: 'row' as const,
      items: ['digit_1', 'digit_2', 'digit_3'],
      gap: '2rem',
      marginBottom: '0.5rem',
      inlineLabels: { digit_1: '1', digit_2: '2', digit_3: '3' }
    },
    {
      type: 'row' as const,
      items: ['digit_4', 'digit_5', 'digit_6'],
      gap: '2rem',
      marginBottom: '0.5rem',
      inlineLabels: { digit_4: '4', digit_5: '5', digit_6: '6' }
    },
    {
      type: 'row' as const,
      items: ['digit_7', 'digit_8', 'digit_9'],
      gap: '2rem',
      marginBottom: '0.5rem',
      inlineLabels: { digit_7: '7', digit_8: '8', digit_9: '9' }
    },
    {
      type: 'row' as const,
      items: [
        { type: 'spacer' as const },
        'digit_0',
        { type: 'spacer' as const }
      ],
      gap: '2rem',
      inlineLabels: { digit_0: '0' }
    },
    nodeOptions
  ],
  toFormData: (node: Node, nodeUI?: any) => {
    const formData: FormData = {
      uuid: node.uuid,
      result_name: node.router?.result_name || ''
    };

    // Initialize all digit fields as empty
    for (const digit of MENU_DIGITS) {
      formData[digitFieldKey(digit)] = '';
    }

    // Fill in category names from cases
    if (node.router?.cases && node.router?.categories) {
      for (const case_ of node.router.cases) {
        if (case_.type === 'has_number_eq' && case_.arguments?.[0]) {
          const digit = case_.arguments[0];
          const category = node.router.categories.find(
            (cat: Category) => cat.uuid === case_.category_uuid
          );
          if (category && MENU_DIGITS.includes(digit)) {
            formData[digitFieldKey(digit)] = category.name;
          }
        }
      }
    }

    formData.localizeRules = nodeUI?.config?.localizeRules || false;
    formData.localizeCategories = nodeUI?.config?.localizeCategories || false;
    return formData;
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
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const categories: Category[] = [];
    const exits: Exit[] = [];
    const cases: any[] = [];

    // Build categories and cases for each filled digit
    for (const digit of MENU_DIGITS) {
      const categoryName = (formData[digitFieldKey(digit)] || '').trim();
      if (!categoryName) continue;

      // Check if a category with this name already exists in our new list
      let category = categories.find((c) => c.name === categoryName);

      if (!category) {
        // Try to find existing category with same name to preserve UUIDs
        const existingCat = existingCategories.find(
          (c: Category) => c.name === categoryName
        );

        if (existingCat) {
          category = existingCat;
          const existingExit = existingExits.find(
            (e: Exit) => e.uuid === existingCat.exit_uuid
          );
          categories.push(category);
          exits.push(
            existingExit || {
              uuid: existingCat.exit_uuid,
              destination_uuid: null
            }
          );
        } else {
          const exitUuid = generateUUID();
          category = {
            uuid: generateUUID(),
            name: categoryName,
            exit_uuid: exitUuid
          };
          categories.push(category);
          exits.push({ uuid: exitUuid, destination_uuid: null });
        }
      }

      // Find existing case for this digit to preserve UUID
      const existingCase = existingCases.find(
        (c: any) => c.type === 'has_number_eq' && c.arguments?.[0] === digit
      );

      cases.push({
        uuid: existingCase?.uuid || generateUUID(),
        type: 'has_number_eq',
        arguments: [digit],
        category_uuid: category.uuid
      });
    }

    // Add "Other" default category
    const existingOther = existingCategories.find(
      (c: Category) => c.name === 'Other'
    );

    let otherCategory: Category;
    if (existingOther) {
      otherCategory = existingOther;
      const existingExit = existingExits.find(
        (e: Exit) => e.uuid === existingOther.exit_uuid
      );
      exits.push(
        existingExit || {
          uuid: existingOther.exit_uuid,
          destination_uuid: null
        }
      );
    } else {
      const exitUuid = generateUUID();
      otherCategory = {
        uuid: generateUUID(),
        name: 'Other',
        exit_uuid: exitUuid
      };
      exits.push({ uuid: exitUuid, destination_uuid: null });
    }
    categories.push(otherCategory);

    const router: any = {
      type: 'switch',
      operand: '@input.text',
      default_category_uuid: otherCategory.uuid,
      cases,
      categories,
      wait: {
        type: 'msg',
        hint: {
          type: 'digits',
          count: 1
        }
      }
    };

    if (formData.result_name && formData.result_name.trim() !== '') {
      router.result_name = formData.result_name.trim();
    }

    return {
      ...originalNode,
      router,
      exits
    };
  },
  localizable: 'categories'
};
