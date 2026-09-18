import { property } from 'lit/decorators.js';
import {
  fetchResults,
  getUrl,
  getAssets,
  Asset,
  WebResponse,
  postUrl,
  postJSON,
  postForm,
  getCookie
} from '../utils';
import {
  ContactField,
  ContactGroup,
  CompletionOption,
  CompletionSchema,
  KeyedAssets,
  CustomEventType,
  Workspace,
  Shortcut,
  DirtyTrackable
} from '../interfaces';
import { RapidElement } from '../RapidElement';
import {
  onWorkspaceAccessLost,
  RealtimeSubscription,
  setRealtimeContext,
  subscribeToOrganization,
  OrganizationEvent
} from '../live/Realtime';
import { Watchers } from '../live/Watchers';
import { lru } from 'tiny-lru';
import { DateTime } from 'luxon';
import { css, html } from 'lit';
import { configureLocalization } from '@lit/localize';
import { sourceLocale, targetLocales } from '../locales/locale-codes';
import { getFullName } from '../display/TembaUser';
import {
  AppState,
  DependencyResolver,
  getDependencyResolver,
  setDependencyResolver,
  zustand
} from './AppState';
import { StoreApi } from 'zustand/vanilla';
import { normalizeUuid } from './identity';

const { setLocale } = configureLocalization({
  sourceLocale,
  targetLocales,
  loadLocale: (locale) => import(`./locales/${locale}.js`)
});

export const getStore = () => {
  return document.querySelector('temba-store') as Store;
};

export const STORE_ASSET_TYPES = [
  'channel',
  'contact',
  'field',
  'flow',
  'global',
  'group',
  'label',
  'llm',
  'template',
  'topic',
  'user'
] as const;

export type StoreAssetType = (typeof STORE_ASSET_TYPES)[number];

export interface StoreAssetReference {
  type: StoreAssetType;
  uuid?: string;
  key?: string;
}

export interface StoreAsset extends StoreAssetReference {
  name: string;
}

export interface StoreAssetChangedEvent {
  type: 'asset_changed';
  asset: StoreAsset;
}

export type StoreAssetHandler = (event: StoreAssetChangedEvent | null) => void;

interface AssetWatcher {
  interests: StoreAssetReference[];
  onEvent: StoreAssetHandler;
}

const STORE_ASSET_TYPE_SET = new Set<string>(STORE_ASSET_TYPES);

// the endpoint rejects a request carrying more than this many identifiers
const ASSET_BATCH_SIZE = 100;

// long-lived pages (a flow list paged through many times) would otherwise
// accumulate an entry for every asset ever seen. Once an entry is evicted the
// component falls back to the name its own response carried, and the identity
// is fetched again next time it is asked for.
export const ASSET_CACHE_SIZE = 500;

/**
 * Versions are held well above the asset cache because losing one doesn't just
 * forget a name, it drops the in-flight guard for that identity - and `assets`
 * is bumped by reads that never touch `assetVersions`, so the two ages drift
 * apart. Entries are a single number, so the extra headroom is cheap.
 */
export const ASSET_VERSION_CACHE_SIZE = ASSET_CACHE_SIZE * 8;

const isStoreAssetType = (type: string): type is StoreAssetType =>
  STORE_ASSET_TYPE_SET.has(type);

const assetIdentity = (
  asset: { type?: string; uuid?: string; key?: string } | null
): string | null => {
  if (!asset || !isStoreAssetType(asset.type)) {
    return null;
  }
  const identity = asset.uuid ? normalizeUuid(asset.uuid) : asset.key;
  return identity ? `${asset.type}:${identity}` : null;
};

const watchesAsset = (watcher: AssetWatcher, asset: StoreAsset): boolean => {
  const identity = assetIdentity(asset);
  return (
    !!identity &&
    watcher.interests.some((interest) => assetIdentity(interest) === identity)
  );
};

export class Store extends RapidElement {
  public static get styles() {
    return css`
      :host {
        position: fixed;
        z-index: 1000;
        text-align: center;
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 100%;
        top: 0.5em;
      }
    `;
  }

