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
  it('matches rules without UUIDs to existing categories by name only', () => {
    const result = build([rule('Crimson'), rule('Blue')]);
    const { router, exits } = result;

    expectAllUnique(result);
    expect(router.categories[1].uuid).to.equal('cat-blue');
    expect(exits[1].destination_uuid).to.equal('node-blue');

    // Crimson is new rather than a guessed rename of Red
    expect(router.categories[0].uuid).to.not.be.oneOf([
      'cat-red',
      'cat-blue',
      'cat-other'
    ]);
    expect(exits[0].destination_uuid).to.equal(null);
    expect(router.categories.map((c) => c.uuid)).to.not.include('cat-red');
  });

  it("doesn't reuse anything when every rule is replaced", () => {
    const existingCases = [
      {
        uuid: 'case-red',
        type: 'has_any_word',
        arguments: ['red'],
        category_uuid: 'cat-red'
      },
      {
        uuid: 'case-blue',
        type: 'has_any_word',
        arguments: ['blue'],
        category_uuid: 'cat-blue'
      }
    ];

    // every loaded rule deleted and new ones typed in
    const result = build(
      [rule('Green'), rule('Purple')],
      existingCategories,
      existingExits,
      existingCases
    );

    expectAllUnique(result);
    const reused = (uuids: string[], existing: string[]) =>
      uuids.filter((uuid) => existing.includes(uuid));

    expect(
      reused(
        result.router.categories.map((c) => c.uuid),
        ['cat-red', 'cat-blue']
      )
    ).to.be.empty;
    expect(
      reused(
        result.exits.map((e) => e.uuid),
        ['exit-red', 'exit-blue']
      )
    ).to.be.empty;
    expect(
      reused(
        result.router.cases.map((c) => c.uuid),
        ['case-red', 'case-blue']
      )
    ).to.be.empty;
    expect(
      result.exits.slice(0, 2).map((e) => e.destination_uuid)
    ).to.deep.equal([null, null]);

    // the default category is kept
    expect(result.router.categories[2].uuid).to.equal('cat-other');
    expect(result.exits[2].destination_uuid).to.equal('node-other');
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

  describe('with rules that carry their UUIDs', () => {
    const existingCases = [
      {
        uuid: 'case-red',
        type: 'has_any_word',
        arguments: ['red'],
        category_uuid: 'cat-red'
      },
      {
        uuid: 'case-blue',
        type: 'has_any_word',
        arguments: ['blue'],
        category_uuid: 'cat-blue'
      }
    ];

    // a rule row as loaded from the existing node
    const loaded = (
      category: string,
      value: string,
      caseUuid: string,
      categoryUuid: string
    ) => ({
      ...rule(category, value),
      case_uuid: caseUuid,
      category_uuid: categoryUuid
    });
    const red = (category = 'Red', value = 'red') =>
      loaded(category, value, 'case-red', 'cat-red');
    const blue = (category = 'Blue', value = 'blue') =>
      loaded(category, value, 'case-blue', 'cat-blue');

    const buildLoaded = (rules: any[]) =>
      build(rules, existingCategories, existingExits, existingCases);

    const byName = (result: ReturnType<typeof build>, name: string) => {
      const category = result.router.categories.find((c) => c.name === name)!;
      const exit = result.exits.find((e) => e.uuid === category.exit_uuid)!;
      return { category, exit };
    };

    it('keeps everything when nothing changes', () => {
      const result = buildLoaded([red(), blue()]);

      expectAllUnique(result);
      expect(result.router.categories.map((c) => c.uuid)).to.deep.equal([
        'cat-red',
        'cat-blue',
        'cat-other'
      ]);
      expect(result.router.cases.map((c) => c.uuid)).to.deep.equal([
        'case-red',
        'case-blue'
      ]);
    });

    it('keeps a renamed category wherever it moves', () => {
      const result = buildLoaded([blue(), red('Crimson')]);

      expectAllUnique(result);
      const { category, exit } = byName(result, 'Crimson');
      expect(category.uuid).to.equal('cat-red');
      expect(exit.destination_uuid).to.equal('node-red');
      expect(result.router.cases[1].uuid).to.equal('case-red');
    });

    it("doesn't give a new category a deleted one's routing", () => {
      // Red's rule deleted, a new Green rule added at the top
      const result = buildLoaded([rule('Green'), blue()]);

      expectAllUnique(result);
      const { category, exit } = byName(result, 'Green');
      expect(category.uuid).to.not.be.oneOf(['cat-red', 'cat-blue']);
      expect(exit.uuid).to.not.equal('exit-red');
      expect(exit.destination_uuid).to.equal(null);
      expect(result.router.cases[0].uuid).to.not.equal('case-red');

      // Red's category and exit are gone
      expect(result.router.categories.map((c) => c.uuid)).to.not.include(
        'cat-red'
      );
      expect(result.exits.map((e) => e.uuid)).to.not.include('exit-red');
    });

    it('keeps cases with their rules when categories are swapped', () => {
      const result = buildLoaded([red('Blue'), blue('Red')]);

      expectAllUnique(result);

      // routing follows the category names
      expect(byName(result, 'Blue').category.uuid).to.equal('cat-blue');
      expect(byName(result, 'Red').category.uuid).to.equal('cat-red');

      // each rule keeps its own case, and so its argument translations
      expect(
        result.router.cases.map((c) => [
          c.uuid,
          c.arguments[0],
          c.category_uuid
        ])
      ).to.deep.equal([
        ['case-red', 'red', 'cat-blue'],
        ['case-blue', 'blue', 'cat-red']
      ]);
    });

    it('splits off a category when only some of its rules are renamed', () => {
      // Red has two rules, and only the second is renamed
      const result = build(
        [
          red(),
          loaded('Crimson', 'scarlet', 'case-scarlet', 'cat-red'),
          blue()
        ],
        existingCategories,
        existingExits,
        [
          ...existingCases,
          {
            uuid: 'case-scarlet',
            type: 'has_any_word',
            arguments: ['scarlet'],
            category_uuid: 'cat-red'
          }
        ]
      );

      expectAllUnique(result);
      expect(byName(result, 'Red').category.uuid).to.equal('cat-red');
      expect(byName(result, 'Red').exit.destination_uuid).to.equal('node-red');
      expect(byName(result, 'Crimson').category.uuid).to.not.be.oneOf([
        'cat-red',
        'cat-blue'
      ]);
      expect(byName(result, 'Crimson').exit.destination_uuid).to.equal(null);

      // the renamed rule keeps its own case
      expect(result.router.cases[1].uuid).to.equal('case-scarlet');
    });

    it('gives duplicated rows their own UUIDs', () => {
      // the Red row appears twice, once renamed to Crimson
      const result = buildLoaded([red(), red('Crimson'), blue()]);

      expectAllUnique(result);
      expect(byName(result, 'Red').category.uuid).to.equal('cat-red');
      expect(byName(result, 'Crimson').category.uuid).to.not.be.oneOf([
        'cat-red',
        'cat-blue'
      ]);
      expect(byName(result, 'Crimson').exit.destination_uuid).to.equal(null);
      expect(result.router.cases[0].uuid).to.equal('case-red');
      expect(result.router.cases[1].uuid).to.not.be.oneOf([
        'case-red',
        'case-blue'
      ]);
    });

    it("gives new UUIDs for ones the existing node doesn't have", () => {
      const result = buildLoaded([
        loaded('Red', 'red', 'case-unknown', 'cat-unknown')
      ]);

      expectAllUnique(result);

      // the category still matches by name
      expect(byName(result, 'Red').category.uuid).to.equal('cat-red');
      expect(result.router.cases[0].uuid).to.not.equal('case-unknown');
    });

    it('merges categories renamed to the same name', () => {
      const result = buildLoaded([red('Crimson'), blue('Crimson')]);

      expectAllUnique(result);
      expect(result.router.categories.map((c) => c.name)).to.deep.equal([
        'Crimson',
        'Other'
      ]);

      // the merged category keeps the first existing category the rules came from
      const { category, exit } = byName(result, 'Crimson');
      expect(category.uuid).to.equal('cat-red');
      expect(exit.destination_uuid).to.equal('node-red');
      expect(result.exits.map((e) => e.uuid)).to.not.include('exit-blue');

      // both rules keep their cases
      expect(
        result.router.cases.map((c) => [c.uuid, c.category_uuid])
      ).to.deep.equal([
        ['case-red', 'cat-red'],
        ['case-blue', 'cat-red']
      ]);
    });

    it("takes a deleted category's routing when renamed to its name", () => {
      // Blue's rule deleted and Red renamed to Blue - names are matched first
      const result = buildLoaded([red('Blue')]);

      expectAllUnique(result);
      const { category, exit } = byName(result, 'Blue');
      expect(category.uuid).to.equal('cat-blue');
      expect(exit.destination_uuid).to.equal('node-blue');
      expect(result.router.categories.map((c) => c.uuid)).to.not.include(
        'cat-red'
      );
      expect(result.router.cases[0].uuid).to.equal('case-red');
    });
  });
});
