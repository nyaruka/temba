import { html } from 'lit-html';
import { ActionConfig, ACTION_GROUPS, FormData, FlowTypes } from '../types';
import { Node, SendBroadcast } from '../../store/flow-definition';
import {
  renderMixedList,
  renderAttachments,
  renderClamped,
  renderHighlightedText,
  validateRecipients,
  validateTemplateVariables,
  validateWith
} from '../utils';
import { Icon } from '../../Icons';
import { CustomEventType } from '../../interfaces';

export const send_broadcast: ActionConfig = {
  name: 'Send Broadcast',
  group: ACTION_GROUPS.broadcast,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SendBroadcast) => {
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

    return html`<div>
      <div>${renderMixedList(recipients)}</div>
      <div style="margin-top: 0.5em">
        ${action.template
          ? html`<div
              style="border: 1px solid #7dc8bc;padding: 0.5em;margin-bottom: 0.5em;border-radius: 4px; display:flex;align-items: flex-start;background: #f0faf7;color: #128C7E;font-size: 0.85em;"
            >
              <temba-icon
                name="channel_wac"
                style="--icon-size: 14px;"
              ></temba-icon>
              <div style="margin-left:0.4em">${action.template.name}</div>
            </div>`
          : null}
        ${renderClamped(renderHighlightedText(action.text, true), action.text)}
        ${renderAttachments(action.attachments)}
      </div>
    </div>`;
  },

  form: {
    recipients: {
      type: 'select',
      label: 'Recipients',
      helpText: 'Select the contacts or groups to receive the broadcast',
      multi: true,
      searchable: true,
      endpoint: '/contact/omnibox/?types=gc',
      queryParam: 'search',
      valueKey: 'id',
      nameKey: 'name',
      placeholder: 'Search for contacts or groups...',
      required: true,
      expressions: 'session'
    },
    text: {
      type: 'message-editor',
      label: 'Message',
      helpText:
        'Enter the message to send with optional attachments. You can use expressions like @contact.name',
      required: true,
      evaluated: true,
      placeholder: 'Type your message here...',
      maxLength: 640,
      maxAttachments: 10,
      accept: '',
      endpoint: '/api/v2/media.json',
      counter: 'temba-charcount',
      gsm: true,
      autogrow: true
    },
    template: {
      type: 'template-editor',
      endpoint: '/api/internal/templates.json'
    }
  },

  layout: [
    'recipients',
    'text',
    {
      type: 'accordion',
      sections: [
        {
          label: 'WhatsApp Template',
          collapsed: true,
          localizable: false,
          getValueCount: (formData: FormData) => {
            return !!formData.template;
          },
          items: ['template']
        }
      ]
    }
  ],

  toFormData: (action: SendBroadcast) => {
    return {
      uuid: action.uuid,
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
      text: action.text || '',
      attachments: action.attachments || [],
      template: action.template || null,
      template_variables: action.template_variables || []
    };
  },

  fromFormData: (formData: FormData): SendBroadcast => {
    const recipients = formData.recipients || [];
    const contacts = recipients
      .filter(
        (r: any) => r.type === 'contact' || (!r.type && !r.expression && r.id)
      )
      .map((c: any) => ({ uuid: c.id, name: c.name }));
    const groups = recipients
      .filter((r: any) => r.type === 'group')
      .map((g: any) => ({ uuid: g.id, name: g.name }));
    const legacy_vars = recipients
      .filter((r: any) => r.type === 'expression' || r.expression)
      .map((e: any) => e.value || e.name || e.id);

    const result: SendBroadcast = {
      uuid: formData.uuid,
      type: 'send_broadcast',
      text: formData.text || '',
      contacts,
      groups,
      attachments: formData.attachments || []
    };

    if (legacy_vars.length > 0) {
      result.legacy_vars = legacy_vars;
    }

    // Remove empty attachments array to match original format
    if (result.attachments.length === 0) {
      delete result.attachments;
    }

    // Add template and template_variables if a template is selected
    if (formData.template) {
      result.template = formData.template;
      result.template_variables = formData.template_variables || [];
    }

    return result;
  },

  sanitize: (formData: FormData): void => {
    if (formData.text && typeof formData.text === 'string') {
      formData.text = formData.text.trim();
    }
  },
  validate: validateWith((formData, errors) => {
    const recipientsError = validateRecipients(formData.recipients || []);
    if (recipientsError) {
      errors.recipients = recipientsError;
    }

    const templateVariablesError = validateTemplateVariables(
      formData.template_variables || []
    );
    if (templateVariablesError) {
      errors.template = templateVariablesError;
    }
  }),
  localizable: ['text', 'attachments'],
  toLocalizationFormData: (
    action: SendBroadcast,
    localization: Record<string, any>
  ) => {
    const formData: FormData = {
      uuid: action.uuid
    };

    if (localization.text && Array.isArray(localization.text)) {
      formData.text = localization.text[0] || '';
    } else {
      formData.text = '';
    }

    if (localization.attachments && Array.isArray(localization.attachments)) {
      formData.attachments = localization.attachments;
    } else {
      formData.attachments = [];
    }

    return formData;
  },
  fromLocalizationFormData: (formData: FormData, action: SendBroadcast) => {
    const localization: Record<string, any> = {};

    if (formData.text && formData.text.trim() !== '') {
      if (formData.text !== action.text) {
        localization.text = [formData.text];
      }
    }

    const attachments = (formData.attachments || []).filter(
      (att: string) => att && att.trim() !== ''
    );

    if (attachments.length > 0) {
      if (
        JSON.stringify(attachments) !== JSON.stringify(action.attachments || [])
      ) {
        localization.attachments = attachments;
      }
    }

    return localization;
  }
};
