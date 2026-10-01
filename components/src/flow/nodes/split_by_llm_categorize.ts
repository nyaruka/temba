import { FormData, NodeConfig, ACTION_GROUPS, FlowTypes } from '../types';
import {
  CallClassifier,
  ClassifierConfidence,
  Node
} from '../../store/flow-definition';
import { generateUUID, createMultiCategoryRouter } from '../../utils';
import { html } from 'lit';
import { until } from 'lit/directives/until.js';
import { msg, str } from '@lit/localize';
import { validateWith } from '../utils';
import { getStore } from '../../store/Store';
import { LLMModel, hasLLMRole } from '../flow-utils';
import {
  resultNameField,
  localizeCategoriesField,
  nodeOptionsAccordionCategoriesOnly
} from './shared';

// local the classifier writes the chosen option (or <NONE> / <ERROR>) to
const DEFAULT_OUTPUT_LOCAL = '_classification';

// new nodes always pick a category, so they start without an Other category
const DEFAULT_REQUIRED_CONFIDENCE: ClassifierConfidence = 'none';

// names reserved by the engine for outputs other than a chosen option
const RESERVED_OPTION_NAMES = ['<ERROR>', '<NONE>'];

const LLMS_ENDPOINT = '/api/internal/llms.json';

// the platform-provided model type, which isn't worth naming on the node
const INTERNAL_MODEL_TYPE = 'builtin';

// types of the workspace's models by UUID, loaded once so rendering can stay synchronous
let modelTypes: Map<string, string> = null;
let modelTypesLoading: Promise<Map<string, string>> = null;

const loadModelTypes = (): Promise<Map<string, string>> => {
  if (!modelTypesLoading) {
    modelTypesLoading = getStore()
      .getResults(LLMS_ENDPOINT)
      .then((models: LLMModel[]) => {
        modelTypes = new Map((models || []).map((m) => [m.uuid, m.type]));
        return modelTypes;
      });
  }
  return modelTypesLoading;
};

// the confidence levels the model's choice can be required to meet, below which it routes to Other
const CONFIDENCE_LEVELS: { value: ClassifierConfidence; name: string }[] = [
  { value: 'none', name: 'Always pick a category' },
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' }
];

const toConfidenceLevel = (confidence: ClassifierConfidence) => [
  CONFIDENCE_LEVELS.find((level) => level.value === confidence) ||
    CONFIDENCE_LEVELS.find(
      (level) => level.value === DEFAULT_REQUIRED_CONFIDENCE
    )
];

const fromConfidenceLevel = (selection: any): ClassifierConfidence => {
  const level = Array.isArray(selection) ? selection[0] : selection;
  const value = level?.value ?? level;
  return CONFIDENCE_LEVELS.some((l) => l.value === value)
    ? value
    : DEFAULT_REQUIRED_CONFIDENCE;
};

