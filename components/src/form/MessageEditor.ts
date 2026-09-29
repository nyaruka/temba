import { TemplateResult, css, html } from 'lit';
import { property } from 'lit/decorators.js';
import { ifDefined } from 'lit-html/directives/if-defined.js';
import { FieldElement } from './FieldElement';
import { RichEditor } from './RichEditor';
import { MediaPicker } from './MediaPicker';
import { Attachment, CustomEventType } from '../interfaces';
import { getClasses } from '../utils';
import { Icon } from '../Icons';

/**
 * MessageEditor is a composed component that combines temba-completion and temba-media-picker
 * for editing messages with text completion and file attachments
 */
export class MessageEditor extends FieldElement {
  static get styles() {
    return css`
      ${super.styles}
      :host {
        display: block;
      }

      .message-editor-container {
        border: 1px solid var(--color-widget-border);
        border-radius: var(--curvature-widget);
        background: var(--surface);
        position: relative;
        transition:
          border-color 0.2s ease-in-out,
          box-shadow 0.2s ease-in-out;
      }

      .message-editor-container:focus-within {
        border-color: var(--color-focus);
        box-shadow: var(--widget-box-shadow-focused);
      }

      .message-editor-container.highlight {
        border-color: rgba(156, 222, 106, 0.88);
      }

      /* Hide the rich editor field border since we draw our own */
      .message-editor-container temba-rich-edit::part(field) {
        border: none;
        box-shadow: none;
        border-radius: 0;
      }

      .message-editor-container temba-rich-edit {
        --widget-box-shadow: none;
        --widget-box-shadow-focused: none;
        --widget-box-shadow-focused: none;
        --color-widget-border: transparent;
        --color-focus: transparent;
      }

      .completion-wrapper {
        position: relative;
      }

      /* set on the element itself, since its :host design tokens would win over an
         inherited value; the bottom padding keeps text clear of the attachment button
         and counter */
      .completion-wrapper temba-rich-edit {
        --temba-textinput-padding: 7px var(--pad) 40px var(--pad);
      }

      ::slotted([slot='icons']) {
        position: absolute;
        bottom: 4px;
        left: 36px;
        cursor: pointer;
        padding: 6px;
        border-radius: var(--curvature);
        z-index: 1;
      }

      .has-attachments ::slotted([slot='icons']) {
        left: 4px;
      }

      .media-wrapper {
        padding: 4px 8px;
        background: var(--sunken);
        border-top: 1px solid var(--color-widget-border);
        border-radius: 0 0 var(--curvature-widget) var(--curvature-widget);
        margin-top: 3px;
        display: none;
      }
      .has-attachments .media-wrapper {
        display: flex;
      }

      /* Override media picker styles to integrate better */
      .media-wrapper temba-media-picker {
        --color-widget-border: transparent;
      }

      .media-wrapper .attachments-list {
        padding: 0.2em 0;
      }

      .drop-overlay {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(210, 243, 184, 0.5);
        border-radius: var(--curvature-widget);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease-in-out;
        z-index: 10;
      }

      .message-editor-container.highlight .drop-overlay {
        opacity: 1;
      }

      .drop-message {
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 12px 24px;
        border-radius: var(--curvature);
        font-weight: 500;
      }

      .bottom-bar {
        position: absolute;
        bottom: 4px;
        right: 4px;
        display: flex;
        align-items: center;
      }

      .bottom-bar temba-charcount {
        display: flex;
        align-items: center;
        --temba-charcount-background: var(
          --color-overlay-light,
          rgba(0, 0, 0, 0.05)
        );
        --temba-charcount-color: var(--color-overlay-light-text, #666);
      }

      .has-attachments .attachment-icon {
        display: none;
      }

      .attachment-icon {
        position: absolute;
        bottom: 4px;
        left: 4px;
        color: #888;
        cursor: pointer;
        padding: 6px;
        border-radius: 8px;
        background: rgba(0, 0, 0, 0.04);
        transition:
          background-color 0.2s ease-in-out,
          color 0.2s ease-in-out;
      }

      .attachment-icon:hover {
        color: var(--color-text-dark);
        background: rgba(0, 0, 0, 0.08);
      }
    `;
  }

  @property({ type: String })
  name = '';

  @property({ type: String })
  placeholder = '';

  @property({ type: Boolean })
  textarea = true;

  @property({ type: Boolean })
  autogrow = true;

