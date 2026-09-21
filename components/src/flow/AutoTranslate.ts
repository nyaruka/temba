import { html, TemplateResult } from 'lit-html';
import { css, PropertyValues } from 'lit';
import { msg, str } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { getStore } from '../store/Store';
import { AppState, fromStore, zustand } from '../store/AppState';
import { FlowDefinition } from '../store/flow-definition';
import { TranslationEntry, buildTranslationBundles } from './flow-translations';
import { getLanguageName } from '../languages';
import { LLMModel, hasLLMRole } from './flow-utils';
import { formatCount } from '../utils';

interface TranslationModel {
  uuid: string;
  name: string;
}

const MODELS_ENDPOINT = '/api/internal/llms.json';
const ADD_MODEL_URL = '/ai/';

// Max size of the serialized JSON payload per translate request. Measured
// against the full payload (uuids, keys, JSON structural chars, and source
// strings). Sized so that the LLM can produce the translation within the
// per-call deadline mailroom enforces, which is well under a minute, even
// for slower models and target languages which tokenize poorly.
const TRANSLATION_BATCH_CHAR_LIMIT = 2000;

// How many translate requests to keep in flight at once. Batches are small so
// a large flow produces many of them - running a few concurrently keeps the
// total time down without hammering the LLM provider.
const TRANSLATION_CONCURRENCY = 3;

// The error code returned when the LLM didn't respond within its deadline,
// which we handle by splitting the batch rather than giving up.
const TIMEOUT_ERROR_CODE = 'timeout';

export class AutoTranslate extends RapidElement {
  static get styles() {
    return css`
      :host {
        display: contents;
      }

      .auto-translate-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 20px;
        font-size: 14px;
        color: #374151;
      }

      .auto-translate-body p {
        margin: 0;
      }

      .auto-translate-loading {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: #6b7280;
      }

      .auto-translate-empty {
        display: flex;
        flex-direction: column;
        gap: 8px;
        font-size: 13px;
      }

      .auto-translate-empty a {
        color: var(--color-link);
        text-decoration: none;
      }

      .auto-translate-empty a:hover {
        text-decoration: underline;
      }

      .auto-translate-status {
        display: flex;
        align-items: center;
        gap: 6px;
        /* align with the progress bar in the body (body has 20px padding,
           dialog-footer has 10px) */
        padding-left: 10px;
        font-size: 12px;
        color: #6b7280;
      }

      .auto-translate-status-spinner {
        --icon-color: #6b7280;
      }

      .auto-translate-error-block {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 12px 14px;
        background: #fef2f2;
        border: 1px solid #fecaca;
        border-radius: 6px;
        overflow: hidden;
        font-size: 13px;
        color: #7f1d1d;
      }

      .auto-translate-error-block p {
        margin: 0;
      }

      .auto-translate-error-help {
        color: inherit;
      }

      .auto-translate-error-toggle {
        align-self: flex-start;
        margin-top: 2px;
        padding: 0;
        background: none;
        border: none;
        color: inherit;
        font: inherit;
        font-size: 12px;
        text-decoration: underline;
        cursor: pointer;
      }

      .auto-translate-error-details {
        margin: 6px -14px -12px;
        padding: 10px 14px;
        background: #fff;
        border-top: 1px solid #fecaca;
        font-size: 12px;
        color: inherit;
        white-space: pre-wrap;
        word-break: break-word;
      }
    `;
  }

  @property({ attribute: false })
  definition: FlowDefinition | null = null;

  @property({ type: String, attribute: 'language-code' })
  languageCode = '';

  @property({ type: Boolean })
  disabled = false;

  @fromStore(zustand, (state: AppState) => state.brand)
  private brand!: string;

  // Reactive flag the host can read to show "translating" state in UI
  // adjacent to this component (e.g. the toolbar button).
  @property({ type: Boolean, reflect: true })
  running = false;

  @state()
  dialogOpen = false;

  @state()
  models: TranslationModel[] = [];

  @state()
  modelsLoading = false;

  @state()
  selectedModel: TranslationModel | null = null;

