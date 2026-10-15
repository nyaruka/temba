import { expect } from '@open-wc/testing';
import { getSentenceTokens, parseSentence } from '../src/flow/sentences';
import { ACTION_CONFIG, NODE_CONFIG } from '../src/flow/config';
import { ExtrasSection, LayoutItem } from '../src/flow/types';

const collectSections = (items: LayoutItem[] = []): ExtrasSection[] =>
  items.flatMap((item) => {
    if (typeof item !== 'object') return [];
    if (item.type === 'extras') return item.sections;
    if (item.type === 'row' || item.type === 'group') {
      return collectSections(item.items);
    }
    return [];
  });

const collectFields = (items: LayoutItem[]): string[] =>
  items.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (item.type === 'field') return [item.field];
    if (item.type === 'row' || item.type === 'group') {
      return collectFields(item.items);
    }
    return [];
  });

const INLINE_TYPES = ['text', 'select', 'checkbox'];

describe('sentences', () => {
  it('parses tokens and bold text', () => {
    expect(
      parseSentence(
        "If there's no reply after {duration} go to **No Response**"
      )
    ).to.deep.equal([
      { type: 'text', text: "If there's no reply after " },
      { type: 'token', name: 'duration' },
      { type: 'text', text: ' go to ' },
      { type: 'bold', text: 'No Response' }
    ]);

    expect(parseSentence('{name}')).to.deep.equal([
      { type: 'token', name: 'name' }
    ]);
    expect(parseSentence('plain text')).to.deep.equal([
      { type: 'text', text: 'plain text' }
    ]);
    expect(getSentenceTokens('Between {min} and **{max}**')).to.deep.equal([
      'min'
    ]);
  });

  it('places every field of every sentence section', () => {
    const configs = [
      ...Object.values(NODE_CONFIG),
      ...Object.values(ACTION_CONFIG)
    ];

    let checked = 0;
    configs.forEach((config: any) => {
      collectSections(config.layout)
        .filter((section) => section.sentence)
        .forEach((section) => {
          const where = `${config.type} "${section.label}"`;
          const fields = getSentenceTokens(section.sentence()).map(
            (token) => section.tokens?.[token] ?? token
          );

          expect(fields, where).to.have.members(collectFields(section.items));
          fields.forEach((field) => {
            expect(
              INLINE_TYPES,
              `${where} can't show ${field} inline`
            ).to.include(config.form[field]?.type);
          });
          checked++;
        });
    });
    expect(checked).to.be.greaterThan(0);
  });

  ['es', 'fr', 'pt'].forEach((locale) => {
    it(`keeps the {tokens} and ** markers in ${locale} translations`, async () => {
      const response = await fetch(`/xliff/${locale}.xlf`);
      const doc = new DOMParser().parseFromString(
        await response.text(),
        'application/xml'
      );

      // textContent leaves out the <x/> placeholders of html`` strings
      const markers = (text: string) => ({
        tokens: (text.match(/\{\w+\}/g) || []).sort(),
        bold: (text.match(/\*\*/g) || []).length
      });

      const units = Array.from(doc.querySelectorAll('trans-unit'));
      expect(units.length).to.be.greaterThan(0);

      units.forEach((unit) => {
        const source = unit.querySelector('source')?.textContent || '';
        const target = unit.querySelector('target')?.textContent;
        if (target === undefined) return;

        expect(
          markers(target),
          `${locale} ${unit.id}: ${source}`
        ).to.deep.equal(markers(source));
      });
    });
  });
});