  settings = {};

  @property({ type: Number })
  ttl = 60000;

  @property({ type: Number })
  max = 20;

  @property({ type: Boolean })
  ready = false;

  @property({ type: Boolean })
  loader = false;

  @property({ type: String, attribute: 'completion' })
  completionEndpoint: string;

  @property({ type: String, attribute: 'fields' })
  fieldsEndpoint: string;

  @property({ type: String, attribute: 'groups' })
  groupsEndpoint: string;

  @property({ type: String, attribute: 'assets' })
  assetsEndpoint: string;

  @property({ type: String, attribute: 'globals' })
  globalsEndpoint: string;

  @property({ type: String, attribute: 'workspace' })
  workspaceEndpoint: string;

  @property({ type: String, attribute: 'shortcuts' })
  shortcutsEndpoint: string;

  // current workspace and user uuids, used to address user-scoped realtime
  // channels - hydrated by the page template
  @property({ type: String })
  org: string;

  @property({ type: String })
  user: string;

  @property({ type: String })
  brand = '';

  @property({ type: Object, attribute: false })
  private schema: CompletionSchema;

  @property({ type: Object, attribute: false })
  private fnOptions: CompletionOption[];

  @property({ type: Object, attribute: false })
  private keyedAssets: KeyedAssets = {};

  private locale = [...navigator.languages];

  private fields: { [key: string]: ContactField } = {};
  private groups: { [uuid: string]: ContactGroup } = {};
  private shortcuts: Shortcut[] = [];
  private workspace: Workspace;
  private featuredFields: ContactField[] = [];
  private assetWatchers = new Watchers<AssetWatcher>('store asset watcher');
  // canonical names, the identities we've already asked about (including ones
  // the endpoint had no asset for) and their last-write versions, all bounded
  // so a long-lived page doesn't keep every asset it has ever rendered
  private assets = lru<StoreAsset>(ASSET_CACHE_SIZE);
  private resolvedAssetIdentities = lru<boolean>(ASSET_CACHE_SIZE);
  private assetVersions = lru<number>(ASSET_VERSION_CACHE_SIZE);
  private pendingAssetRequests = new Map<string, Promise<void>>();
  private assetVersion = 0;
  // bumped by reset(), which only firstUpdated() calls today - the guard exists
  // so a future caller that resets a live store can't have the cleared cache
  // repopulated by a batch that was already in flight
  private assetGeneration = 0;
  private organizationWatch: RealtimeSubscription = null;
  private accessWatch: RealtimeSubscription = null;
  private organizationSubscribed = false;
  private previousDependencyResolver: DependencyResolver = null;
  private dependencyResolver: DependencyResolver = (dependencies) =>
    this.resolveAssets(dependencies);

  // http promise to monitor for completeness
  public initialHttpComplete: Promise<void | WebResponse[]>;

  private dirtyElements: DirtyTrackable[] = [];

  public markDirty(ele: DirtyTrackable) {
    if (!this.dirtyElements.includes(ele)) {
      this.dirtyElements.push(ele);
    }
  }

  public cleanAll() {
    this.dirtyElements.forEach((ele) => ele.markClean());
    this.dirtyElements = [];
  }

  public markClean(ele: DirtyTrackable) {
    this.dirtyElements = this.dirtyElements.filter((el) => el !== ele);
  }

  public getDirtyMessage() {
    if (this.dirtyElements.length > 0) {
      return (
        this.dirtyElements[0].dirtyMessage ||
        'You have unsaved changes, are you sure you want to continue?'
      );
    }
  }

  private cache: any;

  // user avatar urls by user uuid, seeded from server-hydrated user
  // references so ones that arrive without an avatar (e.g. events published
  // over sockets) can be filled in from users we've already seen. LRU-bounded
  // so long-lived tabs don't accumulate every user ever seen.
  private userAvatars = lru<string>(500);

  public setUserAvatar(uuid: string, avatar: string) {
    if (uuid && avatar) {
      this.userAvatars.set(uuid, avatar);
    }
  }

