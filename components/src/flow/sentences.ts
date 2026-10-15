/**
 * Sentences let a translated string hold form fields without any markup. A {token}
 * marks where a field goes and **text** is shown bold, e.g.
 *
 *   If there's no reply after {duration} go to **No Response**
 */

export type SentencePart =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'token'; name: string };

const SENTENCE_MARKERS = /(\{\w+\}|\*\*.+?\*\*)/;

export const parseSentence = (sentence: string): SentencePart[] =>
  sentence
    .split(SENTENCE_MARKERS)
    .filter((piece) => piece !== '')
    .map((piece): SentencePart => {
      if (/^\{\w+\}$/.test(piece)) {
        return { type: 'token', name: piece.slice(1, -1) };
      }
      if (/^\*\*.+\*\*$/.test(piece)) {
        return { type: 'bold', text: piece.slice(2, -2) };
      }
      return { type: 'text', text: piece };
    });

/** the {tokens} in a sentence, in order */
export const getSentenceTokens = (sentence: string): string[] =>
  parseSentence(sentence)
    .filter((part) => part.type === 'token')
    .map((part) => (part as { name: string }).name);
