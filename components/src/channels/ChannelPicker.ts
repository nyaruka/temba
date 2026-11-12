import { css, html, PropertyValues, TemplateResult } from 'lit';
import { msg, str } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { Modal } from '../layout/Modal';
import { CustomEventType } from '../interfaces';
import { Icon } from '../Icons';
import {
  getUrl,
  postUrl,
  serialize,
  serializeFiles,
  WebResponse
} from '../utils';
import { channelLogoStyles, renderChannelLogo } from './ChannelLogo';

/** A channel type the workspace can add, as given by get_claimable_types */
export interface ClaimableType {
  code: string;
  slug: string;
  name: string;
  category: 'social' | 'phone' | 'api';
  claim_url: string;
  /** whether the claim form can be shown in the picker, else its page is opened */
  in_modal: boolean;
  /** whether the type is available in the workspace's region */
  in_region: boolean;
  recommended: boolean;
}

/** the header claim views look for to render just their form */
const MODAL_HEADER = 'X-Temba-Claim-Modal';

/** the light DOM container the loaded claim form is rendered into */
const FORM_CLASS = 'channel-claim-form';

const hasContent = (node: Node): boolean =>
  node.nodeType === Node.ELEMENT_NODE
    ? (node as HTMLElement).tagName !== 'STYLE' &&
      (!!node.textContent.trim() ||
        !!(node as HTMLElement).querySelector('img'))
    : node.nodeType === Node.TEXT_NODE && !!node.textContent.trim();

const hasContentBefore = (el: HTMLElement): boolean => {
  let node = el.previousSibling;
  while (node) {
    if (hasContent(node)) {
      return true;
    }
    node = node.previousSibling;
  }
  return false;
};

/** whether a URL is a page of a channel type's claim flow, which the modal can show */
const isClaimFlowUrl = (url: string): boolean => {
  const parsed = new URL(url, location.href);
  return (
    parsed.origin === location.origin &&
    parsed.pathname.startsWith('/channels/types/')
  );
};

/** the form of a claim flow page which the picker submits */
const getClaimForm = (container: HTMLElement): HTMLFormElement =>
  (container.querySelector('form[data-claim-form]') ||
    container.querySelector('form.smartmin-form')) as HTMLFormElement;

/** Runs a page's scripts, in order, now its content is in the document */
const runScripts = (scripts: HTMLScriptElement[], container: HTMLElement) => {
  for (const original of scripts) {
    const script = document.createElement('script');
    if (original.src) {
      script.src = original.src;
      script.async = false;
    } else {
      script.textContent = original.textContent;
    }
    container.appendChild(script);
  }
};

const FORM_STYLES_ID = 'channel-claim-form-styles';

/**
 * The claim form lives in the light DOM so the page styles it, which means
 * its tweaks for the modal have to be page styles too, scoped to it: claim
 * templates box their parts in cards for a full page, which the modal
 * doesn't need.
 */
