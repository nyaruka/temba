import { msg, str } from '@lit/localize';
import { html } from 'lit-html';
import {
  ActionConfig,
  ACTION_GROUPS,
  FormData,
  ValidationResult,
  FlowTypes
} from '../types';
import { Node, SetContactLanguage } from '../../store/flow-definition';
import { getStore } from '../../store/Store';
import { renderClamped } from '../utils';
import { getLanguageLabel, getLanguageName } from '../../languages';

export const set_contact_language: ActionConfig = {
  get name() {
    return msg('Update Language');
  },
  get subtitle() {
    return msg(
      'Later messages and flows will use translations in this language.'
    );
  },
  group: ACTION_GROUPS.contacts,
  flowTypes: [FlowTypes.VOICE, FlowTypes.MESSAGE, FlowTypes.BACKGROUND],
  render: (_node: Node, action: SetContactLanguage) => {
    const name = getLanguageName(action.language);
    return renderClamped(
      msg(html`Set to <strong>${name}</strong>`),
      msg(str`Set to ${name}`)
    );
  },
  form: {
    language: {
      type: 'select',
      get label() {
        return msg('Language');
      },
      required: true,
      searchable: true,
      clearable: false,
      valueKey: 'value',
      nameKey: 'name',
      getDynamicOptions: () => {
        const store = getStore();
        const workspace = store?.getState().workspace;
        if (workspace?.languages && Array.isArray(workspace.languages)) {
          return workspace.languages.map((languageCode: string) => ({
            value: languageCode,
            name: getLanguageLabel(languageCode)
          }));
        }
        return [];
      }
    }
  },
  toFormData: (action: SetContactLanguage) => {
    // Convert the language code back to the option object format expected by the form
    if (action.language) {
      return {
        language: [
          {
            value: action.language,
            name: getLanguageLabel(action.language)
          }
        ],
        uuid: action.uuid
      };
    }
    return {
      language: null,
      uuid: action.uuid
    };
  },
  fromFormData: (formData: FormData): SetContactLanguage => {
    return {
      uuid: formData.uuid,
      type: 'set_contact_language',
      language: formData.language[0].value
    };
  },

  validate: (formData: FormData): ValidationResult => {
    const errors: { [key: string]: string } = {};

    if (!formData.language) {
      errors.language = msg('Language is required');
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors
    };
  }
};
