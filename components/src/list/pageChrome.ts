import { html, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { Icon } from '../Icons';

/** The header's Search action, which opens the search bar. Styled by
 * headerActionsStyles. */
export const renderSearchAction = (onClick: () => void): TemplateResult => html`
  <span class="action" @click=${onClick}>
    <temba-icon name=${Icon.search} size="0.95"></temba-icon>
    ${msg('Search')}
  </span>
`;

export interface SearchbarOptions {
  placeholder: string;
  value: string;
  disabled?: boolean;
  onInput: (event: InputEvent) => void;
  onKeydown: (event: KeyboardEvent) => void;
  /** Closes the bar — the ✕ at its trailing edge. */
  onCancel: () => void;
  /** Controls between the input and the ✕, e.g. a run-search icon. */
  extras?: unknown;
}

/** The inline search bar under the header. Styled by searchbarStyles. */
export const renderSearchbar = (
  options: SearchbarOptions
): TemplateResult => html`
  <div class="searchbar">
    <input
      type="text"
      placeholder=${options.placeholder}
      .value=${options.value}
      ?disabled=${!!options.disabled}
      @input=${options.onInput}
      @keydown=${options.onKeydown}
    />
    ${options.extras ?? null}
    <temba-icon
      class="search-cancel"
      name=${Icon.close}
      size="1.1"
      clickable
      title=${msg('Cancel search')}
      aria-label=${msg('Cancel search')}
      @click=${options.onCancel}
    ></temba-icon>
  </div>
`;