const ensureFormStyles = () => {
  if (document.getElementById(FORM_STYLES_ID)) {
    return;
  }
  const style = document.createElement('style');
  style.id = FORM_STYLES_ID;
  style.textContent = `
    .${FORM_CLASS} .card {
      background: none;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      margin: 0;
      padding: 0;
      overflow: visible;
    }
    .${FORM_CLASS} form .control-group {
      margin-left: 12px;
      margin-right: 12px;
    }
    .${FORM_CLASS} .claim-form-block {
      margin-top: 24px;
    }

    /* errors which aren't about one field, lined up with the fields */
    .${FORM_CLASS} .form-errors {
      margin: 0 12px 16px;
      padding: 10px 14px;
      border: 1px solid #ecc5c0;
      border-radius: var(--curvature);
      background: #fdf3f2;
      color: #9a2e24;
      font-size: 14px;
      line-height: 20px;
    }
    .${FORM_CLASS} .form-errors ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }

    /* a page's main action is shown as the footer's button instead */
    .${FORM_CLASS} [data-claim-action] {
      display: none !important;
    }

    /* signing in with Facebook: its steps, the button, and then the pages to pick from */
    .${FORM_CLASS} #fb-guide {
      margin-top: 12px;
    }
    .${FORM_CLASS} #fb-channel-options {
      margin-top: 20px;
    }

    /* the account a provider's claim flow is using, with a link to change it */
    .${FORM_CLASS} .card.claim-account {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 4px 8px;
      margin: 16px 0 0;
      padding: 10px 14px;
      border-radius: var(--curvature);
      background: rgba(0, 0, 0, 0.03);
      color: var(--color-text-help, #666);
    }
    .${FORM_CLASS} .claim-account > div {
      font-size: inherit;
      font-weight: 600;
      margin: 0;
      color: var(--color-text-dark, #222);
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .${FORM_CLASS} .claim-account > a {
      margin-left: auto;
    }

    /* a number picker's search: the country takes the room, the button sits level with the inputs */
    .${FORM_CLASS} #search-form {
      margin-top: 24px;
    }
    .${FORM_CLASS} #search-form > .flex {
      display: flex;
      align-items: flex-end;
      gap: 12px;
    }
    .${FORM_CLASS} #search-form .country {
      flex: 1;
      width: auto;
      min-width: 0;
      margin: 0;
    }
    .${FORM_CLASS} #search-form .pattern {
      width: 140px;
      margin: 0;
    }
    .${FORM_CLASS} #search-form temba-button {
      flex: none;
      margin: 0;
      align-self: flex-end;
      align-items: flex-end;
      /* centred on the inputs it sits beside, which are a little taller */
      margin-bottom: 3px;
    }
    .${FORM_CLASS} #results {
      margin: 16px 0 0;
    }
    .${FORM_CLASS} #results:empty,
    .${FORM_CLASS} #results.hide {
      display: none;
    }
    .${FORM_CLASS} #throbber {
      margin: 16px 0 0;
    }
    /* the search's own message, e.g. no numbers found */
    .${FORM_CLASS} #claim-message:not(.hide) {
      display: block;
      margin-top: 16px;
    }

    /* the numbers already on the account, as a section of their own */
    .${FORM_CLASS} #account-numbers {
      margin-top: 28px;
      padding-top: 20px;
      border-top: 1px solid rgba(0, 0, 0, 0.1);
    }
    .${FORM_CLASS} .phone-number,
    .${FORM_CLASS} .unsupported-number {
      display: inline-flex;
      align-items: center;
      font-size: 0.9rem;
      padding: 6px 12px;
      margin: 10px 8px 0 0;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
    }
    .${FORM_CLASS} .phone-number {
      cursor: pointer;
    }
    .${FORM_CLASS} .phone-number:hover {
      background: rgba(var(--primary-rgb), 0.12);
      color: var(--color-link-primary);
    }
    .${FORM_CLASS} #account-numbers .title {
      font-size: 1rem;
      font-weight: 600;
      margin: 0 0 2px;
      color: var(--color-text-dark, #222);
    }
  `;
  document.head.appendChild(style);
};

/**
 * The new channel picker - a modal of the channel types the workspace can
 * add, filtered by a category rail and a search box. Picking a type shows
 * its claim form in the same modal, loaded from the type's claim view, with
 * buttons to add the channel, cancel or go back. A type whose claim page
 * can't be shown in a modal (see ChannelType.claim_in_modal) is opened as
 * its full page instead.
 *
 * The claim form is rendered into the light DOM, slotted into the dialog,
 * so it's styled by the page like any other form. Fires `temba-redirected`
 * with a url to navigate to, once a channel is added or a type's page needs
 * opening, and `temba-canceled` when closed without either.
 */
