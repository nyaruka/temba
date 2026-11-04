import { css } from 'lit';

/* The product's card title: the heading at the top of a card, beside its
   icon (which takes iconMuted from iconChrome). Shared by <temba-card> and
   matched by the .card-title class in tailwind.scss for cards drawn in page
   markup. Interpolate it into a rule's body, e.g. `.my-title { ${cardTitle} }`. */

export const cardTitle = css`
  font-size: 14px;
  font-weight: var(--w-medium, 500);
  color: var(--text-1, #1a1f26);
  letter-spacing: -0.006em;
`;
