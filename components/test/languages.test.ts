import { expect } from '@open-wc/testing';
import { getLanguageLabel, getLanguageName } from '../src/languages';

describe('getLanguageName', () => {
  it('returns "Unknown" for the "und" code', () => {
    expect(getLanguageName('und')).to.equal('Unknown');
  });

  it('resolves names via Intl.DisplayNames for known codes', () => {
    expect(getLanguageName('eng')).to.equal('English');
    expect(getLanguageName('fra')).to.equal('French');
    expect(getLanguageName('spa')).to.equal('Spanish');
  });

  it('names languages in the language of the page', () => {
    const original = document.documentElement.lang;
    try {
      document.documentElement.lang = 'fr';
      expect(getLanguageName('eng')).to.equal('anglais');
      expect(getLanguageName('kin')).to.equal('kinyarwanda');

      // codes Intl can't name fall back to the English table
      expect(getLanguageName('aar')).to.equal('Afar');

      document.documentElement.lang = 'es';
      expect(getLanguageName('fra')).to.equal('francés');
    } finally {
      document.documentElement.lang = original;
    }
  });

  it('falls back to the additional lookup map for unsupported codes', () => {
    expect(getLanguageName('prd')).to.equal('Parsi-Dari');
    expect(getLanguageName('pst')).to.equal('Central Pashto');
    expect(getLanguageName('ksw')).to.equal("S'gaw Karen");
    expect(getLanguageName('tdt')).to.equal('Tetun Dili');
  });

  it('names ISO-639-1 languages missing from browser locale data', () => {
    expect(getLanguageName('aar')).to.equal('Afar');
    expect(getLanguageName('bod')).to.equal('Tibetan');
    expect(getLanguageName('run')).to.equal('Rundi');
    expect(getLanguageName('vol')).to.equal('Volapük');
  });

  it('returns the raw code for codes not in either source', () => {
    expect(getLanguageName('xx-invalid-code')).to.equal('xx-invalid-code');
  });

  it('returns an empty string for empty or undefined input', () => {
    expect(getLanguageName('')).to.equal('');
    expect(getLanguageName(undefined as unknown as string)).to.equal('');
  });
});

describe('getLanguageLabel', () => {
  it('capitalizes names that the page language writes in lowercase', () => {
    const original = document.documentElement.lang;
    try {
      document.documentElement.lang = 'fr';
      expect(getLanguageName('eng')).to.equal('anglais');
      expect(getLanguageLabel('eng')).to.equal('Anglais');

      document.documentElement.lang = 'en';
      expect(getLanguageLabel('eng')).to.equal('English');
      expect(getLanguageLabel('')).to.equal('');
    } finally {
      document.documentElement.lang = original;
    }
  });
});
