import { msg, str } from '@lit/localize';
import { localizedOption, renderClamped } from '../utils';
import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactStatus } from '../../store/flow-definition';

const STATUS_OPTIONS = [
  localizedOption('active', () => msg('Active')),
  localizedOption('archived', () => msg('Archived')),
  localizedOption('stopped', () => msg('Stopped')),
  localizedOption('blocked', () => msg('Blocked'))
];

const getStatusOption = (status: string) =>
  STATUS_OPTIONS.find((option) => option.value === status) || STATUS_OPTIONS[0];

export const set_contact_status: ActionConfig = {
  get name() {
    return msg('Update Status');
  },
  get subtitle() {
    return msg("Stopped and blocked contacts won't get any more messages.");
  },
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactStatus) => {
    const name = getStatusOption(action.status).name;
    return renderClamped(
      msg(html`Set to <strong>${name}</strong>`),
      msg(str`Set to ${name}`)
    );
  },
  toFormData: (action: SetContactStatus) => {
    return {
      uuid: action.uuid,
      status: [getStatusOption(action.status)]
    };
  },
  fromFormData: (formData: FormData): SetContactStatus => {
    return {
      status: formData.status[0].value,
      type: 'set_contact_status',
      uuid: formData.uuid
    };
  },
  form: {
    status: {
      type: 'select',
      get label() {
        return msg('Status');
      },
      required: true,
      searchable: false,
      clearable: false,
      options: STATUS_OPTIONS
    }
  }
};
