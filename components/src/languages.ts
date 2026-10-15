import { msg } from '@lit/localize';

// the page is rendered in the user's chosen UI language, which can differ from the browser's
export function getPageLocale(): string {
  return document.documentElement.lang || navigator.language || 'en';
}

const displayNamesByLocale = new Map<string, Intl.DisplayNames>();

function getDisplayNames(): Intl.DisplayNames {
  const locale = getPageLocale();
  let names = displayNamesByLocale.get(locale);
  if (!names) {
    try {
      names = new Intl.DisplayNames([locale], {
        type: 'language',
        fallback: 'none'
      });
    } catch {
      names = new Intl.DisplayNames(['en'], {
        type: 'language',
        fallback: 'none'
      });
    }
    displayNamesByLocale.set(locale, names);
  }
  return names;
}

const ADDITIONAL_LANGUAGE_NAMES: { [code: string]: string } = {
  aab: 'Alumu-Tesu',
  aac: 'Ari',
  aar: 'Afar',
  aas: 'Aasáx',
  abk: 'Abkhazian',
  abp: 'Abellen Ayta',
  acf: 'Saint Lucian Creole French',
  aec: 'Saidi Arabic',
  afb: 'Gulf Arabic',
  apd: 'Sudanese Arabic',
  ava: 'Avaric',
  ave: 'Avestan',
  ayl: 'Libyan Arabic',
  bak: 'Bashkir',
  bis: 'Bislama',
  blk: "Pa'o Karen",
  bod: 'Tibetan',
  bog: 'Bamako Sign Language',
  bzs: 'Brazilian Sign Language',
  cha: 'Chamorro',
  che: 'Chechen',
  chu: 'Church Slavic',
  chv: 'Chuvash',
  cor: 'Cornish',
  cre: 'Cree',
  csn: 'Colombian Sign Language',
  dag: 'Dagbani',
  dzo: 'Dzongkha',
  ecs: 'Ecuadorian Sign Language',
  fij: 'Fijian',
  frk: 'Frankish',
  fsl: 'French Sign Language',
  ful: 'Fulah',
  fuv: 'Nigerian Fulfulde',
  gcr: 'Guianese Creole French',
  glv: 'Manx',
  gpe: 'Ghanaian Pidgin English',
  gux: 'Gourmanchéma',
  her: 'Herero',
  hmo: 'Hiri Motu',
  ido: 'Ido',
  iii: 'Sichuan Yi',
  iku: 'Inuktitut',
  ile: 'Interlingue',
  ipk: 'Inupiaq',
  ise: 'Italian Sign Language',
  kal: 'Kalaallisut',
  kas: 'Kashmiri',
  kau: 'Kanuri',
  kik: 'Kikuyu',
  kom: 'Komi',
  kon: 'Kongo',
  ksw: "S'gaw Karen",
  kua: 'Kuanyama',
  kun: 'Kunama',
  kyu: 'Western Kayah',
  laj: 'Lango',
  lim: 'Limburgan',
  lub: 'Luba-Katanga',
  mah: 'Marshallese',
  nau: 'Nauru',
  nav: 'Navajo',
  nbl: 'South Ndebele',
  nde: 'North Ndebele',
  ndo: 'Ndonga',
  nyj: 'Nyanga',
  oji: 'Ojibwa',
  oss: 'Ossetian',
  pli: 'Pali',
  prd: 'Parsi-Dari',
  prl: 'Peruvian Sign Language',
  pst: 'Central Pashto',
  rop: 'Kriol',
  run: 'Rundi',
  sag: 'Sango',
  sme: 'Northern Sami',
  srd: 'Sardinian',
  ssw: 'Swati',
  tah: 'Tahitian',
  tdt: 'Tetun Dili',
  toi: 'Tonga',
  tuv: 'Turkana',
  ven: 'Venda',
  vol: 'Volapük',
  vsl: 'Venezuelan Sign Language',
  zha: 'Zhuang'
};

export function getLanguageName(code: string): string {
  if (!code) return '';
  if (code === 'und') return msg('Unknown');

  try {
    const name = getDisplayNames().of(code);
    if (name) return name;
  } catch {
    // fall through to additional lookup
  }

  return ADDITIONAL_LANGUAGE_NAMES[code] || code;
}
