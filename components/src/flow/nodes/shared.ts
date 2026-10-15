import { msg, str } from '@lit/localize';
import {
  FormData,
  TextFieldConfig,
  ExtrasLayoutConfig,
  ExtrasSection,
  CheckboxFieldConfig
} from '../types';
import { Node, Category, Exit, Case } from '../../store/flow-definition';
import { getOperatorConfig } from '../operators';
import { generateUUID } from '../../utils';
import { categoryNamesEqual, findCategoryByName } from '../categoryUtils';
import { zustand } from '../../store/AppState';

/**
 * Shared result_name field configuration for router nodes.
 * This provides a consistent "Save as..." optional field interface across all splits.
 *
 * The field is hidden by default and revealed via a "Save as..." link.
 * Once revealed, it cannot be hidden again (the link disappears).
 * If the field already has a value, it's shown immediately without the link.
 */
export const resultNameField: TextFieldConfig = {
  type: 'text',
  required: false,
  maxLength: 64,
  placeholder: '(optional)',
  helpText: 'The name to use to reference this result in the flow'
};

/**
 * Shared localization requirement fields for router nodes.
 * These provide the checkboxes in the optional Translations sentence,
 * so their labels are single words that read as part of it.
 */
export const localizeRulesField: CheckboxFieldConfig = {
  type: 'checkbox',
  label: () =>
    msg('rules', {
      desc: 'A checkbox in "Each language must translate its {rules} {categories}"'
    }),
  helpText: () => msg('Each language must specify its own rules for this node')
};

export const localizeCategoriesField: CheckboxFieldConfig = {
  type: 'checkbox',
  label: () =>
    msg('categories', {
      desc: 'A checkbox in "Each language must translate its {rules} {categories}"'
    }),
  helpText: (formData: FormData) => {
    const name = formData.result_name?.trim();
    if (name) {
      const key = name.toLowerCase().replace(/\s+/g, '_');
      return msg(
        str`Only enable if you plan to use @results.${key}.category_localized`
      );
    }
    return msg(
      'Only enable if you plan to use category_localized in your expressions for this result'
    );
  },
  conditions: {
    visible: (formData: FormData) => !!formData.result_name
  }
};

/**
 * A result name not yet used in the flow: Result, Result 2, Result 3, ...
 */
export const getDefaultResultName = (): string => {
  const results = zustand.getState().flowInfo?.results || [];
  const used = new Set(results.map((result) => result.name));
  let candidate = 'Result';
  let number = 2;
  while (used.has(candidate)) {
    candidate = `Result ${number}`;
    number++;
  }
  return candidate;
};

export const resultNameSection: ExtrasSection = {
  label: 'Save Result',
  localizable: false,
  items: ['result_name'],
  onAdd: () => ({ result_name: getDefaultResultName() }),
  sentence: () =>
    msg('Save the result as {name}', {
      desc: '{name} is a text box for the result name. Keep {name} as it is.'
    }),
  tokens: { name: 'result_name' }
};

const advancedSection: ExtrasSection = {
  label: 'Translations',
  localizable: false,
  items: ['localizeRules', 'localizeCategories'],
  sentence: () =>
    msg('Each language must translate its {rules} {categories}', {
      desc: '{rules} and {categories} are checkboxes labeled "rules" and "categories". Keep them as they are.'
    }),
  tokens: { rules: 'localizeRules', categories: 'localizeCategories' }
};

const categoriesLocalizationSection: ExtrasSection = {
  label: 'Translations',
  localizable: false,
  items: ['localizeCategories'],
  sentence: () =>
    msg('Each language must translate its {categories}', {
      desc: '{categories} is a checkbox labeled "categories". Keep it as it is.'
    }),
  tokens: { categories: 'localizeCategories' }
};

export const nodeOptions: ExtrasLayoutConfig = {
  type: 'extras',
  sections: [resultNameSection, advancedSection]
};

export const nodeOptionsSimple: ExtrasLayoutConfig = {
  type: 'extras',
  sections: [resultNameSection]
};

export const nodeOptionsCategoriesOnly: ExtrasLayoutConfig = {
  type: 'extras',
  sections: [resultNameSection, categoriesLocalizationSection]
};

/**
 * Shared category localization functions for router nodes.
 * These provide a consistent way to localize category names across all router types.
 */

/**
 * Converts a node's categories to localization form data.
 * @param node - The node containing categories to localize
 * @param localization - The existing localization data for this language
 * @returns Form data with category UUIDs mapped to original and localized names
 */
export function categoriesToLocalizationFormData(
  node: Node,
  localization: Record<string, any>
): FormData {
  const categories = node.router?.categories || [];
  const localizationData: Record<string, any> = {};

  categories.forEach((category: any) => {
    const categoryUuid = category.uuid;
    const categoryLocalization = localization[categoryUuid];

    localizationData[categoryUuid] = {
      originalName: category.name,
      localizedName:
        categoryLocalization && categoryLocalization.name
          ? Array.isArray(categoryLocalization.name)
            ? categoryLocalization.name[0] || ''
            : categoryLocalization.name
          : ''
    };
  });

  // Also include rule (case) argument localizations
  const cases = node.router?.cases || [];
  const rulesData: Record<string, any> = {};

  cases.forEach((c: any) => {
    if (!c.arguments?.length || !c.arguments.some((a: string) => a)) return;

    const caseLocalization = localization[c.uuid];
    const operatorName = getOperatorConfig(c.type)?.name || c.type;
    rulesData[c.uuid] = {
      operatorName,
      originalArguments: [...c.arguments],
      localizedArguments: caseLocalization?.arguments
        ? [...caseLocalization.arguments]
        : c.arguments.map(() => '')
    };
  });

  return {
    categories: localizationData,
    rules: rulesData
  };
}

