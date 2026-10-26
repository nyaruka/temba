import { msg } from '@lit/localize';
import {
  getOperatorConfig,
  getWaitForResponseOperators,
  operatorsToSelectOptions
} from '../operators';
import { generateDefaultCategoryName } from '../../utils';
import { isSystemCategory } from '../categoryUtils';
import { FormData } from '../types';
import { zustand } from '../../store/AppState';

/**
 * Shared helper function to get operator value from various formats.
 * Handles string, object, and array formats that can come from the form system.
 */
export const getOperatorValue = (operator: any): string => {
  if (typeof operator === 'string') {
    return operator.trim();
  } else if (Array.isArray(operator) && operator.length > 0) {
    const firstOperator = operator[0];
    if (
      firstOperator &&
      typeof firstOperator === 'object' &&
      firstOperator.value
    ) {
      return firstOperator.value.trim();
    }
  } else if (operator && typeof operator === 'object' && operator.value) {
    return operator.value.trim();
  }
  return '';
};

/**
 * Shared isEmptyItem function for rules array.
 * Determines if a rule item is considered empty and should be filtered out.
 */
export const isEmptyRuleItem = (item: any): boolean => {
  // Check if operator and category are provided
  const operatorValue = getOperatorValue(item.operator);
  if (!operatorValue || !item.category || item.category.trim() === '') {
    return true;
  }

  // Check if value is required based on operator configuration
  const operatorConfig = getOperatorConfig(operatorValue);
  if (operatorConfig && operatorConfig.operands === 1) {
    return !item.value1 || item.value1.trim() === '';
  } else if (operatorConfig && operatorConfig.operands === 2) {
    return (
      !item.value1 ||
      item.value1.trim() === '' ||
      !item.value2 ||
      item.value2.trim() === ''
    );
  }

  return false;
};

/**
 * Shared onItemChange function for rules array.
 * Handles auto-updating category names based on operator and value changes.
 */
export const createRuleItemChangeHandler = () => {
  return (itemIndex: number, field: string, value: any, allItems: any[]) => {
    const updatedItems = [...allItems];
    const item = { ...updatedItems[itemIndex] };

    // Update the changed field
    item[field] = value;

    // Get operator values (before and after the change)
    const oldItem = allItems[itemIndex] || {};
    const oldOperatorValue =
      field === 'operator'
        ? getOperatorValue(oldItem.operator)
        : getOperatorValue(item.operator);
    const newOperatorValue = getOperatorValue(item.operator);

    // Calculate what the default category name should be before the change
    const oldDefaultCategory = generateDefaultCategoryName(
      oldOperatorValue,
      getOperatorConfig,
      field === 'value1' ? oldItem.value1 : item.value1,
      field === 'value2' ? oldItem.value2 : item.value2
    );

    // Calculate what the new default category name should be after the change
    const newDefaultCategory = generateDefaultCategoryName(
      newOperatorValue,
      getOperatorConfig,
      item.value1,
      item.value2
    );

    // Determine if we should auto-update the category
    const shouldUpdateCategory =
      !item.category ||
      item.category.trim() === '' ||
      item.category === oldDefaultCategory;

    // Auto-populate or update category if conditions are met
    if (shouldUpdateCategory && newDefaultCategory) {
      item.category = newDefaultCategory;
    }

    updatedItems[itemIndex] = item;
    return updatedItems;
  };
};

/**
 * Shared visibility condition for value1 field.
 */
export const value1VisibilityCondition = (formData: Record<string, any>) => {
  const operatorValue = getOperatorValue(formData.operator);
  const operatorConfig = getOperatorConfig(operatorValue);
  return operatorConfig ? operatorConfig.operands >= 1 : true;
};

/**
 * Shared visibility condition for value2 field.
 */
export const value2VisibilityCondition = (formData: Record<string, any>) => {
  const operatorValue = getOperatorValue(formData.operator);
  const operatorConfig = getOperatorConfig(operatorValue);
  return operatorConfig ? operatorConfig.operands === 2 : false;
};

/**
 * Returns a placeholder for value1 based on the selected operator.
 * Location operators use "State" as the first operand.
 */
const value1Placeholder = (formData: Record<string, any>): string => {
  const operatorValue = getOperatorValue(formData.operator);
  if (operatorValue === 'has_district' || operatorValue === 'has_ward') {
    return msg('State');
  }
  return '';
};

/**
 * Returns a placeholder for value2 based on the selected operator.
 * has_ward uses "District" as the second operand.
 */
const value2Placeholder = (formData: Record<string, any>): string => {
  const operatorValue = getOperatorValue(formData.operator);
  if (operatorValue === 'has_ward') {
    return msg('District');
  }
  return '';
};

/**
 * Shared item configuration for rules array.
 * This defines the operator, value1, value2, and category fields.
 */
export const createRulesItemConfig = () => ({
  operator: {
    type: 'select' as const,
    required: true,
    multi: false,
    options: [], // Will be set by the caller
    getDynamicOptions: () => {
      const features = zustand.getState().features;
      return operatorsToSelectOptions(getWaitForResponseOperators(features));
    },
    width: '220px'
  },
  value1: {
    type: 'text' as const,
    placeholder: value1Placeholder,
    evaluated: true,
    maxLength: 10000,
    conditions: {
      visible: value1VisibilityCondition
    }
  },
  value2: {
    type: 'text' as const,
    placeholder: value2Placeholder,
    evaluated: true,
    maxLength: 10000,
    conditions: {
      visible: value2VisibilityCondition
    }
  },
  category: {
    type: 'text' as const,
    placeholder: 'Category',
    required: true,
    maxLength: 36,
    maxWidth: '120px'
  }
});

