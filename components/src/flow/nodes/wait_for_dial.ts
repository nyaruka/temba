import { SPLIT_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node, Category, Exit } from '../../store/flow-definition';
import { generateUUID } from '../../utils';
import { resultNameField } from './shared';

const DIAL_CATEGORIES = ['Answered', 'No Answer', 'Busy', 'Failed'];
const DIAL_CASES = [
  { type: 'has_only_text', arguments: ['answered'], categoryName: 'Answered' },
  {
    type: 'has_only_text',
    arguments: ['no_answer'],
    categoryName: 'No Answer'
  },
  { type: 'has_only_text', arguments: ['busy'], categoryName: 'Busy' }
];

export const wait_for_dial: NodeConfig = {
  type: 'wait_for_dial',
  name: 'Redirect Call',
  subtitle: 'Connect the caller to another number, then branch on how it went.',
  group: SPLIT_GROUPS.wait,
  flowTypes: [FlowTypes.VOICE],
  router: {
    type: 'switch',
    defaultCategory: 'Failed',
    rules: DIAL_CASES.map((c) => ({
      type: c.type as any,
      arguments: c.arguments,
      categoryName: c.categoryName
    }))
  },
  form: {
    phone: {
      type: 'text',
      label: 'Phone Number',
      required: true,
      evaluated: true,
      maxLength: 1000,
      placeholder: 'Phone number or expression'
    },
    dial_limit_seconds: {
      type: 'text',
      label: 'Dial Limit (seconds)',
      required: false,
      helpText: 'Defaults to 60 seconds.'
    },
    call_limit_seconds: {
      type: 'text',
      label: 'Call Limit (seconds)',
      required: false,
      helpText: 'Defaults to two hours.'
    },
    result_name: { ...resultNameField, label: 'Result Name' }
  },
  layout: [
    'phone',
    {
      type: 'row',
      items: ['dial_limit_seconds', 'call_limit_seconds']
    },
    'result_name'
  ],
  toFormData: (node: Node) => {
    const wait = node.router?.wait;
    return {
      uuid: node.uuid,
      phone: wait?.phone || '',
      dial_limit_seconds: wait?.dial_limit_seconds
        ? String(wait.dial_limit_seconds)
        : '',
      call_limit_seconds: wait?.call_limit_seconds
        ? String(wait.call_limit_seconds)
        : '',
      result_name: node.router?.result_name || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const categories: Category[] = [];
    const exits: Exit[] = [];
    const cases: any[] = [];

    // Build categories and cases for each dial outcome
    for (const catName of DIAL_CATEGORIES) {
      const existing = existingCategories.find(
        (c: Category) => c.name === catName
      );

      if (existing) {
        categories.push(existing);
        const existingExit = existingExits.find(
          (e: Exit) => e.uuid === existing.exit_uuid
        );
        exits.push(
          existingExit || {
            uuid: existing.exit_uuid,
            destination_uuid: null
          }
        );
      } else {
        const exitUuid = generateUUID();
        categories.push({
          uuid: generateUUID(),
          name: catName,
          exit_uuid: exitUuid
        });
        exits.push({ uuid: exitUuid, destination_uuid: null });
      }
    }

    // Build cases for non-default categories
    for (const dialCase of DIAL_CASES) {
      const category = categories.find((c) => c.name === dialCase.categoryName);
      if (!category) continue;

      const existingCase = existingCases.find(
        (c: any) =>
          c.type === dialCase.type && c.arguments?.[0] === dialCase.arguments[0]
      );

      cases.push({
        uuid: existingCase?.uuid || generateUUID(),
        type: dialCase.type,
        arguments: dialCase.arguments,
        category_uuid: category.uuid
      });
    }

    const failedCategory = categories.find((c) => c.name === 'Failed');

    // Build wait config
    const phone = (formData.phone || '').trim();
    const dialLimit = parseInt(formData.dial_limit_seconds, 10);
    const callLimit = parseInt(formData.call_limit_seconds, 10);

    const waitConfig: any = {
      type: 'dial',
      phone
    };

    if (!isNaN(dialLimit) && dialLimit > 0) {
      waitConfig.dial_limit_seconds = dialLimit;
    }

    if (!isNaN(callLimit) && callLimit > 0) {
      waitConfig.call_limit_seconds = callLimit;
    }

    const router: any = {
      type: 'switch',
      operand: '@(default(resume.dial.status, ""))',
      default_category_uuid: failedCategory?.uuid,
      cases,
      categories,
      wait: waitConfig
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
  localizable: 'categories',
  nonTranslatableCategories: 'all'
};
