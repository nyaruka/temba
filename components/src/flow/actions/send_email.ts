import { msg } from '@lit/localize';
import { html } from 'lit-html';
import {
  ActionConfig,
  ACTION_GROUPS,
  FormData,
  FlowTypes,
  Features
} from '../types';
import { Node, SendEmail } from '../../store/flow-definition';
import {
  renderStringList,
  renderClamped,
  renderHighlightedText,
  validateWith
} from '../utils';
import { Icon } from '../../Icons';

export const send_email: ActionConfig = {
  get name() {
    return msg('Send Email');
  },
  get subtitle() {
    return msg('Notify your team or anyone else, with details from the flow.');
  },
  group: ACTION_GROUPS.broadcast,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  needs: {
    feature: Features.EMAIL,
    get warning() {
      return msg('This workspace has no email configuration.');
    }
  },
  render: (_node: Node, action: SendEmail) => {
    return html`<div>
      <div>${renderStringList(action.addresses, Icon.email, true)}</div>
      <div style="margin-top: 0.5em">
        ${renderClamped(
          renderHighlightedText(action.subject, true),
          action.subject
        )}
      </div>
    </div>`;
  },
  form: {
    addresses: {
      type: 'select',
      get label() {
        return msg('Recipients');
      },
      multi: true,
      searchable: true,
      emails: true,
      expressions: 'session'
    },
    subject: {
      type: 'text',
      get label() {
        return msg('Subject');
      },
      required: true,
      evaluated: true,
      maxLength: 1000
    },
    body: {
      type: 'textarea',
      required: true,
      evaluated: true,
      maxLength: 10000,
      minHeight: 175
    }
  },
  fromFormData: (formData: FormData): SendEmail => {
    return {
      uuid: formData.uuid,
      type: 'send_email',
      addresses: formData.addresses.map(
        (addr: { name: string; value: string }) => addr.value
      ),
      subject: formData.subject,
      body: formData.body
    };
  },
  localizable: ['subject', 'body'],
  validate: validateWith((formData, errors) => {
    if (!formData.addresses || formData.addresses.length === 0) {
      errors.addresses = msg(
        'At least one recipient email address is required'
      );
    }
  })
};
