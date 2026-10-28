import { msg } from '@lit/localize';
import { SPLIT_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node, Case } from '../../store/flow-definition.d';
import { SCHEMES, validateWith } from '../utils';
import {
  resultNameField,
  nodeOptionsSimple,
  buildCategoriesExitsCases,
  appendOtherCategory
} from './shared';

const getSchemeOptions = () => {
  return SCHEMES.map((scheme) => ({
    value: scheme.scheme,
    name: scheme.name
  }));
};

const getSchemeName = (scheme: string) =>
  SCHEMES.find((s) => s.scheme === scheme)?.name || scheme;

export const split_by_scheme: NodeConfig = {
  type: 'split_by_scheme',
  name: 'Split by URN Type',
  subtitle:
    'Branch on how the contact reaches you, like SMS, WhatsApp or email.',
  group: SPLIT_GROUPS.split,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  form: {
    schemes: {
      type: 'select',
      label: 'Channel Types',
      helpText:
        'Routes contacts by the type of address they used, e.g. a phone number or Facebook ID.',
      required: true,
      options: getSchemeOptions(),
      multi: true,
      searchable: true,
      placeholder: 'Select the channels to split by...'
    },
    result_name: resultNameField
  },
  layout: ['schemes', nodeOptionsSimple],
  validate: validateWith((formData, errors) => {
    if (
      !formData.schemes ||
      !Array.isArray(formData.schemes) ||
      formData.schemes.length === 0
    ) {
      errors.schemes = msg('At least one channel type is required');
    }
  }),
  toFormData: (node: Node) => {
    const schemes: string[] = [];

    if (node.router?.cases) {
      node.router.cases.forEach((c: Case) => {
        if (c.type === 'has_only_phrase' && c.arguments?.length > 0) {
          schemes.push(c.arguments[0]);
        }
      });
    }

    return {
      uuid: node.uuid,
      schemes: schemes.map((scheme) => ({
        value: scheme,
        name: getSchemeName(scheme)
      })),
      result_name: node.router?.result_name || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    const selectedSchemes = (formData.schemes || [])
      .filter((scheme: any) => scheme)
      .map((scheme: any) =>
        typeof scheme === 'string' ? scheme : scheme.value
      );

    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const { categories, exits, cases } = buildCategoriesExitsCases(
      selectedSchemes.map((scheme) => ({
        name: getSchemeName(scheme),
        case: {
          type: 'has_only_phrase',
          arguments: [scheme]
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
      selectedSchemes.map(getSchemeName)
    );

    return {
      uuid: originalNode.uuid,
      actions: originalNode.actions || [],
      router: {
        type: 'switch',
        cases,
        categories,
        default_category_uuid: defaultCategoryUuid,
        operand: '@(urn_parts(contact.urn).scheme)',
        result_name: formData.result_name || ''
      },
      exits
    };
  },
  router: {
    type: 'switch',
    operand: '@(urn_parts(contact.urn).scheme)'
  },

  // Localization support for categories
  localizable: 'categories'
};