/**
 * Shared function to extract rules from form data.
 * Filters and transforms form rules into the format expected by createRulesRouter.
 */
export const extractUserRules = (formData: FormData) => {
  return (formData.rules || [])
    .filter((rule: any) => {
      const operatorValue = getOperatorValue(rule?.operator);
      if (
        !operatorValue ||
        !rule?.category ||
        operatorValue === '' ||
        rule.category.trim() === ''
      ) {
        return false;
      }

      const operatorConfig = getOperatorConfig(operatorValue);
      if (operatorConfig && operatorConfig.operands === 1) {
        return rule?.value1 && rule.value1.trim() !== '';
      } else if (operatorConfig && operatorConfig.operands === 2) {
        return (
          rule?.value1 &&
          rule.value1.trim() !== '' &&
          rule?.value2 &&
          rule.value2.trim() !== ''
        );
      }

      return true;
    })
    .map((rule: any) => {
      const operatorValue = getOperatorValue(rule.operator);
      const operatorConfig = getOperatorConfig(operatorValue);
      const value1 = rule.value1 ? rule.value1.trim() : '';
      const value2 = rule.value2 ? rule.value2.trim() : '';

      let value = '';

      if (operatorConfig && operatorConfig.operands === 1) {
        value = value1;
      } else if (operatorConfig && operatorConfig.operands === 2) {
        value = '';
      } else {
        value = '';
      }

      return {
        operator: operatorValue,
        value: value,
        value1,
        value2,
        category: rule.category.trim(),
        ...(rule.case_uuid && { case_uuid: rule.case_uuid }),
        ...(rule.category_uuid && { category_uuid: rule.category_uuid })
      };
    });
};

/**
 * Shared function to transform router cases to form rules.
 * Converts node router cases back into the form data structure.
 */
export const casesToFormRules = (node: any) => {
  const rules = [];
  if (node.router?.cases && node.router?.categories) {
    node.router.cases.forEach((case_: any) => {
      // Find the category for this case
      const category = node.router!.categories.find(
        (cat: any) => cat.uuid === case_.category_uuid
      );

      // Skip system categories
      if (category && !isSystemCategory(category.name)) {
        // Handle different operator types
        const operatorConfig = getOperatorConfig(case_.type);
        const operatorDisplayName = operatorConfig
          ? operatorConfig.name
          : case_.type;
        let value1 = '';
        let value2 = '';

        if (operatorConfig && operatorConfig.operands === 0) {
          value1 = '';
          value2 = '';
        } else if (operatorConfig && operatorConfig.operands === 1) {
          value1 = case_.arguments.join(' ');
          value2 = '';
        } else if (operatorConfig && operatorConfig.operands === 2) {
          value1 = case_.arguments[0] || '';
          value2 = case_.arguments[1] || '';
        } else {
          value1 = case_.arguments.join(' ');
          value2 = '';
        }

        // keep the case and category UUIDs on the row so saving knows which rule it was,
        // rather than guessing from names and positions
        rules.push({
          operator: { value: case_.type, name: operatorDisplayName },
          value1: value1,
          value2: value2,
          category: category.name,
          case_uuid: case_.uuid,
          category_uuid: category.uuid
        });
      }
    });
  }
  return rules;
};

/**
 * Creates a complete rules array configuration for forms.
 * This is the shared configuration used by both wait_for_response and split_by_expression.
 *
 * @param operatorOptions - The operator options to use (from operatorsToSelectOptions)
 * @param helpText - The help text to display for the rules array
 * @returns A complete array field configuration object
 */
export const createRulesArrayConfig = (
  operatorOptions: any[],
  helpText: string = 'Define rules to categorize responses'
) => ({
  type: 'array' as const,
  helpText,
  itemLabel: 'Rule',
  minItems: 0,
  maxItems: 100,
  sortable: true,
  maintainEmptyItem: true,
  isEmptyItem: isEmptyRuleItem,
  onItemChange: createRuleItemChangeHandler(),
  createEmptyItem: (items: any[]) => {
    // Get current operator options dynamically (includes location operators if enabled)
    const features = zustand.getState().features;
    const currentOptions = operatorsToSelectOptions(
      getWaitForResponseOperators(features)
    );

    // Default to the last rule's non-location operator that has at least one operand,
    // falling back to the first non-location operator option
    const lastWithOperand = [...items].reverse().find((item) => {
      const opValue = getOperatorValue(item.operator);
      const config = opValue ? getOperatorConfig(opValue) : undefined;
      return config && config.operands >= 1 && config.filter !== 'locations';
    });

    const nonLocationOptions = currentOptions.filter((o: any) => {
      const config = getOperatorConfig(o.value);
      return !config || config.filter !== 'locations';
    });

    const opValue = lastWithOperand
      ? getOperatorValue(lastWithOperand.operator)
      : null;
    const option = opValue
      ? currentOptions.find((o: any) => o.value === opValue)
      : nonLocationOptions[0];

    return option ? { operator: [{ ...option }] } : {};
  },
  itemConfig: {
    ...createRulesItemConfig(),
    operator: {
      ...createRulesItemConfig().operator,
      options: operatorOptions
    }
  }
});
