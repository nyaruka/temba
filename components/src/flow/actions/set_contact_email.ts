import { msg, str } from '@lit/localize';
import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactEmail } from '../../store/flow-definition';
import { renderClamped, renderHighlightedText } from '../utils';

export const set_contact_email: ActionConfig = {
  get name() {
    return msg('Update Email');
  },
  get subtitle() {
    return msg('Keep the address the contact gave you on their profile.');
  },
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactEmail) => {
    if (!action.email) {
      return html`${msg('Clear email')}`;
    }
    return renderClamped(
      msg(html`Set to ${renderHighlightedText(action.email, true)}`),
      msg(str`Set to ${action.email}`)
    );
  },
  form: {
    email: {
      type: 'text',
      get label() {
        return msg('Email');
      },
      required: false,
      evaluated: true,
      maxLength: 1000,
      get helpText() {
        return msg(
          'Clears it when empty, and can include expressions, e.g. `@input.text`.'
        );
      }
    }
  },
  sanitize: (formData: FormData): void => {
    if (formData.email && typeof formData.email === 'string') {
      formData.email = formData.email.trim();
    }
  }
};
