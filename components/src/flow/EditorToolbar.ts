import { css, html, TemplateResult } from 'lit';
import { msg, str } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { CustomEventType } from '../interfaces';
import { Icon } from '../Icons';

export interface LanguageOption {
  name: string;
  value: string;
  percent?: number;
}

export const PRIMARY_LANGUAGE_OPTION_VALUE = '__primary_language__';

export class EditorToolbar extends RapidElement {
  static get styles() {
    return css`
      :host {
        display: block;
      }

      /* buttons take the browser's own font unless told otherwise */
      button {
        font-family: var(--font-family);
      }

      .editor-toolbar {
        --toolbar-control-height: 28px;
        --toolbar-translation-control-height: 28px;
        display: flex;
        align-items: center;
        padding: 6px 12px;
        background: #fff;
        border-bottom: 1px solid #e8e8e8;
        flex-shrink: 0;
        gap: 8px;
      }

      .toolbar-left {
        display: flex;
        align-items: center;
        gap: 2px;
      }

      .toolbar-right {
        display: flex;
        align-items: center;
        gap: 2px;
        margin-left: auto;
      }

      .toolbar-btn {
        width: var(--toolbar-control-height);
        height: var(--toolbar-control-height);
        border: none;
        background: transparent;
        border-radius: var(--curvature);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        color: #888;
        font-size: 16px;
        line-height: 1;
        outline: none;
      }

      .toolbar-btn:focus {
        outline: none;
      }

      .toolbar-btn:focus-visible {
        outline: 2px solid #0064c8;
        outline-offset: 2px;
      }

      .toolbar-btn:hover {
        background: rgba(0, 0, 0, 0.06);
        color: #555;
      }

      .toolbar-btn:disabled {
        opacity: 0.3;
        cursor: default;
        background: transparent;
      }

      .toolbar-btn.active {
        background: rgba(0, 100, 200, 0.1);
        color: #0064c8;
      }

      .toolbar-btn.active:hover {
        background: rgba(0, 100, 200, 0.15);
      }

      .toolbar-tip {
        display: flex;
        align-items: center;
      }

      .toolbar-divider {
        width: 1px;
        height: 16px;
        background: #e0e0e0;
        margin: 0 4px;
      }

      .toolbar-group {
        display: flex;
        align-items: center;
        gap: 4px;
        height: var(--toolbar-control-height);
        box-sizing: border-box;
        padding: 0 3px;
        border: 1px solid #d7dce2;
        border-radius: calc(var(--curvature) + 2px);
        background: #f7f9fb;
      }

      .toolbar-group-divider {
        width: 1px;
        height: 18px;
        background: #d7dce2;
        margin: 0 2px;
      }

      .toolbar-language {
        position: relative;
        display: flex;
        align-items: center;
      }

      .toolbar-language-group {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-left: 2px;
      }

      .toolbar-zoom-group {
        gap: 2px;
      }

      .language-pill {
        display: flex;
        align-items: center;
        gap: 6px;
        background: #e9eef4;
        color: #0064c8;
        height: var(--toolbar-translation-control-height);
        padding: 0 8px;
        border-radius: var(--curvature);
        box-sizing: border-box;
        font-size: 13px;
        font-weight: 400;
        white-space: nowrap;
        cursor: pointer;
        --icon-color: #0064c8;
        --icon-size: 16px;
        border: none;
        outline: none;
      }

      .language-pill:hover {
        filter: brightness(1.04);
      }

      .language-pill.primary {
        background: #fff;
        border: 1px solid #d7dce2;
      }

      .language-pill.complete {
        background: #d4f5e0;
        color: #1a7f37;
        --icon-color: #1a7f37;
      }

      .language-pill-caret {
        margin-left: 1px;
        --icon-color: currentColor;
        --icon-size: 12px;
      }

      .language-percent {
        display: inline-block;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        color: #0064c8;
        white-space: nowrap;
      }

      .language-pill.complete .language-percent {
        color: #1a7f37;
      }

      .toolbar-btn.make-default {
        width: var(--toolbar-translation-control-height);
        height: var(--toolbar-translation-control-height);
      }

      .toolbar-zoom-level {
        font-size: 12px;
        min-width: 40px;
        text-align: center;
        color: #555;
        font-weight: 500;
      }

      .toolbar-translation {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .toolbar-btn.language-tool {
        width: var(--toolbar-translation-control-height);
        height: var(--toolbar-translation-control-height);
      }
    `;
  }

