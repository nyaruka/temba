import { msg } from '@lit/localize';
import { SPLIT_GROUPS, FormData, NodeConfig, FlowTypes } from '../types';
import { Node, Category, Exit, Case } from '../../store/flow-definition';
import { generateUUID, createRulesRouter } from '../../utils';
import {
  getWaitForResponseOperators,
  operatorsToSelectOptions,
  getOperatorConfig
} from '../operators';
import {
  resultNameField,
  localizeRulesField,
  localizeCategoriesField,
  nodeOptions
} from './shared';
import {
  createRulesArrayConfig,
  extractUserRules,
  casesToFormRules
} from './shared-rules';
import { validateWith } from '../utils';

const TIMEOUT_OPTIONS = [
  { value: '60', name: '1 minute' },
  { value: '120', name: '2 minutes' },
  { value: '180', name: '3 minutes' },
  { value: '240', name: '4 minutes' },
  { value: '300', name: '5 minutes' },
  { value: '600', name: '10 minutes' },
  { value: '900', name: '15 minutes' },
  { value: '1800', name: '30 minutes' },
  { value: '3600', name: '1 hour' },
  { value: '7200', name: '2 hours' },
  { value: '10800', name: '3 hours' },
  { value: '21600', name: '6 hours' },
  { value: '43200', name: '12 hours' },
  { value: '64800', name: '18 hours' },
  { value: '86400', name: '1 day' },
  { value: '172800', name: '2 days' },
  { value: '259200', name: '3 days' },
  { value: '604800', name: '1 week' }
];

// Helper function to create a wait_for_response router with user rules
// This is a thin wrapper around createRulesRouter that adds the No Response category for timeouts
const createWaitForResponseRouter = (
  userRules: any[],
  existingCategories: Category[] = [],
  existingExits: Exit[] = [],
  existingCases: Case[] = []
) => {
  const { router, exits } = createRulesRouter(
    '@input.text',
    userRules,
    getOperatorConfig,
    existingCategories,
    existingExits,
    existingCases
  );

  // Add "No Response" category last (if it exists in the original)
  const existingNoResponseCategory = existingCategories.find(
    (cat) => cat.name === 'No Response' || cat.name === 'Timeout'
  );

  if (existingNoResponseCategory) {
    const existingNoResponseExit = existingExits.find(
      (exit) => exit.uuid === existingNoResponseCategory.exit_uuid
    );

    if (existingNoResponseExit) {
      // the existing definition may have shared this category's UUID or exit with another
      // category, in which case it gets new ones
      const categoryUuid = router.categories.some(
        (cat) => cat.uuid === existingNoResponseCategory.uuid
      )
        ? generateUUID()
        : existingNoResponseCategory.uuid;
      const exitUuid = exits.some(
        (exit) => exit.uuid === existingNoResponseExit.uuid
      )
        ? generateUUID()
        : existingNoResponseExit.uuid;

      router.categories.push({
        ...existingNoResponseCategory,
        uuid: categoryUuid,
        exit_uuid: exitUuid
      });
      exits.push({
        uuid: exitUuid,
        destination_uuid: existingNoResponseExit.destination_uuid || null
      });
    }
  }

  return { router, exits };
};

