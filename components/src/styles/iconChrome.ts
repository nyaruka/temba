import { css } from 'lit';

/* The quiet icons that sit beside content: card title icons, and the
   affordances on fields like search, copy, clear and a select's chevron.
   Matched by the .card-title icon rule in tailwind.scss. Interpolate these
   into a rule's body, e.g. `.my-icon { ${iconMuted} }`, using the hover one
   where the icon is an action. */

export const iconMuted = css`
  --icon-color: var(--text-3, #7b8593);
`;

export const iconMutedHover = css`
  --icon-color: var(--text-1, #1a1f26);
`;