  @property({ type: Boolean, attribute: 'message-view' })
  messageView = false;

  @property({ type: Number })
  zoom = 1.0;

  @property({ type: Boolean, attribute: 'zoom-initialized' })
  zoomInitialized = false;

  @property({ type: Boolean, attribute: 'zoom-fitted' })
  zoomFitted = false;

  @property({ type: Boolean, attribute: 'revisions-active' })
  revisionsActive = false;

  @property({ type: Boolean, attribute: 'is-saving' })
  isSaving = false;

  @property({ type: Boolean, attribute: 'search-disabled' })
  searchDisabled = false;

  @property({ type: Array })
  languageOptions: LanguageOption[] = [];

  @property({ type: String, attribute: 'current-language-name' })
  currentLanguageName = '';

  @property({ type: Boolean, attribute: 'is-base-language' })
  isBaseLanguage = true;

  @property({ type: Number, attribute: 'language-percent' })
  languagePercent = 0;

  @property({ type: Boolean, attribute: 'show-localization-tools' })
  showLocalizationTools = false;

  @property({ type: Boolean, attribute: 'can-make-default' })
  canMakeDefault = false;

  @property({ type: Boolean, attribute: 'has-pending-translations' })
  hasPendingTranslations = false;

  @property({ type: Boolean, attribute: 'auto-translate-disabled' })
  autoTranslateDisabled = false;

  @property({ type: Boolean, attribute: 'auto-translating' })
  autoTranslating = false;

  @state()
  private showLanguageOptions = false;

  private fireToolbarAction(action: string, detail: any = {}): void {
    this.fireCustomEvent(CustomEventType.ButtonClicked, { action, ...detail });
  }

  private handleLanguageIconClick(): void {
    if (this.showLanguageOptions) {
      this.showLanguageOptions = false;
      return;
    }
    this.showLanguageOptions = true;
    requestAnimationFrame(() => {
      const close = () => {
        this.showLanguageOptions = false;
        document.removeEventListener('click', close);
      };
      document.addEventListener('click', close, { once: true });
    });
  }

  private handleLanguageOptionSelected(event: CustomEvent): void {
    if (!this.showLanguageOptions) return;
    const selected = event.detail?.selected;
    if (selected?.value === PRIMARY_LANGUAGE_OPTION_VALUE) {
      this.fireToolbarAction('language-change', { isPrimary: true });
    } else if (selected?.value) {
      this.fireToolbarAction('language-change', {
        languageCode: selected.value
      });
    }
    this.showLanguageOptions = false;
  }