  @state()
  progress: { done: number; total: number } = { done: 0, total: 0 };

  @state()
  error: string | null = null;

  @state()
  errorExpanded = false;

  @state()
  interrupt = false;

  @state()
  updateExisting = false;

  // Tracks whether the dialog has ever opened so we can keep it mounted
  // afterwards (so it sees its own close transition) without paying
  // for an empty hidden dialog before that.
  private everOpened = false;

  /**
   * Public entry point. If a translation is in flight, sets the interrupt
   * flag; otherwise opens the model picker.
   */
  public async start(): Promise<void> {
    if (this.disabled) {
      return;
    }

    if (this.running) {
      this.interrupt = true;
      return;
    }

    this.error = null;
    this.errorExpanded = false;
    this.selectedModel = null;
    this.updateExisting = false;
    this.dialogOpen = true;
    await this.loadModels();

    if (this.models.length === 1) {
      this.selectedModel = this.models[0];
    }
  }

  private async loadModels(): Promise<void> {
    this.modelsLoading = true;
    try {
      const store = getStore();
      const results: LLMModel[] = store
        ? ((await store.getResults(MODELS_ENDPOINT, { force: true })) ?? [])
        : [];
      this.models = results
        .filter((r) => hasLLMRole(r, 'editing'))
        .map((r) => ({
          uuid: r.uuid,
          name: r.name
        }));
    } catch (err) {
      console.error('Failed to load AI models', err);
      this.models = [];
      this.error = msg('Unable to load AI models.');
    } finally {
      this.modelsLoading = false;
    }
  }

  private handleModelChange(event: Event): void {
    const select = event.target as any;
    const next = select?.values?.[0];
    this.selectedModel = next ? { uuid: next.uuid, name: next.name } : null;
  }

  private handleUpdateExistingChange(event: Event): void {
    const checkbox = event.target as any;
    this.updateExisting = !!checkbox?.checked;
  }

  private confirmTranslate(): void {
    if (!this.selectedModel) {
      return;
    }
    this.dialogOpen = false;
    this.runAutoTranslation().catch((err) => {
      console.error('Auto translation failed', err);
      this.error = msg('Auto translation failed. Please try again.');
      this.running = false;
    });
  }

  private cancelDialog(): void {
    this.dialogOpen = false;
  }

  private dismissError(): void {
    this.error = null;
    this.errorExpanded = false;
    this.progress = { done: 0, total: 0 };
  }