export class ChannelPicker extends RapidElement {
  static get styles() {
    return css`
      ${channelLogoStyles}

      /* the backdrop, the panel and how they come and go are temba-modal's */
      :host {
        display: contents;
        font-family: var(--font);
        color: var(--text-1);
      }

      temba-modal {
        --modal-width: 880px;
        --modal-height: 640px;
      }

      .dialog {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 210px minmax(0, 1fr);
        overflow: hidden;
      }
      .dialog.single {
        grid-template-columns: minmax(0, 1fr);
      }

      /* the category rail */
      .rail {
        border-right: 1px solid var(--border, rgba(0, 0, 0, 0.1));
        background: rgba(0, 0, 0, 0.03);
        padding: 14px 10px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        overflow-y: auto;
      }
      .search {
        width: 100%;
        box-sizing: border-box;
        font: inherit;
        font-size: 0.92rem;
        padding: 8px 10px;
        margin-bottom: 10px;
        border: 1px solid rgba(0, 0, 0, 0.15);
        border-radius: calc(var(--curvature) * 0.75);
        outline: none;
        background: var(--surface, #fff);
        color: inherit;
      }
      .search:focus {
        border-color: var(--color-focus);
        box-shadow: var(--widget-box-shadow-focused);
      }
      .category {
        font: inherit;
        border: 0;
        background: none;
        text-align: left;
        padding: 7px 10px;
        border-radius: 6px;
        cursor: pointer;
        color: inherit;
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .category .count {
        color: var(--text-3);
        font-size: 0.82rem;
        font-variant-numeric: tabular-nums;
      }
      .category:hover {
        background: rgba(0, 0, 0, 0.05);
      }
      .category.selected {
        background: var(--accent-100);
        color: var(--accent-800);
        font-weight: var(--w-semibold, 600);
      }
      .category.selected .count {
        color: var(--accent-600);
      }
      .grow {
        flex: 1;
      }
      .regions {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 0.82rem;
        color: var(--text-2);
        padding: 8px 10px;
        cursor: pointer;
      }

      /* the main pane - the type grid or a type's form */
      .main {
        display: flex;
        flex-direction: column;
        min-width: 0;
        min-height: 0;
      }
      .body {
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        padding: 18px 20px;
      }
      .footer {
        padding: 12px 20px;
        border-top: 1px solid var(--border, rgba(0, 0, 0, 0.1));
        background: rgba(0, 0, 0, 0.03);
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .footer .spacer {
        flex: 1;
      }
      .help {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--color-link-primary);
        font-size: 0.85rem;
        text-decoration: none;
      }
      .help:hover {
        text-decoration: underline;
      }
      .help temba-icon {
        --icon-color: currentColor;
      }

      .section {
        margin-bottom: 22px;
      }
      .section-title {
        font-size: 0.78rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-3);
        margin-bottom: 9px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(106px, 1fr));
        gap: 10px;
      }
      .tile {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 9px;
        padding: 14px 6px 10px;
        border-radius: 10px;
        border: 1px solid transparent;
        background: none;
        cursor: pointer;
        font: inherit;
        color: inherit;
        text-align: center;
        min-width: 0;
      }
      .tile .label {
        font-size: 0.85rem;
        font-weight: 500;
        line-height: 1.25;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .tile .channel-logo {
        transition: transform 0.12s;
      }
      .tile:hover,
      .tile.highlighted {
        background: rgba(0, 0, 0, 0.03);
        border-color: var(--border, rgba(0, 0, 0, 0.1));
      }
      .tile:hover .channel-logo,
      .tile.highlighted .channel-logo {
        transform: scale(1.06);
      }
      .tile:focus-visible {
        outline: 2px solid var(--color-focus);
      }
      /* the channel just added */
      .added {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        gap: 8px;
        padding: 40px;
      }
      .added-logo {
        position: relative;
        margin-bottom: 12px;
      }
      .added-check {
        position: absolute;
        right: -8px;
        bottom: -8px;
        width: 26px;
        height: 26px;
        border-radius: 50%;
        background: #22a06b;
        color: #fff;
        box-shadow: 0 0 0 3px #fff;
        display: flex;
        align-items: center;
        justify-content: center;
        --icon-color: #fff;
      }
      .added-title {
        font-size: 1.4rem;
        font-weight: 600;
        color: var(--text-1);
      }
      .added-name {
        font-size: 1rem;
        color: var(--text-2);
      }
      .added-message {
        max-width: 360px;
        margin-top: 8px;
        color: var(--text-2);
        line-height: 1.5;
      }

      .empty {
        text-align: center;
        color: var(--text-3);
        padding: 40px 10px;
      }

      /* a type's form */
      .form-header {
        display: flex;
        gap: 14px;
        align-items: center;
        padding: 16px 28px;
        border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.1));
      }
      .form-header .title {
        flex: 1;
        min-width: 0;
      }
      .form-header .name {
        display: block;
        font-size: 1.15rem;
        font-weight: 600;
      }
      .form-header .kind {
        color: var(--text-3);
        font-size: 0.82rem;
      }
      .back {
        border: 0;
        background: none;
        width: 32px;
        height: 32px;
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        flex: none;
      }
      .back:hover {
        background: rgba(0, 0, 0, 0.06);
      }
      .loading {
        display: flex;
        justify-content: center;
        padding: 40px;
      }
      /* room around the form so its widgets, and their focus rings, aren't
         against the edges */
      .form-body {
        padding: 20px 28px 28px;
      }
      .form-body.submitting {
        opacity: 0.6;
        pointer-events: none;
      }

      @media (max-width: 720px) {
        .dialog {
          grid-template-columns: 1fr;
          grid-template-rows: auto minmax(0, 1fr);
        }
        .rail {
          border-right: 0;
          border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.1));
          flex-direction: row;
          flex-wrap: wrap;
          gap: 4px;
        }
        .grow,
        .regions {
          display: none;
        }
      }
    `;
  }

  @property({ type: Boolean, reflect: true })
  open = false;

  /** the channel types the workspace can add */
  @property({ type: Array, attribute: false })
  types: ClaimableType[] = [];

