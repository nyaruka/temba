import { msg } from '@lit/localize';
import { ACTION_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { CallLLM, Node } from '../../store/flow-definition';
import { generateUUID, createSuccessFailureRouter } from '../../utils';
import { html } from 'lit';
import {
  renderClamped,
  renderHighlightedText,
  renderLineItem,
  getLlmIcon
} from '../utils';
import { LLMModel, hasLLMRole } from '../flow-utils';

export const split_by_llm: NodeConfig = {
  type: 'split_by_llm',
  name: 'Call AI',
  group: ACTION_GROUPS.services,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  showAsAction: true,
  render: (node: Node) => {
    const callLlmAction = node.actions?.find(
      (action) => action.type === 'call_llm'
    ) as CallLLM;
    const instructions =
      callLlmAction?.instructions || msg('Configure AI instructions');
    const llmName = callLlmAction?.llm?.name;
    return html`
      ${llmName
        ? html`<div class="body" style="padding-bottom:0;">
            ${renderLineItem(llmName, getLlmIcon(llmName))}
          </div>`
        : null}
      <div class="body" style="margin-bottom:10px;">
        ${renderClamped(
          renderHighlightedText(instructions, true),
          instructions
        )}
      </div>
    `;
  },

  form: {
    llm: {
      type: 'select',
      label: 'LLM',
      required: true,
      options: [],
      endpoint: '/api/internal/llms.json',
      searchable: true,
      valueKey: 'uuid',
      nameKey: 'name',
      placeholder: 'Select an LLM...',
      shouldExclude: (option: LLMModel) => !hasLLMRole(option, 'generation')
    },
    input: {
      type: 'text',
      label: 'Input',
      helpText: 'The input the AI will process',
      required: true,
      evaluated: true,
      maxLength: 10000,
      placeholder: '@input'
    },
    instructions: {
      type: 'textarea',
      label: 'Instructions',
      helpText:
        'Tell the AI what to do with the input. The result can be referenced as **`@locals._llm_output`**',
      required: true,
      evaluated: true,
      maxLength: 10000,
      placeholder: 'Enter instructions for the AI model...',
      minHeight: 130
    }
  },
  layout: ['llm', 'input', 'instructions'],
  toFormData: (node: Node) => {
    // Extract data from the existing node structure
    const callLlmAction = node.actions?.find(
      (action) => action.type === 'call_llm'
    ) as CallLLM;

    return {
      uuid: node.uuid,
      llm: callLlmAction?.llm ? [callLlmAction.llm] : [],
      input: callLlmAction?.input || '@input',
      instructions: callLlmAction?.instructions || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Get LLM selection
    const llmSelection =
      Array.isArray(formData.llm) && formData.llm.length > 0
        ? formData.llm[0]
        : null;

    // Find existing call_llm action to preserve its UUID
    const existingCallLlmAction = originalNode.actions?.find(
      (action) => action.type === 'call_llm'
    );
    const callLlmUuid = existingCallLlmAction?.uuid || generateUUID();

    // Create call_llm action
    const callLlmAction: CallLLM = {
      type: 'call_llm',
      uuid: callLlmUuid,
      llm: llmSelection
        ? {
            uuid: llmSelection.uuid || llmSelection.value,
            name: llmSelection.name
          }
        : { uuid: '', name: '' },
      input: formData.input || '@input',
      instructions: formData.instructions || '',
      output_local: '_llm_output'
    };

    // Create categories and exits for Success and Failure
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const { router, exits } = createSuccessFailureRouter(
      '@locals._llm_output',
      {
        type: 'has_text',
        arguments: []
      },
      existingCategories,
      existingExits,
      existingCases
    );

    // Return the complete node
    return {
      uuid: originalNode.uuid,
      actions: [callLlmAction],
      router: router,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: 'all'
};
