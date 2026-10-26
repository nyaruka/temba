import { expect } from '@open-wc/testing';
import { createRulesRouter } from '../src/utils';

const getOperatorConfig = () => ({ operands: 1 });

const rule = (category: string, value = category.toLowerCase()) => ({
  operator: 'has_any_word',
  value,
  category
});

// an existing Red/Blue/Other router, each exit pointing somewhere
const existingCategories = [
  { uuid: 'cat-red', name: 'Red', exit_uuid: 'exit-red' },
  { uuid: 'cat-blue', name: 'Blue', exit_uuid: 'exit-blue' },
  { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
];
const existingExits = [
  { uuid: 'exit-red', destination_uuid: 'node-red' },
  { uuid: 'exit-blue', destination_uuid: 'node-blue' },
  { uuid: 'exit-other', destination_uuid: 'node-other' }
];

const build = (rules: any[]) =>
  createRulesRouter(
    '@input.text',
    rules,
    getOperatorConfig,
    existingCategories,
    existingExits
  );

const expectUnique = (values: string[]) =>
  expect(new Set(values).size).to.equal(values.length);

describe('createRulesRouter', () => {
  it('reuses an existing category by position when renamed', () => {
    const { router, exits } = build([rule('Crimson'), rule('Blue')]);

    expect(router.categories.map((c) => [c.name, c.uuid])).to.deep.equal([
      ['Crimson', 'cat-red'],
      ['Blue', 'cat-blue'],
      ['Other', 'cat-other']
    ]);
    expect(exits.map((e) => e.destination_uuid)).to.deep.equal([
      'node-red',
      'node-blue',
      'node-other'
    ]);
  });

  it("doesn't take by position a category matched by name earlier", () => {
    const { router, exits } = build([rule('Blue'), rule('Green')]);

    expectUnique(router.categories.map((c) => c.uuid));
    expectUnique(exits.map((e) => e.uuid));
    expect(router.categories[0].uuid).to.equal('cat-blue');
    expect(router.categories[1].uuid).to.not.be.oneOf([
      'cat-red',
      'cat-blue',
      'cat-other'
    ]);
    expect(exits[1].destination_uuid).to.equal(null);
  });

  it("doesn't take by position a category matched by name later", () => {
    const { router, exits } = build([rule('Green'), rule('Red')]);

    expectUnique(router.categories.map((c) => c.uuid));
    expectUnique(exits.map((e) => e.uuid));
    expect(router.categories[1].uuid).to.equal('cat-red');
    expect(exits[1].destination_uuid).to.equal('node-red');
  });
});
