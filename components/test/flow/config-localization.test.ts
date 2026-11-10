import { expect } from '@open-wc/testing';
import { ACTION_CONFIG, NODE_CONFIG } from '../../src/flow/config';
import {
  ACTION_GROUP_METADATA,
  CONTEXT_MENU_SHORTCUTS,
  SPLIT_GROUP_METADATA
} from '../../src/flow/types';
import { OPERATORS } from '../../src/flow/operators';
import { localizedOption } from '../../src/flow/utils';

// properties that hold text shown to the user
const TEXT_KEYS = new Set([
  'subtitle',
  'label',
  'helpText',
  'placeholder',
  'optionalLink',
  'warning',
  'itemLabel',
  'keyPlaceholder',
  'valuePlaceholder',
  'text',
  'title',
  'description'
]);

// fields whose option names aren't the config's own text: they are saved into
// the flow definition, or come from a data table shared with other code
const EXEMPT_OPTION_NAMES = new Set([
  'split_by_contact_field.form.field',
  'add_contact_urn.form.scheme',
  'split_by_scheme.form.schemes',
  'split_by_airtime.form.amounts.itemConfig.currency'
]);

// Collects the paths of text held as a plain string. Configs are module-level
// constants, so a plain string is fixed in whichever locale was active when the
// module loaded, where a getter is read again on every render.
const findPlainText = (
  value: any,
  path: string,
  found: string[],
  seen = new Set<any>()
) => {
  if (!value || typeof value !== 'object' || seen.has(value)) {
    return;
  }
  seen.add(value);

  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const child = value[key];
    if (TEXT_KEYS.has(key) && typeof child === 'string' && child !== '') {
      if (!descriptor.get) {
        found.push(`${path}.${key}`);
      }
    } else if (key === 'options' && Array.isArray(child)) {
      child.forEach((option, index) => {
        const name = Object.getOwnPropertyDescriptor(Object(option), 'name');
        if (name && !name.get && !EXEMPT_OPTION_NAMES.has(path)) {
          found.push(`${path}.options[${index}].name`);
        }
      });
    } else {
      findPlainText(child, `${path}.${key}`, found, seen);
    }
  }
};

describe('flow config localization', () => {
  it('holds action and node text in getters', () => {
    const found: string[] = [];
    for (const [type, config] of Object.entries({
      ...ACTION_CONFIG,
      ...NODE_CONFIG
    })) {
      if (config.name) {
        expect(
          Object.getOwnPropertyDescriptor(config, 'name').get,
          `${type}.name`
        ).to.be.a('function');
      }
      findPlainText(config, type, found);
    }
    expect(found).to.deep.equal([]);
  });

  it('holds group and shortcut text in getters', () => {
    const found: string[] = [];
    findPlainText(ACTION_GROUP_METADATA, 'actionGroups', found);
    findPlainText(SPLIT_GROUP_METADATA, 'splitGroups', found);
    expect(found).to.deep.equal([]);

    for (const shortcut of Object.values(CONTEXT_MENU_SHORTCUTS).flat()) {
      expect(
        Object.getOwnPropertyDescriptor(shortcut, 'name').get,
        shortcut.type
      ).to.be.a('function');
      expect(shortcut.name).to.be.a('string');
    }
  });

  it('holds operator names in getters', () => {
    for (const operator of OPERATORS) {
      expect(
        Object.getOwnPropertyDescriptor(operator, 'name').get,
        operator.type
      ).to.be.a('function');
      expect(operator.name).to.be.a('string');
    }
  });

  it('reads an option name each time it is used', () => {
    let name = 'One';
    const option = localizedOption('1', () => name);
    expect(option).to.deep.equal({ value: '1', name: 'One' });

    name = 'Uno';
    expect(option.name).to.equal('Uno');
  });
});
