import { ACTION_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node, SetRunResult } from '../../store/flow-definition';
import { generateUUID } from '../../utils';
import { html } from 'lit';
import { renderFlowLinks } from '../utils';
import { shouldExcludeFlow } from '../flow-utils';

export const split_by_subflow: NodeConfig = {
  type: 'split_by_subflow',
  name: 'Enter a Flow',
  group: ACTION_GROUPS.trigger,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  showAsAction: true,
  form: {
    flow: {
      type: 'select',
      required: true,
      searchable: true,
      placeholder: 'Select a flow...',
      helpText:
        'Once the subflow is complete or expires, the contact will return here',
      endpoint: '/api/v2/flows.json?archived=false',
      valueKey: 'uuid',
      nameKey: 'name',
      shouldExclude: shouldExcludeFlow
    },
    params: {
      type: 'key-value',
      keyPlaceholder: 'Parameter name',
      valuePlaceholder: 'Value',
      minRows: 0,
      readOnlyKeys: true,
      dependsOn: ['flow'],
      conditions: {
        visible: (formData: Record<string, any>) => {
          const params = formData.params;
          if (Array.isArray(params)) return params.length > 0;
          if (params && typeof params === 'object')
            return Object.keys(params).length > 0;
          return false;
        }
      },
      computeValue: (values: Record<string, any>, currentValue: any) => {
        const flow =
          Array.isArray(values.flow) && values.flow.length > 0
            ? values.flow[0]
            : null;
        if (!flow?.parent_refs?.length) {
          // Clear params when selected flow has no parent_refs
          return [];
        }

        // Build a map of existing values
        const existingValues: Record<string, string> = {};
        if (Array.isArray(currentValue)) {
          currentValue.forEach((item: any) => {
            if (item.key) existingValues[item.key] = item.value || '';
          });
        } else if (currentValue && typeof currentValue === 'object') {
          Object.entries(currentValue).forEach(([k, v]) => {
            existingValues[k] = typeof v === 'string' ? (v as string) : '';
          });
        }

        // Create params from parent_refs, preserving existing values
        return flow.parent_refs.map((ref: string) => ({
          key: ref,
          value: existingValues[ref] || ''
        }));
      }
    }
  },
  layout: [
    'flow',
    {
      type: 'accordion',
      sections: [
        {
          label: 'Parameters',
          collapsed: false,
          getValueCount: (formData: FormData) => {
            const params = formData.params;
            if (Array.isArray(params)) {
              return params.filter((p: any) => p.value && p.value.trim() !== '')
                .length;
            }
            if (params && typeof params === 'object') {
              return Object.values(params).filter(
                (v) => typeof v === 'string' && v.trim() !== ''
              ).length;
            }
            return 0;
          },
          items: ['params']
        }
      ]
    }
  ],
  resolveFormData: async (formData: FormData) => {
    const flow =
      Array.isArray(formData.flow) && formData.flow.length > 0
        ? formData.flow[0]
        : null;
    if (!flow?.uuid) return formData;

    // Already have parent_refs (e.g. from a fresh selection)
    if (flow.parent_refs) return formData;

    try {
      const response = await fetch(`/api/v2/flows.json?uuid=${flow.uuid}`);
      const data = await response.json();
      const flowData = data.results?.[0];
      if (flowData?.parent_refs) {
        const updatedFlow = { ...flow, parent_refs: flowData.parent_refs };
        return { ...formData, flow: [updatedFlow] };
      }
    } catch {
      // Non-fatal; params just won't auto-populate
    }

    return formData;
  },
  render: (node: Node) => {
    const enterFlowAction = node.actions?.find(
      (action) => action.type === 'enter_flow'
    ) as any;
    return html`
      <div class="body">
        ${enterFlowAction?.flow
          ? renderFlowLinks([enterFlowAction.flow], 'flow')
          : null}
      </div>
    `;
  },
  toFormData: (node: Node) => {
    // Extract data from the existing node structure
    const enterFlowAction = node.actions?.find(
      (action) => action.type === 'enter_flow'
    ) as any;

    // Extract params from set_run_result actions
    const params: Record<string, string> = {};
    node.actions
      ?.filter((action) => action.type === 'set_run_result')
      .forEach((action) => {
        const setResult = action as SetRunResult;
        params[setResult.name] = setResult.value;
      });

    return {
      uuid: node.uuid,
      flow: enterFlowAction?.flow
        ? [{ uuid: enterFlowAction.flow.uuid, name: enterFlowAction.flow.name }]
        : [],
      params
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Get flow selection
    const flowSelection =
      Array.isArray(formData.flow) && formData.flow.length > 0
        ? formData.flow[0]
        : null;

    // Find existing enter_flow action to preserve its UUID
    const existingEnterFlowAction = originalNode.actions?.find(
      (action) => action.type === 'enter_flow'
    );
    const enterFlowUuid = existingEnterFlowAction?.uuid || generateUUID();

    // Create enter_flow action
    const enterFlowAction: any = {
      type: 'enter_flow',
      uuid: enterFlowUuid,
      flow: flowSelection
        ? {
            uuid: flowSelection.uuid || flowSelection.value,
            name: flowSelection.name
          }
        : { uuid: '', name: '' }
    };

    // Create set_run_result actions for params
    const actions: any[] = [];
    const params = formData.params || {};
    Object.entries(params).forEach(([name, value]: [string, any]) => {
      if (typeof value === 'string' && value.trim() !== '') {
        actions.push({
          type: 'set_run_result',
          uuid: generateUUID(),
          name,
          value,
          category: ''
        });
      }
    });

    // enter_flow action goes last (after set_run_result actions)
    actions.push(enterFlowAction);

    // Create categories and exits for Complete and Expired
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    // Find existing Complete category
    const existingCompleteCategory = existingCategories.find(
      (cat) => cat.name === 'Complete'
    );
    const existingCompleteExit = existingCompleteCategory
      ? existingExits.find(
          (exit) => exit.uuid === existingCompleteCategory.exit_uuid
        )
      : null;
    const existingCompleteCase = existingCompleteCategory
      ? existingCases.find(
          (case_) => case_.category_uuid === existingCompleteCategory.uuid
        )
      : null;

    const completeCategoryUuid =
      existingCompleteCategory?.uuid || generateUUID();
    const completeExitUuid = existingCompleteExit?.uuid || generateUUID();
    const completeCaseUuid = existingCompleteCase?.uuid || generateUUID();

    // Find existing Expired category
    const existingExpiredCategory = existingCategories.find(
      (cat) => cat.name === 'Expired'
    );
    const existingExpiredExit = existingExpiredCategory
      ? existingExits.find(
          (exit) => exit.uuid === existingExpiredCategory.exit_uuid
        )
      : null;

    const expiredCategoryUuid = existingExpiredCategory?.uuid || generateUUID();
    const expiredExitUuid = existingExpiredExit?.uuid || generateUUID();

    const categories = [
      {
        uuid: completeCategoryUuid,
        name: 'Complete',
        exit_uuid: completeExitUuid
      },
      {
        uuid: expiredCategoryUuid,
        name: 'Expired',
        exit_uuid: expiredExitUuid
      }
    ];

    const exits = [
      {
        uuid: completeExitUuid,
        destination_uuid: existingCompleteExit?.destination_uuid || null
      },
      {
        uuid: expiredExitUuid,
        destination_uuid: existingExpiredExit?.destination_uuid || null
      }
    ];

    const cases = [
      {
        uuid: completeCaseUuid,
        type: 'has_only_text',
        arguments: ['completed'],
        category_uuid: completeCategoryUuid
      }
    ];

    // Create the router
    const router: any = {
      type: 'switch' as const,
      categories: categories,
      default_category_uuid: expiredCategoryUuid,
      operand: '@child.status',
      cases: cases
    };

    // This node doesn't expose a result name, but preserve one set elsewhere
    if (originalNode.router?.result_name) {
      router.result_name = originalNode.router.result_name;
    }

    // Return the complete node
    return {
      uuid: originalNode.uuid,
      actions: actions,
      router: router,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: 'all'
};