  /**
   * Builds batches of translation requests from all untranslated entries,
   * grouping so each request's serialized payload stays under
   * TRANSLATION_BATCH_CHAR_LIMIT. Skips entries whose source matches a
   * translation already present in the flow (those are returned in
   * preTranslated for direct application), and dedupes pending entries
   * sharing identical source arrays so each unique array is sent at most
   * once (duplicates are returned in duplicateKeyToCanonical for
   * propagation when the canonical key's translation lands). When
   * updateExisting is true, already-translated entries are also included
   * and the pre-translation reuse path is skipped so all localizable
   * entries are sent to the LLM.
   */
  private buildTranslationBatches(): {
    keyToEntries: Map<string, TranslationEntry[]>;
    batches: { items: Record<string, string[]> }[];
    preTranslated: Map<string, string[]>;
    duplicateKeyToCanonical: Map<string, string>;
  } {
    const keyToEntries = new Map<string, TranslationEntry[]>();
    const batches: { items: Record<string, string[]> }[] = [];
    const preTranslated = new Map<string, string[]>();
    const duplicateKeyToCanonical = new Map<string, string>();

    if (!this.definition) {
      return { keyToEntries, batches, preTranslated, duplicateKeyToCanonical };
    }

    const bundles = buildTranslationBundles(this.definition, this.languageCode);
    const updateExisting = this.updateExisting;

    // Map source-content -> already-stored translation array, built from
    // entries that have a translation in the live localization map. Reading
    // the stored array (not entry.to) preserves the original shape. Skipped
    // in update mode so we always re-translate via the LLM.
    const existingByContent = new Map<string, string[]>();
    const localization =
      this.definition.localization?.[this.languageCode] || {};

    if (!updateExisting) {
      for (const bundle of bundles) {
        for (const entry of bundle.translations) {
          // Skip entries with no real translation: an empty array OR an
          // array of only empty/whitespace strings shouldn't seed reuse,
          // or we'd silently propagate a blank to other matching sources.
          if (
            !entry.toValues ||
            !entry.toValues.some((v) => v && v.trim().length > 0)
          ) {
            continue;
          }
          if (!entry.fromValues || entry.fromValues.length === 0) {
            continue;
          }
          const stored = localization[entry.uuid]?.[entry.attribute];
          if (!Array.isArray(stored) || stored.length === 0) {
            continue;
          }
          const contentKey = JSON.stringify(entry.fromValues);
          if (!existingByContent.has(contentKey)) {
            existingByContent.set(contentKey, stored);
          }
        }
      }
    }

    // Collect pending entries preserving order. Each unique key (uuid +
    // attribute) maps to its source array (entry.fromValues), preserving
    // multi-item structure for attributes like router-case `arguments`.
    // In update mode we include entries that already have a translation.
    // Invariant: findTranslations produces at most one entry per
    // (uuid, attribute) pair, so the first fromValues is authoritative
    // and any later entry with the same key is treated as a duplicate.
    const valuesByKey = new Map<string, string[]>();

    for (const bundle of bundles) {
      for (const entry of bundle.translations) {
        if (
          !updateExisting &&
          entry.toValues &&
          entry.toValues.some((v) => v && v.trim().length > 0)
        ) {
          continue;
        }
        if (!entry.fromValues || entry.fromValues.length === 0) {
          continue;
        }
        const key = `${entry.uuid}:${entry.attribute}`;
        const list = keyToEntries.get(key) || [];
        list.push(entry);
        keyToEntries.set(key, list);
        if (!valuesByKey.has(key)) {
          valuesByKey.set(key, entry.fromValues);
        }
      }
    }

    // Split pending keys into pre-translated (matching an existing
    // translation), duplicates (sharing content with an earlier pending
    // key), and unique canonical keys that need to be sent to the LLM.
    const canonicalByContent = new Map<string, string>();
    const canonicalKeysWithValues: { key: string; values: string[] }[] = [];

    for (const [key, values] of valuesByKey) {
      const contentKey = JSON.stringify(values);

      const existing = existingByContent.get(contentKey);
      if (existing && existing.length === values.length) {
        preTranslated.set(key, existing);
        continue;
      }

      const canonical = canonicalByContent.get(contentKey);
      if (canonical) {
        duplicateKeyToCanonical.set(key, canonical);
        continue;
      }

      canonicalByContent.set(contentKey, key);
      canonicalKeysWithValues.push({ key, values });
    }

    const source = this.definition.language;
    const target = this.languageCode;
    const measurePayload = (items: Record<string, string[]>): number =>
      JSON.stringify({ source, target, items }).length;

    let current: Record<string, string[]> = {};

    for (const { key, values } of canonicalKeysWithValues) {
      const tentative = { ...current, [key]: values };
      const tentativeSize = measurePayload(tentative);
      const batchHasItems = Object.keys(current).length > 0;

      if (tentativeSize > TRANSLATION_BATCH_CHAR_LIMIT && batchHasItems) {
        // a single oversized entry still ships on its own
        batches.push({ items: current });
        current = { [key]: values };
      } else {
        current = tentative;
      }
    }

    if (Object.keys(current).length > 0) {
      batches.push({ items: current });
    }

    return { keyToEntries, batches, preTranslated, duplicateKeyToCanonical };
  }

