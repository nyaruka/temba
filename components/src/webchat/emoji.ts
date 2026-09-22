import { getCookie, setCookie } from '../utils';
import { EMOJI_CATALOG, EmojiEntry } from './emojiCatalog';

// which emoji the visitor reaches for is remembered on the embedding site,
// across all of its channels
export const EMOJI_COOKIE = 'temba-chat-emoji';

// how many shortcuts are offered, and how many emoji we keep counts for - the
// cookie has to stay well within a browser's 4KB
export const MAX_FREQUENT = 8;
const MAX_TRACKED = 24;

// the shortcuts offered until the visitor has favorites of their own
export const DEFAULT_FREQUENT = [
  '👍',
  '❤️',
  '😂',
  '😊',
  '🙏',
  '🎉',
  '😢',
  '👋'
];

// the ones offered for browsing - a basic set of single code point emoji
// (give or take a variation selector), which every platform's emoji font can
// draw. Search reaches the rest of the catalog.
export const EMOJI = [
  // faces
  ...['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣'],
  ...['😊', '🙂', '😉', '😍', '🥰', '😘', '😋', '😎'],
  ...['🤩', '🥳', '🤔', '🤗', '🤫', '😐', '🙄', '😏'],
  ...['😴', '😕', '😟', '😮', '😳', '🥺', '😢', '😭'],
  ...['😤', '😠', '😡', '🤯', '😱', '😬', '🤒', '🤢'],
  // hands and people
  ...['👍', '👎', '👌', '✌️', '🤞', '🤝', '👏', '🙌'],
  ...['🙏', '💪', '👋', '🤙', '👀', '🤷', '🤦', '🙋'],
  // hearts and symbols
  ...['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔'],
  ...['💯', '✅', '❌', '❓', '❗', '⭐', '🔥', '✨'],
  // things
  ...['🎉', '🎁', '🎂', '☕', '🍕', '🌞', '🌧️', '🌈'],
  ...['📞', '📧', '📎', '📷', '📍', '⏰', '💡', '💰']
];

// the most a search shows - beyond this the visitor is better off typing more
export const MAX_SEARCH_RESULTS = 64;

// what an entry is searched by: its name and shortcodes as words
const searchWords = (entry: EmojiEntry): string[] => {
  return `${entry[1]} ${entry[2] || ''}`
    .toLowerCase()
    .split(/[\s,_:-]+/)
    .filter((word) => word.length > 0);
};

const CATALOG = EMOJI_CATALOG.flatMap((category) => category.emojis);
const CATALOG_WORDS = CATALOG.map(searchWords);
const KNOWN = new Set(CATALOG.map((entry) => entry[0]));

/**
 * Finds emoji whose name or shortcodes start with each word of the query -
 * those the query names exactly first, then those whose name it starts, then
 * those whose shortcode it starts, then the rest in catalog order.
 */
export const searchEmoji = (query: string): string[] => {
  const words = query
    .toLowerCase()
    .split(/[\s,_:-]+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) {
    return [];
  }

  const normalized = words.join(' ');
  const ranked: [number, string][] = [];
  CATALOG.forEach((entry, idx) => {
    const entryWords = CATALOG_WORDS[idx];
    const matches = words.every((word) =>
      entryWords.some((entryWord) => entryWord.startsWith(word))
    );
    if (!matches) {
      return;
    }

    const name = entry[1].toLowerCase();
    const codes = (entry[2] || '').split(',').map((c) => c.replace(/_/g, ' '));
    let rank = 3;
    if (name === normalized || codes.includes(normalized)) {
      rank = 0;
    } else if (name.startsWith(normalized)) {
      rank = 1;
    } else if (codes.some((code) => code.startsWith(normalized))) {
      rank = 2;
    }
    ranked.push([rank, entry[0]]);
  });

  // sort is stable, so catalog order holds within a rank
  return ranked
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_SEARCH_RESULTS)
    .map((r) => r[1]);
};

// an emoji and how many times it's been used, kept most recently used first
type EmojiUse = [string, number];

/**
 * Reads the visitor's emoji usage. The cookie is whatever the page or the
 * visitor made of it, so anything that isn't a catalog emoji with a sane
 * count is dropped.
 */
const readUsage = (): EmojiUse[] => {
  try {
    const parsed = JSON.parse(getCookie(EMOJI_COOKIE) || '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    return parsed
      .filter((use) => {
        const valid =
          Array.isArray(use) &&
          KNOWN.has(use[0]) &&
          Number.isInteger(use[1]) &&
          use[1] > 0 &&
          !seen.has(use[0]);
        if (valid) {
          seen.add(use[0]);
        }
        return valid;
      })
      .slice(0, MAX_TRACKED)
      .map((use) => [use[0], use[1]] as EmojiUse);
  } catch (err) {
    return [];
  }
};

/**
 * Counts a use of the given emoji towards the visitor's shortcuts
 */
export const recordEmojiUse = (emoji: string): void => {
  if (!KNOWN.has(emoji)) {
    return;
  }

  const usage = readUsage();
  const idx = usage.findIndex((use) => use[0] === emoji);
  const count = idx >= 0 ? usage.splice(idx, 1)[0][1] + 1 : 1;
  usage.unshift([emoji, count]);

  // when there are too many to keep, the least used goes - and of those, the
  // one used longest ago
  while (usage.length > MAX_TRACKED) {
    const fewest = Math.min(...usage.map((use) => use[1]));
    usage.splice(usage.map((use) => use[1]).lastIndexOf(fewest), 1);
  }

  // setCookie writes the value as is, which for JSON and emoji isn't safe
  setCookie(EMOJI_COOKIE, encodeURIComponent(JSON.stringify(usage)));
};

/**
 * The visitor's most used emoji - ties going to the more recently used - topped
 * up with the defaults until they have enough of their own.
 */
export const getFrequentEmoji = (): string[] => {
  // sort is stable, so equal counts stay in most recently used order
  const used = readUsage()
    .sort((a, b) => b[1] - a[1])
    .map((use) => use[0]);

  const fill = DEFAULT_FREQUENT.filter((emoji) => !used.includes(emoji));
  return [...used, ...fill].slice(0, MAX_FREQUENT);
};
