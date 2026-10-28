import { msg } from '@lit/localize';
import { ACTION_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node, OpenTicket } from '../../store/flow-definition';
import { generateUUID, createSuccessFailureRouter } from '../../utils';
import { html } from 'lit';

export const split_by_ticket: NodeConfig = {
  type: 'split_by_ticket',
  name: 'Open Ticket',
  subtitle: 'A person on your team will be able to follow up.',
  group: ACTION_GROUPS.trigger,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  showAsAction: true,
  form: {
    topic: {
      type: 'select',
      label: 'Topic',
      required: true,
      placeholder: 'Select a topic',
      options: [],
      endpoint: '/api/v2/topics.json',
      valueKey: 'uuid',
      nameKey: 'name',
      maxWidth: '200px'
    },
    assignee: {
      type: 'select',
      label: 'Assignee',
      required: false,
      placeholder: 'Select an agent',
      endpoint: '/api/v2/users.json',
      valueKey: 'uuid',
      getName: (item: {
        first_name?: string;
        last_name?: string;
        name?: string;
      }) => {
        return item.name || [item.first_name, item.last_name].join(' ');
      },
      clearable: true
    },
    note: {
      type: 'textarea',
      label: 'Note',
      required: false,
      evaluated: true,
      placeholder: 'Enter a note for the ticket',
      maxLength: 10000,
      minHeight: 100
    }
  },
  layout: [{ type: 'row', items: ['topic', 'assignee'] }, 'note'],
  render: (node: Node) => {
    const openTicketAction = node.actions?.find(
      (action) => action.type === 'open_ticket'
    ) as OpenTicket;
    return html`
      <div class="body">
        ${openTicketAction?.topic?.name || msg('Configure ticket')}
      </div>
    `;
  },
  toFormData: (node: Node) => {
    // Extract data from the existing node structure
    const openTicketAction = node.actions?.find(
      (action) => action.type === 'open_ticket'
    ) as any;

    return {
      uuid: node.uuid,
      topic: openTicketAction?.topic
        ? [
            {
              uuid: openTicketAction.topic.uuid,
              name: openTicketAction.topic.name
            }
          ]
        : [],
      assignee: openTicketAction?.assignee
        ? [
            {
              uuid: openTicketAction.assignee.uuid,
              name: openTicketAction.assignee.name
            }
          ]
        : [],
      note: openTicketAction?.note || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Find existing open_ticket action to preserve its UUID
    const existingOpenTicketAction = originalNode.actions?.find(
      (action) => action.type === 'open_ticket'
    );
    const openTicketUuid = existingOpenTicketAction?.uuid || generateUUID();

    // Create open_ticket action
    const openTicketAction: OpenTicket = {
      type: 'open_ticket',
      uuid: openTicketUuid,
      topic:
        formData.topic && formData.topic.length > 0
          ? {
              uuid: formData.topic[0].uuid,
              name: formData.topic[0].name
            }
          : undefined,
      assignee:
        formData.assignee && formData.assignee.length > 0
          ? {
              uuid: formData.assignee[0].uuid,
              name:
                formData.assignee[0].name ||
                [
                  formData.assignee[0].first_name,
                  formData.assignee[0].last_name
                ].join(' ')
            }
          : undefined,
      note: formData.note || ''
    };

    // Create categories and exits for Success and Failure
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    const { router, exits } = createSuccessFailureRouter(
      '@locals._new_ticket',
      {
        type: 'has_text',
        arguments: []
      },
      existingCategories,
      existingExits,
      existingCases
    );

    // This node doesn't expose a result name, but preserve one set elsewhere
    if (originalNode.router?.result_name) {
      (router as any).result_name = originalNode.router.result_name;
    }

    // Return the complete node
    return {
      uuid: originalNode.uuid,
      actions: [openTicketAction],
      router: router,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: 'all'
};
