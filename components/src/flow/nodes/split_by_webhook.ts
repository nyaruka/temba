import { msg } from '@lit/localize';
import { ACTION_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { CallWebhook, Node } from '../../store/flow-definition';
import { generateUUID, createSuccessFailureRouter } from '../../utils';
import { html } from 'lit';
import { resultNameField, resultNameSection } from './shared';
import { renderClamped, renderHighlightedText } from '../utils';

// Default headers as {key, value} arrays (format used by key-value editor)
const defaultGetHeaders = [{ key: 'Accept', value: 'application/json' }];

const defaultPostHeaders = [
  { key: 'Accept', value: 'application/json' },
  { key: 'Content-Type', value: 'application/json' }
];

function headersMatchDefaults(headers: any[]): boolean {
  if (!headers || headers.length === 0) return true;
  const filtered = headers.filter(
    (h: any) => (h.key || h.name || '') !== '' || (h.value || '') !== ''
  );
  if (filtered.length === 0) return true;
  for (const defaults of [defaultGetHeaders, defaultPostHeaders]) {
    if (
      filtered.length === defaults.length &&
      filtered.every(
        (h: any, i: number) =>
          (h.key || h.name) === defaults[i].key && h.value === defaults[i].value
      )
    ) {
      return true;
    }
  }
  return false;
}

function getDefaultHeaders(method: string): { key: string; value: string }[] {
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    return defaultPostHeaders.map((h) => ({ ...h }));
  }
  return defaultGetHeaders.map((h) => ({ ...h }));
}

// the selected method, whether the select's value is an option or a plain string
function getMethod(values: Record<string, any>): string {
  return Array.isArray(values.method) && values.method.length > 0
    ? values.method[0].value || values.method[0].name
    : values.method;
}

// Default headers as Record format (for toFormData, before processFormDataForEditing converts them)
function getDefaultHeadersRecord(method: string): Record<string, string> {
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    return { Accept: 'application/json', 'Content-Type': 'application/json' };
  }
  return { Accept: 'application/json' };
}

const defaultPost = `@(json(object(
  "contact", object(
    "uuid", contact.uuid, 
    "name", contact.name, 
    "urn", contact.urn
  ),
  "flow", object(
    "uuid", run.flow.uuid, 
    "name", run.flow.name
  ),
  "results", foreach_value(results, extract_object, "value", "category")
)))`;

