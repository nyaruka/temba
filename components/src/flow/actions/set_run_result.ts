import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetRunResult } from '../../store/flow-definition';
import { getStore } from '../../store/Store';
import { renderClamped, renderHighlightedText } from '../utils';

export const set_run_result: ActionConfig = {
  name: 'Save Flow Result',
  subtitle:
    'Results show up in flow reports and can be used later in the flow.',
  group: ACTION_GROUPS.save,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetRunResult) => {
    return renderClamped(
      html`Set <strong>${action.name}</strong> to
        ${renderHighlightedText(action.value, true)}`,
      `Set ${action.name} to ${action.value}`
    );
  },
  form: {
    name: {
      type: 'select',
      label: 'Result Name',
      helpText: 'Typing a new name creates a new result.',
      required: true,
      maxLength: 64,
      createArbitraryOption: (input, options) => {
        const exists = options.some(
          (option: any) =>
            option.value.toLowerCase() === input.toLowerCase() ||
            option.name.toLowerCase() === input.toLowerCase()
        );
        return !exists && input.trim().length > 0
          ? { value: input, name: input }
          : null;
      },
      searchable: true,
      clearable: false,
      getDynamicOptions: () => {
        const store = getStore();
        return store
          ? store
              .getState()
              .getFlowResults()
              .map((r) => ({ value: r.name, name: r.name }))
          : [];
      }
    },
    value: {
      type: 'textarea',
      label: 'Value',
      helpText: 'Can include expressions, e.g. `@input.text`.',
      required: false,
      evaluated: true,
      maxLength: 10000
    },
    category: {
      type: 'text',
      label: 'Category',
      required: false,
      maxLength: 36
    }
  },
  layout: ['name', 'value', 'category'],
  toFormData: (action: SetRunResult) => {
    return {
      uuid: action.uuid,
      name: action.name ? [{ name: action.name, value: action.name }] : null,
      value: action.value || '',
      category: action.category || ''
    };
  },
  fromFormData: (formData: FormData): SetRunResult => {
    // Ensure name is a simple string, handling both direct values and select option objects
    let name = formData.name || '';
    if (Array.isArray(name) && name.length > 0) {
      // If it's an array (from multi-select), take the first item
      name = name[0];
    }
    if (typeof name === 'object' && name.value) {
      // If it's an option object, extract the value
      name = name.value;
    }
    if (typeof name === 'object' && name.name) {
      // If it's an option object with name property, extract it
      name = name.name;
    }

    return {
      uuid: formData.uuid,
      type: 'set_run_result',
      name: String(name), // Ensure it's always a string
      value: formData.value || '',
      category: formData.category || ''
    };
  }
};
