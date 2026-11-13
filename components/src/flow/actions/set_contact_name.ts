import { msg, str } from '@lit/localize';
import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactName } from '../../store/flow-definition';
import { renderClamped, renderHighlightedText } from '../utils';

export const set_contact_name: ActionConfig = {
  get name() {
    return msg('Update Name');
  },
  get subtitle() {
    return msg('Useful once the contact has told you what to call them.');
  },
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactName) => {
    if (!action.name) {
      return html`${msg('Clear name')}`;
    }
    return renderClamped(
      msg(html`Set to ${renderHighlightedText(action.name, true)}`),
      msg(str`Set to ${action.name}`)
    );
  },
  form: {
    name: {
      type: 'text',
      get label() {
        return msg('Name');
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
    if (formData.name && typeof formData.name === 'string') {
      formData.name = formData.name.trim();
    }
  }
};
