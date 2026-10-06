import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FlowTypes } from '../types';
import { Node, EnterFlow } from '../../store/flow-definition';
import { renderFlowLinks } from '../utils';
import { shouldExcludeFlow } from '../flow-utils';

export const enter_flow: ActionConfig = {
  name: 'Enter a Flow',
  group: ACTION_GROUPS.trigger,
  hideFromActions: true,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: EnterFlow) => {
    return html`${renderFlowLinks([action.flow], 'flow')}`;
  },
  toFormData: (action: EnterFlow) => {
    return {
      uuid: action.uuid,
      flow: action.flow ? [action.flow] : []
    };
  },
  form: {
    flow: {
      type: 'select',
      required: true,
      placeholder: 'Select a flow...',
      helpText: 'The contact will enter this flow and not return',
      endpoint: '/api/v2/flows.json?archived=false',
      valueKey: 'uuid',
      nameKey: 'name',
      shouldExclude: shouldExcludeFlow
    }
  },
  layout: ['flow'],
  fromFormData: (formData: any): EnterFlow => {
    const selected = formData.flow[0];
    return {
      uuid: formData.uuid,
      type: 'enter_flow',
      terminal: true,
      flow: {
        uuid: selected.uuid || selected.value,
        name: selected.name
      }
    };
  }
};