  private isMacPlatform(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      /Mac|iPod|iPhone|iPad/.test(navigator.platform)
    );
  }

  private getSearchShortcutLabel(): string {
    return this.isMacPlatform() ? '⌘F' : 'Ctrl+F';
  }

  private renderTip(
    text: string | TemplateResult,
    content: TemplateResult
  ): TemplateResult {
    return html`
      <temba-tip
        class="toolbar-tip"
        .text=${typeof text === 'string' ? text : ''}
        .content=${typeof text === 'string' ? null : text}
        position="top"
      >
        ${content}
      </temba-tip>
    `;
  }

  private renderShortcutLabel(label: string, shortcut: string): TemplateResult {
    return html`<span style="display:inline-flex; align-items:center; gap:8px;">
      <span>${label}</span>
      <kbd>${shortcut}</kbd>
    </span>`;
  }

  private renderLanguageOption(
    option: LanguageOption,
    selected: boolean
  ): TemplateResult {
    if (option.value === PRIMARY_LANGUAGE_OPTION_VALUE) {
      const primaryBackground = selected ? '#e1e8ef' : '#edf1f5';
      return html`
        <div
          style="display:flex; align-items:center; justify-content:space-between; gap:8px; background:${primaryBackground}; color:#2f3f52; border-radius:4px; padding:6px 10px;"
        >
          <span>${option.name}</span>
          <span
            style="display:inline-flex; align-items:center; border-radius:999px; background:rgba(47, 63, 82, 0.12); color:#2f3f52; font-size:10px; font-weight:700; line-height:1; padding:3px 7px;"
            >${msg('Original')}</span
          >
        </div>
      `;
    }

    const isComplete = option.percent === 100;
    const optionBg = isComplete ? '#d4f5e0' : '';
    const optionHoverBg = isComplete ? '#c0edce' : '';
    const optionRadius = isComplete ? 'border-radius:4px;' : '';
    const percentColor = isComplete ? 'color:#1a7f37;' : 'color:#5f6b7a;';

    return html`
      <div
        style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 10px; ${optionBg
          ? `background:${optionBg};`
          : ''} ${optionRadius}"
        @mouseenter=${isComplete
          ? (e: MouseEvent) => {
              (e.currentTarget as HTMLElement).style.background = optionHoverBg;
            }
          : null}
        @mouseleave=${isComplete
          ? (e: MouseEvent) => {
              (e.currentTarget as HTMLElement).style.background = optionBg;
            }
          : null}
      >
        <span style="${isComplete ? 'color:#1a7f37;' : ''}"
          >${option.name}</span
        >
        <span style="font-size:11px; font-weight:600; ${percentColor}"
          >${option.percent ?? 0}%</span
        >
      </div>
    `;
  }

  public render(): TemplateResult {
    const showLanguageControls = this.languageOptions.length > 1;
    const searchTargetLabel = this.messageView
      ? msg('Search table')
      : msg('Search flow');

    return html`
      <div class="editor-toolbar">
        <div class="toolbar-left">
          ${this.renderTip(
            msg('Flow View'),
            html`
              <button
                class="toolbar-btn ${!this.messageView ? 'active' : ''}"
                @click=${() =>
                  this.fireToolbarAction('view-change', { view: 'flow' })}
                aria-label=${msg('Flow View')}
              >
                <temba-icon name="flow" size="1"></temba-icon>
              </button>
            `
          )}
          ${this.renderTip(
            msg('Table View'),
            html`
              <button
                class="toolbar-btn ${this.messageView ? 'active' : ''}"
                @click=${() =>
                  this.fireToolbarAction('view-change', { view: 'table' })}
                aria-label=${msg('Table View')}
              >
                <temba-icon name=${Icon.quick_replies} size="1"></temba-icon>
              </button>
            `
          )}
          ${showLanguageControls
            ? html`
                <div class="toolbar-divider"></div>
                <div class="toolbar-language-group">
                  <div class="toolbar-language">
                    ${this.renderTip(
                      msg('Change language'),
                      html`
                        <button
                          class="language-pill ${this.isBaseLanguage
                            ? 'primary'
                            : this.languagePercent === 100
                              ? 'complete'
                              : ''}"
                          id="language-btn"
                          @click=${this.handleLanguageIconClick}
                          aria-label=${msg('Change language')}
                        >
                          <temba-icon name=${Icon.language}></temba-icon>
                          <span>${this.currentLanguageName}</span>
                          ${!this.isBaseLanguage
                            ? html`<span class="language-percent"
                                >${this.languagePercent}%</span
                              >`
                            : ''}
                          <temba-icon
                            class="language-pill-caret"
                            name=${this.showLanguageOptions
                              ? Icon.arrow_up
                              : Icon.arrow_down}
                          ></temba-icon>
                        </button>
                      `
                    )}
                    <temba-options
                      .anchorTo=${this.shadowRoot?.querySelector(
                        '#language-btn'
                      ) as HTMLElement}
                      .options=${this.languageOptions}
                      .renderOption=${this.renderLanguageOption}
                      ?visible=${this.showLanguageOptions}
                      @temba-selection=${this.handleLanguageOptionSelected}
                      style="--temba-options-option-margin:4px; --temba-options-option-padding:0; --temba-options-option-radius:4px;"
                      min-width="230"
                    ></temba-options>
                  </div>
                  ${this.canMakeDefault ? this.renderMakeDefaultButton() : ''}
                  ${this.showLocalizationTools
                    ? this.renderTranslationTools()
                    : ''}
                </div>
              `
            : ''}
        </div>
        <div class="toolbar-right">
          ${!this.messageView
            ? html`
                ${this.renderTip(
                  msg('Zoom to fit'),
                  html`
                    <button
                      class="toolbar-btn"
                      @click=${() => this.fireToolbarAction('zoom-to-fit')}
                      ?disabled=${!this.zoomInitialized || this.zoomFitted}
                      aria-label=${msg('Zoom to fit')}
                    >
                      <temba-icon name=${Icon.zoom_fit} size="1"></temba-icon>
                    </button>
                  `
                )}
                <div class="toolbar-divider"></div>
                ${this.renderTip(
                  msg('Zoom out'),
                  html`
                    <button
                      class="toolbar-btn"
                      @click=${() => this.fireToolbarAction('zoom-out')}
                      ?disabled=${!this.zoomInitialized || this.zoom <= 0.3}
                      aria-label=${msg('Zoom out')}
                    >
                      −
                    </button>
                  `
                )}
                <span class="toolbar-zoom-level"
                  >${this.zoomInitialized
                    ? `${Math.round(this.zoom * 100)}%`
                    : ''}</span
                >
                ${this.renderTip(
                  msg('Zoom in'),
                  html`
                    <button
                      class="toolbar-btn"
                      @click=${() => this.fireToolbarAction('zoom-in')}
                      ?disabled=${!this.zoomInitialized || this.zoom >= 1.0}
                      aria-label=${msg('Zoom in')}
                    >
                      +
                    </button>
                  `
                )}
                <div class="toolbar-divider"></div>
                ${this.renderTip(
                  msg('Zoom to 100%'),
                  html`
                    <button
                      class="toolbar-btn"
                      @click=${() => this.fireToolbarAction('zoom-to-full')}
                      ?disabled=${!this.zoomInitialized || this.zoom >= 1.0}
                      aria-label=${msg('Zoom to 100%')}
                    >
                      <temba-icon name=${Icon.zoom_in} size="1"></temba-icon>
                    </button>
                  `
                )}
                <div class="toolbar-divider"></div>
              `
            : ''}
          ${this.renderTip(
            msg('Revisions'),
            html`
              <button
                class="toolbar-btn ${this.revisionsActive ? 'active' : ''}"
                @click=${() => this.fireToolbarAction('revisions')}
                aria-label=${msg('Revisions')}
              >
                <temba-icon
                  name=${this.isSaving ? 'progress_spinner' : 'revisions'}
                  size="1"
                  ?spin=${this.isSaving}
                ></temba-icon>
              </button>
            `
          )}
          <div class="toolbar-divider"></div>
          ${this.renderTip(
            this.renderShortcutLabel(
              searchTargetLabel,
              this.getSearchShortcutLabel()
            ),
            html`
              <button
                class="toolbar-btn"
                @click=${() => this.fireToolbarAction('search')}
                ?disabled=${this.searchDisabled}
                aria-label=${searchTargetLabel}
              >
                <temba-icon name=${Icon.search} size="1"></temba-icon>
              </button>
            `
          )}
        </div>
      </div>
    `;
  }

  private renderMakeDefaultButton(): TemplateResult {
    return this.renderTip(
      msg(str`Make ${this.currentLanguageName} the default`),
      html`
        <button
          class="toolbar-btn language-tool make-default"
          @click=${() => this.fireToolbarAction('make-default-language')}
          aria-label=${msg('Make default language')}
        >
          <temba-icon name=${Icon.language_default} size="1"></temba-icon>
        </button>
      `
    );
  }

  private renderTranslationTools(): TemplateResult {
    if (!this.hasPendingTranslations && !this.autoTranslating) {
      return html``;
    }
    const label = this.autoTranslating
      ? msg('Stop auto translate')
      : msg('Auto translate');
    return html`
      <div class="toolbar-translation">
        ${this.renderTip(
          label,
          html`
            <button
              class="toolbar-btn language-tool ${this.autoTranslating
                ? 'active'
                : ''}"
              @click=${() => this.fireToolbarAction('auto-translate')}
              ?disabled=${this.autoTranslateDisabled}
              aria-label=${label}
            >
              <temba-icon
                name=${this.autoTranslating ? 'progress_spinner' : Icon.ai}
                size="1"
                ?spin=${this.autoTranslating}
              ></temba-icon>
            </button>
          `
        )}
      </div>
    `;
  }
}
