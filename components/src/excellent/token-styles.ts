import { css, unsafeCSS } from 'lit';
import { TokenType, Token } from './tokenizer';

/** Default colors for expression token syntax highlighting. */
export const TOKEN_COLORS = {
  expression: '#0086e0',
  fn: '#0086e0',
  string: '#06a810',
  number: '#c25ceb',
  keyword: '#1750eb',
  operator: '#666',
  paren: '#999',
  parenUnmatched: '#ff0011'
};

export const TOKEN_CLASS_MAP: Record<string, string> = {
  [TokenType.Text]: 'tok-text',
  [TokenType.ExpressionPrefix]: 'tok-prefix',
  [TokenType.Identifier]: 'tok-id',
  [TokenType.FunctionName]: 'tok-fn',
  [TokenType.StringLiteral]: 'tok-str',
  [TokenType.NumberLiteral]: 'tok-num',
  [TokenType.Keyword]: 'tok-kw',
  [TokenType.Operator]: 'tok-op',
  [TokenType.ContextRef]: 'tok-ctx',
  [TokenType.Separator]: 'tok-sep',
  [TokenType.Whitespace]: 'tok-ws',
  [TokenType.Arrow]: 'tok-arrow',
  [TokenType.Bracket]: 'tok-bracket',
  [TokenType.EscapedAt]: 'tok-text',
  [TokenType.Paren]: 'tok-paren'
};

/** Expression token types get monospace font. */
export const EXPRESSION_TOKENS = new Set([
  TokenType.ExpressionPrefix,
  TokenType.Identifier,
  TokenType.FunctionName,
  TokenType.StringLiteral,
  TokenType.NumberLiteral,
  TokenType.Keyword,
  TokenType.Operator,
  TokenType.ContextRef,
  TokenType.Separator,
  TokenType.Whitespace,
  TokenType.Arrow,
  TokenType.Bracket,
  TokenType.Paren
]);

export function getTokenClass(token: Token): string {
  if (token.type === TokenType.Paren && token.balanced === false) {
    return 'tok-paren-unmatched';
  }
  return TOKEN_CLASS_MAP[token.type] || 'tok-text';
}

const c = (key: keyof typeof TOKEN_COLORS) => unsafeCSS(TOKEN_COLORS[key]);

/** Shared CSS for token syntax highlighting. */
export const tokenCss = css`
  .tok-text {
    color: inherit;
  }

  .tok-prefix {
    color: var(--expression-color, ${c('expression')});
    font-weight: 600;
  }

  .tok-id {
    color: var(--expression-color, ${c('expression')});
  }

  .tok-fn {
    color: var(--expression-fn-color, ${c('fn')});
    font-weight: 900;
  }

  .tok-str {
    color: var(--expression-string-color, ${c('string')});
  }

  .tok-num {
    color: var(--expression-number-color, ${c('number')});
  }

  .tok-kw {
    color: var(--expression-keyword-color, ${c('keyword')});
  }

  .tok-op {
    color: var(--expression-operator-color, ${c('operator')});
  }

  .tok-ctx {
    color: var(--expression-color, ${c('expression')});
  }

  .tok-sep {
    color: var(--expression-operator-color, ${c('operator')});
  }

  .tok-arrow {
    color: var(--expression-operator-color, ${c('operator')});
  }

  .tok-bracket {
    color: var(--expression-operator-color, ${c('operator')});
  }

  .tok-ws {
    /* whitespace tokens — no special color */
  }

  .tok-newline {
    /* Newline chars rendered via white-space: pre-wrap on parent */
  }

  .tok-paren {
    color: ${c('paren')};
  }

  .tok-paren-unmatched {
    color: var(--expression-paren-unmatched-color, ${c('parenUnmatched')});
    font-weight: 900;
  }

  .tok-fn-invalid {
    text-decoration: wavy underline ${c('parenUnmatched')};
    text-underline-offset: 3px;
  }

  .tok-mono {
    font-family: var(--expression-font-family, var(--font-mono, monospace));
    font-size: 0.95em;
  }
`;
