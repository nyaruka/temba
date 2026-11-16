import { msg } from '@lit/localize';
import { NodeConfig, ACTION_GROUPS, FlowTypes } from '../types';

export const split_by_llm_categorize: NodeConfig = {
  type: 'split_by_intent',
  get name() {
    return msg('Call classifier');
  },
  get subtitle() {
    return msg(
      'Work out what the last message means and branch on its intent.'
    );
  },
  group: ACTION_GROUPS.services,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND]
};
