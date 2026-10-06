import { html } from 'lit-html';
import {
  ActionConfig,
  ACTION_GROUPS,
  FormData,
  ValidationResult,
  FlowTypes
} from '../types';
import { Node, StartSession } from '../../store/flow-definition';
import {
  renderMixedList,
  renderFlowLinks,
  renderHighlightedText,
  validateRecipients
} from '../utils';
import { Icon } from '../../Icons';
import { CustomEventType } from '../../interfaces';

export const start_session: ActionConfig = {
  name: 'Start Flow',
  group: ACTION_GROUPS.broadcast,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: StartSession) => {
    let recipientsDisplay = html``;
    if (action.create_contact) {
      recipientsDisplay = html`Create a new contact`;
    } else if ((action as any).contact_query) {
      recipientsDisplay = html`${renderHighlightedText(
        (action as any).contact_query,
        true
      )}`;
    } else {
      const recipients = [
        ...(action.groups || []).map((g) => ({
          name: g.name,
          icon: Icon.group,
          uuid: g.uuid,
          eventType: CustomEventType.GroupClicked
        })),
        ...(action.contacts || []).map((c) => ({
          name: c.name,
          icon: Icon.contacts,
          uuid: c.uuid,
          eventType: CustomEventType.ContactClicked
        })),
        ...(action.legacy_vars || []).map((v) => ({
          name: v,
          icon: Icon.contacts,
          content: renderHighlightedText(v, true)
        }))
      ];
      recipientsDisplay = html`${renderMixedList(recipients)}`;
    }

    return html`
      <div>
        <div>${recipientsDisplay}</div>
        <div style="margin-top: 0.5em">
          ${renderFlowLinks([action.flow], 'flow')}
        </div>
      </div>
    `;
  },

  toFormData: (action: StartSession) => {
    const extendedAction = action as StartSession & {
      contact_query?: string;
      exclusions?: { in_a_flow?: boolean };
    };

    // Determine start type based on action properties
    let startTypeValue = 'manual';
    if (action.create_contact) {
      startTypeValue = 'create';
    } else if (extendedAction.contact_query) {
      startTypeValue = 'query';
    }

    // Map value to full option object for proper display
    const startTypeOptions = [
      { value: 'manual', name: 'Select recipients manually' },
      { value: 'query', name: 'Select a contact with a query' },
      { value: 'create', name: 'Create a new contact' }
    ];
    const startType =
      startTypeOptions.find((opt) => opt.value === startTypeValue) ||
      startTypeOptions[0];

    return {
      flow: action.flow ? [action.flow] : null,
      recipients: [
        ...(action.contacts || []).map((c) => ({
          id: c.uuid,
          name: c.name,
          type: 'contact'
        })),
        ...(action.groups || []).map((g) => ({
          id: g.uuid,
          name: g.name,
          type: 'group'
        })),
        ...(action.legacy_vars || []).map((v) => ({
          id: v,
          name: v,
          type: 'expression'
        }))
      ],
      startType: [startType],
      contactQuery: extendedAction.contact_query || '',
      skipContactsInFlow: extendedAction.exclusions?.in_a_flow || false,
      uuid: action.uuid
    };
  },

  form: {
    flow: {
      type: 'select',
      label: 'Flow',
      helpText: 'Select the flow to start',
      required: true,
      searchable: true,
      endpoint: '/api/v2/flows.json?archived=false',
      valueKey: 'uuid',
      nameKey: 'name',
      placeholder: 'Select a flow...'
    },
    startType: {
      type: 'select',
      label: 'Start Type',
      helpText: 'How should contacts be selected?',
      required: true,
      options: [
        { value: 'manual', name: 'Select recipients manually' },
        { value: 'query', name: 'Select a contact with a query' },
        { value: 'create', name: 'Create a new contact' }
      ]
    },
    recipients: {
      type: 'select',
      label: 'Recipients',
      helpText: 'Select who should be started in the flow',
      multi: true,
      searchable: true,
      endpoint: '/contact/omnibox/?types=gc',
      queryParam: 'search',
      valueKey: 'id',
      nameKey: 'name',
      placeholder: 'Search for contacts or groups...',
      expressions: 'session',
      conditions: {
        visible: (formData: FormData) => {
          const startType = formData.startType?.[0]?.value;
          return startType === 'manual';
        }
      }
    },
    contactQuery: {
      type: 'text',
      evaluated: true,
      label: 'Contact Query',
      helpText: 'Only one matching contact will be started',
      maxLength: 10000,
      placeholder: 'household_id = @fields.household_id',
      conditions: {
        visible: (formData: FormData) => {
          const startType = formData.startType?.[0]?.value;
          return startType === 'query';
        }
      }
    },
    skipContactsInFlow: {
      type: 'checkbox',
      label: 'Skip contacts currently in a flow',
      helpText: 'Avoid interrupting a contact who is already in a flow'
    }
  },

  layout: [
    'flow',
    'startType',
    'recipients',
    'contactQuery',
    'skipContactsInFlow'
  ],

  validate: (formData: FormData): ValidationResult => {
    const errors: { [key: string]: string } = {};

    const startType = formData.startType?.[0]?.value;

    // Check if manual selection has recipients
    if (
      startType === 'manual' &&
      (!formData.recipients || formData.recipients.length === 0)
    ) {
      errors.recipients = 'At least one contact or group must be selected';
    }

    if (startType === 'manual') {
      const recipientsError = validateRecipients(formData.recipients || []);
      if (recipientsError) {
        errors.recipients = recipientsError;
      }
    }

    // Check if query has a query string
    if (
      startType === 'query' &&
      (!formData.contactQuery || !formData.contactQuery.trim())
    ) {
      errors.contactQuery = 'Contact query is required';
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  },

  fromFormData: (formData: FormData): StartSession => {
    const action: StartSession & {
      contact_query?: string;
      exclusions?: { in_a_flow: boolean };
    } = {
      uuid: formData.uuid,
      type: 'start_session',
      flow: {
        uuid: formData.flow[0].uuid || formData.flow[0].value,
        name: formData.flow[0].name
      },
      groups: [],
      contacts: []
    };

    // Get the start type value from array
    const startTypeValue = formData.startType[0].value;

    // Handle different start types
    if (startTypeValue === 'create') {
      action.create_contact = true;
    } else if (startTypeValue === 'query') {
      action.contact_query = formData.contactQuery || '';
    } else {
      // Manual selection - separate contacts, groups, and legacy vars
      const recipients = formData.recipients || [];
      action.contacts = recipients
        .filter(
          (r: any) => r.type === 'contact' || (!r.type && !r.expression && r.id)
        )
        .map((c: any) => ({ uuid: c.id, name: c.name }));
      action.groups = recipients
        .filter((r: any) => r.type === 'group')
        .map((g: any) => ({ uuid: g.id, name: g.name }));
      const legacy_vars = recipients
        .filter((r: any) => r.type === 'expression' || r.expression)
        .map((e: any) => e.value || e.name || e.id);
      if (legacy_vars.length > 0) {
        action.legacy_vars = legacy_vars;
      }
    }

    // Add exclusions if set
    if (formData.skipContactsInFlow) {
      action.exclusions = { in_a_flow: true };
    }

    return action;
  }
};
