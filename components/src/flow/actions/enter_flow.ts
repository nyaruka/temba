import { msg } from '@lit/localize';
import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FlowTypes } from '../types';
import { Node, EnterFlow } from '../../store/flow-definition';
import { renderFlowLinks } from '../utils';
import { shouldExcludeFlow } from '../flow-utils';

export const enter_flow: ActionConfig = {
  get name() {
    return msg('Enter a Flow');
  },
  get subtitle() {
    return msg(
      "The contact runs another flow, then carries on here once it's done."
    );
  },
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
      get placeholder() {
        return msg('Select a flow...');
      },
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
