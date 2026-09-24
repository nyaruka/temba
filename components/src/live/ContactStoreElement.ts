import { PropertyValues } from 'lit';
import { property } from 'lit/decorators.js';
import { Contact, CustomEventType, Group, URN } from '../interfaces';
import { EndpointMonitorElement } from '../store/EndpointMonitorElement';
import {
  CONTACT_STATE_TYPES,
  refreshContact,
  updateContact,
  watchContact
} from './ContactWatch';
import { RealtimeSubscription } from './Realtime';

/**
 * Returns the URN that will be used to message the given contact — URNs are
 * ordered by priority and only ones with a channel are sendable.
 */
export const getDestinationURN = (contact: Contact | null): URN | null => {
  return (contact?.urns || []).find((urn) => !!urn.channel) || null;
};

export class ContactStoreElement extends EndpointMonitorElement {
  @property({ type: String })
  contact: string;

  @property({ type: Object, attribute: false })
  data: Contact;

  // the contact events this component registers interest in with the central
  // watcher - subclasses narrow this to what they actually render. An empty
  // list still receives eventless deliveries (initial values and refetches);
  // null opts out of watching entirely
  protected watchTypes: string[] = CONTACT_STATE_TYPES;

  private watch: RealtimeSubscription = null;
  private watchedContact: string = null;

  // Resolve each URN against a channel while retaining the user's priority
  // order. Consumers can select the first channel-backed URN for messaging.
  @property({ type: String })
  endpoint = '/api/v2/contacts.json?expand_urns=true&urn_order=priority&uuid=';

  // Writes go through the internal API, which responds with the same shape
  // as the read endpoint above.
  @property({ type: String })
  writeEndpoint = '/api/internal/contacts.json?uuid=';

  prepareData(data: any) {
    if (data) {
      data = Array.isArray(data) ? data[0] : data;
    }
    if (data) {
      data.groups.forEach((group: Group) => {
        group.is_dynamic = this.store.isDynamicGroup(group.uuid);
      });

      // groups the store hasn't loaded yet read as smart, so classify them
      // again once it has
      if (!this.store.ready && this.store.initialHttpComplete) {
        const uuid = data.uuid;
        this.store.initialHttpComplete.then(() => {
          if (this.data?.uuid === uuid) {
            this.data = this.prepareData({
              ...this.data,
              groups: this.data.groups.map((group: Group) => ({ ...group }))
            });
          }
        });
      }

      data.groups.sort((a: Group, b: Group) => {
        if (!a.is_dynamic || !b.is_dynamic) {
          if (a.is_dynamic) {
            return -1;
          }

          if (b.is_dynamic) {
            return 1;
          }
        }

        return a.name.localeCompare(b.name);
      });

      return data;
    }
    return null;
  }

  public postChanges(payload: any) {
    // clear our cache so we don't have any races
    this.store.removeFromCache(`${this.endpoint}${this.contact}`);
    return this.store
      .postJSON(`${this.writeEndpoint}${this.contact}`, payload)
      .then((response) => {
        this.setContact(response.json);
      });
  }

  public setContact(contact: any, contactId = this.contact) {
    // make sure contact data is properly prepped
    this.data = this.prepareData([contact]);
    this.store.updateCache(`${this.endpoint}${contactId}`, this.data);

    // sync every watcher on the page with the change immediately, without
    // waiting for it to echo back over the socket
    if (this.data) {
      updateContact(this.data.uuid, this.data);
    }
  }

  /**
   * Refetches the contact. When watched we also go through the central
   * watcher so every watcher on the page gets the fresh contact, not just us,
   * while the store fetch keeps the cache fresh for the components that read
   * it without watching. Two fetches for what is a rare manual operation.
   */
  public refresh(): void {
    if (this.watchedContact) {
      refreshContact(this.watchedContact);
    }
    super.refresh();
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
    // derive our url before the base class runs so it sees the url change
    // in this same pass (clearing stale data when the contact is unset)
    if (changed.has('contact') || changed.has('endpoint')) {
      if (this.contact) {
        this.url = `${this.endpoint}${this.contact}`;
      } else {
        this.url = null;
      }
      this.syncWatch();
    }
    super.willUpdate(changed);
  }

  // keeps our registration with the central watcher in sync with the
  // contact we're pointed at
  private syncWatch() {
    const target =
      (this.isConnected && this.watchTypes && this.contact) || null;
    if (target === this.watchedContact) {
      return;
    }

    if (this.watch) {
      this.watch.unsubscribe();
      this.watch = null;
    }
    this.watchedContact = target;

    if (target) {
      this.watch = watchContact(target, this.watchTypes, (event, contact) =>
        this.handleWatchedContact(event, contact)
      );
    }
  }

  /**
   * A delivery from the central watcher - an event we registered interest in
   * or an eventless delivery carrying initial or refetched values. Either
   * way the contact is current, so it simply becomes our data.
   */
  protected handleWatchedContact(event: any, contact: Contact) {
    if (contact && contact.uuid === this.watchedContact) {
      const previous = this.data;
      // fresh identity so change detection sees every delivery, copying the
      // parts prepareData mutates so we never write into the registry's
      // snapshot
      const copy = {
        ...contact,
        groups: (contact.groups || []).map((group) => ({ ...group })),
        fields: { ...contact.fields }
      };
      this.data = this.prepareData(this.mergeWatchedContact(copy, previous));
      this.fireCustomEvent(CustomEventType.Refreshed, {
        data: this.data,
        previous
      });
    }
  }

  /**
   * Lets subclasses keep values they have a write in flight for. A delivery
   * carries server state that predates our own unsaved edits, so anything
   * mid-save would otherwise flip back to its old value until the write
   * lands. Returns the contact to become our data.
   */
  protected mergeWatchedContact(contact: Contact, _previous: Contact): Contact {
    return contact;
  }
}