  @property({ type: Number })
  minHeight = 92;

  @property({ type: Number })
  maxLength: number;

  @property({ type: Boolean })
  session: boolean;

  @property({ type: Boolean })
  submitOnEnter = false;

  @property({ type: Boolean })
  gsm: boolean;

  @property({ type: Boolean })
  disableCompletion: boolean;

  @property({ type: String })
  counter: string;

  @property({ type: Array })
  attachments: (Attachment | string)[] = [];

  @property({ type: String })
  accept = '';

  @property({ type: Number, attribute: 'max-attachments' })
  maxAttachments = 3;

  @property({ type: String })
  endpoint = '';

  @property({ type: Boolean, attribute: false })
  pendingDrop = false;

  @property({ type: String, attribute: 'attachment-format' })
  attachmentFormat: 'string' | 'object' = 'string';

  @property({ type: Boolean, attribute: false })
  uploading = false;

  private completionElement: RichEditor;
  private mediaPickerElement: MediaPicker;

  public firstUpdated(changes: Map<string, any>) {
    super.firstUpdated(changes);

    this.completionElement = this.shadowRoot.querySelector(
      'temba-rich-edit'
    ) as RichEditor;

    // Get the visible media picker (either in media-wrapper or the hidden one)
    this.mediaPickerElement = this.shadowRoot.querySelector(
      'temba-media-picker'
    ) as MediaPicker;

    // Set up proper attachment filtering and parsing
    this.parseAndFilterAttachments();
  }

  /**
   * Parse attachments and filter out runtime attachments for media picker
   */
  private parseAndFilterAttachments() {
    if (!this.attachments) return;

    // Filter out runtime attachments (those without '/' in content type)
    const staticAttachments = this.attachments.filter((attachment) => {
      if (typeof attachment === 'string') {
        const [contentType] = attachment.split(':');
        return contentType.includes('/');
      }
      return true;
    });

    // Convert string attachments to Attachment objects for media picker
    const mediaAttachments = staticAttachments.map((attachment) => {
      if (typeof attachment === 'string') {
        // split into content type and URL
        // e.g. "image/jpeg:http://example.com/image.jpg"
        const colonIndex = attachment.indexOf(':');
        const contentType = attachment.substring(0, colonIndex);
        const url = attachment.substring(colonIndex + 1);
        return {
          content_type: contentType,
          url: url,
          filename: this.getFilenameFromUrl(url),
          size: 0
        } as Attachment;
      }
      return attachment;
    });

    if (this.mediaPickerElement) {
      this.mediaPickerElement.attachments = mediaAttachments;
    }
  }

  /**
   * Check if there are any static attachments (excluding runtime attachments)
   */
  private hasStaticAttachments(): boolean {
    if (!this.attachments || this.attachments.length === 0) return false;

    return this.attachments.some((attachment) => {
      if (typeof attachment === 'string') {
        const [contentType] = attachment.split(':');
        return contentType.includes('/');
      }
      return true;
    });
  }

