import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactName } from '../../store/flow-definition';
import { renderClamped, renderHighlightedText } from '../utils';

export const set_contact_name: ActionConfig = {
  name: 'Update Name',
  subtitle: 'Useful once the contact has told you what to call them.',
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactName) => {
    if (!action.name) {
      return html`Clear name`;
    }
    return renderClamped(
      html`Set to ${renderHighlightedText(action.name, true)}`,
      `Set to ${action.name}`
    );
  },
  form: {
    name: {
      type: 'text',
      label: 'Name',
      placeholder: 'Enter contact name...',
      evaluated: true,
      maxLength: 1000,
      helpText:
        'Clears it when empty, and can include expressions, e.g. `@input.text`.'
    }
  },
  sanitize: (formData: FormData): void => {
    if (formData.name && typeof formData.name === 'string') {
      formData.name = formData.name.trim();
    }
  }
};
