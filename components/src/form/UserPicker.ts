import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { msg } from '@lit/localize';
import { RapidElement } from '../RapidElement';
import { Icon } from '../Icons';
import { fetchResults } from '../utils';
import { getFullName } from '../display/TembaUser';
import { Dropdown } from '../display/Dropdown';

interface PickerUser {
  uuid: string;
  name: string;
  email: string;
  avatar?: string;
}

/**
 * Picks a user, shown as the user themselves - their avatar and name, with an
 * arrow - rather than as a form field. Opening it shows a searchable list of
 * users, led by an option for all of them when allLabel is set. Its value is
 * the picked user's uuid, empty for all of them, and it fires change when
 * that changes.
 */
export class UserPicker extends RapidElement {
  static get styles() {
    return css`
      :host {
        display: block;
        min-width: 0;
      }

      temba-dropdown {
        display: block;
      }

      /* the whole width is the control, with its arrow at the far end */
      .current {
        display: flex;
        align-items: center;
        gap: var(--user-picker-gap, 12px);
        min-width: 0;
        padding: 4px 8px 4px var(--user-picker-inset, 6px);
        border-radius: var(--r, 8px);
        cursor: pointer;
        user-select: none;
        font-size: var(--user-picker-font-size, 15.5px);
        font-weight: var(--w-semibold, 600);
        color: var(--text-1);
      }

      .current:hover {
        background: var(--sunken);
      }

      /* the user's own 26px circle scaled from its left edge to 32px */
      .current .avatar {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        width: 32px;
        height: 32px;
      }

      .current .avatar temba-user {
        --temba-scale: 1.23;
      }

      /* all users take the same place as one, as an outlined circle that
         still shows against the hover */
      .current .avatar.all {
        box-sizing: border-box;
        justify-content: center;
        border-radius: 50%;
        background: var(--surface);
        box-shadow: inset 0 0 0 1px var(--border);
        --icon-color: var(--text-2);
      }

      .current .name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .current > temba-icon {
        flex-shrink: 0;
        --icon-color: var(--text-3);
      }

      .menu {
        width: 260px;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .search {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 4px;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: var(--r-sm, 4px);
        --icon-color: var(--text-3);
      }

      .search input {
        flex: 1;
        min-width: 0;
        border: none;
        outline: none;
        background: transparent;
        font: inherit;
        font-size: 13px;
        color: var(--text-1);
      }

      .options {
        max-height: 320px;
        overflow-y: auto;
      }

      .option {
        display: flex;
        align-items: center;
        gap: 0;
        padding: 6px 8px;
        border-radius: var(--r-sm, 4px);
        font-size: 13px;
        color: var(--text-1);
        cursor: pointer;
      }

      .option .name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .option:hover,
      .option.cursor {
        background: var(--sunken);
      }

      .option.picked {
        background: var(--accent-50);
      }

      .option .all-icon {
        width: 26px;
        display: flex;
        justify-content: center;
        --icon-color: var(--text-2);
      }

      .none {
        padding: 8px;
        font-size: 13px;
        color: var(--text-3);
      }
    `;
  }

  @property({ type: String })
  endpoint = '/api/v2/users.json';

  // the picked user's uuid, empty for all of them
  @property({ type: String })
  value = '';

  // when set, the list leads with this option for all users
  @property({ type: String, attribute: 'all-label' })
  allLabel = '';

  @state()
  private users: PickerUser[] = [];

  @state()
  private query = '';

  @state()
  private cursor = 0;

  public connectedCallback(): void {
    super.connectedCallback();
    fetchResults(this.endpoint).then((users: any[]) => {
      this.users = users.map((user) => ({
        uuid: user.uuid,
        email: user.email,
        avatar: user.avatar,
        name: user.name || getFullName(user) || user.email
      }));
    });
  }

