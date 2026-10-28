import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, AddToGroup } from '../../store/flow-definition';
import { renderGroupLinks } from '../utils';

export const add_contact_groups: ActionConfig = {
  name: 'Add to Group',
  subtitle: 'Good for triggering campaigns or targeting later broadcasts.',
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: AddToGroup) => {
    return html`<div>${renderGroupLinks(action.groups, 'group')}</div>`;
  },

  // Form-level transformations - default 1:1 mapping for this case
  toFormData: (action: AddToGroup) => {
    return {
      groups: action.groups || null,
      uuid: action.uuid
    };
  },
  form: {
    groups: {
      type: 'select',
      label: 'Groups',
      required: true,
      options: [],
      multi: true,
      searchable: true,
      endpoint: '/api/v2/groups.json',
      valueKey: 'uuid',
      nameKey: 'name',
      placeholder: 'Search for groups...',
      shouldExclude: (option: any) => !!option.query,
      allowCreate: true,
      createArbitraryOption: (input: string, options: any[]) => {
        // Check if a label with this name already exists
        const existing = options.find(
          (option) =>
            option.name.toLowerCase().trim() === input.toLowerCase().trim()
        );
        if (!existing && input.trim()) {
          return {
            name: input.trim(),
            arbitrary: true
          };
        }
        return null;
      }
    }
  },
  fromFormData: (formData: FormData): AddToGroup => {
    return {
      uuid: formData.uuid,
      type: 'add_contact_groups',
      groups: (formData.groups || []).map((g: any) => ({
        uuid: g.uuid,
        name: g.name
      }))
    };
  }
};
