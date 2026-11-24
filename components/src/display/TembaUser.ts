import { PropertyValues, TemplateResult, css, html } from 'lit';
import { property } from 'lit/decorators.js';

import { colorHash, extractInitials } from '../utils';

import { DEFAULT_AVATAR } from '../webchat/assets';
import { Icon } from '../Icons';
import { RapidElement } from '../RapidElement';

export const getFullName = (user: {
  name?: string;
  first_name?: string;
  last_name?: string;
}) => {
  if (user.first_name || user.last_name) {
    return [user.first_name, user.last_name].filter(Boolean).join(' ');
  }
  return user.name || '';
};

export class TembaUser extends RapidElement {
  public static styles = css`
    :host {
      display: flex;
      box-sizing: border-box;
    }

    .wrapper {
      display: flex;
      flex-direction: row;
      align-items: center;
      flex-grow: 1;
    }

    .avatar-circle {
      transform-origin: left center;
    }

    .name {
      flex-grow: 1;
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  `;

  @property({ type: Number })
  scale: number;

  @property({ type: Boolean })
  showName: boolean;

  @property({ type: Boolean })
  system: boolean;

  @property({ type: String, attribute: false })
  bgimage: string = null;

  @property({ type: String, attribute: false })
  bgcolor: string = '#e6e6e6';

  @property({ type: String, attribute: false })
  initials: string = '';

  @property({ type: String })
  name: string;

  @property({ type: String })
  first_name: string;

  @property({ type: String })
  last_name: string;

  @property({ type: String })
  email: string;

  @property({ type: String })
  uuid: string;

  @property({ type: String })
  avatar: string;

  public willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);

    // when system toggles, set the default avatar background while system, and
    // clear it otherwise so a reused element doesn't keep a stale default that
    // would suppress the initials/contact-icon branch. a real `avatar` below
    // can still override this.
    if (changed.has('system')) {
      this.bgimage = this.system
        ? `url('${DEFAULT_AVATAR}') center / contain no-repeat`
        : null;
    }

    if (
      changed.has('name') ||
      changed.has('first_name') ||
      changed.has('last_name')
    ) {
      const fullName = getFullName({
        name: this.name,
        first_name: this.first_name,
        last_name: this.last_name
      });
      if (fullName) {
        this.bgcolor = colorHash.hex(fullName);
        this.initials = extractInitials(fullName);
      } else {
        this.bgcolor = '#e6e6e6';
        this.initials = '';
      }
    }

    if (changed.has('avatar')) {
      if (this.avatar) {
        this.bgimage = `url('${this.avatar}') center / contain no-repeat`;
      } else {
        // clearing the avatar must also clear the image, otherwise a reused
        // element keeps showing the previous user's avatar - fall back to the
        // system default or the initials/contact-icon branch
        this.bgimage = this.system
          ? `url('${DEFAULT_AVATAR}') center / contain no-repeat`
          : null;
      }
    }
  }

  public render(): TemplateResult {
    return html`<div class="wrapper">
      <div
        class="avatar-circle"
        style="
              transform:scale(calc(var(--temba-scale, 1) * ${this.scale || 1}));
              display: flex;
              min-height: 26px;
              min-width: 26px;
              flex-direction: row;
              align-items: center;
              color: #fff;
              border-radius: 100%;
              font-weight: 400;
              overflow: hidden;
              font-size: 0.8em;
              margin-right: max(
                0px,
                calc(0.75em - (1 - var(--temba-scale, 1)) * 26px)
              );
              box-shadow: inset 0 0 0 3px rgba(0, 0, 0, 0.1);
              background:${this.bgimage || this.bgcolor};"
      >
        ${this.bgimage
          ? null
          : this.initials
            ? html` <div
                style="display:flex; flex-direction: column; align-items:center;flex-grow:1"
              >
                <div>${this.initials}</div>
              </div>`
            : // the icon takes its own color, not one a selected row or
              // hovered menu passes down to icons through --icon-color
              html`<temba-icon
                name="${Icon.contact}"
                style="display:flex;flex-grow:1;justify-content:center;--icon-color:rgba(0,0,0,0.35)"
              ></temba-icon>`}
      </div>
      ${this.showName
        ? html`<div
            class="name"
            style="margin: 0px ${this.scale - 0.5}em;font-size:${this.scale +
            0.2}em"
          >
            ${this.name}
          </div>`
        : null}
    </div>`;
  }
}
