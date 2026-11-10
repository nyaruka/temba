import { msg, str } from '@lit/localize';
import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactChannel } from '../../store/flow-definition';
import { renderClamped } from '../utils';

export const set_contact_channel: ActionConfig = {
  get name() {
    return msg('Update Channel');
  },
  get subtitle() {
    return msg(
      'Choose which of your channels reaches this contact from now on.'
    );
  },
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactChannel) => {
    return renderClamped(
      msg(html`Set to <strong>${action.channel.name}</strong>`),
      msg(str`Set to ${action.channel.name}`)
    );
  },
  form: {
    channel: {
      type: 'select',
      get label() {
        return msg('Channel');
      },
      required: true,
      searchable: true,
      clearable: false,
      endpoint: '/api/v2/channels.json',
      valueKey: 'uuid',
      nameKey: 'name'
    }
  },
  toFormData: (action: SetContactChannel) => {
    return {
      uuid: action.uuid,
      channel: action.channel ? [action.channel] : null
    };
  },
  fromFormData: (formData: FormData): SetContactChannel => {
    const channel = formData.channel?.[0];
    return {
      uuid: formData.uuid,
      type: 'set_contact_channel',
      channel: {
        uuid: channel.uuid || channel.value,
        name: channel.name
      }
    };
  }
};
