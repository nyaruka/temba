import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactEmail } from '../../store/flow-definition';
import { renderClamped, renderHighlightedText } from '../utils';

export const set_contact_email: ActionConfig = {
  name: 'Update Email',
  subtitle: 'Keep the address the contact gave you on their profile.',
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
        'Clears it when empty, and can include expressions, e.g. `@input.text`.'
    }
  },
  sanitize: (formData: FormData): void => {
    if (formData.email && typeof formData.email === 'string') {
      formData.email = formData.email.trim();
    }
  }
};