/**
 * Converts localization form data back to the localization structure.
 * @param formData - The form data containing category localizations
 * @param _node - The original node (reserved for future validation)
 * @returns Record mapping category UUIDs to their localization data
 */
export function localizationFormDataToCategories(
  formData: FormData,
  _node: Node
): Record<string, any> {
  const localizationData: Record<string, any> = {};

  if (formData.categories) {
    Object.keys(formData.categories).forEach((categoryUuid) => {
      const categoryData = formData.categories[categoryUuid];
      const localizedName = categoryData.localizedName?.trim() || '';
      const originalName = categoryData.originalName?.trim() || '';

      // Only save if localized name is different from original and not empty
      if (localizedName && localizedName !== originalName) {
        localizationData[categoryUuid] = {
          name: [localizedName]
        };
      }
    });
  }

  // Also process rule localizations
  if (formData.rules) {
    Object.keys(formData.rules).forEach((caseUuid) => {
      const ruleData = formData.rules[caseUuid];
      const localized = ruleData.localizedArguments || [];
      const original = ruleData.originalArguments || [];

      // Save if any argument differs from original and is non-empty
      const hasLocalization = localized.some(
        (arg: string, i: number) =>
          arg?.trim() && arg.trim() !== (original[i] || '')
      );

      if (hasLocalization) {
        localizationData[caseUuid] = {
          arguments: localized.map((a: string) => a?.trim() || '')
        };
      }
    });
  }

  return localizationData;
}

/**
 * Describes a category to build for a router node. When `case` is provided,
 * a matching switch-router case is also built and linked to the category.
 */
export interface CategoryEntry {
  name: string;
  case?: {
    type: string;
    arguments: string[];
  };
}

/**
 * Builds categories, exits, and (optionally) cases for a router node,
 * preserving UUIDs and exit destinations from existing data when possible.
 * Categories/exits are matched by category name; cases by their first argument.
 */
export function buildCategoriesExitsCases(
  entries: CategoryEntry[],
  existingCategories: Category[],
  existingExits: Exit[],
  existingCases: Case[] = []
): { categories: Category[]; exits: Exit[]; cases: Case[] } {
  const categories: Category[] = [];
  const exits: Exit[] = [];
  const cases: Case[] = [];

  entries.forEach((entry) => {
    const existingCategory = findCategoryByName(existingCategories, entry.name);
    const existingExit = existingCategory
      ? existingExits.find((exit) => exit.uuid === existingCategory.exit_uuid)
      : null;

    const exitUuid = existingExit?.uuid || generateUUID();
    const categoryUuid = existingCategory?.uuid || generateUUID();

    categories.push({
      uuid: categoryUuid,
      name: entry.name,
      exit_uuid: exitUuid
    });

    exits.push({
      uuid: exitUuid,
      destination_uuid: existingExit?.destination_uuid || null
    });

    if (entry.case) {
      const matchArg = entry.case.arguments[0];
      const existingCase = existingCases.find(
        (c) => c.arguments?.[0] === matchArg
      );
      cases.push({
        uuid: existingCase?.uuid || generateUUID(),
        type: entry.case.type,
        arguments: entry.case.arguments,
        category_uuid: categoryUuid
      });
    }
  });

  return { categories, exits, cases };
}

/**
 * Appends a default "Other" category and its exit to the given arrays,
 * preserving the UUID/destination of an existing "Other" unless the user
 * selected an item also named "Other" (in which case the existing one was
 * already consumed by buildCategoriesExitsCases). Returns the Other category
 * UUID for use as `default_category_uuid`.
 */
export function appendOtherCategory(
  categories: Category[],
  exits: Exit[],
  existingCategories: Category[],
  existingExits: Exit[],
  userItemNames: string[]
): string {
  const userHasOther = userItemNames.some((name) =>
    categoryNamesEqual(name, 'Other')
  );
  const existingOther = userHasOther
    ? null
    : findCategoryByName(existingCategories, 'Other');
  const existingOtherExit = existingOther
    ? existingExits.find((exit) => exit.uuid === existingOther.exit_uuid)
    : null;

  const otherExitUuid = existingOtherExit?.uuid || generateUUID();
  const otherCategoryUuid = existingOther?.uuid || generateUUID();

  categories.push({
    uuid: otherCategoryUuid,
    name: 'Other',
    exit_uuid: otherExitUuid
  });

  exits.push({
    uuid: otherExitUuid,
    destination_uuid: existingOtherExit?.destination_uuid || null
  });

  return otherCategoryUuid;
}
