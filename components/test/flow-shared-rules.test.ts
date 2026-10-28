import { expect } from '@open-wc/testing';
import {
  getOperatorValue,
  isEmptyRuleItem,
  createRuleItemChangeHandler,
  value1VisibilityCondition,
  value2VisibilityCondition,
  createRulesItemConfig,
  createRulesArrayConfig,
  extractUserRules,
  casesToFormRules
} from '../src/flow/nodes/shared-rules';
import { zustand } from '../src/store/AppState';

// a rule that passes every emptiness check
const validRule = (overrides: any = {}) => ({
  operator: 'has_any_word',
  value1: 'red',
  value2: '',
  category: 'Red',
  ...overrides
});

describe('flow/nodes/shared-rules', () => {
  describe('getOperatorValue', () => {
    it('reads a plain string operator', () => {
      expect(getOperatorValue('has_any_word')).to.equal('has_any_word');
    });

    it('trims surrounding whitespace', () => {
      expect(getOperatorValue('  has_text  ')).to.equal('has_text');
    });

    it('reads the value from an object operator', () => {
      expect(
        getOperatorValue({ value: 'has_text', name: 'has some text' })
      ).to.equal('has_text');
    });

    it('reads the value from the first entry of an array operator', () => {
      expect(
        getOperatorValue([{ value: 'has_phrase', name: 'has the phrase' }])
      ).to.equal('has_phrase');
    });

    it('returns empty for missing or unusable operators', () => {
      expect(getOperatorValue(undefined)).to.equal('');
      expect(getOperatorValue(null)).to.equal('');
      expect(getOperatorValue('')).to.equal('');
      expect(getOperatorValue([])).to.equal('');
      expect(getOperatorValue({})).to.equal('');
      expect(getOperatorValue([{ name: 'no value' }])).to.equal('');
    });
  });

  describe('isEmptyRuleItem', () => {
    it('treats a fully specified rule as non-empty', () => {
      expect(isEmptyRuleItem(validRule())).to.equal(false);
    });

    it('treats a missing operator or category as empty', () => {
      expect(isEmptyRuleItem(validRule({ operator: '' }))).to.equal(true);
      expect(isEmptyRuleItem(validRule({ category: '' }))).to.equal(true);
      expect(isEmptyRuleItem(validRule({ category: '   ' }))).to.equal(true);
    });

    it('requires value1 for a single operand operator', () => {
      expect(isEmptyRuleItem(validRule({ value1: '' }))).to.equal(true);
      expect(isEmptyRuleItem(validRule({ value1: '   ' }))).to.equal(true);
    });

    it('requires both values for a two operand operator', () => {
      const between = {
        operator: 'has_number_between',
        category: 'Teens',
        value1: '13',
        value2: '19'
      };
      expect(isEmptyRuleItem(between)).to.equal(false);
      expect(isEmptyRuleItem({ ...between, value2: '' })).to.equal(true);
      expect(isEmptyRuleItem({ ...between, value1: '' })).to.equal(true);
    });

    it('requires no value for a zero operand operator', () => {
      expect(
        isEmptyRuleItem({
          operator: 'has_text',
          category: 'Has Text',
          value1: ''
        })
      ).to.equal(false);
    });

    it('treats an unknown operator with a category as non-empty', () => {
      expect(
        isEmptyRuleItem({ operator: 'has_nonsense', category: 'Something' })
      ).to.equal(false);
    });
  });

  describe('createRuleItemChangeHandler', () => {
    const onChange = createRuleItemChangeHandler();

    it('does not mutate the items it is given', () => {
      const items = [validRule()];
      const result = onChange(0, 'value1', 'blue', items);
      expect(result).to.not.equal(items);
      expect(items[0].value1).to.equal('red');
      expect(result[0].value1).to.equal('blue');
    });

    it('auto-populates an empty category from the new value', () => {
      const items = [{ operator: 'has_any_word', value1: '', category: '' }];
      const result = onChange(0, 'value1', 'blue', items);
      expect(result[0].category).to.equal('Blue');
    });

    it('updates a category that still matches the old default', () => {
      const items = [validRule()];
      const result = onChange(0, 'value1', 'blue', items);
      expect(result[0].category).to.equal('Blue');
    });

    it('leaves a user customized category alone', () => {
      const items = [validRule({ category: 'Favourite Colour' })];
      const result = onChange(0, 'value1', 'blue', items);
      expect(result[0].category).to.equal('Favourite Colour');
    });

    it('sets the fixed category name when switching to a zero operand operator', () => {
      const items = [validRule()];
      const result = onChange(0, 'operator', 'has_text', items);
      expect(result[0].category).to.equal('Has Text');
    });

    it('only touches the item at the given index', () => {
      const items = [validRule(), validRule({ category: 'Second' })];
      const result = onChange(0, 'value1', 'blue', items);
      expect(result[1].category).to.equal('Second');
      expect(result).to.have.length(2);
    });
  });

  describe('value visibility conditions', () => {
    it('shows value1 for operators taking at least one operand', () => {
      expect(value1VisibilityCondition({ operator: 'has_any_word' })).to.equal(
        true
      );
      expect(
        value1VisibilityCondition({ operator: 'has_number_between' })
      ).to.equal(true);
    });

    it('hides value1 for zero operand operators', () => {
      expect(value1VisibilityCondition({ operator: 'has_text' })).to.equal(
        false
      );
    });

    it('shows value2 only for two operand operators', () => {
      expect(
        value2VisibilityCondition({ operator: 'has_number_between' })
      ).to.equal(true);
      expect(value2VisibilityCondition({ operator: 'has_any_word' })).to.equal(
        false
      );
      expect(value2VisibilityCondition({ operator: 'has_text' })).to.equal(
        false
      );
    });

    it('defaults to showing value1 and hiding value2 for unknown operators', () => {
      expect(value1VisibilityCondition({ operator: 'has_nonsense' })).to.equal(
        true
      );
      expect(value2VisibilityCondition({ operator: 'has_nonsense' })).to.equal(
        false
      );
    });
  });

  describe('createRulesItemConfig', () => {
    it('labels the location operands for has_ward', () => {
      const config = createRulesItemConfig();
      expect(config.value1.placeholder({ operator: 'has_ward' })).to.equal(
        'State'
      );
      expect(config.value2.placeholder({ operator: 'has_ward' })).to.equal(
        'District'
      );
    });

    it('labels the first operand for has_district', () => {
      const config = createRulesItemConfig();
      expect(config.value1.placeholder({ operator: 'has_district' })).to.equal(
        'State'
      );
      expect(config.value2.placeholder({ operator: 'has_district' })).to.equal(
        ''
      );
    });

    it('uses no placeholder for ordinary operators', () => {
      const config = createRulesItemConfig();
      expect(config.value1.placeholder({ operator: 'has_any_word' })).to.equal(
        ''
      );
      expect(config.value2.placeholder({ operator: 'has_any_word' })).to.equal(
        ''
      );
    });

    it('caps the category name length', () => {
      expect(createRulesItemConfig().category.maxLength).to.equal(36);
    });
  });

  describe('extractUserRules', () => {
    it('returns an empty list when there are no rules', () => {
      expect(extractUserRules({} as any)).to.deep.equal([]);
      expect(extractUserRules({ rules: [] } as any)).to.deep.equal([]);
    });

    it('keeps a complete rule and carries the value across', () => {
      const result = extractUserRules({
        rules: [validRule()]
      } as any);
      expect(result).to.deep.equal([
        {
          operator: 'has_any_word',
          value: 'red',
          value1: 'red',
          value2: '',
          category: 'Red'
        }
      ]);
    });

    it('trims whitespace from values and category', () => {
      const result = extractUserRules({
        rules: [validRule({ value1: '  red  ', category: '  Red  ' })]
      } as any);
      expect(result[0].value1).to.equal('red');
      expect(result[0].category).to.equal('Red');
    });

    it('drops rules missing an operator or category', () => {
      const result = extractUserRules({
        rules: [
          validRule({ operator: '' }),
          validRule({ category: '   ' }),
          validRule()
        ]
      } as any);
      expect(result).to.have.length(1);
    });

    it('drops a single operand rule with no value', () => {
      const result = extractUserRules({
        rules: [validRule({ value1: '  ' })]
      } as any);
      expect(result).to.have.length(0);
    });

    it('drops a two operand rule missing its second value', () => {
      const result = extractUserRules({
        rules: [
          {
            operator: 'has_number_between',
            value1: '13',
            value2: '',
            category: 'Teens'
          }
        ]
      } as any);
      expect(result).to.have.length(0);
    });

    it('leaves value empty for two operand operators', () => {
      const result = extractUserRules({
        rules: [
          {
            operator: 'has_number_between',
            value1: '13',
            value2: '19',
            category: 'Teens'
          }
        ]
      } as any);
      expect(result[0].value).to.equal('');
      expect(result[0].value1).to.equal('13');
      expect(result[0].value2).to.equal('19');
    });

    it('keeps a zero operand rule with no values', () => {
      const result = extractUserRules({
        rules: [{ operator: 'has_text', category: 'Has Text' }]
      } as any);
      expect(result).to.have.length(1);
      expect(result[0].value).to.equal('');
    });

    it('passes through the UUIDs a rule was loaded with', () => {
      const result = extractUserRules({
        rules: [
          validRule({ case_uuid: 'case-1', category_uuid: 'cat-1' }),
          validRule({ category: 'Blue', value1: 'blue' })
        ]
      } as any);
      expect(result[0].case_uuid).to.equal('case-1');
      expect(result[0].category_uuid).to.equal('cat-1');
      expect(result[1]).to.not.have.property('case_uuid');
      expect(result[1]).to.not.have.property('category_uuid');
    });
  });

  describe('casesToFormRules', () => {
    it('keeps the case and category UUIDs on each rule', () => {
      const rules = casesToFormRules({
        router: {
          cases: [
            {
              uuid: 'case-1',
              type: 'has_any_word',
              arguments: ['red'],
              category_uuid: 'cat-1'
            }
          ],
          categories: [{ uuid: 'cat-1', name: 'Red' }]
        }
      });
      expect(rules[0].case_uuid).to.equal('case-1');
      expect(rules[0].category_uuid).to.equal('cat-1');
    });

    it('returns an empty list when the node has no router', () => {
      expect(casesToFormRules({})).to.deep.equal([]);
      expect(casesToFormRules({ router: {} })).to.deep.equal([]);
    });

    it('converts a single operand case', () => {
      const rules = casesToFormRules({
        router: {
          cases: [
            {
              type: 'has_any_word',
              arguments: ['red'],
              category_uuid: 'cat-1'
            }
          ],
          categories: [{ uuid: 'cat-1', name: 'Red' }]
        }
      });
      expect(rules).to.have.length(1);
      expect(rules[0].operator).to.deep.equal({
        value: 'has_any_word',
        name: 'has any of the words'
      });
      expect(rules[0].value1).to.equal('red');
      expect(rules[0].value2).to.equal('');
      expect(rules[0].category).to.equal('Red');
    });

    it('joins multiple arguments for a single operand case', () => {
      const rules = casesToFormRules({
        router: {
          cases: [
            {
              type: 'has_any_word',
              arguments: ['red', 'blue'],
              category_uuid: 'cat-1'
            }
          ],
          categories: [{ uuid: 'cat-1', name: 'Colours' }]
        }
      });
      expect(rules[0].value1).to.equal('red blue');
    });

    it('splits the arguments of a two operand case', () => {
      const rules = casesToFormRules({
        router: {
          cases: [
            {
              type: 'has_number_between',
              arguments: ['13', '19'],
              category_uuid: 'cat-1'
            }
          ],
          categories: [{ uuid: 'cat-1', name: 'Teens' }]
        }
      });
      expect(rules[0].value1).to.equal('13');
      expect(rules[0].value2).to.equal('19');
    });

    it('leaves both values empty for a zero operand case', () => {
      const rules = casesToFormRules({
        router: {
          cases: [{ type: 'has_text', arguments: [], category_uuid: 'cat-1' }],
          categories: [{ uuid: 'cat-1', name: 'Has Text' }]
        }
      });
      expect(rules[0].value1).to.equal('');
      expect(rules[0].value2).to.equal('');
    });

    it('skips cases pointing at system categories', () => {
      const rules = casesToFormRules({
        router: {
          cases: [
            {
              type: 'has_any_word',
              arguments: ['red'],
              category_uuid: 'cat-1'
            },
            { type: 'has_text', arguments: [], category_uuid: 'cat-other' }
          ],
          categories: [
            { uuid: 'cat-1', name: 'Red' },
            { uuid: 'cat-other', name: 'Other' }
          ]
        }
      });
      expect(rules).to.have.length(1);
      expect(rules[0].category).to.equal('Red');
    });

    it('skips cases whose category is missing', () => {
      const rules = casesToFormRules({
        router: {
          cases: [
            { type: 'has_any_word', arguments: ['red'], category_uuid: 'gone' }
          ],
          categories: [{ uuid: 'cat-1', name: 'Red' }]
        }
      });
      expect(rules).to.have.length(0);
    });

    it('falls back to the raw type for an unknown operator', () => {
      const rules = casesToFormRules({
        router: {
          cases: [
            {
              type: 'has_nonsense',
              arguments: ['a', 'b'],
              category_uuid: 'cat-1'
            }
          ],
          categories: [{ uuid: 'cat-1', name: 'Odd' }]
        }
      });
      expect(rules[0].operator).to.deep.equal({
        value: 'has_nonsense',
        name: 'has_nonsense'
      });
      expect(rules[0].value1).to.equal('a b');
    });
  });

  describe('createRulesArrayConfig', () => {
    const originalFeatures = zustand.getState().features;

    afterEach(() => {
      zustand.setState({ features: originalFeatures });
    });

    it('exposes the shared emptiness and change behaviour', () => {
      const config = createRulesArrayConfig([]);
      expect(config.type).to.equal('array');
      expect(config.isEmptyItem).to.equal(isEmptyRuleItem);
      expect(config.maxItems).to.equal(100);
      expect(config.sortable).to.equal(true);
    });

    it('uses the supplied help text', () => {
      expect(createRulesArrayConfig([], 'Custom help').helpText).to.equal(
        'Custom help'
      );
      expect(createRulesArrayConfig([]).helpText).to.equal(
        'Responses are categorized by the first rule they match.'
      );
    });

    it('passes the operator options through to the item config', () => {
      const options = [{ value: 'has_any_word', name: 'has any of the words' }];
      const config = createRulesArrayConfig(options);
      expect(config.itemConfig.operator.options).to.equal(options);
    });

    it('seeds a new item with the first non-location operator', () => {
      zustand.setState({ features: [] });
      const config = createRulesArrayConfig([]);
      const created: any = config.createEmptyItem([]);
      expect(created.operator[0].value).to.equal('has_any_word');
    });

    it('repeats the operator of the last rule that takes an operand', () => {
      zustand.setState({ features: [] });
      const config = createRulesArrayConfig([]);
      const created: any = config.createEmptyItem([
        { operator: 'has_any_word' },
        { operator: 'has_phrase' }
      ]);
      expect(created.operator[0].value).to.equal('has_phrase');
    });

    it('ignores zero operand operators when picking the default', () => {
      zustand.setState({ features: [] });
      const config = createRulesArrayConfig([]);
      const created: any = config.createEmptyItem([
        { operator: 'has_phrase' },
        { operator: 'has_text' }
      ]);
      expect(created.operator[0].value).to.equal('has_phrase');
    });

    it('never seeds a new item with a location operator', () => {
      zustand.setState({ features: ['locations'] });
      const config = createRulesArrayConfig([]);
      // even though has_district takes an operand and was used last, it is
      // not repeated - a fresh rule falls back to the first non-location option
      const created: any = config.createEmptyItem([
        { operator: 'has_district' }
      ]);
      expect(created.operator[0].value).to.equal('has_any_word');

      const fresh: any = config.createEmptyItem([]);
      expect(fresh.operator[0].value).to.equal('has_any_word');
    });
  });
});
