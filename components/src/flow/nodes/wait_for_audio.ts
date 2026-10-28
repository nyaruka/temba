import { SPLIT_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node, Category, Exit } from '../../store/flow-definition';
import { generateUUID } from '../../utils';

export const wait_for_audio: NodeConfig = {
  type: 'wait_for_audio',
  name: 'Make Recording',
  subtitle: "Capture the caller's voice, like a voicemail or a spoken answer.",
  group: SPLIT_GROUPS.wait,
  flowTypes: [FlowTypes.VOICE],
  form: {
    result_name: {
      type: 'text',
      label: 'Result Name',
      required: false,
      maxLength: 64,
      placeholder: '(optional)',
      helpText: 'Used to reference this result elsewhere in the flow.'
    }
  },
  layout: ['result_name'],
  toFormData: (node: Node) => {
    return {
      uuid: node.uuid,
      result_name: node.router?.result_name || ''
    };
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Preserve or create "All Responses" category
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];

    let allResponsesCategory = existingCategories.find(
      (cat: Category) => cat.name === 'All Responses'
    );

    let allResponsesExit: Exit;

    if (allResponsesCategory) {
      allResponsesExit = existingExits.find(
        (exit: Exit) => exit.uuid === allResponsesCategory!.exit_uuid
      ) || {
        uuid: allResponsesCategory.exit_uuid,
        destination_uuid: null
      };
    } else {
      const exitUuid = generateUUID();
      allResponsesCategory = {
        uuid: generateUUID(),
        name: 'All Responses',
        exit_uuid: exitUuid
      };
      allResponsesExit = {
        uuid: exitUuid,
        destination_uuid: null
      };
    }

    const router: any = {
      type: 'switch',
      operand: '@input',
      default_category_uuid: allResponsesCategory.uuid,
      cases: [],
      categories: [allResponsesCategory],
      wait: {
        type: 'msg',
        hint: {
          type: 'audio'
        }
      }
    };

    if (formData.result_name && formData.result_name.trim() !== '') {
      router.result_name = formData.result_name.trim();
    }

    return {
      ...originalNode,
      router,
      exits: [allResponsesExit]
    };
  },
  localizable: 'categories',
  nonTranslatableCategories: 'all'
};