export const wait_for_response: NodeConfig = {
  type: 'wait_for_response',
  name: 'Wait for Response',
  subtitle:
    "Sort the contact's reply into categories, with a timeout if they go quiet.",
  group: SPLIT_GROUPS.wait,
  flowTypes: [FlowTypes.MESSAGE],
  hideFromSplits: true,
  dialogSize: 'large',
  form: {
    rules: createRulesArrayConfig(
      operatorsToSelectOptions(getWaitForResponseOperators()),
      'If the message from the contact...'
    ),
    timeout_duration: {
      type: 'select',
      placeholder: '5 minutes',
      multi: false,
      options: TIMEOUT_OPTIONS
    },
    result_name: resultNameField,
    localizeRules: localizeRulesField,
    localizeCategories: localizeCategoriesField
  },
  layout: [
    'rules',
    {
      ...nodeOptions,
      sections: [
        ...nodeOptions.sections,
        {
          // timeout_enabled isn't a field, adding or removing this section toggles it
          label: 'Time Limit',
          sentence: () =>
            msg("If there's no reply after {duration} go to **No Response**", {
              desc: '{duration} is a dropdown of times, e.g. "5 minutes". Keep {duration} and the ** markers as they are.'
            }),
          tokens: { duration: 'timeout_duration' },
          localizable: false,
          items: ['timeout_duration'],
          hasValue: (formData: FormData) => !!formData.timeout_enabled,
          onAdd: () => ({ timeout_enabled: true }),
          onRemove: () => ({ timeout_enabled: false })
        }
      ]
    }
  ],
  validate: validateWith(() => {
    // No validation needed - allow multiple rules to use same category name.
    // Rules with the same category name will be merged to use the same exit.
  }),
  toFormData: (node: Node, nodeUI?: any) => {
    // Extract rules from router cases using shared function
    const rules = casesToFormRules(node);

    // Extract timeout configuration
    const timeoutSeconds = node.router?.wait?.timeout?.seconds;
    let timeoutOption = TIMEOUT_OPTIONS.find(
      (opt) => opt.value === String(timeoutSeconds)
    );

    if (!timeoutOption) {
      timeoutOption = { value: '300', name: '5 minutes' };
    }

    return {
      uuid: node.uuid,
      rules: rules,
      timeout_enabled: !!timeoutSeconds,
      timeout_duration: timeoutOption,
      result_name: node.router?.result_name || '',
      localizeRules: nodeUI?.config?.localizeRules || false,
      localizeCategories: nodeUI?.config?.localizeCategories || false
    };
  },
  toUIConfig: (formData: FormData) => {
    const config: Record<string, any> = {};
    config.localizeRules = !!formData.localizeRules;
    config.localizeCategories = formData.result_name
      ? !!formData.localizeCategories
      : false;
    return config;
  },
  fromFormData: (formData: FormData, originalNode: Node): Node => {
    // Get user rules using shared extraction function
    const userRules = extractUserRules(formData);

    // If no user rules, clear cases but preserve other router config
    if (userRules.length === 0) {
      // Get existing router data for preservation
      let existingCategories = originalNode.router?.categories || [];
      const existingExits = [...(originalNode.exits || [])]; // Create a copy to avoid extensibility issues

      // Handle timeout: ensure "No Response" category exists if timeout is enabled,
      // or remove it if timeout is disabled
      if (formData.timeout_enabled) {
        let noResponseCategory = existingCategories.find(
          (cat: any) => cat.name === 'No Response'
        );

        if (!noResponseCategory) {
          // Create new "No Response" category and exit
          const noResponseExitUuid = generateUUID();
          noResponseCategory = {
            uuid: generateUUID(),
            name: 'No Response',
            exit_uuid: noResponseExitUuid
          };

          // Add to existing categories for processing
          existingCategories = [...existingCategories, noResponseCategory];

          // Add corresponding exit if it doesn't exist
          if (!existingExits.find((exit) => exit.uuid === noResponseExitUuid)) {
            existingExits.push({
              uuid: noResponseExitUuid,
              destination_uuid: null
            });
          }
        }
      } else {
        // If timeout is disabled, remove "No Response" category from existing categories
        existingCategories = existingCategories.filter(
          (cat: any) => cat.name !== 'No Response'
        );
      }

      // Create router with "All Responses" as default category
      // This will now properly handle the "No Response" category if it exists
      const { router: noRulesRouter, exits: noRulesExits } =
        createWaitForResponseRouter(
          [], // No user rules
          existingCategories,
          existingExits,
          [] // No cases
        );

      const router: any = {
        ...noRulesRouter,
        cases: [] // Clear all cases when no rules
      };

      // Only set result_name if provided
      if (formData.result_name && formData.result_name.trim() !== '') {
        router.result_name = formData.result_name.trim();
      }

      // Build wait configuration based on form data
      const waitConfig: any = {
        type: 'msg'
      };

      // Add timeout if enabled
      if (formData.timeout_enabled) {
        // Extract timeout value (handle both string and object formats)
        let timeoutSeconds;

        if (formData.timeout_duration) {
          if (
            Array.isArray(formData.timeout_duration) &&
            formData.timeout_duration.length > 0
          ) {
            // Handle array of selected options (multi-select behavior)
            timeoutSeconds = parseInt(formData.timeout_duration[0].value, 10);
          } else if (typeof formData.timeout_duration === 'string') {
            timeoutSeconds = parseInt(formData.timeout_duration, 10);
          } else if (
            formData.timeout_duration &&
            typeof formData.timeout_duration === 'object' &&
            formData.timeout_duration.value
          ) {
            timeoutSeconds = parseInt(formData.timeout_duration.value, 10);
          } else {
            timeoutSeconds = 300; // Default to 5 minutes
          }
        } else {
          // No duration selected, use default
          timeoutSeconds = 300; // Default to 5 minutes
        }

        // Validate that we got a valid number
        if (isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
          timeoutSeconds = 300; // Default to 5 minutes
        }

        // Find the "No Response" category (should exist now)
        const noResponseCategory = router.categories.find(
          (cat: any) => cat.name === 'No Response'
        );

        if (noResponseCategory) {
          waitConfig.timeout = {
            seconds: timeoutSeconds,
            category_uuid: noResponseCategory.uuid
          };
        }
      }

      router.wait = waitConfig;

      return {
        ...originalNode,
        router,
        exits: noRulesExits
      };
    }

    // Get existing router data for preservation
    const existingCategories = originalNode.router?.categories || [];
    const existingExits = originalNode.exits || [];
    const existingCases = originalNode.router?.cases || [];

    // Create router and exits using existing data when possible
    const { router, exits } = createWaitForResponseRouter(
      userRules,
      existingCategories,
      existingExits,
      existingCases
    );

    // Build final router with wait configuration and result_name
    const finalRouter: any = {
      ...router
    };

    // Only set result_name if provided
    if (formData.result_name && formData.result_name.trim() !== '') {
      finalRouter.result_name = formData.result_name.trim();
    }

    // Build wait configuration based on form data
    const waitConfig: any = {
      type: 'msg'
    };

    try {
      // Handle timeout configuration
      if (formData.timeout_enabled) {
        // Extract timeout value (handle both string and object formats)
        let timeoutSeconds;

        if (formData.timeout_duration) {
          try {
            timeoutSeconds = parseInt(formData.timeout_duration[0].value, 10);
          } catch (e) {
            timeoutSeconds = 300; // Default to 5 minutes
          }
        }

        // Find or create the "No Response" category
        const existingNoResponseCategory =
          originalNode.router?.categories?.find(
            (cat: any) => cat.name === 'No Response'
          );

        // the router may have already added it, possibly with new UUIDs
        const noResponseCategory = router.categories?.find(
          (cat: any) => cat.name === 'No Response'
        ) ||
          existingNoResponseCategory || {
            uuid: generateUUID(),
            name: 'No Response',
            exit_uuid: generateUUID()
          };

        waitConfig.timeout = {
          seconds: timeoutSeconds,
          category_uuid: noResponseCategory.uuid
        };

        // Ensure No Response category and exit exist
        if (
          !router.categories?.some((cat: any) => cat.name === 'No Response')
        ) {
          router.categories = router.categories || [];
          router.categories.push(noResponseCategory);

          // Add corresponding exit if it doesn't exist
          if (
            !exits.some(
              (exit: any) => exit.uuid === noResponseCategory.exit_uuid
            )
          ) {
            const noResponseExit = {
              uuid: noResponseCategory.exit_uuid,
              destination_uuid: existingNoResponseCategory?.exit_uuid
                ? originalNode.exits?.find(
                    (exit) => exit.uuid === existingNoResponseCategory.exit_uuid
                  )?.destination_uuid || null
                : null
            };
            exits.push(noResponseExit);
          }
        }
      } else {
        // Remove "No Response" category if timeout is disabled
        if (router.categories) {
          const noResponseCategoryIndex = router.categories.findIndex(
            (cat: any) => cat.name === 'No Response'
          );
          if (noResponseCategoryIndex !== -1) {
            const noResponseCategory =
              router.categories[noResponseCategoryIndex];

            // Remove the category
            router.categories.splice(noResponseCategoryIndex, 1);

            // Remove corresponding exit
            const exitIndex = exits.findIndex(
              (exit: any) => exit.uuid === noResponseCategory.exit_uuid
            );
            if (exitIndex !== -1) {
              exits.splice(exitIndex, 1);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error processing timeout configuration:', error);
      // Continue without timeout in case of error
    }

    finalRouter.wait = waitConfig;
    return {
      ...originalNode,
      router: finalRouter,
      exits: exits
    };
  },

  // Localization support for categories
  localizable: 'categories',
  nonTranslatableCategories: ['Timeout']
};
