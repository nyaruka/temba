import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactField } from '../../store/flow-definition';
import { renderClamped, renderHighlightedText } from '../utils';

export const set_contact_field: ActionConfig = {
  name: 'Update Field',
  subtitle:
    'Store what you learn about the contact for later flows and reports.',
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactField) => {
    if (action.value) {
      return renderClamped(
        html`Set <strong>${action.field.name}</strong> to
          ${renderHighlightedText(action.value, true)}`,
        `Set ${action.field.name} to ${action.value}`
      );
    } else {
      return renderClamped(
        html`Clear <strong>${action.field.name}</strong>`,
        `Clear ${action.field.name}`
      );
    }
  },
  form: {
    field: {
      type: 'select',
      label: 'Field',
      required: true,
      searchable: true,
      clearable: false,
      placeholder: 'Search for contact fields...',
      nameKey: 'name',
      valueKey: 'key',
      endpoint: '/api/v2/fields.json',
      helpText: 'Typing a new name creates a new field.',
      allowCreate: true,
      createArbitraryOption: (input: string) => ({
        key: input,
        name: input,
        type: 'text'
      })
    },
    value: {
      type: 'textarea',
      label: 'Value',
      placeholder: 'Enter field value...',
      evaluated: true,
      maxLength: 10000,
      helpText:
        'Clears it when empty, and can include expressions, e.g. `@input.text`.'
    }
  },
  toFormData: (action: SetContactField) => {
    return {
      uuid: action.uuid,
      field: action.field ? [action.field] : null,
      value: action.value
    };
  },
  fromFormData: (formData: FormData): SetContactField => {
    const field = formData.field[0];
    return {
      uuid: formData.uuid,
      type: 'set_contact_field',
      field: { name: field.name, key: field.key },
      value: formData.value
    };
  },
  sanitize: (formData: FormData): void => {
    if (formData.value && typeof formData.value === 'string') {
      formData.value = formData.value.trim();
    }
  }
};