export const split_by_llm_categorize: NodeConfig = {
  type: 'split_by_llm_categorize',
  name: 'Split by AI',
  group: ACTION_GROUPS.services,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  form: {
    model: {
      type: 'select',
      label: 'Model',
      helpText: 'Select the AI model to use for classification',
      required: true,
      endpoint: LLMS_ENDPOINT,
      valueKey: 'uuid',
      nameKey: 'name',
      placeholder: 'Select a model...',
      shouldExclude: (option: LLMModel) => !hasLLMRole(option, 'classification')
    },
    input: {
      type: 'text',
      label: 'Input',
      helpText: 'The input to classify (usually @input)',
      required: true,
      evaluated: true,
      maxLength: 10000,
      placeholder: '@input'
    },
    options: {
      type: 'array',
      helpText:
        'Define the categories for classification. Descriptions help the model decide when each one fits.',
      required: true,
      sortable: true,
      itemLabel: 'Category',
      minItems: 1,
      maxItems: 10,
      isEmptyItem: (item: any) => {
        return (
          (!item.name || item.name.trim() === '') &&
          (!item.description || item.description.trim() === '')
        );
      },
      itemConfig: {
        name: {
          type: 'text',
          placeholder: 'Category name',
          required: true,
          maxLength: 36,
          width: '160px'
        },
        description: {
          type: 'text',
          placeholder: 'Description (optional)',
          maxLength: 1000
        }
      }
    },
    required_confidence: {
      type: 'select',
      helpText: (formData: FormData) =>
        fromConfidenceLevel(formData.required_confidence) === 'none'
          ? 'The model always picks one of the categories, so there is no **Other** category.'
          : 'How sure the model must be of its choice. Less confident answers go to **Other**.',
      required: true,
      options: CONFIDENCE_LEVELS,
      searchable: false,
      clearable: false
    },
    result_name: resultNameField,
    localizeCategories: localizeCategoriesField
  },
  layout: [
    'model',
    'input',
    'options',
    {
      ...nodeOptionsAccordionCategoriesOnly,
      sections: [
        {
          label: 'Confidence',
          localizable: false,
          items: ['required_confidence'],
          collapsed: true,
          // flag it when a confidence is required
          getValueCount: (formData: FormData) =>
            fromConfidenceLevel(formData.required_confidence) !== 'none'
        },
        ...nodeOptionsAccordionCategoriesOnly.sections
      ]
    }
  ],
  validate: validateWith((formData, errors) => {
    if (!formData.options || !Array.isArray(formData.options)) return;

    const options = formData.options.filter((item: any) => !!item);

    if (
      options.some(
        (item: any) => item.description?.trim() && !item.name?.trim()
      )
    ) {
      errors.options = msg('Every category with a description needs a name');
      return;
    }

    const names = options
      .map((item: any) => item.name?.trim())
      .filter((name: string) => !!name);

    const reserved = names.filter((name: string) =>
      RESERVED_OPTION_NAMES.includes(name.toUpperCase())
    );
    if (reserved.length > 0) {
      errors.options = msg(str`Category names can't be ${reserved.join(', ')}`);
      return;
    }

    const lowerCaseMap = new Map<string, string[]>();
    names.forEach((name: string) => {
      const lowerName = name.toLowerCase();
      if (!lowerCaseMap.has(lowerName)) {
        lowerCaseMap.set(lowerName, []);
      }
      lowerCaseMap.get(lowerName).push(name);
    });

    const duplicates: string[] = [];
    lowerCaseMap.forEach((originalNames) => {
      if (originalNames.length > 1) {
        duplicates.push(...originalNames);
      }
    });

    if (duplicates.length > 0) {
      const uniqueDuplicates = [...new Set(duplicates)];
      errors.options = msg(
        str`Duplicate category names found: ${uniqueDuplicates.join(', ')}`
      );
    }
  }),
  render: (node: Node) => {
    const action = node.actions?.find(
      (action) => action.type === 'call_classifier'
    ) as CallClassifier;
    const model = action?.model;
    if (!model?.uuid || !model?.name) {
      return null;
    }

    const body = html`
      <div class="body">${msg(str`Classify with ${model.name}`)}</div>
    `;
    const bodyUnlessInternal = (types: Map<string, string>) =>
      types.get(model.uuid) === INTERNAL_MODEL_TYPE ? null : body;

    if (modelTypes) {
      return bodyUnlessInternal(modelTypes);
    }
    if (!getStore()) {
      return body;
    }
    return html`${until(loadModelTypes().then(bodyUnlessInternal), null)}`;
  },
  toFormData: (node: Node, nodeUI?: any) => {
    const action = node.actions?.find(
      (action) => action.type === 'call_classifier'
    ) as CallClassifier;

    // descriptions live on the action, but the router's categories are the source of truth for names and order
    const descriptions = new Map<string, string>(
      (action?.options || []).map((o) => [o.name, o.description || ''])
    );
    const options =
      node.router?.categories
        ?.filter((cat) => cat.name !== 'Other' && cat.name !== 'Failure')
        .map((cat) => ({
          name: cat.name,
          description: descriptions.get(cat.name) || ''
        })) || [];

    return {
      uuid: node.uuid,
      model: action?.model ? [action.model] : [],
      input: action?.input || '@input',
      options,
      required_confidence: toConfidenceLevel(action?.required_confidence),
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
    const modelSelection =
      Array.isArray(formData.model) && formData.model.length > 0
        ? formData.model[0]
        : null;

    const options = (formData.options || [])
      .filter((item: any) => item?.name?.trim())
      .map((item: any) => {
        const option: { name: string; description?: string } = {
          name: item.name.trim()
        };
        if (item.description?.trim()) {
          option.description = item.description.trim();
        }
        return option;
      });

    const requiredConfidence = fromConfidenceLevel(
      formData.required_confidence
    );

    // preserve the UUID and output local of an existing classifier action
    const existingAction = originalNode.actions?.find(
      (action) => action.type === 'call_classifier'
    ) as CallClassifier;
    const outputLocal = existingAction?.output_local || DEFAULT_OUTPUT_LOCAL;

    const action: CallClassifier = {
      type: 'call_classifier',
      uuid: existingAction?.uuid || generateUUID(),
      model: modelSelection
        ? {
            uuid: modelSelection.uuid || modelSelection.value,
            name: modelSelection.name
          }
        : { uuid: '', name: '' },
      input: formData.input || '@input',
      options,
      required_confidence: requiredConfidence,
      output_local: outputLocal
    };

    // each option routes to its own category, <NONE> falls through to Other and <ERROR> to Failure
    const { router, exits } = createMultiCategoryRouter(
      `@locals.${outputLocal}`,
      options.map((o) => o.name),
      (categoryName) => ({
        type: 'has_only_text',
        arguments: [categoryName]
      }),
      originalNode.router?.categories || [],
      originalNode.exits || [],
      originalNode.router?.cases || []
    );

    const finalRouter: any = { ...router };
    let finalExits = exits;

    // requiring no confidence means the model always picks an option, so <NONE> never happens and Other can't be
    // reached - drop it and let anything unexpected fall through to Failure instead
    if (requiredConfidence === 'none') {
      const other = router.categories.find(
        (c) => c.uuid === router.default_category_uuid
      );
      const failure = router.categories.find((c) => c.name === 'Failure');
      finalRouter.categories = router.categories.filter((c) => c !== other);
      finalRouter.default_category_uuid = failure.uuid;
      finalExits = exits.filter((e) => e.uuid !== other.exit_uuid);
    }

    if (formData.result_name && formData.result_name.trim() !== '') {
      finalRouter.result_name = formData.result_name.trim();
    }

    return {
      uuid: originalNode.uuid,
      actions: [action],
      router: finalRouter,
      exits: finalExits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: ['Failure']
};
