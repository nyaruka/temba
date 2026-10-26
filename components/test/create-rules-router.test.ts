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

const build = (
  rules: any[],
  categories = existingCategories,
  exits = existingExits,
  cases: any[] = []
) =>
  createRulesRouter(
    '@input.text',
    rules,
    getOperatorConfig,
    categories,
    exits,
    cases
  );

const expectUnique = (values: string[]) =>
  expect(new Set(values).size).to.equal(values.length);

const expectAllUnique = ({ router, exits }: ReturnType<typeof build>) => {
  expectUnique(router.categories.map((c) => c.uuid));
  expectUnique(exits.map((e) => e.uuid));
  expectUnique(router.cases.map((c) => c.uuid));
  expect(router.categories.map((c) => c.exit_uuid)).to.deep.equal(
    exits.map((e) => e.uuid)
  );
};

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

  it('reuses a category that was renamed and moved', () => {
    const { router, exits } = build([rule('Blue'), rule('Crimson')]);

    expect(router.categories.map((c) => [c.name, c.uuid])).to.deep.equal([
      ['Blue', 'cat-blue'],
      ['Crimson', 'cat-red'],
      ['Other', 'cat-other']
    ]);
    expect(exits[1].destination_uuid).to.equal('node-red');
  });

  it("doesn't take by position a category matched by name earlier", () => {
    const result = build([rule('Blue'), rule('Green')]);
    const { router, exits } = result;

    expectAllUnique(result);
    expect(router.categories[0].uuid).to.equal('cat-blue');

    // Green takes the first unclaimed category instead
    expect(router.categories[1].uuid).to.equal('cat-red');
    expect(exits[1].destination_uuid).to.equal('node-red');
  });

  it('only creates new categories when every existing one is claimed', () => {
    const result = build([rule('Red'), rule('Blue'), rule('Green')]);
    const { router, exits } = result;

    expectAllUnique(result);
    expect(router.categories[2].uuid).to.not.be.oneOf([
      'cat-red',
      'cat-blue',
      'cat-other'
    ]);
    expect(exits[2].destination_uuid).to.equal(null);
  });

  it("doesn't take by position a category matched by name later", () => {
    const result = build([rule('Green'), rule('Red')]);
    const { router, exits } = result;

    expectAllUnique(result);
    expect(router.categories[1].uuid).to.equal('cat-red');
    expect(exits[1].destination_uuid).to.equal('node-red');
  });

  it('gives categories that shared an exit their own exits', () => {
    const result = build(
      [rule('A'), rule('B')],
      [
        { uuid: 'cat-a', name: 'A', exit_uuid: 'exit-shared' },
        { uuid: 'cat-b', name: 'B', exit_uuid: 'exit-shared' },
        { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-shared' }
      ],
      [{ uuid: 'exit-shared', destination_uuid: 'node-x' }]
    );

    expectAllUnique(result);
    expect(result.router.categories.map((c) => c.uuid)).to.deep.equal([
      'cat-a',
      'cat-b',
      'cat-other'
    ]);
    expect(result.exits[0].uuid).to.equal('exit-shared');

    // every category still routes where it did
    expect(result.exits.map((e) => e.destination_uuid)).to.deep.equal([
      'node-x',
      'node-x',
      'node-x'
    ]);
  });

  it('repairs existing categories that repeat UUIDs', () => {
    const result = build(
      [rule('Blue'), rule('Green')],
      [
        { uuid: 'cat-blue', name: 'Blue', exit_uuid: 'exit-blue' },
        { uuid: 'cat-blue', name: 'Green', exit_uuid: 'exit-blue' },
        { uuid: 'cat-other', name: 'Other', exit_uuid: 'exit-other' }
      ],
      [
        { uuid: 'exit-blue', destination_uuid: 'node-blue' },
        { uuid: 'exit-other', destination_uuid: 'node-other' }
      ]
    );

    expectAllUnique(result);
    expect(result.router.categories[0].uuid).to.equal('cat-blue');
    expect(result.exits[0].uuid).to.equal('exit-blue');
  });

  it('reuses each existing case at most once', () => {
    const existingCases = [
      {
        uuid: 'case-red',
        type: 'has_any_word',
        arguments: ['red'],
        category_uuid: 'cat-red'
      }
    ];

    // a second rule for the same category
    let result = build(
      [rule('Red'), rule('Red', 'crimson')],
      existingCategories,
      existingExits,
      existingCases
    );
    expectAllUnique(result);
    expect(result.router.cases[0].uuid).to.equal('case-red');

    // a new rule inserted above the existing one doesn't take its case
    result = build(
      [rule('Green'), rule('Red')],
      existingCategories,
      existingExits,
      existingCases
    );
    expectAllUnique(result);
    expect(result.router.cases[0].uuid).to.not.equal('case-red');
    expect(result.router.cases[1].uuid).to.equal('case-red');
    expect(result.router.cases[1].category_uuid).to.equal('cat-red');
  });
});