  private getFilenameFromUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      return pathname.substring(pathname.lastIndexOf('/') + 1) || 'attachment';
    } catch {
      return 'attachment';
    }
  }

  private handleCompletionChange(event: Event) {
    event.stopPropagation();
    const completion = event.target as RichEditor;
    this.value = completion.value;
    this.fireEvent('change');
  }

  private handleMediaLoading(event: CustomEvent) {
    this.uploading = event.detail.loading;
  }

  private handleMediaChange(event: Event) {
    event.stopPropagation();
    const mediaPicker = event.target as MediaPicker;

    if (this.attachmentFormat === 'object') {
      this.attachments = [...mediaPicker.attachments];
      this.fireCustomEvent(CustomEventType.ContentChanged, {
        attachments: this.attachments
      });
      this.fireEvent('change');
      return;
    }

    // Convert media picker attachments back to the format expected by the form
    const formattedAttachments = mediaPicker.attachments.map((attachment) => {
      return `${attachment.content_type}:${attachment.url}`;
    });

    // Merge with any runtime attachments that were filtered out
    const runtimeAttachments = (this.attachments || []).filter((attachment) => {
      if (typeof attachment === 'string') {
        const [contentType] = attachment.split(':');
        return !contentType.includes('/');
      }
      return false;
    }) as string[];

    this.attachments = [...runtimeAttachments, ...formattedAttachments];
    this.fireEvent('change');
  }

  private handleDragEnter(evt: DragEvent): void {
    this.highlight(evt);
  }

  private handleDragOver(evt: DragEvent): void {
    this.highlight(evt);
  }

  private handleDragLeave(evt: DragEvent): void {
    this.unhighlight(evt);
  }

  private handleDrop(evt: DragEvent): void {
    this.unhighlight(evt);

    // Forward to media picker
    if (this.mediaPickerElement) {
      const files = [...evt.dataTransfer.files];
      this.mediaPickerElement.uploadFiles(files);
    }
  }

  private handleAttachmentIconClick(): void {
    // Trigger the file picker on the media picker
    if (this.mediaPickerElement) {
      const uploadInput = this.mediaPickerElement.shadowRoot.querySelector(
        '#upload-input'
      ) as HTMLInputElement;
      if (uploadInput) {
        uploadInput.click();
      }
    }
  }

  private highlight(evt: DragEvent): void {
    evt.preventDefault();
    evt.stopPropagation();

    // Always allow highlight for testing purposes, but in real usage check media picker
    this.pendingDrop = true;
  }

  private unhighlight(evt: DragEvent): void {
    evt.preventDefault();
    evt.stopPropagation();
    this.pendingDrop = false;
  }

  public updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    if (changedProperties.has('attachments')) {
      // Re-query media picker since the DOM structure may have changed
      this.mediaPickerElement = this.shadowRoot.querySelector(
        'temba-media-picker'
      ) as MediaPicker;
    }

    if (changedProperties.has('uploading')) {
      this.dispatchEvent(
        new CustomEvent('loading', {
          detail: { loading: this.uploading }
        })
      );
    }
  }

  public getRichEditor(): RichEditor {
    return this.completionElement;
  }

  public focus() {
    super.focus();
    if (this.completionElement) {
      this.completionElement.focus();
    }
  }

  public click() {
    super.click();
    if (this.completionElement) {
      this.completionElement.click();
    }
  }

  public render(): TemplateResult {
    return this.renderField();
  }

  protected renderWidget(): TemplateResult {
    const hasAttachments = this.hasStaticAttachments();

    return html`
      <div
        class=${getClasses({
          'message-editor-container': true,
          highlight: this.pendingDrop,
          'has-attachments': hasAttachments || this.uploading
        })}
        @dragenter=${this.handleDragEnter}
        @dragover=${this.handleDragOver}
        @dragleave=${this.handleDragLeave}
        @drop=${this.handleDrop}
      >
        <div class="completion-wrapper">
          <temba-rich-edit
            name=${this.name}
            .value=${this.value}
            placeholder=${this.placeholder}
            ?textarea=${this.textarea}
            ?autogrow=${this.autogrow}
            ?session=${this.session}
            ?submitOnEnter=${this.submitOnEnter}
            ?gsm=${this.gsm}
            ?disableCompletion=${this.disableCompletion}
            maxlength=${ifDefined(this.maxLength)}
            minHeight=${ifDefined(this.minHeight)}
            widgetOnly
            @change=${this.handleCompletionChange}
          ></temba-rich-edit>
          <slot name="icons"></slot>
        </div>

        <div class="media-wrapper ">
          <temba-media-picker
            .accept=${this.accept}
            .max=${this.maxAttachments}
            .endpoint=${this.endpoint}
            @change=${this.handleMediaChange}
            @temba-loading=${this.handleMediaLoading}
            ignoreDrops
          ></temba-media-picker>
        </div>
        <temba-icon
          class="attachment-icon"
          name=${Icon.attachment}
          size="1"
          @click=${this.handleAttachmentIconClick}
        ></temba-icon>
        <div class="bottom-bar">
          ${this.counter
            ? html`<temba-charcount
                .text="${this.value || ''}"
                ?no-expressions=${this.disableCompletion}
              ></temba-charcount>`
            : null}
        </div>

        <div class="drop-overlay"></div>

        <!-- Hidden media picker for handling uploads when no attachments are shown -->
        ${!hasAttachments
          ? html`<temba-media-picker
              style="display: none;"
              .accept=${this.accept}
              .max=${this.maxAttachments}
              .endpoint=${this.endpoint}
              @change=${this.handleMediaChange}
              @temba-loading=${this.handleMediaLoading}
              ignoreDrops
            ></temba-media-picker>`
          : ''}
      </div>
    `;
  }
}
