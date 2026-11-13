import { msg, str } from '@lit/localize';
import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactField } from '../../store/flow-definition';
import { renderClamped, renderHighlightedText } from '../utils';

export const set_contact_field: ActionConfig = {
  get name() {
    return msg('Update Field');
  },
  get subtitle() {
    return msg(
      'Store what you learn about the contact for later flows and reports.'
    );
  },
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactField) => {
    if (action.value) {
      const value = renderHighlightedText(action.value, true);
      return renderClamped(
        msg(html`Set <strong>${action.field.name}</strong> to ${value}`),
        msg(str`Set ${action.field.name} to ${action.value}`)
      );
    } else {
      return renderClamped(
        msg(html`Clear <strong>${action.field.name}</strong>`),
        msg(str`Clear ${action.field.name}`)
      );
    }
  },
  form: {
    field: {
      type: 'select',
      get label() {
        return msg('Field');
      },
      required: true,
      searchable: true,
      clearable: false,
      nameKey: 'name',
      valueKey: 'key',
      endpoint: '/api/v2/fields.json',
      get helpText() {
        return msg('Typing a new name creates a new field.');
      },
      allowCreate: true,
      createArbitraryOption: (input: string) => ({
        key: input,
        name: input,
        type: 'text'
      })
    },
    value: {
      type: 'textarea',
      get label() {
        return msg('Value');
      },
      required: false,
      evaluated: true,
      maxLength: 10000,
      get helpText() {
        return msg(
          'Clears it when empty, and can include expressions, e.g. `@input.text`.'
        );
      }
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
