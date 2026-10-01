import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactEmail } from '../../store/flow-definition';
import { renderClamped, renderHighlightedText } from '../utils';

export const set_contact_email: ActionConfig = {
  name: 'Update Email',
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactEmail) => {
    if (!action.email) {
      return html`Clear email`;
    }
    return renderClamped(
      html`Set to ${renderHighlightedText(action.email, true)}`,
      `Set to ${action.email}`
    );
  },
  form: {
    email: {
      type: 'text',
      label: 'Email',
      placeholder: 'Enter email address...',
      evaluated: true,
      maxLength: 1000,
      helpText:
        'The new email address for the contact, or leave empty to clear it. You can use expressions like @input.text'
    }
  },
  sanitize: (formData: FormData): void => {
    if (formData.email && typeof formData.email === 'string') {
      formData.email = formData.email.trim();
    }
  }
};
