import { html } from 'lit-html';
import {
  ActionConfig,
  ACTION_GROUPS,
  FormData,
  ValidationResult,
  FlowTypes
} from '../types';
import { Node, RemoveFromGroup } from '../../store/flow-definition';
import { renderGroupLinks } from '../utils';

export const remove_contact_groups: ActionConfig = {
  name: 'Remove from Group',
  subtitle:
    'Takes effect right away, including for campaigns based on the group.',
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: RemoveFromGroup) => {
    if (action.all_groups) {
      return html`<div>Remove from all groups</div>`;
    }
    return html`<div>${renderGroupLinks(action.groups, 'group')}</div>`;
  },
  toFormData: (action: RemoveFromGroup) => {
    return {
      uuid: action.uuid,
      all_groups: action.all_groups || false,
      groups: action.groups || null
    };
  },
  form: {
    groups: {
      type: 'select',
      label: 'Groups',
      options: [],
      multi: true,
      searchable: true,
      endpoint: '/api/v2/groups.json',
      valueKey: 'uuid',
      nameKey: 'name',
      placeholder: 'Search for groups...',
      conditions: {
        visible: (formData) => !formData.all_groups
      }
    },
    all_groups: {
      type: 'checkbox',
      label: 'Remove from All Groups'
    }
  },
  validate: (formData: FormData): ValidationResult => {
    const errors: { [key: string]: string } = {};

    if (
      !formData.all_groups &&
      (!formData.groups || formData.groups.length === 0)
    ) {
      errors.groups =
        'At least one group must be selected or check "Remove from All Groups"';
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  },
  fromFormData: (formData: FormData): RemoveFromGroup => {
    return {
      uuid: formData.uuid,
      type: 'remove_contact_groups',
      groups: formData.all_groups
        ? []
        : (formData.groups || []).map((g: any) => ({
            uuid: g.uuid,
            name: g.name
          })),
      all_groups: formData.all_groups || false
    };
  }
};
