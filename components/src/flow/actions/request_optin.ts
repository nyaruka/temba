import { msg, str } from '@lit/localize';
import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS } from '../types';
import { Node, RequestOptin } from '../../store/flow-definition';
import { renderClamped } from '../utils';

// Opt-ins are no longer a supported concept — this config exists only so
// that actions left behind in older flow definitions still render. It has
// no form, which makes the action read-only in the editor.
export const request_optin: ActionConfig = {
  get name() {
    return msg('Request Opt-In');
  },
  get subtitle() {
    return msg('No longer supported. Shown so older flows still open.');
  },
  group: ACTION_GROUPS.send,
  flowTypes: [],
  render: (_node: Node, action: RequestOptin) => {
    const optinName = action.optin?.name || msg('Unknown opt-in');
    return renderClamped(
      msg(html`Request <strong>${optinName}</strong>`),
      msg(str`Request ${optinName}`)
    );
  }
};
