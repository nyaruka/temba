import { msg } from '@lit/localize';
import { ACTION_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { CallResthook, Node } from '../../store/flow-definition';
import { generateUUID, createSuccessFailureRouter } from '../../utils';
import { html } from 'lit';
import { resultNameField } from './shared';
import { renderClamped, validateWith } from '../utils';

export const split_by_resthook: NodeConfig = {
  type: 'split_by_resthook',
  name: 'Call Resthook',
  subtitle:
    'Hand data to an integration like Zapier, then branch on the response.',
  group: ACTION_GROUPS.services,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  showAsAction: true,
  form: {
    resthook: {
      type: 'select',
      label: 'Resthook',
      required: true,
      searchable: true,
      clearable: false,
      placeholder: 'Select a resthook...',
      endpoint: '/api/v2/resthooks.json',
      valueKey: 'resthook',
      nameKey: 'resthook'
    },
    result_name: resultNameField
  },
  layout: ['resthook', 'result_name'],
  validate: validateWith((formData, errors) => {
    if (!formData.resthook || formData.resthook.length === 0) {
      errors.resthook = msg('A resthook is required');
    }
  }),
  render: (node: Node) => {
    const callResthookAction = node.actions?.find(
      (action) => action.type === 'call_resthook'
    ) as CallResthook;
    const resthook = callResthookAction?.resthook || msg('Configure resthook');
    return html` <div class="body">${renderClamped(resthook, resthook)}</div> `;
  },
  toFormData: (node: Node) => {
    // extract data from the existing node structure
    const callResthookAction = node.actions?.find(
      (action) => action.type === 'call_resthook'
    ) as CallResthook;

    return {
      uuid: node.uuid,
      resthook: callResthookAction?.resthook
        ? [
            {
              resthook: callResthookAction.resthook
            }
          ]
        : [],
      result_name: node.router?.result_name || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // get resthook selection
    const resthookSelection =
      Array.isArray(formData.resthook) && formData.resthook.length > 0
        ? formData.resthook[0]
        : null;

    if (!resthookSelection) {
      return originalNode;
    }

    // find existing call_resthook action to preserve its UUID
    const existingCallResthookAction = originalNode.actions?.find(
      (action) => action.type === 'call_resthook'
    );
    const callResthookUuid = existingCallResthookAction?.uuid || generateUUID();

    // create call_resthook action
    const callResthookAction: CallResthook = {
      type: 'call_resthook',
      uuid: callResthookUuid,
      resthook: resthookSelection.resthook
    };

    // create categories and exits for Success and Failure
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const { router, exits } = createSuccessFailureRouter(
      // default() guards against @webhook being null (e.g. the call was
      // skipped because the request exceeded the engine's size limit) which
      // would otherwise produce lookup errors when the router evaluates
      '@(default(webhook.status, 0))',
      {
        type: 'has_number_between',
        arguments: ['200', '299']
      },
      existingCategories,
      existingExits,
      existingCases
    );

    // Build final router with result_name
    const finalRouter: any = {
      ...router
    };

    // Only set result_name if provided
    if (formData.result_name && formData.result_name.trim() !== '') {
      finalRouter.result_name = formData.result_name.trim();
    }

    // return the complete node
    return {
      uuid: originalNode.uuid,
      actions: [callResthookAction],
      router: finalRouter,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: 'all'
};