  public getUserAvatar(uuid: string): string {
    return this.userAvatars.get(uuid);
  }

  public getLocale() {
    return this.locale[0];
  }

  public clearCache() {
    this.cache = lru(this.max, this.ttl);
  }

  public reset() {
    const appState = this.getState();
    this.ready = false;
    this.clearCache();
    this.settings = JSON.parse(getCookie('settings') || '{}');
    zustand.setState({ brand: this.brand });
    this.groups = {};
    this.assets.clear();
    this.resolvedAssetIdentities.clear();
    this.pendingAssetRequests.clear();
    this.assetVersions.clear();
    this.assetVersion = 0;
    this.assetGeneration++;

    /* 
    // This will create a shorthand unit
    this.humanizer.addLanguage("en", {
      y: () => "y",
      mo: () => "mo",
      w: () => "w",
      d: () => "d",
      h: () => "h",
      m: () => "m",
      s: () => "s",
      ms: () => "ms",
      decimal: ".",
    });
    */

    const fetches = [];
    if (this.completionEndpoint) {
      fetches.push(
        getUrl(this.completionEndpoint).then((response) => {
          this.schema = response.json['context'] as CompletionSchema;
          this.fnOptions = response.json['functions'] as CompletionOption[];
        })
      );
    }

    if (this.fieldsEndpoint) {
      fetches.push(this.refreshFields());
    }

    if (this.globalsEndpoint) {
      fetches.push(
        getAssets(this.globalsEndpoint).then((assets: Asset[]) => {
          this.keyedAssets['globals'] = assets.map((asset: Asset) => asset.key);
        })
      );
    }

    if (this.groupsEndpoint) {
      fetches.push(
        getAssets<ContactGroup>(this.groupsEndpoint).then((groups) => {
          for (const group of groups) {
            this.groups[group.uuid] = group;
          }
        })
      );
    }

    if (this.workspaceEndpoint) {
      appState.fetchWorkspace(this.workspaceEndpoint);
      fetches.push(
        getUrl(this.workspaceEndpoint).then((response: WebResponse) => {
          this.workspace = response.json;
          const lang = response.headers.get('content-language');
          if (lang) {
            this.locale = [lang, ...this.locale];
          }
        })
      );
    }

    if (this.shortcutsEndpoint) {
      fetches.push(this.refreshShortcuts());
    }

    this.initialHttpComplete = Promise.all(fetches);

    this.initialHttpComplete.then(() => {
      this.ready = true;
    });
  }

  public getShortcuts() {
    return this.shortcuts || [];
  }

  public connectedCallback(): void {
    super.connectedCallback();
    // lit only runs firstUpdated once, so a store that is detached and
    // re-attached has to reinstall its page hooks here
    if (this.hasUpdated) {
      this.installPageHooks();
    }
  }

  public firstUpdated() {
    this.installPageHooks();
    this.reset();
  }

