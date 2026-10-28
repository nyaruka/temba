import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, AddInputLabels } from '../../store/flow-definition';
import { renderNamedObjects } from '../utils';

export const add_input_labels: ActionConfig = {
  name: 'Add Input Labels',
  subtitle: "Tag the contact's last message so it's easy to find in the inbox.",
  group: ACTION_GROUPS.save,
  // Not allowed in background flows: goflow treats add_input_labels as an interactive
  // action (messaging, messaging_offline, voice only), so offering it in a
  // messaging_background flow produces a definition the backend rejects.
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE],
  render: (_node: Node, action: AddInputLabels) => {
    return html`<div>${renderNamedObjects(action.labels, 'label')}</div>`;
  },

  // Form-level transformations
  toFormData: (action: AddInputLabels) => {
    return {
      labels: action.labels || null,
      uuid: action.uuid
    };
  },
  form: {
    labels: {
      type: 'select',
      label: 'Labels',
      helpText: 'Typing a new name creates a new label.',
      required: true,
      options: [],
      multi: true,
      searchable: true,
      endpoint: '/api/v2/labels.json',
      valueKey: 'uuid',
      nameKey: 'name',
      placeholder: 'Search for labels or type to create new ones...',
      allowCreate: true,
      createArbitraryOption: (input: string, options: any[]) => {
        // Check if a label with this name already exists
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
    }
  },
  fromFormData: (formData: FormData): AddInputLabels => {
    return {
      uuid: formData.uuid,
      type: 'add_input_labels',
      labels: (formData.labels || []).map((l: any) => ({
        uuid: l.uuid,
        name: l.name
      }))
    };
  }
};
