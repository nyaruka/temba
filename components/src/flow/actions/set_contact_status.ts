import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SetContactStatus } from '../../store/flow-definition';
import { titleCase } from '../../utils';
import { renderClamped } from '../utils';

export const set_contact_status: ActionConfig = {
  name: 'Update Status',
  subtitle: "Stopped and blocked contacts won't get any more messages.",
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactStatus) => {
    return renderClamped(
      html`Set to <strong>${titleCase(action.status)}</strong>`,
      `Set to ${titleCase(action.status)}`
    );
  },
  toFormData: (action: SetContactStatus) => {
    return {
      uuid: action.uuid,
      status: [
        {
          name: titleCase(action.status || 'active'),
          value: action.status || 'active'
        }
      ]
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
      label: 'Status',
      required: true,
      searchable: false,
      clearable: false,
      options: [
        { value: 'active', name: 'Active' },
        { value: 'archived', name: 'Archived' },
        { value: 'stopped', name: 'Stopped' },
        { value: 'blocked', name: 'Blocked' }
      ]
    }
  }
};