  /** help URLs keyed by topic (see get_channel_help_links) */
  @property({ type: Object, attribute: false })
  helpLinks: Record<string, string> = {};

  @state()
  private query = '';

  @state()
  private category = 'all';

  @state()
  private allRegions = false;

  @state()
  private highlighted = 0;

  /** the type whose form is showing, if any */
  @state()
  private selected: ClaimableType = null;

  @state()
  private loading = false;

  @state()
  private submitting = false;

  /** the page of the claim flow being shown - the claim view, or a step before it */
  @state()
  private formUrl: string = null;

  /** whether the claim flow couldn't be shown */
  @state()
  private loadError = false;

  /** whether we're on our way out, while the modal plays its exit */
  @state()
  private closing = false;

  /** the channel just added, which we show before moving on */
  @state()
  private added: { uuid: string; name: string; next: string } = null;

  /** the claim flow steps we've been sent to, to stop going round in circles */
  private visited: string[] = [];

  /** the form we submit, if the page has one we drive */
  @state()
  private claimForm: HTMLFormElement = null;

  /** the page's main action, e.g. signing in with Facebook, which our footer button stands in for */
  @state()
  private claimAction: HTMLElement = null;

  /** re-renders the footer when the page's script shows or hides its action */
  private actionObserver: MutationObserver = null;

  /** Opens the picker on its list of types */
  public show(): void {
    this.closing = false;
    this.query = '';
    this.category = 'all';
    this.highlighted = 0;
    this.selected = null;
    this.clearForm();
    this.open = true;
  }

  /** Closes the picker, once its modal has played its exit */
  public close(fireCanceled = true): void {
    if (!this.open || this.closing) {
      return;
    }
    if (fireCanceled) {
      this.fireCustomEvent(CustomEventType.Canceled, {});
    }

    if (Modal.animates()) {
      // the modal plays its exit, then tells us it's gone (see handleModalClosed)
      this.closing = true;
    } else {
      this.handleModalClosed();
    }
  }

  private handleModalClosed(): void {
    this.closing = false;
    this.open = false;
    this.selected = null;
    this.added = null;
    this.clearForm();
  }

  /** Escape goes back a step before it closes, as does a click outside once a channel's added */
  private handleDismiss(e: CustomEvent): void {
    if (this.added) {
      this.finish();
    } else if (this.selected && e.detail?.reason === 'escape') {
      this.handleBack();
    } else {
      this.close();
    }
  }

  /** Plays an animation on an element of ours, if there is one and we're animating */
  private play(
    selector: string,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
  ): void {
    const el = this.shadowRoot?.querySelector(selector) as HTMLElement;
    if (el && Modal.animates()) {
      el.animate(keyframes, { fill: 'backwards', ...options });
    }
  }

  protected updated(changes: PropertyValues): void {
    super.updated(changes);
    if (changes.has('open')) {
      if (this.open) {
        this.focusSearch();
      }
    }
    if (this.open && !changes.has('open')) {
      this.animateProgress(changes);
    }
  }

