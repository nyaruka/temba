import { css } from 'lit';

/* The product's button look, shared by <temba-button> and the components
   that draw their own button-like controls: soft corners, medium weight,
   and ring-style edges (box-shadow) in place of hard borders. Interpolate
   these into a rule's body, e.g. `.my-button { ${buttonChrome} }`. */

export const buttonChrome = css`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: 30px;
  padding: 0 11px;
  border: none;
  border-radius: var(--r, 8px);
  background: var(--surface, #fff);
  color: var(--text-1, #1a1f26);
  box-shadow:
    0 0 0 1px var(--border-strong, #d2d6dc),
    0 1px 2px rgba(15, 22, 36, 0.06);
  font-size: 13px;
  font-weight: var(--w-medium, 500);
  letter-spacing: -0.006em;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition:
    background 120ms ease,
    box-shadow 120ms ease,
    color 120ms ease,
    transform 80ms ease;
`;

/* a smaller size for buttons in tight rows, like page header actions;
   interpolate after buttonChrome */
export const buttonChromeCompact = css`
  height: 26px;
  padding: 0 10px;
  border-radius: 7px;
  font-size: 12.5px;
`;

export const buttonChromeHover = css`
  background: var(--bg, #f6f7f9);
`;

export const buttonChromeActive = css`
  transform: scale(0.97);
`;

export const buttonChromePrimary = css`
  background: var(--accent, #497fce);
  color: #fff;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    0 0 0 1px var(--accent-600, #3a66a5),
    0 1px 3px rgba(15, 22, 36, 0.16);
`;

export const buttonChromePrimaryHover = css`
  background: var(--accent-500, #4272b9);
`;

/* a ring-style button whose action can't be undone: tinted red throughout,
   text and ring, with a faint red wash on hover */
export const buttonChromeDestructive = css`
  background: var(--surface, #fff);
  color: var(--danger, #d03f3f);
  box-shadow:
    0 0 0 1px var(--danger-border, #f4c8c8),
    0 1px 2px rgba(15, 22, 36, 0.06);
`;

export const buttonChromeDestructiveHover = css`
  background: var(--danger-bg, #fcebeb);
  /* pre-mixed first for browsers without color-mix(), which drop the second */
  box-shadow:
    0 0 0 1px #e48a8a,
    0 1px 2px rgba(15, 22, 36, 0.06);
  box-shadow:
    0 0 0 1px
      color-mix(
        in srgb,
        var(--danger, #d03f3f) 45%,
        var(--danger-border, #f4c8c8)
      ),
    0 1px 2px rgba(15, 22, 36, 0.06);
`;