  /**
   * Installs the hooks this store owns on behalf of the page: the canonical
   * name resolver and the workspace realtime subscription. Idempotent so it
   * can run again when a store is re-attached.
   */
  private installPageHooks(): void {
    if (getDependencyResolver() !== this.dependencyResolver) {
      this.previousDependencyResolver = setDependencyResolver(
        this.dependencyResolver
      );
    }
    if (this.org && this.user) {
      setRealtimeContext({ org: this.org, user: this.user });
      if (!this.organizationWatch) {
        this.organizationWatch = subscribeToOrganization(
          (event) => this.handleOrganizationEvent(event),
          () => {
            if (this.organizationSubscribed) {
              this.refreshAssetCache().catch((error) => {
                console.error('failed to refresh store assets', error);
              });
            }
            this.organizationSubscribed = true;
          }
        );
      }
      if (!this.accessWatch) {
        // the page owns what to tell the user, we just let it know
        this.accessWatch = onWorkspaceAccessLost(() =>
          this.fireCustomEvent(CustomEventType.WorkspaceAccessLost)
        );
      }
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    // only hand the resolver back if we're still the installed one, otherwise
    // a store that never installed it would clear the live store's resolver
    if (getDependencyResolver() === this.dependencyResolver) {
      setDependencyResolver(this.previousDependencyResolver);
    }
    this.previousDependencyResolver = null;
    if (this.organizationWatch) {
      this.organizationWatch.unsubscribe();
      this.organizationWatch = null;
    }
    if (this.accessWatch) {
      this.accessWatch.unsubscribe();
      this.accessWatch = null;
    }
  }

  public getLanguageCode() {
    if (this.locale.length > 0) {
      return this.locale[0].split('-')[0];
    }
    return 'en';
  }

  public async refreshGlobals() {
    return getAssets(this.globalsEndpoint).then((assets: Asset[]) => {
      this.keyedAssets['globals'] = assets.map((asset: Asset) => asset.key);
    });
  }

  public async refreshShortcuts() {
    return getAssets(this.shortcutsEndpoint).then((shortcuts: Shortcut[]) => {
      this.shortcuts = shortcuts;
    });
  }

  public async refreshFields() {
    return getAssets(this.fieldsEndpoint).then((assets: Asset[]) => {
      this.keyedAssets['fields'] = [];
      this.featuredFields = [];

      assets.forEach((field: ContactField) => {
        this.keyedAssets['fields'].push(field.key);
        this.fields[field.key] = field;
        if (field.featured) {
          this.featuredFields.push(field);
        }
      });

      this.featuredFields.sort((a, b) => {
        return b.priority - a.priority;
      });

      this.keyedAssets['fields'].sort();

      this.fireCustomEvent(CustomEventType.StoreUpdated, {
        url: this.fieldsEndpoint,
        data: this.keyedAssets['fields']
      });
    });
  }

  public shiftAndRound(duration, unit: string, singular: string) {
    const value = Math.round(duration.shiftTo(unit).get(unit));
    if (value == 1) {
      return `1 ${singular}`;
    } else {
      return `${value} ${unit}`;
    }
  }

  public getCountdown(futureDate: DateTime) {
    const duration = futureDate.diff(DateTime.now());
    const comps = duration.rescale();

    if (comps.months > 0) {
      return '> 1 month';
    }

    if (comps.days > 1) {
      return `~ ${this.shiftAndRound(comps, 'days', 'day')}`;
    }

    if (comps.hours > 0) {
      return `~ ${this.shiftAndRound(comps, 'hours', 'hour')}`;
    }

    return `~ ${this.shiftAndRound(comps, 'minutes', 'minute')}`;
  }

  public getShortDuration(scheduled: DateTime, compareDate: DateTime = null) {
    const now = compareDate || DateTime.now();
    return scheduled
      .setLocale(this.locale[0])
      .toRelative({ base: now, style: 'long' });
  }

  public getShortDurationFromIso(isoDateA: string, isoDateB: string = null) {
    const scheduled = DateTime.fromISO(isoDateA);
    const now = isoDateB ? DateTime.fromISO(isoDateB) : DateTime.now();
    return this.getShortDuration(scheduled, now);
  }

  public setKeyedAssets(name: string, values: string[]): void {
    this.keyedAssets[name] = values;
  }

  public updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has('ready') && this.ready) {
      const locale = this.getLanguageCode();
      const target = targetLocales.find(
        (targetLocale) => targetLocale === locale
      );

      if (target) {
        setLocale(target);
      }
    }
  }

  public getCompletionSchema(): CompletionSchema {
    return this.schema;
  }

  public getFunctions(): CompletionOption[] {
    return this.fnOptions;
  }

  public getKeyedAssets(): KeyedAssets {
    return this.keyedAssets;
  }

  public getFieldKeys(): string[] {
    return this.keyedAssets['fields'] || [];
  }

  public getContactField(key: string): ContactField {
    return this.fields[key];
  }

  public getFeaturedFields(): ContactField[] {
    return this.featuredFields;
  }

  public getAsset(type: string, identity: string): StoreAsset | null {
    if (!isStoreAssetType(type) || !identity) {
      return null;
    }
    // the identity may be a key (cached verbatim, and case-sensitive) or a uuid
    // (cached under its canonical form), so try verbatim first — a canonical
    // uuid already hits on that pass, and keys never reach the normalizing one
    return (
      this.assets.get(`${type}:${identity}`) ||
      this.assets.get(`${type}:${normalizeUuid(identity)}`) ||
      null
    );
  }

  /** Adds server-authoritative assets to the page cache. Components whose
   * own response already contains canonical names can seed the same cache
   * without making another request. */
  public cacheAssets(assets: StoreAsset[]): void {
    for (const asset of assets) {
      this.cacheAsset(asset);
    }
  }

  /** Resolves every requested reference from the cache, fetching only the
   * identities this page hasn't resolved before. Concurrent callers share
   * each in-flight batch and absent assets are negatively cached. */
  public async resolveAssets(
    requested: { type: string; uuid?: string; key?: string }[],
    force = false
  ): Promise<StoreAsset[]> {
    const references = new Map<string, StoreAssetReference>();
    for (const candidate of requested || []) {
      if (!isStoreAssetType(candidate.type)) {
        continue;
      }
      const reference: StoreAssetReference = {
        type: candidate.type,
        ...(candidate.uuid ? { uuid: candidate.uuid } : {}),
        ...(candidate.key ? { key: candidate.key } : {})
      };
      const identity = assetIdentity(reference);
      if (identity) {
        references.set(identity, reference);
      }
    }

    const waits = new Set<Promise<void>>();
    const missing: StoreAssetReference[] = [];
    for (const [identity, reference] of references) {
      const pending = this.pendingAssetRequests.get(identity);
      if (pending) {
        waits.add(pending);
      } else if (force || !this.resolvedAssetIdentities.has(identity)) {
        missing.push(reference);
      }
    }

    if (this.assetsEndpoint) {
      for (
        let offset = 0;
        offset < missing.length;
        offset += ASSET_BATCH_SIZE
      ) {
        const batch = missing.slice(offset, offset + ASSET_BATCH_SIZE);
        const pending = this.fetchAssetBatch(batch);
        waits.add(pending);
        for (const reference of batch) {
          const identity = assetIdentity(reference);
          if (identity) {
            this.pendingAssetRequests.set(identity, pending);
          }
        }
        const cleanup = () => {
          for (const reference of batch) {
            const identity = assetIdentity(reference);
            if (
              identity &&
              this.pendingAssetRequests.get(identity) === pending
            ) {
              this.pendingAssetRequests.delete(identity);
            }
          }
        };
        void pending.then(cleanup, cleanup);
      }
    }

    // one failed batch mustn't discard the names the others resolved
    await Promise.all(
      [...waits].map((wait) =>
        wait.catch((error) => {
          console.error('failed to resolve assets', error);
        })
      )
    );

    const resolved: StoreAsset[] = [];
    for (const identity of references.keys()) {
      const asset = this.assets.get(identity);
      if (asset) {
        resolved.push(asset);
      }
    }
    return resolved;
  }

  /**
   * Registers interest in workspace asset changes. An eventless delivery
   * lets the watcher apply anything already cached and is repeated after a
   * reconnect refresh; live changes carry the changed asset.
   */
  public watchAssets(
    requested: { type: string; uuid?: string; key?: string }[],
    onEvent: StoreAssetHandler
  ): RealtimeSubscription {
    const watcher: AssetWatcher = {
      // an interest without an identifier is dropped rather than treated as a
      // type wildcard, matching how resolveAssets ignores those references
      interests: (requested || [])
        .filter(
          (interest) =>
            isStoreAssetType(interest.type) && !!(interest.uuid || interest.key)
        )
        .map((interest) => ({
          type: interest.type as StoreAssetType,
          ...(interest.uuid ? { uuid: interest.uuid } : {}),
          ...(interest.key ? { key: interest.key } : {})
        })),
      onEvent
    };
    this.assetWatchers.add(watcher);
    this.assetWatchers.prime(watcher, () => watcher.onEvent(null));

    return {
      unsubscribe: () => {
        this.assetWatchers.remove(watcher);
      }
    };
  }

  /**
   * Refetches the assets the page is currently displaying after a reconnect,
   * when we may have missed changes. Only live interests are refreshed - the
   * identities we resolved for content that has since scrolled away would
   * otherwise fan out into a request per hundred for no visible benefit.
   */
  private async refreshAssetCache(): Promise<void> {
    const interests = new Map<string, StoreAssetReference>();
    for (const watcher of this.assetWatchers.all()) {
      for (const interest of watcher.interests) {
        const identity = assetIdentity(interest);
        if (identity) {
          interests.set(identity, interest);
        }
      }
    }
    if (interests.size > 0) {
      await this.resolveAssets([...interests.values()], true);
    }
    this.assetWatchers.each((watcher) => watcher.onEvent(null));
  }

  private async fetchAssetBatch(
    references: StoreAssetReference[]
  ): Promise<void> {
    if (!this.assetsEndpoint || references.length === 0) {
      return;
    }

    const generation = this.assetGeneration;
    // undefined means "no write recorded", which is not the same as version 0:
    // assetVersions is bounded, so an evicted entry must not be read as a
    // newer write and throw away a perfectly fresh name
    const startVersions = new Map<string, number | undefined>();
    const requested = new Set<string>();
    const payload: Partial<Record<StoreAssetType, string[]>> = {};
    for (const reference of references) {
      const identity = assetIdentity(reference);
      const value = reference.uuid || reference.key;
      if (!identity || !value) {
        continue;
      }
      requested.add(identity);
      startVersions.set(identity, this.assetVersions.get(identity));
      (payload[reference.type] ||= []).push(value);
    }

    const response = await postJSON(this.assetsEndpoint, payload);
    if (generation !== this.assetGeneration) {
      return;
    }
    // postJSON only rejects on a server error, so a 4xx arrives here as an
    // empty body - bail before the bookkeeping below negatively caches every
    // requested identity for the life of the page
    if (response.status < 200 || response.status >= 300) {
      console.warn(
        `asset request failed with status ${response.status}`,
        payload
      );
      return;
    }

    for (const candidate of response.json?.results || []) {
      // the endpoint echoes normalized uuids, which assetIdentity matches back
      // to whatever form the reference was embedded in
      const identity = assetIdentity(candidate);
      if (
        identity &&
        requested.has(identity) &&
        typeof candidate.name === 'string' &&
        this.isCurrentAssetVersion(identity, startVersions.get(identity))
      ) {
        this.cacheAsset(candidate as StoreAsset);
      }
    }
    // Remember every requested identity, including assets the endpoint
    // omitted, so deleted/missing references aren't repeatedly fetched.
    for (const identity of requested) {
      this.resolvedAssetIdentities.set(identity, true);
    }
  }

  /**
   * True when nothing has written this identity since the given version was
   * read. A version we no longer have (evicted from the bounded map) can't
   * prove a newer write, so the response is allowed through - keeping a name
   * we know is stale forever is the worse failure.
   *
   * Note what that costs when it happens: the write it can't see may be a live
   * socket rename that landed mid-batch, so this doesn't merely fail to protect
   * a name we've forgotten, it can overwrite a fresher one we still hold. That
   * needs an eviction inside a single batch's flight time, which is why
   * ASSET_VERSION_CACHE_SIZE is kept well clear of the asset cache; the next
   * socket event or reconnect refresh heals it either way.
   */
  private isCurrentAssetVersion(
    identity: string,
    startVersion: number | undefined
  ): boolean {
    const current = this.assetVersions.get(identity);
    return current === undefined || current === startVersion;
  }

  private cacheAsset(asset: StoreAsset): void {
    const identity = assetIdentity(asset);
    if (!identity || typeof asset.name !== 'string') {
      return;
    }
    this.assets.set(identity, { ...asset });
    this.resolvedAssetIdentities.set(identity, true);
    // every direct write is newer than any batch already in flight, so bump
    // the version to discard a response that read an older name
    this.assetVersions.set(identity, ++this.assetVersion);
  }

  private handleOrganizationEvent(event: OrganizationEvent): void {
    const asset = event?.asset;
    const identity = assetIdentity(asset);
    if (
      event?.type !== 'asset_changed' ||
      !identity ||
      typeof asset.name !== 'string'
    ) {
      return;
    }

    const changed = { ...asset };
    const interested = this.assetWatchers.some((watcher) =>
      watchesAsset(watcher, changed)
    );
    const previouslyResolved = this.resolvedAssetIdentities.has(identity);
    const pending = this.pendingAssetRequests.has(identity);
    const legacyGroup =
      changed.type === 'group' &&
      changed.uuid &&
      Object.prototype.hasOwnProperty.call(this.groups, changed.uuid);

    if (legacyGroup) {
      this.groups[changed.uuid] = {
        ...this.groups[changed.uuid],
        uuid: changed.uuid,
        name: changed.name
      };
    }
    if (!previouslyResolved && !pending && !interested) {
      return;
    }

    // cacheAsset records the write version, discarding any batch in flight
    // for this identity that read the name before this change
    this.cacheAsset(changed);

    const publication: StoreAssetChangedEvent = {
      type: 'asset_changed',
      asset: changed
    };
    this.assetWatchers.each(
      (watcher) => watcher.onEvent(publication),
      (watcher) => watchesAsset(watcher, changed)
    );
  }

  public isDynamicGroup(uuid: string): boolean {
    const group = this.groups[uuid];
    // we treat missing groups as dynamic since the
    // api excludes initializing groups
    if (!group) {
      // console.warn('No group for ' + uuid);
    }

    if (!group || group.query) {
      return true;
    }
    return false;
  }

  public getWorkspace(): Workspace {
    return this.workspace;
  }

  public formatDate(dateString: string) {
    return DateTime.fromISO(dateString)
      .setLocale(this.getLocale())
      .toLocaleString(DateTime.DATETIME_SHORT);
  }

  public postJSON(url: string, payload: any = '') {
    return postJSON(url, payload);
  }

  public postForm(url: string, payload: any | FormData, headers: any = {}) {
    return postForm(url, payload, headers);
  }

  public postUrl(
    url: string,
    payload: any = '',
    headers: any = {},
    contentType = null
  ) {
    return postUrl(url, payload, headers, contentType);
  }

  public getUrl(
    url: string,
    options?: {
      force?: boolean;
      skipCache?: boolean;
      controller?: AbortController;
      headers?: { [key: string]: string };
    }
  ): Promise<WebResponse> {
    options = options || {};
    if (!options.force && this.cache.has(url)) {
      return new Promise<WebResponse>((resolve) => {
        resolve(this.cache.get(url));
      });
    }

    return getUrl(url, options.controller, options.headers || {}).then(
      (response: WebResponse) => {
        return new Promise<WebResponse>((resolve, reject) => {
          if (response.status >= 200 && response.status <= 300) {
            if (!options.skipCache) {
              this.cache.set(url, response);
            }
            resolve(response);
          } else {
            reject('Status: ' + response.status);
          }
        });
      }
    );
  }

  private pendingResolves = {};

  /**
   * Fetches all of the results for a given API endpoint with caching
   * @param url
   */
  public getResults(
    url: string,
    options?: { force?: boolean }
  ): Promise<any[]> {
    options = options || {};
    const key = 'results_' + url;
    const results = this.cache.get(key);

    if (!options.force && results) {
      return new Promise<any[]>((resolve) => {
        resolve(results);
      });
    }

    return new Promise<any[]>((resolve) => {
      const pending = this.pendingResolves[url] || [];
      pending.push(resolve);
      this.pendingResolves[url] = pending;
      if (pending.length <= 1) {
        fetchResults(url).then((results: any[]) => {
          this.cache.set(key, results);
          const pending = this.pendingResolves[url] || [];
          while (pending.length > 0) {
            const resolve = pending.pop();
            resolve(results);
          }
        });
      }
    });
  }

  public fetching: { [url: string]: number } = {};

  public updateCache(url: string, data: any) {
    this.cache.set(url, data);
    this.fireCustomEvent(CustomEventType.StoreUpdated, { url, data });
  }

  public removeFromCache(url: string) {
    this.cache.delete(url);
  }

  public resolveUsers(items: any, keys: string[]): Promise<void> {
    return new Promise<void>((resolve) => {
      const uuids = new Set<string>();

      // keys are dot notation paths to user fields
      items.forEach((item) => {
        keys.forEach((key) => {
          const parts = key.split('.');
          let value = item;
          for (let i = 0; i < parts.length; i++) {
            value = value[parts[i]];
            if (!value) {
              break;
            }
          }
          if (value && value.uuid) {
            uuids.add(value.uuid);
          }
        });
      });

      const promises = [];
      // we don't want to fetch all users at once so we can benefit from caching
      uuids.forEach((uuid) => {
        promises.push(
          this.getUrl(`/api/v2/users.json?uuid=${encodeURIComponent(uuid)}`, {
            force: true
          })
        );
      });

      // wait for all of our user fetches to complete
      Promise.all(promises).then((promises) => {
        promises.forEach((response: WebResponse) => {
          if (response && response.json) {
            const results = response.json.results;
            if (results && results.length === 1) {
              const user = results[0];
              this.setUserAvatar(user.uuid, user.avatar);

              items.forEach((item) => {
                // replace each key with a matching user
                keys.forEach((key) => {
                  const parts = key.split('.');
                  let value = item;
                  let last = value;
                  for (let i = 0; i < parts.length; i++) {
                    last = value;
                    value = value[parts[i]];
                    if (!value) {
                      break;
                    }
                  }
                  if (value && value.email === user.email) {
                    // only care about avatars for now
                    const orginalUser = last[parts[parts.length - 1]];
                    orginalUser.avatar = user.avatar;
                    orginalUser.name = getFullName(user);
                    orginalUser.uuid = user.uuid;
                    last[parts[parts.length - 1]].avatar = user.avatar;
                  }
                });
              });
            }
          }
        });
        resolve();
      });
    });
  }

  public makeRequest(
    url: string,
    options?: { force?: boolean; prepareData?: (data: any) => any }
  ) {
    const previousRequest = this.fetching[url];
    const now = new Date().getTime();
    // if the request was recently made, don't do anything
    if (previousRequest) {
      setTimeout(() => {
        this.makeRequest(url, options);
      }, 500);
      return;
    }

    let cached = this.cache.get(url);
    if (cached && !options.force) {
      cached = options.prepareData ? options.prepareData(cached) : cached;
      this.fireCustomEvent(CustomEventType.StoreUpdated, { url, data: cached });
    } else {
      options = options || {};
      this.fetching[url] = now;
      fetchResults(url).then((data) => {
        if (!data) {
          delete this.fetching[url];
          return;
        }
        this.cache.set(url, data);
        delete this.fetching[url];
        data = options.prepareData ? options.prepareData(data) : data;
        this.fireCustomEvent(CustomEventType.StoreUpdated, { url, data });
      });
    }
  }

  public get(key: string, defaultValue: any = null) {
    return this.settings[key] || defaultValue;
  }

  public set(key: string, value: string) {
    this.settings[key] = value;
    // not sure yet if we really want to perist these
    // setCookie(COOKIE_KEYS.SETTINGS, JSON.stringify(this.settings), '/');
  }

  public render() {
    if (!this.ready && this.loader) {
      return html`<temba-loading size="10" units="8"></temba-loading>`;
    }
  }

  public getCompletions(type: string) {
    const info = this.getState().flowInfo;
    if (type === 'results') {
      return info.results.map((result) => result.key);
    } else if (type === 'locals') {
      return info.locals;
    }

    return this.keyedAssets[type] || [];
  }

  public getApp(): StoreApi<AppState> {
    return zustand;
  }

  public getState(): AppState {
    return zustand.getState();
  }
}
