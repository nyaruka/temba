import { css, html, PropertyValues, TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { Contact, CustomEventType } from '../interfaces';
import { Events } from '../events/eventRenderers';
import { getDestinationURN } from '../live/ContactStoreElement';
import { watchContact } from '../live/ContactWatch';
import { RealtimeSubscription } from '../live/Realtime';

/**
 * A contact's name, optionally with the URN that will be used to message
 * them. Given a contact uuid it manages itself: it registers interest in name
 * events with the central contact watcher, which delivers the initial value
 * and any live changes through the same handler - the component never fetches
 * anything. Alternatively the name and urn can be set explicitly for static
 * rendering (e.g. rows of a list that arrived in one fetch).
 */
export class ContactName extends RapidElement {
  @property({ type: String })
  name: string;

  @property({ type: String })
  urn: string;

  // when set, name and urn are kept live by the central contact watcher
  @property({ type: String })
  contact: string;

  @property({ type: Number, attribute: 'icon-size' })
  size = 20;

  // leads with the contact's avatar, with the URN's scheme inset on it,
  // rather than the scheme on its own
  @property({ type: Boolean })
  avatar = false;

  // the contact's own name for their avatar's initials - a watched contact
  // without one shows its ref or URN as its name, which has no initials
  @state()
  private avatarName: string = null;

  private watch: RealtimeSubscription = null;
  private watchedContact: string = null;

  // the contact the name and urn on screen came from - only what we put there
  // is ours to clear, and only when we're pointed somewhere else
  private displayedContact: string = null;

  // the contact behind a refresh notification we've already queued - a name
  // and a urn change arrive as separate deliveries, as does a burst of live
  // events, so the notification is coalesced into a microtask
  private pendingRefresh: Contact = null;

  static get styles() {
    return css`
      :host {
        display: flex;
        align-items: center;
      }

      temba-urn {
        margin-right: 0.2em;
      }

      temba-contact-avatar {
        margin-right: 0.6em;
      }

      .name {
        font-size: var(--contact-name-font-size, 1.5rem);
        overflow: hidden;
        max-height: 2rem;
        line-height: 2rem;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
        text-overflow: ellipsis;
      }
    `;
  }

  public connectedCallback(): void {
    super.connectedCallback();
    this.syncWatch();
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.syncWatch();
  }

  public willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    if (changed.has('contact')) {
      this.syncWatch();
    }
  }

  /**
   * Keeps our watch in sync with the contact we're pointed at, clearing the
   * previous contact's values when we switch contacts on the page. Explicitly
   * set name/urn never pass through here since they involve no watch.
   */
  private syncWatch() {
    const target = (this.isConnected && this.contact) || null;
    if (target === this.watchedContact) {
      return;
    }

    if (this.watch) {
      this.watch.unsubscribe();
      this.watch = null;
    }

    // only values we put there are ours to clear - a name and urn supplied
    // alongside the contact render until the watcher has something better.
    // Leaving the DOM isn't a switch, and blanking there would flash empty
    // and refetch when we're only being moved - but a swap made while we were
    // detached is, so compare against the contact on screen rather than the
    // one we were last watching
    if (
      this.isConnected &&
      this.displayedContact &&
      this.displayedContact !== target
    ) {
      this.name = null;
      this.urn = null;
      this.avatarName = null;
      this.displayedContact = null;
    }
    this.watchedContact = target;

    if (target) {
      this.watch = watchContact(
        target,
        [Events.CONTACT_NAME_CHANGED, Events.CONTACT_URNS_CHANGED],
        (event, contact) => this.handleContactEvent(event, contact)
      );
    }
  }

  private handleContactEvent(event: any, contact: Contact) {
    if (contact) {
      // the watcher keeps the contact current, so it's authoritative whether
      // this delivery is an event or an initial value. Anon workspaces have
      // no names, show the contact's ref instead
      this.name = contact.name || contact.ref || null;
      this.avatarName = contact.name || null;

      // show the URN that will be used when messaging the contact, falling
      // back to their highest priority URN if none are sendable
      const urn = getDestinationURN(contact) || (contact.urns || [])[0] || null;
      this.urn = urn ? `${urn.scheme}:${urn.display || urn.path}` : null;
      this.displayedContact = this.watchedContact;
      this.fireRefreshed(contact);
    } else if (event && event.type === Events.CONTACT_NAME_CHANGED) {
      // a live event can outrun the initial fetch - show the name we have
      this.name = event.name || null;
      this.avatarName = this.name;
      this.displayedContact = this.watchedContact;
    }
  }

  private fireRefreshed(contact: Contact) {
    if (!this.pendingRefresh) {
      Promise.resolve().then(() => {
        const refreshed = this.pendingRefresh;
        this.pendingRefresh = null;
        if (refreshed) {
          this.fireCustomEvent(CustomEventType.Refreshed, { data: refreshed });
        }
      });
    }
    this.pendingRefresh = contact;
  }

  public render(): TemplateResult {
    // a contact we're watching names its avatar once it's arrived, one set
    // explicitly goes by the name it was given
    const avatarName = this.contact ? this.avatarName : this.name;
    const urn = this.avatar
      ? html`<temba-contact-avatar
          name=${avatarName || ''}
          scheme=${this.urn ? this.urn.split(':')[0] : ''}
        ></temba-contact-avatar>`
      : this.urn
        ? html`<temba-urn size=${this.size} urn=${this.urn}></temba-urn>`
        : null;
    return html`
      ${urn}
      <div class="name">
        ${this.name ? this.name : this.urn ? this.urn.split(':')[1] : ''}
      </div>
      <slot></slot>
    `;
  }
}
