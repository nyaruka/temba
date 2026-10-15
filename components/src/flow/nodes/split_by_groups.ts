import { msg } from '@lit/localize';
import { SPLIT_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node, Case } from '../../store/flow-definition.d';
import { generateUUID } from '../../utils';
import { validateWith } from '../utils';
import {
  resultNameField,
  nodeOptionsSimple,
  buildCategoriesExitsCases,
  appendOtherCategory
} from './shared';

export const split_by_groups: NodeConfig = {
  type: 'split_by_groups',
  name: 'Split by Group',
  subtitle: 'Send members of different groups down different paths.',
  group: SPLIT_GROUPS.split,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  form: {
    groups: {
      type: 'select',
      label: 'Groups',
      helpText:
        'Select the groups to split contacts by. Contacts will be routed based on their group membership.',
      required: true,
      options: [],
      multi: true,
      searchable: true,
      endpoint: '/api/v2/groups.json',
      valueKey: 'uuid',
      nameKey: 'name',
      placeholder: 'Search for groups...',
      allowCreate: true,
      createArbitraryOption: (input: string, options: any[]) => {
        // Check if a group with this name already exists
        const existing = options.find(
          (option) =>
            option.name.toLowerCase().trim() === input.toLowerCase().trim()
        );
        if (!existing && input.trim()) {
          return {
            name: input.trim(),
            arbitrary: true
          };
        }
        return null;
      }
    },
    result_name: resultNameField
  },
  layout: ['groups', nodeOptionsSimple],
  validate: validateWith((formData, errors) => {
    if (
      !formData.groups ||
      !Array.isArray(formData.groups) ||
      formData.groups.length === 0
    ) {
      errors.groups = msg('At least one group is required');
    }
  }),
  toFormData: (node: Node) => {
    // Extract groups from the existing node structure
    const groups: { uuid: string; name: string }[] = [];

    if (node.router?.cases) {
      node.router.cases.forEach((c: Case) => {
        if (c.type === 'has_group' && c.arguments?.length >= 2) {
          groups.push({
            uuid: c.arguments[0],
            name: c.arguments[1]
          });
        }
      });
    }

    return {
      uuid: node.uuid,
      groups: groups,
      result_name: node.router?.result_name || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    const selectedGroups = (formData.groups || [])
      .filter((group: any) => group?.uuid || group?.arbitrary)
      .map((group: any) => ({
        uuid: group.uuid || generateUUID(),
        name: group.name
      }));

    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const { categories, exits, cases } = buildCategoriesExitsCases(
      selectedGroups.map((group) => ({
        name: group.name,
        case: {
          type: 'has_group',
          arguments: [group.uuid, group.name]
        }
      })),
      existingCategories,
      existingExits,
      existingCases
    );

    const defaultCategoryUuid = appendOtherCategory(
      categories,
      exits,
      existingCategories,
      existingExits,
      selectedGroups.map((g) => g.name)
    );

    return {
      uuid: originalNode.uuid,
      actions: originalNode.actions || [],
      router: {
        type: 'switch',
        cases,
        categories,
        default_category_uuid: defaultCategoryUuid,
        operand: '@contact.groups',
        result_name: formData.result_name || ''
      },
      exits
    };
  },
  router: {
    type: 'switch',
    operand: '@contact.groups'
  },

  // Localization support for categories
  localizable: 'categories'
};
