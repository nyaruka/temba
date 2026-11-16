// Flow router operator configurations
// These define the available operators for rule-based routing in flow nodes
import { msg } from '@lit/localize';

export interface OperatorConfig {
  type: string;
  name: string;
  operands: number; // Number of operands required (0 = no input needed, 1 = single value, 2 = two values)
  categoryName?: string; // Default category name when operands is 0
  visibility?: 'hidden' | 'visible'; // Whether to show in UI
  filter?: string; // Feature filter requirement
}

// All available operators for flow routing
export const OPERATORS: OperatorConfig[] = [
  // Text operators
  {
    type: 'has_any_word',
    get name() {
      return msg('has any of the words');
    },
    operands: 1
  },
  {
    type: 'has_all_words',
    get name() {
      return msg('has all of the words');
    },
    operands: 1
  },
  {
    type: 'has_phrase',
    get name() {
      return msg('has the phrase');
    },
    operands: 1
  },
  {
    type: 'has_only_phrase',
    get name() {
      return msg('has only the phrase');
    },
    operands: 1
  },
  {
    type: 'has_beginning',
    get name() {
      return msg('starts with');
    },
    operands: 1
  },
  {
    type: 'has_text',
    get name() {
      return msg('has some text');
    },
    operands: 0,
    categoryName: 'Has Text'
  },

  // Number operators
  {
    type: 'has_number',
    get name() {
      return msg('has a number');
    },
    operands: 0,
    categoryName: 'Has Number'
  },
  {
    type: 'has_number_between',
    get name() {
      return msg('has a number between');
    },
    operands: 2
  },
  {
    type: 'has_number_lt',
    get name() {
      return msg('has a number below');
    },
    operands: 1
  },
  {
    type: 'has_number_lte',
    get name() {
      return msg('has a number at or below');
    },
    operands: 1
  },
  {
    type: 'has_number_eq',
    get name() {
      return msg('has a number equal to');
    },
    operands: 1
  },
  {
    type: 'has_number_gte',
    get name() {
      return msg('has a number at or above');
    },
    operands: 1
  },
  {
    type: 'has_number_gt',
    get name() {
      return msg('has a number above');
    },
    operands: 1
  },

  // Date operators
  {
    type: 'has_date',
    get name() {
      return msg('has a date');
    },
    operands: 0,
    categoryName: 'Has Date'
  },
  {
    type: 'has_date_lt',
    get name() {
      return msg('has a date before');
    },
    operands: 1
  },
  {
    type: 'has_date_eq',
    get name() {
      return msg('has a date equal to');
    },
    operands: 1
  },
  {
    type: 'has_date_gt',
    get name() {
      return msg('has a date after');
    },
    operands: 1
  },
  {
    type: 'has_time',
    get name() {
      return msg('has a time');
    },
    operands: 0,
    categoryName: 'Has Time'
  },

  // Contact data operators
  {
    type: 'has_phone',
    get name() {
      return msg('has a phone number');
    },
    operands: 0,
    categoryName: 'Has Phone'
  },
  {
    type: 'has_email',
    get name() {
      return msg('has an email');
    },
    operands: 0,
    categoryName: 'Has Email'
  },

  // Location operators (require location feature)
  {
    type: 'has_state',
    get name() {
      return msg('has state');
    },
    operands: 0,
    categoryName: 'Has State',
    filter: 'locations'
  },
  {
    type: 'has_district',
    get name() {
      return msg('has district');
    },
    operands: 1,
    categoryName: 'Has District',
    filter: 'locations'
  },
  {
    type: 'has_ward',
    get name() {
      return msg('has ward');
    },
    operands: 2,
    categoryName: 'Has Ward',
    filter: 'locations'
  },

  // Hidden/system operators
  {
    type: 'has_group',
    get name() {
      return msg('is in the group');
    },
    operands: 1,
    visibility: 'hidden'
  },
  {
    type: 'has_category',
    get name() {
      return msg('has the category');
    },
    operands: 0,
    visibility: 'hidden'
  },
  {
    type: 'has_error',
    get name() {
      return msg('has an error');
    },
    operands: 0,
    categoryName: 'Has Error',
    visibility: 'hidden'
  },
  {
    type: 'has_value',
    get name() {
      return msg('is not empty');
    },
    operands: 0,
    categoryName: 'Not Empty',
    visibility: 'hidden'
  },
  {
    type: 'has_pattern',
    get name() {
      return msg('matches regex');
    },
    operands: 1
  }
];

// Get operators suitable for wait_for_response rules
// When features are provided, includes operators whose filter matches an enabled feature
export const getWaitForResponseOperators = (
  features?: string[]
): OperatorConfig[] => {
  return OPERATORS.filter((op) => {
    if (op.visibility === 'hidden') return false;
    if (op.filter) {
      return features ? features.includes(op.filter) : false;
    }
    return true;
  });
};

// Number operator types used for digit-based routing
const DIGIT_OPERATOR_TYPES = new Set([
  'has_beginning',
  'has_number',
  'has_number_between',
  'has_number_lt',
  'has_number_lte',
  'has_number_eq',
  'has_number_gte',
  'has_number_gt',
  'has_pattern'
]);

// Get operators suitable for wait_for_digits rules (number operators + regex)
export const getDigitOperators = (): OperatorConfig[] => {
  return OPERATORS.filter((op) => DIGIT_OPERATOR_TYPES.has(op.type));
};

// Get operator configuration by type
export const getOperatorConfig = (type: string): OperatorConfig | undefined => {
  return OPERATORS.find((op) => op.type === type);
};

// Convert operators to select options
export const operatorsToSelectOptions = (operators: OperatorConfig[]) => {
  return operators.map((op) => ({
    value: op.type,
    get name() {
      return op.name;
    }
  }));
};

// Create an operator object for select components
export const createOperatorOption = (
  type: string
): { value: string; name: string } => {
  const config = getOperatorConfig(type);
  return {
    value: type,
    get name() {
      return config ? config.name : type;
    }
  };
};
