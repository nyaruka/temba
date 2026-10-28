import { html } from 'lit-html';
import {
  ActionConfig,
  ACTION_GROUPS,
  FormData,
  ValidationResult,
  FlowTypes
} from '../types';
import { Node, AddContactUrn } from '../../store/flow-definition';
import { SCHEMES, renderClamped, renderHighlightedText } from '../utils';

export const add_contact_urn: ActionConfig = {
  name: 'Add URN',
  subtitle: 'Save another phone number, handle or address for the contact.',
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: AddContactUrn) => {
    const schemeObj = SCHEMES.find((s) => s.scheme === action.scheme);
    const friendlyScheme = schemeObj?.path || action.scheme;
    return renderClamped(
      html`Add ${friendlyScheme} ${renderHighlightedText(action.path, true)}`,
      `Add ${friendlyScheme} ${action.path}`
    );
  },

  toFormData: (action: AddContactUrn) => {
    const schemeObj = SCHEMES.find((s) => s.scheme === action.scheme);
    return {
      uuid: action.uuid,
      scheme: schemeObj
        ? [{ name: schemeObj.path, value: action.scheme }]
        : null,
      path: action.path || ''
    };
  },

  fromFormData: (formData: FormData): AddContactUrn => {
    // Extract scheme value from select format
    const schemeValue =
      Array.isArray(formData.scheme) && formData.scheme.length > 0
        ? formData.scheme[0].value
        : 'tel';

    return {
      uuid: formData.uuid,
      type: 'add_contact_urn',
      scheme: schemeValue,
      path: formData.path || ''
    };
  },

  form: {
    scheme: {
      type: 'select',
      label: 'URN Type',
      required: true,
      searchable: false,
      multi: false,
      options: SCHEMES.map((scheme) => ({
        name: scheme.path,
        value: scheme.scheme
      }))
    },
    path: {
      type: 'text',
      label: 'URN Value',
      helpText: 'e.g. a phone number or Facebook ID',
      required: true,
      maxLength: 1000,
      evaluated: true
    }
  },

  validate: (formData: FormData): ValidationResult => {
    const errors: { [key: string]: string } = {};

    if (!formData.scheme || formData.scheme.length === 0) {
      errors.scheme = 'URN type is required';
    }

    if (!formData.path || formData.path.trim() === '') {
      errors.path = 'URN value is required';
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  }
};