export const split_by_webhook: NodeConfig = {
  type: 'split_by_webhook',
  name: 'Call Webhook',
  subtitle:
    'Send or fetch data from your own systems, then branch on the response.',
  group: ACTION_GROUPS.services,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  showAsAction: true,
  form: {
    method: {
      type: 'select',
      required: true,
      options: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'],
      maxWidth: '120px',
      searchable: false
    },
    url: {
      type: 'text',
      required: true,
      evaluated: true,
      maxLength: 8192,
      placeholder: 'https://example.com/webhook'
    },
    headers: {
      type: 'key-value',
      sortable: true,
      keyPlaceholder: 'Header name',
      valuePlaceholder: 'Header value',
      maxItems: 100,
      keyMaxLength: 100,
      valueMaxLength: 8192,
      minRows: 0,
      dependsOn: ['method'],
      computeValue: (
        values: Record<string, any>,
        currentValue: any,
        _originalValues?: Record<string, any>
      ) => {
        const method = getMethod(values);

        if (headersMatchDefaults(currentValue)) {
          return getDefaultHeaders(method);
        }
        return currentValue;
      }
    },
    result_name: resultNameField,
    body: {
      type: 'textarea',
      evaluated: true,
      maxLength: 20000,
      placeholder: 'Request body content (JSON, XML, etc.)',
      minHeight: 200,
      dependsOn: ['method'],
      computeValue: (
        values: Record<string, any>,
        currentValue: any,
        originalValues?: Record<string, any>
      ) => {
        const method = getMethod(values);

        if (method === 'POST') {
          // For POST, provide the template if body is empty or was never set by user
          if (!currentValue || currentValue.trim() === '') {
            return defaultPost;
          }
        } else {
          // For non-POST methods, clear the body if it was auto-generated or empty
          // Check if the original body was empty (user never specified a body)
          const originalBody = originalValues?.body || '';
          const isOriginallyEmpty = !originalBody || originalBody.trim() === '';

          // Clear if: originally empty, contains default template, or is currently empty
          if (
            isOriginallyEmpty ||
            !currentValue ||
            currentValue.trim() === '' ||
            currentValue.trim() === defaultPost.trim()
          ) {
            return '';
          }
        }

        return currentValue; // Keep existing value if user has customized it
      }
    }
  },
  layout: [
    { type: 'row', items: ['method', 'url'] },
    {
      type: 'extras',
      sections: [
        {
          label: 'Headers',
          hasValue: (formData: FormData) =>
            !headersMatchDefaults(formData.headers),
          onRemove: (formData: FormData) => ({
            headers: getDefaultHeaders(getMethod(formData))
          }),
          items: ['headers']
        },
        {
          label: 'Body',
          hasValue: (formData: FormData) =>
            !!(
              formData.body &&
              formData.body.trim() !== '' &&
              formData.body !== defaultPost
            ),
          onRemove: (formData: FormData) => ({
            body: getMethod(formData) === 'POST' ? defaultPost : ''
          }),
          items: ['body']
        },
        resultNameSection
      ]
    }
  ],
  render: (node: Node) => {
    const callWebhookAction = node.actions?.find(
      (action) => action.type === 'call_webhook'
    ) as CallWebhook;
    const url = callWebhookAction?.url || msg('Configure webhook');
    return html` <div class="body">
      ${renderClamped(renderHighlightedText(url, true), url)}
    </div>`;
  },
  toFormData: (node: Node) => {
    // Extract data from the existing node structure
    const callWebhookAction = node.actions?.find(
      (action) => action.type === 'call_webhook'
    ) as any;

    return {
      uuid: node.uuid,
      method: callWebhookAction?.method || 'GET',
      url: callWebhookAction?.url || '',
      headers:
        callWebhookAction?.headers ||
        getDefaultHeadersRecord(callWebhookAction?.method || 'GET'),
      body: callWebhookAction?.body || '',
      // Legacy webhooks store result_name on the action; modern ones store it
      // on the router. Prefer the action so legacy nodes round-trip correctly.
      result_name:
        callWebhookAction?.result_name || node.router?.result_name || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Get method selection
    const methodSelection =
      Array.isArray(formData.method) && formData.method.length > 0
        ? formData.method[0]
        : { value: 'GET', name: 'GET' };

    // Find existing call_webhook action to preserve its UUID
    const existingCallWebhookAction = originalNode.actions?.find(
      (action) => action.type === 'call_webhook'
    ) as CallWebhook | undefined;
    const callWebhookUuid = existingCallWebhookAction?.uuid || generateUUID();

    // Legacy webhooks keep the result_name on the action rather than the
    // router. Detect them by the presence of result_name on the existing
    // action so they continue to round-trip in their original format instead
    // of being silently migrated (which would change how results are
    // referenced downstream of the flow).
    const isLegacyResultName = !!existingCallWebhookAction?.result_name;
    const trimmedResultName = formData.result_name?.trim() || '';

    // Create call_webhook action
    const callWebhookAction: CallWebhook = {
      type: 'call_webhook',
      uuid: callWebhookUuid,
      method: methodSelection.value,
      url: formData.url || '',
      headers: formData.headers || [],
      body: formData.body || ''
    };

    // Preserve the legacy placement: result_name stays on the action.
    if (isLegacyResultName && trimmedResultName !== '') {
      callWebhookAction.result_name = trimmedResultName;
    }

    // Create categories and exits for Success and Failure
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

    // Modern webhooks store result_name on the router. For legacy webhooks the
    // result_name lives on the action (set above), so we leave it off the
    // router to avoid storing it in both places.
    if (!isLegacyResultName && trimmedResultName !== '') {
      finalRouter.result_name = trimmedResultName;
    }

    // Return the complete node
    return {
      uuid: originalNode.uuid,
      actions: [callWebhookAction],
      router: finalRouter,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: 'all'
};