  /** Moves the content along as we go from step to step */
  private animateProgress(changes: PropertyValues): void {
    const slide = (from: string) => [
      { opacity: 0, transform: from },
      { opacity: 1, transform: 'none' }
    ];
    const ease = 'cubic-bezier(.16,1,.3,1)';

    if (changes.has('added') && this.added) {
      // the channel's arrival gets a little celebration
      this.play(
        '.added-logo',
        [
          { opacity: 0, transform: 'scale(0.6)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 520, easing: 'cubic-bezier(.22,1.28,.36,1)' }
      );
      this.play(
        '.added-check',
        [
          { opacity: 0, transform: 'scale(0)' },
          { opacity: 1, transform: 'none' }
        ],
        { delay: 260, duration: 420, easing: 'cubic-bezier(.22,1.28,.36,1)' }
      );
      ['.added-title', '.added-name', '.added-message', '.footer'].forEach(
        (selector, i) =>
          this.play(selector, slide('translateY(8px)'), {
            delay: 160 + i * 60,
            duration: 360,
            easing: ease
          })
      );
    } else if (changes.has('selected')) {
      // into a type's form from the right, back to the types from the left
      const forward = !!this.selected;
      this.play(
        '.main',
        slide(forward ? 'translateX(28px)' : 'translateX(-28px)'),
        { duration: 300, easing: ease }
      );
    } else if (
      changes.has('formUrl') &&
      changes.get('formUrl') &&
      this.selected
    ) {
      // on to the next step of the same type, e.g. from connecting an account to picking a number
      this.play('.form-body', slide('translateY(10px)'), {
        duration: 280,
        easing: ease
      });
    }
  }

  private focusSearch(): void {
    this.updateComplete.then(() => {
      const search = this.shadowRoot.querySelector(
        '.search'
      ) as HTMLInputElement;
      search?.focus();
    });
  }

  private getCategories(): { key: string; name: string }[] {
    return [
      { key: 'social', name: msg('Social & Chat') },
      { key: 'phone', name: msg('SMS & Voice') },
      { key: 'api', name: msg('Developer') }
    ];
  }

  /** the types in the workspace's region (or all of them) which match the search */
  private getMatching(): ClaimableType[] {
    const q = this.query.trim().toLowerCase();
    const names = Object.fromEntries(
      this.getCategories().map((c) => [c.key, c.name.toLowerCase()])
    );
    return this.types.filter(
      (t) =>
        (this.allRegions || t.in_region || t.recommended) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          (names[t.category] || '').includes(q))
    );
  }

  private inCategory(type: ClaimableType, category: string): boolean {
    if (category === 'all') return true;
    if (category === 'recommended') return type.recommended;
    return type.category === category;
  }

  /** the types shown in the grid, in the order they're shown */
  private getGroups(): { name: string; types: ClaimableType[] }[] {
    const matching = this.getMatching().filter((t) =>
      this.inCategory(t, this.category)
    );
    if (this.category === 'all' && !this.query.trim()) {
      return this.getCategories()
        .map((c) => ({
          name: c.name,
          types: matching.filter((t) => t.category === c.key)
        }))
        .filter((g) => g.types.length > 0);
    }
    return matching.length > 0 ? [{ name: null, types: matching }] : [];
  }

  private getVisible(): ClaimableType[] {
    return this.getGroups().flatMap((g) => g.types);
  }

  /** the type's own setup article, if it has one - a general one wouldn't help with the form at hand */
  private getGuideUrl(type: ClaimableType): string {
    return this.helpLinks?.[`channels.types.${type.slug}`] || null;
  }

  private handleSearchKey(e: KeyboardEvent): void {
    const visible = this.getVisible();
    if (visible.length === 0) {
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this.highlighted =
        (this.highlighted + step + visible.length) % visible.length;
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.pick(visible[Math.min(this.highlighted, visible.length - 1)]);
    }
  }

  private handleSearchInput(e: InputEvent): void {
    this.query = (e.target as HTMLInputElement).value;
    this.highlighted = 0;
    if (this.selected) {
      this.handleBack();
    }
  }

  private handleCategory(category: string): void {
    this.category = category;
    this.highlighted = 0;
    if (this.selected) {
      this.handleBack();
    }
  }

  private handleBack(): void {
    this.selected = null;
    this.submitting = false;
    this.clearForm();
    this.focusSearch();
  }

  /** Shows a type's form, or opens its claim page if it can't be shown here */
  public pick(type: ClaimableType): void {
    if (!type.in_modal) {
      this.close(false);
      this.fireCustomEvent(CustomEventType.Redirected, {
        url: type.claim_url
      });
      return;
    }

    this.selected = type;
    this.visited = [];
    this.load(type.claim_url);
  }

  /** Loads a page of the selected type's claim flow into the modal */
  private load(url: string): void {
    const type = this.selected;
    this.formUrl = url;
    this.loadError = false;
    this.loading = true;
    this.submitting = false;
    this.clearForm();
    getUrl(url, null, { [MODAL_HEADER]: '1' })
      .then((response) => {
        if (this.selected !== type || this.formUrl !== url) {
          return;
        }
        this.loading = false;
        this.handleResponse(response);
      })
      .catch(() => {
        // the page couldn't be loaded here, so fall back to opening it
        this.close(false);
        this.fireCustomEvent(CustomEventType.Redirected, { url });
      });
  }

  /**
   * Handles a response from the claim flow - the next step of it is loaded
   * here, anywhere else (e.g. the new channel) is navigated to, and anything
   * else is a form to show
   */
  private handleResponse(response: WebResponse): void {
    const success = response.headers.get('X-Temba-Success');
    if (success) {
      if (isClaimFlowUrl(success)) {
        // steps which only send us on to each other would otherwise go round forever
        if (this.visited.includes(success)) {
          this.loadError = true;
          return;
        }
        this.visited.push(success);
        this.load(success);
        return;
      }
      // a new channel gets a moment of its own before we move on, with what to do next
      const uuid = response.headers.get('X-Temba-Channel');
      if (uuid) {
        this.clearForm();
        this.added = {
          uuid,
          name: decodeURIComponent(
            response.headers.get('X-Temba-Channel-Name') || ''
          ),
          next: success
        };
        return;
      }
      this.close(false);
      this.fireCustomEvent(CustomEventType.Redirected, { url: success });
      return;
    }
    this.setForm(response.body);
  }

  private getFormContainer(): HTMLElement {
    return this.querySelector(`.${FORM_CLASS}`) as HTMLElement;
  }

  private clearForm(): void {
    this.getFormContainer()?.remove();
    this.claimForm = null;
    this.claimAction = null;
    this.actionObserver?.disconnect();
    this.actionObserver = null;
  }

  /** Renders a claim flow page into the light DOM, where the page styles it */
  private setForm(body: string): void {
    this.clearForm();
    const container = document.createElement('div');
    container.className = FORM_CLASS;
    container.slot = 'form';
    container.innerHTML = body;

    // our footer has the buttons for the form we submit, a form of the page's own (e.g. a number search) keeps its
    getClaimForm(container)
      ?.querySelectorAll(
        '.form-actions, input[type="submit"], button[type="submit"]'
      )
      .forEach((el) => el.remove());

    // the page's scripts are run once it's in place, as they would be on the page
    const scripts = Array.from(container.querySelectorAll('script'));
    scripts.forEach((el) => el.remove());

    // the form we submit - a page can name it with data-claim-form, else it's the smartmin form
    const form = getClaimForm(container);
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.submit();
      });
      // a page script submitting it, e.g. on picking a number, goes through us too
      (form as any).submit = () => this.submit();
      // a page whose form is hidden, e.g. a number picker, is laid out its own way
      if (form.style.display !== 'none') {
        this.spaceForm(container, form);
      }
    }
    this.claimForm = form;

    // a page whose main action isn't submitting a form, e.g. signing in with Facebook, can mark it with
    // data-claim-action, so it sits in our footer like any other step's button
    this.claimAction = container.querySelector('[data-claim-action]');
    if (this.claimAction) {
      this.actionObserver = new MutationObserver(() => this.requestUpdate());
      this.actionObserver.observe(container, {
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }

    // pressing enter in a field submits its form natively, which would skip the page's own handling of it (e.g. a
    // number search) and navigate away - so have the page's other forms submit through their handlers too
    container.querySelectorAll('form').forEach((f) => {
      if (f !== form) {
        (f as any).submit = () => f.requestSubmit();
      }
    });

    // a form's own handlers deal with its submits here, so the page's handling of them (which navigates) mustn't
    container.addEventListener('submit', (e) => e.stopPropagation());

    // links to other steps of the claim flow, e.g. to change accounts, stay in the modal
    container.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement).closest('a');
      const href = link?.getAttribute('href');
      if (href && !link.target && isClaimFlowUrl(href)) {
        e.preventDefault();
        e.stopPropagation();
        this.load(href);
      }
    });

    ensureFormStyles();
    this.appendChild(container);
    runScripts(scripts, container);
    if (Modal.animates()) {
      container.animate(
        [
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 240, easing: 'cubic-bezier(.16,1,.3,1)' }
      );
    }

    this.updateComplete.then(() => {
      const first = container.querySelector(
        'temba-textinput, temba-select, input:not([type="hidden"]), select, textarea'
      ) as HTMLElement;
      first?.focus();
    });
  }

  /** Gives the form room above it, whether the page's intro or the header is there */
  private spaceForm(container: HTMLElement, form: HTMLElement) {
    // climb from the form to the wrapper which sits after the intro
    let block: HTMLElement = form;
    while (
      block.parentElement &&
      block.parentElement !== container &&
      !hasContentBefore(block)
    ) {
      block = block.parentElement;
    }
    block.classList.add('claim-form-block');
  }

  /** Posts the claim form, then navigates to the new channel or shows any errors */
  public submit(): void {
    const form = this.claimForm;
    if (!this.selected || !form || this.submitting) {
      return;
    }

    let payload: any = serialize(form);
    let contentType = 'application/x-www-form-urlencoded';
    const files = serializeFiles(form);
    if (files) {
      new URLSearchParams(payload).forEach((value, key) =>
        files.append(key, value)
      );
      payload = files;
      contentType = null;
    }

    const type = this.selected;
    const url = form.getAttribute('action') || this.formUrl;
    // what the user entered may change where the flow goes, so it can revisit steps
    this.visited = [];
    this.submitting = true;
    this.showSubmitError(false);
    postUrl(url, payload, { [MODAL_HEADER]: '1' }, contentType)
      .then((response) => {
        if (this.selected !== type) {
          return;
        }
        this.submitting = false;
        this.handleResponse(response);
      })
      .catch(() => {
        if (this.selected === type) {
          this.submitting = false;
          this.showSubmitError(true);
        }
      });
  }

  /**
   * Shows or clears an error for a submit which failed without the claim view saying why. It goes at the top of the
   * form, where the claim view's own errors go, so it looks and reads just like them.
   */
  private showSubmitError(show: boolean): void {
    const form = this.claimForm;
    form?.querySelector(':scope > .form-errors.submit-failed')?.remove();
    if (!show || !form) {
      return;
    }
    const error = document.createElement('div');
    error.className = 'alert alert-error form-errors submit-failed';
    error.textContent = msg(
      'Something went wrong adding this channel. Check what you entered and try again.'
    );
    form.prepend(error);
    if (Modal.animates()) {
      error.animate(
        [
          { opacity: 0, transform: 'translateY(-4px)' },
          { opacity: 1, transform: 'none' }
        ],
        { duration: 220, easing: 'cubic-bezier(.16,1,.3,1)' }
      );
    }
  }

  /** whether the page has a visible form for our button to submit - a number picker submits its own */
  private isFormShown(): boolean {
    return !!this.claimForm && this.claimForm.style.display !== 'none';
  }

  /** whether the page has a main action of its own showing, which our footer button stands in for */
  private isActionShown(): boolean {
    return (
      !!this.claimAction && !this.loading && !this.claimAction.closest('.hide')
    );
  }

  /** whether the page showing is the type's claim view, rather than a step before it */
  private isClaimStep(): boolean {
    return (
      !!this.selected &&
      !!this.formUrl &&
      new URL(this.formUrl, location.href).pathname ===
        new URL(this.selected.claim_url, location.href).pathname
    );
  }

  private renderRail(): TemplateResult {
    const matching = this.getMatching();
    const count = (key: string) =>
      matching.filter((t) => this.inCategory(t, key)).length;
    const categories = [
      { key: 'all', name: msg('All') },
      { key: 'recommended', name: msg('Recommended') },
      ...this.getCategories()
    ].filter((c) => c.key === 'all' || count(c.key) > 0);
    const hasOtherRegions = this.types.some(
      (t) => !t.in_region && !t.recommended
    );

    return html`<div class="rail">
      <input
        class="search"
        type="search"
        placeholder=${msg('Search')}
        aria-label=${msg('Search channel types')}
        .value=${this.query}
        @input=${this.handleSearchInput}
        @keydown=${this.handleSearchKey}
        autocomplete="off"
      />
      ${categories.map(
        (c) =>
          html`<button
            class="category ${this.category === c.key ? 'selected' : ''}"
            @click=${() => this.handleCategory(c.key)}
          >
            ${c.name}<span class="count">${count(c.key)}</span>
          </button>`
      )}
      <span class="grow"></span>
      ${hasOtherRegions
        ? html`<label class="regions"
            ><input
              type="checkbox"
              .checked=${this.allRegions}
              @change=${(e: Event) => {
                this.allRegions = (e.target as HTMLInputElement).checked;
                this.highlighted = 0;
              }}
            />${msg('Show other regions')}</label
          >`
        : null}
    </div>`;
  }

  private renderHelp(url: string, label: string): TemplateResult {
    if (!url) {
      return null;
    }
    return html`<a class="help" href=${url} target="_blank" rel="noopener"
      >${label}<temba-icon name=${Icon.link} size="0.8"></temba-icon
    ></a>`;
  }

  private renderTypes(): TemplateResult {
    const groups = this.getGroups();
    let index = 0;
    const body = groups.length
      ? groups.map(
          (g) =>
            html`<div class="section">
              ${g.name
                ? html`<div class="section-title">${g.name}</div>`
                : null}
              <div class="grid">
                ${g.types.map((t) => {
                  const highlighted =
                    !!this.query.trim() && index++ === this.highlighted;
                  return html`<button
                    class="tile ${highlighted ? 'highlighted' : ''}"
                    title=${t.name}
                    @click=${() => this.pick(t)}
                  >
                    ${renderChannelLogo(t.code, t.name, 50)}
                    <span class="label">${t.name}</span>
                  </button>`;
                })}
              </div>
            </div>`
        )
      : html`<div class="empty">
          ${msg('No channel types match your search')}
        </div>`;

    return html`<div class="main">
      <div class="body">${body}</div>
      <div class="footer">
        ${this.renderHelp(
          this.helpLinks?.['channels'],
          msg('Which channel should I use?')
        )}
        <span class="spacer"></span>
        <temba-button
          name=${msg('Cancel')}
          secondary
          @click=${() => this.close()}
        ></temba-button>
      </div>
    </div>`;
  }

  private renderForm(): TemplateResult {
    const type = this.selected;
    const kind =
      this.getCategories().find((c) => c.key === type.category)?.name || '';

    return html`<div class="main">
      <div class="form-header">
        <button
          class="back"
          aria-label=${msg('Back to channel types')}
          @click=${this.handleBack}
        >
          <temba-icon name=${Icon.arrow_left} size="1.2"></temba-icon>
        </button>
        ${renderChannelLogo(type.code, type.name, 40)}
        <div class="title">
          <span class="name">${type.name}</span>
          <span class="kind">${kind}</span>
        </div>
        ${this.renderHelp(this.getGuideUrl(type), msg('Setup guide'))}
      </div>
      <div class="body form-body ${this.submitting ? 'submitting' : ''}">
        ${this.loadError
          ? html`<div class="empty">
              ${msg('This channel type could not be loaded. Try again later.')}
            </div>`
          : this.loading
            ? html`<div class="loading">
                <temba-loading units="6" size="8"></temba-loading>
              </div>`
            : html`<slot name="form"></slot>`}
      </div>
      <div class="footer">
        <span class="spacer"></span>
        <temba-button
          name=${msg('Cancel')}
          secondary
          @click=${() => this.close()}
        ></temba-button>
        ${!this.loadError && this.isActionShown()
          ? html`<temba-button
              name=${this.claimAction.getAttribute('name') ||
              this.claimAction.textContent.trim()}
              primary
              @click=${() => this.claimAction.click()}
            ></temba-button>`
          : !this.loadError && (this.loading || this.isFormShown())
            ? html`<temba-button
                name=${this.isClaimStep()
                  ? msg('Add Channel')
                  : msg('Continue')}
                primary
                ?disabled=${this.loading}
                ?submitting=${this.submitting}
                @click=${() => this.submit()}
              ></temba-button>`
            : null}
      </div>
    </div>`;
  }

  /** whether the channel just added has setup to finish on the provider's side, which its configuration page shows */
  private needsSetup(): boolean {
    return /\/configuration\//.test(
      new URL(this.added.next, location.href).pathname
    );
  }

  /** Leaves the added channel for the given page, by default refreshing this one so the list shows it */
  private finish(url: string = null): void {
    const target = url || location.pathname + location.search;
    this.added = null;
    this.close(false);
    this.fireCustomEvent(CustomEventType.Redirected, { url: target });
  }

  private renderAdded(): TemplateResult {
    const type = this.selected;
    const setup = this.needsSetup();
    const readUrl = `/channels/channel/read/${this.added.uuid}/`;

    return html`<div class="main">
      <div class="body added">
        <div class="added-logo">
          ${renderChannelLogo(type.code, type.name, 64)}
          <span class="added-check"
            ><temba-icon name=${Icon.check} size="1"></temba-icon
          ></span>
        </div>
        <div class="added-title">${msg('Channel added')}</div>
        ${this.added.name
          ? html`<div class="added-name">${this.added.name}</div>`
          : null}
        <div class="added-message">
          ${setup
            ? msg(
                str`One more step: finish setting it up with ${type.name} so messages reach your workspace.`
              )
            : msg("It's ready to send and receive messages.")}
        </div>
      </div>
      <div class="footer">
        <span class="spacer"></span>
        ${setup
          ? html`<temba-button
                name=${msg('Later')}
                secondary
                @click=${() => this.finish()}
              ></temba-button>
              <temba-button
                name=${msg('Finish setup')}
                primary
                @click=${() => this.finish(this.added.next)}
              ></temba-button>`
          : html`<temba-button
                name=${msg('View channel')}
                secondary
                @click=${() => this.finish(readUrl)}
              ></temba-button>
              <temba-button
                name=${msg('Done')}
                primary
                @click=${() => this.finish()}
              ></temba-button>`}
      </div>
    </div>`;
  }

  public render(): TemplateResult {
    if (!this.open) {
      return html``;
    }
    return html`
      <temba-modal
        .open=${!this.closing}
        label=${msg('New Channel')}
        @temba-dismiss-requested=${this.handleDismiss}
        @temba-modal-closed=${this.handleModalClosed}
      >
        <div class="dialog ${this.added ? 'single' : ''}">
          ${this.added
            ? this.renderAdded()
            : html`${this.renderRail()}
              ${this.selected ? this.renderForm() : this.renderTypes()}`}
        </div>
      </temba-modal>
    `;
  }
}