  public willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('query')) {
      this.cursor = 0;
    }
  }

  private get picked(): PickerUser {
    return this.users.find((user) => user.uuid === this.value) || null;
  }

  // the options for the current search, the all option first while browsing
  private get options(): PickerUser[] {
    const query = this.query.trim().toLowerCase();
    const users = query
      ? this.users.filter(
          (user) =>
            user.name.toLowerCase().includes(query) ||
            user.email.toLowerCase().includes(query)
        )
      : this.users;
    return this.allLabel && !query
      ? [{ uuid: '', name: this.allLabel, email: '' }, ...users]
      : users;
  }

  // closes the menu the way clicking away does - by taking focus out of it -
  // so the dropdown's focus tracking is left ready for the next open
  private closeMenu() {
    const input = this.shadowRoot.querySelector(
      '.search input'
    ) as HTMLInputElement;
    if (input && this.shadowRoot.activeElement === input) {
      input.blur();
    }
    (this.shadowRoot.querySelector('temba-dropdown') as Dropdown).close();
  }

  private pick(user: PickerUser) {
    this.closeMenu();
    if (user.uuid !== this.value) {
      this.value = user.uuid;
      this.fireEvent('change');
    }
  }

  private handleOpened() {
    this.query = '';
    this.cursor = 0;
    window.setTimeout(() => {
      (
        this.shadowRoot.querySelector('.search input') as HTMLInputElement
      )?.focus();
    }, 0);
  }

  private handleKeyDown(event: KeyboardEvent) {
    const options = this.options;
    if (event.key === 'ArrowDown') {
      this.cursor = Math.min(this.cursor + 1, options.length - 1);
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      this.cursor = Math.max(this.cursor - 1, 0);
      event.preventDefault();
    } else if (event.key === 'Enter' && options[this.cursor]) {
      this.pick(options[this.cursor]);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      this.closeMenu();
    }
  }

  private renderUser(user: PickerUser): TemplateResult {
    return html`<temba-user
        name=${user.name}
        email=${user.email}
        avatar=${user.avatar || ''}
      ></temba-user
      ><span class="name">${user.name}</span>`;
  }

  public render(): TemplateResult {
    const picked = this.picked;
    const options = this.options;
    return html`
      <temba-dropdown
        arrowSize="0"
        margin="4"
        @temba-opened=${this.handleOpened}
      >
        <div
          slot="toggle"
          class="current"
          role="button"
          aria-haspopup="listbox"
        >
          ${picked
            ? html`<span class="avatar"
                  ><temba-user
                    name=${picked.name}
                    email=${picked.email}
                    avatar=${picked.avatar || ''}
                  ></temba-user></span
                ><span class="name">${picked.name}</span>`
            : html`<span class="avatar all"
                  ><temba-icon name=${Icon.group}></temba-icon></span
                ><span class="name">${this.allLabel}</span>`}
          <temba-icon name=${Icon.arrow_down} size="1"></temba-icon>
        </div>
        <div slot="dropdown" class="menu">
          <div class="search">
            <temba-icon name=${Icon.search} size="0.9"></temba-icon>
            <input
              type="text"
              .value=${this.query}
              @input=${(event: InputEvent) =>
                (this.query = (event.target as HTMLInputElement).value)}
              @keydown=${this.handleKeyDown}
            />
          </div>
          <div class="options" role="listbox">
            ${options.length
              ? options.map(
                  (user, index) =>
                    html`<div
                      class="option ${user.uuid === this.value
                        ? 'picked'
                        : ''} ${index === this.cursor ? 'cursor' : ''}"
                      role="option"
                      aria-selected=${user.uuid === this.value}
                      @click=${() => this.pick(user)}
                    >
                      ${user.uuid
                        ? this.renderUser(user)
                        : html`<span class="all-icon"
                              ><temba-icon
                                name=${Icon.group}
                              ></temba-icon></span
                            ><span class="name">${user.name}</span>`}
                    </div>`
                )
              : html`<div class="none">${msg('No matches')}</div>`}
          </div>
        </div>
      </temba-dropdown>
    `;
  }
}