  /**
   * Drives the batch loop. Public so tests can invoke directly with a
   * pre-set selectedModel.
   */
  public async runAutoTranslation(): Promise<void> {
    if (
      !this.definition ||
      !this.selectedModel ||
      this.languageCode === this.definition.language
    ) {
      return;
    }

    const { keyToEntries, batches, preTranslated, duplicateKeyToCanonical } =
      this.buildTranslationBatches();

    // Apply entries that match an existing translation immediately so we
    // don't need an LLM round-trip for them.
    if (preTranslated.size > 0) {
      this.applyBatchTranslations(
        Object.fromEntries(preTranslated),
        keyToEntries
      );
    }

    if (batches.length === 0) {
      return;
    }

    // Inverse of duplicateKeyToCanonical so we can quickly find which keys
    // need to be back-filled when a canonical key's translation lands.
    const duplicatesByCanonical = new Map<string, string[]>();
    for (const [dup, canonical] of duplicateKeyToCanonical) {
      const list = duplicatesByCanonical.get(canonical) || [];
      list.push(dup);
      duplicatesByCanonical.set(canonical, list);
    }

    this.running = true;
    this.interrupt = false;
    this.error = null;
    this.progress = { done: 0, total: batches.length };

    const source = this.definition.language;
    const target = this.languageCode;
    const url = `/llm/translate/${this.selectedModel.uuid}/`;
    const store = getStore();
    if (!store) {
      this.running = false;
      return;
    }

    // Workers each pull the next unsent batch from the queue until it's
    // empty, or until an interrupt or failure stops any more from being
    // sent. Batches already in flight are allowed to finish and land. The
    // failure is only surfaced as this.error once every worker has finished,
    // so the dialog can't be dismissed while batches are still in flight.
    const queue = [...batches];
    let failure: string | null = null;
    const worker = async () => {
      while (!this.interrupt && !failure && queue.length > 0) {
        const batch = queue.shift();

        try {
          const response = await store.postJSON(url, {
            source,
            target,
            items: batch.items
          });

          if (response.status >= 200 && response.status < 300) {
            const returned: Record<string, string[]> =
              response.json?.items || {};
            const expanded: Record<string, string[]> = { ...returned };
            for (const canonical of Object.keys(returned)) {
              const dups = duplicatesByCanonical.get(canonical);
              if (dups) {
                for (const dup of dups) {
                  expanded[dup] = returned[canonical];
                }
              }
            }
            this.applyBatchTranslations(expanded, keyToEntries);
            this.progress = {
              done: this.progress.done + 1,
              total: this.progress.total
            };
          } else if (
            response.json?.code === TIMEOUT_ERROR_CODE &&
            Object.keys(batch.items).length > 1
          ) {
            // the LLM couldn't translate this much within its deadline, so
            // try again as two halves - a single entry that's still too big
            // will fail again and be reported below
            const keys = Object.keys(batch.items);
            const mid = Math.ceil(keys.length / 2);
            const half = (ks: string[]) => ({
              items: Object.fromEntries(ks.map((k) => [k, batch.items[k]]))
            });
            queue.unshift(half(keys.slice(0, mid)), half(keys.slice(mid)));
            this.progress = {
              done: this.progress.done,
              total: this.progress.total + 1
            };
          } else if (!failure) {
            failure =
              response.json?.error ||
              msg(str`Translate request failed (${response.status}).`);
          }
        } catch (err) {
          console.error('Translate request failed', err);
          if (!failure) {
            failure = msg('Translate request failed.');
          }
        }
      }
    };

    const workers = [];
    for (let i = 0; i < TRANSLATION_CONCURRENCY; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    this.error = failure;
    this.running = false;
    this.interrupt = false;
  }

  private applyBatchTranslations(
    returned: Record<string, string[]>,
    keyToEntries: Map<string, TranslationEntry[]>
  ): void {
    const store = getStore();
    if (!store || !this.definition) {
      return;
    }

    // group updates by uuid so multiple attributes merge into one write
    const updatesByUuid = new Map<string, Record<string, any>>();

    for (const [key, values] of Object.entries(returned)) {
      const entries = keyToEntries.get(key);
      if (!entries || entries.length === 0) {
        continue;
      }
      const [firstEntry] = entries;
      const uuid = firstEntry.uuid;
      const attribute = firstEntry.attribute;

      keyToEntries.delete(key);

      if (!values || values.length === 0) {
        continue;
      }

      // read from the live store rather than this.definition, which can
      // lag behind across batches and cause earlier attributes to be
      // overwritten when multiple attrs on the same uuid land in
      // different batches
      const liveDefinition = zustand.getState().flowDefinition;
      const existing =
        liveDefinition?.localization?.[this.languageCode]?.[uuid] || {};
      const existingValues = Array.isArray(existing[attribute])
        ? (existing[attribute] as string[])
        : null;

      // Never replace an existing non-empty translation with an empty
      // value: when re-translating already-localized content the LLM may
      // return blanks for some entries; keep the prior translation in
      // those slots. Only safe when the arrays align by index — if the
      // source array length has changed since the last translation, the
      // old values aren't tied to the same items anymore, so skip the
      // per-item preserve and let the LLM result through unchanged.
      const canPreservePerItem =
        !!existingValues && existingValues.length === values.length;
      const mergedValues = values.map((v, i) => {
        const isEmpty =
          v === null ||
          v === undefined ||
          (typeof v === 'string' && v.trim().length === 0);
        if (isEmpty && canPreservePerItem && existingValues![i]) {
          return existingValues![i];
        }
        return v;
      });

      const hasContent = mergedValues.some(
        (v) => v && (typeof v !== 'string' || v.trim().length > 0)
      );
      if (!hasContent) {
        continue;
      }

      const merged = updatesByUuid.get(uuid) || { ...existing };
      merged[attribute] = mergedValues;
      updatesByUuid.set(uuid, merged);
    }

    for (const [uuid, merged] of updatesByUuid.entries()) {
      store.getState().updateLocalization(this.languageCode, uuid, merged);
      zustand.getState().markAutoTranslated(
        this.languageCode,
        uuid,
        Object.keys(merged).filter(
          (k) => merged[k] && (merged[k] as any[]).length > 0
        )
      );
    }
  }

  protected updated(changed: PropertyValues): void {
    if (changed.has('running')) {
      // emit a state-change event so the host can update adjacent UI
      // (e.g. toolbar button) without polling
      this.dispatchEvent(
        new CustomEvent('temba-auto-translate-changed', {
          detail: { running: this.running },
          bubbles: true,
          composed: true
        })
      );
    }
  }

  private handleDialogButton(event: CustomEvent): void {
    if (this.error) {
      // only the Dismiss button shows in the error state
      this.dismissError();
      return;
    }
    if (this.running) {
      // only the Stop button shows while running
      if (!this.interrupt) {
        this.interrupt = true;
      }
      return;
    }
    // in the picker state the primary button is Translate
    if (event.detail?.button?.primary) {
      this.confirmTranslate();
    } else {
      this.cancelDialog();
    }
  }

  public render(): TemplateResult | string {
    const showPicker = this.dialogOpen;
    const showProgress = this.running || !!this.error;
    const open = showPicker || showProgress;

    // Skip rendering until the dialog has been opened at least once so we
    // don't pay for an empty hidden dialog on every editor instance.
    if (!open && !this.everOpened) {
      return '';
    }
    if (open) {
      this.everOpened = true;
    }

    let header = msg('Auto Translation');
    let body: TemplateResult = html``;
    let gutter: TemplateResult | string = '';
    let primary = '';
    let cancel = '';
    let disabled = false;

    if (this.error) {
      header = msg('Problem with AI Model');
      body = this.renderErrorBody();
      cancel = msg('Dismiss');
    } else if (this.running) {
      body = this.renderRunningBody();
      gutter = this.renderRunningGutter();
      // Stop is the primary so the dialog does NOT auto-close on click;
      // we close it ourselves once the in-flight batches return
      primary = msg('Stop');
      disabled = this.interrupt;
    } else if (showPicker) {
      const noModels = !this.modelsLoading && this.models.length === 0;
      body = this.renderPickerBody();
      cancel = noModels ? msg('Close') : msg('Cancel');
      primary = noModels ? '' : msg('Translate');
      disabled = this.modelsLoading || noModels || !this.selectedModel;
    }

    // We always render the dialog (after first open) so it sees the
    // open: true -> false transition and runs its body scroll/unlock
    // cleanup; otherwise body styles can stay stuck after auto-translate
    // completes.
    return html`
      <temba-dialog
        header=${header}
        .open=${open}
        size="small"
        primaryButtonName=${primary}
        cancelButtonName=${cancel}
        ?disabled=${disabled}
        variant="flat"
        @temba-button-clicked=${this.handleDialogButton}
      >
        <div class="auto-translate-body">${body}</div>
        ${gutter ? html`<div slot="gutter">${gutter}</div>` : ''}
      </temba-dialog>
    `;
  }

  private renderPickerBody(): TemplateResult {
    if (this.modelsLoading) {
      return html`<div class="auto-translate-loading">
        <temba-loading units="3" size="8"></temba-loading>
      </div>`;
    }

    if (this.models.length === 0) {
      return html`
        <div class="auto-translate-empty">
          <p>
            ${msg('You need to add an AI model before you can auto translate.')}
          </p>
          <p>
            <a href="${ADD_MODEL_URL}" target="_blank" rel="noopener"
              >${msg('Manage AI models')}</a
            >
          </p>
        </div>
      `;
    }

    const selected = this.selectedModel ? [this.selectedModel] : [];
    const languageName = getLanguageName(this.languageCode);
    const aiClause = this.brand
      ? msg(
          html`${this.brand} uses AI for automatic translation, which can make
          mistakes,`
        )
      : msg(html`Automatic translation uses AI, which can make mistakes,`);
    return html`
      <p>
        ${msg(
          html`All remaining text for <strong>${languageName}</strong> will be
            translated automatically. ${aiClause} so it is important to review
            all of your translations to verify they are correct.`
        )}
      </p>
      ${this.models.length > 1
        ? html`<temba-select
            class="auto-translate-model-select"
            endpoint="${MODELS_ENDPOINT}"
            valueKey="uuid"
            .values=${selected}
            .shouldExclude=${(option: LLMModel) =>
              !hasLLMRole(option, 'editing')}
            ?searchable=${true}
            placeholder=${msg('Select an AI model')}
            @change=${this.handleModelChange}
          ></temba-select>`
        : ''}
      <temba-checkbox
        class="auto-translate-update-existing"
        label=${msg('Update existing translations')}
        ?checked=${this.updateExisting}
        @change=${this.handleUpdateExistingChange}
      ></temba-checkbox>
    `;
  }

  private renderRunningBody(): TemplateResult {
    const { done, total } = this.progress;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    return html`
      <temba-progress
        .total=${total}
        .current=${done}
        .pct=${pct}
        showPercentage
      ></temba-progress>
    `;
  }

  private renderRunningGutter(): TemplateResult {
    const { done, total } = this.progress;
    // current batch is 1-indexed: while batch 0 is in flight, done is still
    // 0, so we display "1 of N". With several batches in flight this is the
    // lowest numbered one we're still waiting on.
    const currentBatch = Math.min(done + 1, total);
    const statusText = this.interrupt
      ? msg('Stopping...')
      : total > 1
        ? msg(
            str`Translating ${formatCount(currentBatch)} of ${formatCount(
              total
            )}`
          )
        : msg('Translating');

    return html`
      <div class="auto-translate-status">
        <temba-icon
          class="auto-translate-status-spinner"
          name="progress_spinner"
          size="0.9"
          spin
        ></temba-icon>
        <span>${statusText}</span>
      </div>
    `;
  }

  private renderErrorBody(): TemplateResult {
    return html`
      <div class="auto-translate-error-block">
        <p class="auto-translate-error-help">
          ${msg(
            "Any translations already applied have been kept. You can try again, or check the AI model's settings if the problem persists."
          )}
        </p>
        ${this.errorExpanded
          ? html`<pre class="auto-translate-error-details">${this.error}</pre>`
          : html`<button
              class="auto-translate-error-toggle"
              type="button"
              @click=${() => (this.errorExpanded = true)}
            >
              ${msg('Show details')}
            </button>`}
      </div>
    `;
  }
}
