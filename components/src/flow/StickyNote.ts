import { css, html, PropertyValueMap, TemplateResult } from 'lit';
import { msg } from '@lit/localize';
import { property } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { CustomEventType } from '../interfaces';
import { StickyNote as StickyNoteData } from '../store/flow-definition';
import { getStore } from '../store/Store';
import { AppState, fromStore, zustand } from '../store/AppState';
import { isRightClick } from './utils';

export class StickyNote extends RapidElement {
  @property({ type: String })
  public uuid: string;

  @property({ type: Object })
  public data: StickyNoteData;

  @property({ type: Boolean })
  private dragging = false;

  @property({ type: Boolean })
  public selected = false;

  @property({ type: Boolean })
  private colorPickerExpanded = false;

  @property({ type: Boolean })
  private removing = false;

  // On Apple touch devices, contenteditable starts false to prevent Apple
  // Pencil Scribble from hijacking touches. It is set to true on explicit tap.
  // Only Apple platforms have Scribble, so we avoid disabling contenteditable
  // on Windows touchscreen laptops where it would block mouse-based editing.
  private isTouchDevice =
    navigator.maxTouchPoints > 0 &&
    /iPad|iPhone|Macintosh/.test(navigator.userAgent);
  private editingField: HTMLElement | null = null;
  private removalTimeout: number | null = null;

  // Resize state
  private resizing = false;
  private resizeStartX = 0;
  private resizeStartY = 0;
  private resizeStartWidth = 0;
  private resizeStartHeight = 0;
  private resizeZoom = 1;
  private boundResizeMove = this.handleResizeMove.bind(this);
  private boundResizeEnd = this.handleResizeEnd.bind(this);
  private boundResizeTouchMove = this.handleResizeTouchMove.bind(this);
  private boundResizeTouchEnd = this.handleResizeTouchEnd.bind(this);

  @fromStore(zustand, (state: AppState) => state.isTranslating)
  private isTranslating!: boolean;

  static get styles() {
    return css`
      :host {
        --sticky-color: #fef08a;
        --sticky-border-color: #facc15;
        --sticky-text-color: #451a03;
        --curvature: 8px;
      }

      .sticky-note {
        width: var(--sticky-width, 200px);
        min-width: 200px;
        display: flex;
        flex-direction: column;
        background-color: var(--sticky-color);
        border: 1px solid var(--sticky-border-color);
        border-radius: var(--curvature);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        font-family: var(--font-family);
        font-size: 12px;
        overflow: hidden;
        transition:
          transform 0.1s ease,
          box-shadow 0.2s ease;
        color: var(--sticky-text-color);
        opacity: 0.85;
      }

      .sticky-note.dragging {
        opacity: 0.7;
        z-index: 1000;
        transform: rotate(0deg);
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.3);
      }

      .sticky-note:hover {
        transform: translateY(0px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      }

      :host(.drag-copy) .sticky-note {
        outline: 3px dashed var(--color-primary, #3b82f6);
        outline-offset: 2px;
        opacity: 0.7;
      }

      .sticky-note.selected {
        cursor: var(--shift-held-cursor, move) !important;
      }

      .sticky-note.selected .remove-button {
        cursor: pointer !important;
      }

      .sticky-note.selected [contenteditable] {
        cursor: text !important;
      }

      /* Color themes */
      .sticky-note.yellow {
        --sticky-color: #fef08a;
        --sticky-border-color: #facc15;
        --sticky-text-color: #451a03;
      }
      .sticky-note.blue {
        --sticky-color: #bfdbfe;
        --sticky-border-color: #3b82f6;
        --sticky-text-color: #1e3a8a;
      }
      .sticky-note.pink {
        --sticky-color: #fce7f3;
        --sticky-border-color: #ec4899;
        --sticky-text-color: #831843;
      }
      .sticky-note.green {
        --sticky-color: #d1fae5;
        --sticky-border-color: #10b981;
        --sticky-text-color: #064e3b;
      }
      .sticky-note.gray {
        --sticky-color: #f3f4f6;
        --sticky-border-color: #6b7280;
        --sticky-text-color: #374151;
      }

      /* Title and body containers */
      .sticky-title-container {
        position: relative;
        border-bottom: 1px solid var(--sticky-border-color);
        background-color: rgba(255, 255, 255, 0.5);
        display: flex;
        align-items: flex-start;
      }
      .sticky-body-container {
        position: relative;
        flex: 1;
        display: flex;
        flex-direction: column;
      }

      /* Editable fields */
      [contenteditable='true'] {
        margin: 2px;
        padding: 4px 8px;
        outline: none;
        border-radius: var(--curvature);
        transition: background 0.2s;
      }
      [contenteditable='true']:focus {
        background-color: rgba(255, 255, 255, 0.8);
        border-bottom: 1px solid rgba(0, 0, 0, 0.1);
        outline-color: var(--sticky-border-color);
      }

      /* Title */
      .sticky-title {
        font-weight: 600;
        font-size: 13px;
        color: var(--sticky-text-color);
        min-height: 20px;
        line-height: 20px;
        border-top-left-radius: var(--curvature);
        border-top-right-radius: 0px;
        flex-grow: 1;
        padding: 4px 8px 4px 4px !important;
        margin: 2px;
      }
      .sticky-title:empty::before {
        content: 'Click to add title';
        opacity: 0.5;
        font-style: italic;
      }
      .sticky-title:focus {
        border-bottom-left-radius: 0px;
        border-bottom-right-radius: 0px;
      }

      /* Body */
      .sticky-body {
        padding: 8px 10px 20px;
        color: var(--sticky-text-color);
        line-height: 1.4;
        min-height: 48px;
        word-wrap: break-word;
        white-space: pre-wrap;
        margin: 2px;
        flex: 1;
      }
      .sticky-body:empty::before {
        content: 'Click to add note';
        opacity: 0.5;
        font-style: italic;
      }
      .sticky-body:focus {
        border-top-left-radius: 0px;
        border-top-right-radius: 0px;
      }

      /* Drag icon */
      .sticky-title-container > .drag-handle {
        --icon-color: var(--sticky-border-color);
        cursor: var(--shift-held-cursor, move);
        max-width: 20px;
        padding-left: 8px;
        padding-top: 10px;
        overflow: hidden;
        transition: all 0.2s ease;
        align-self: flex-start;
        flex-shrink: 0;
      }

      .sticky-note:hover .drag-handle {
      }

      .sticky-note:focus-within .sticky-title-container > .drag-handle {
      }

      /* Remove button */
      .remove-button {
        background: transparent;
        border: none;
        color: var(--sticky-text-color);
        visibility: hidden;
        cursor: pointer;
        font-size: 1em;
        font-weight: 600;
        line-height: 1;
        z-index: 10;
        transition: all 100ms ease-in-out;
        margin: 10px 8px 6px;
        width: 1em;
        pointer-events: auto;
        flex-shrink: 0;
      }

      .sticky-note:hover .remove-button {
        visibility: visible;
        opacity: 0.7;
      }

      .remove-button:hover {
        visibility: visible;
        opacity: 1;
      }

      .remove-button.touch-visible {
        visibility: visible !important;
        opacity: 0.7;
      }

      /* Removing state */
      .sticky-note.removing {
        opacity: 1;
      }

      .sticky-title-container.removing {
        background-color: var(--color-error, #dc3545) !important;
      }

      .sticky-title-container.removing .sticky-title {
        color: white;
        text-align: center;
      }

      .sticky-title-container.removing .remove-button {
        color: white;
      }

      .sticky-title-container.removing .drag-handle {
        --icon-color: white;
      }

      .sticky-title-container.removing .remove-button {
        visibility: visible;
        opacity: 0.7;
      }

      .sticky-title-container.removing .remove-button:hover {
        opacity: 1;
      }

      /* Focus/active states */
      .sticky-note:focus-within {
        box-shadow:
          0 0 0 1px var(--sticky-border-color),
          0 10px 20px rgba(0, 0, 0, 0.3);
      }

      .sticky-note:focus-within .drag-handle {
        max-width: 0px;
        padding-left: 0px;
      }

      /* Resize handle */
      .resize-handle {
        position: absolute;
        bottom: 0;
        right: 0;
        width: 16px;
        height: 16px;
        cursor: nwse-resize;
        z-index: 5;
        border-bottom-right-radius: var(--curvature);
      }

      .resize-handle::after {
        content: '';
        position: absolute;
        bottom: 2px;
        right: 2px;
        width: 10px;
        height: 10px;
        border-right: 2px solid var(--sticky-border-color);
        border-bottom: 2px solid var(--sticky-border-color);
        opacity: 0.4;
        border-bottom-right-radius: var(--curvature);
      }

      .sticky-note:hover .resize-handle::after {
        opacity: 0.7;
      }

      .sticky-note.resizing {
        user-select: none;
      }

      /* Color picker */
      .color-picker {
        position: absolute;
        bottom: 4px;
        left: 4px;
        width: 8px;
        height: 8px;
        border: 1px solid rgba(0, 0, 0, 0.2);

        border-radius: 3px;
        background-color: var(--sticky-color);
        cursor: pointer;
        transition: transform 0.2s ease;
      }

      .color-picker:hover {
        transform: scale(1.1);
      }

      .color-options {
        position: absolute;
        bottom: 0;
        left: 0;
        display: flex;
        gap: 4px;
        background-color: rgba(255, 255, 255, 0.9);
        border: 1px solid #ccc;
        border-radius: 6px;
        padding: 3px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        transform-origin: bottom left;
        transform: scale(0);
        opacity: 0;
        transition:
          transform 0.2s ease,
          opacity 0.2s ease;
        z-index: 1000;
      }

      .color-options.expanded {
        transform: scale(1);
        opacity: 1;
      }

      .color-option {
        width: 12px;
        height: 12px;
        border: 1px solid rgba(0, 0, 0, 0.2);
        border-radius: 3px;
        cursor: pointer;
        transition:
          transform 0.15s ease,
          border-color 0.15s ease;
      }

      .color-option:hover {
        transform: scale(1.1);
        border-color: rgba(0, 0, 0, 0.4);
      }

      .color-option.yellow {
        background-color: #fef08a;
      }

      .color-option.blue {
        background-color: #bfdbfe;
      }

      .color-option.pink {
        background-color: #fce7f3;
      }

      .color-option.green {
        background-color: #d1fae5;
      }

      .color-option.gray {
        background-color: #f3f4f6;
      }
    `;
  }

  protected updated(
    changes: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.updated(changes);
    if (changes.has('data') || changes.has('uuid')) {
      this.updateCanvasSize();
    }
  }

  private updateCanvasSize(): void {
    if (!this.data) {
      return;
    }

    const element = this.querySelector('.sticky-note');
    if (element) {
      const rect = element.getBoundingClientRect();
      getStore()
        .getState()
        .expandCanvas(
          this.data.position.left + rect.width,
          this.data.position.top + rect.height
        );
    }
  }

  private handleTitleBlur(event: FocusEvent): void {
    this.handleContentBlurForTouch(event);
    const target = event.target as HTMLElement;
    const newTitle = target.textContent || '';

    if (this.data && newTitle !== this.data.title) {
      getStore()
        .getState()
        .updateStickyNote(this.uuid, {
          ...this.data,
          title: newTitle
        });
      this.fireCustomEvent(CustomEventType.SizeChanged, { uuid: this.uuid });
    }
    this.requestUpdate();
  }

  private handleBodyBlur(event: FocusEvent): void {
    this.handleContentBlurForTouch(event);
    const target = event.target as HTMLElement;
    const newBody = target.innerText || '';

    if (this.data && newBody !== this.data.body) {
      getStore()
        .getState()
        .updateStickyNote(this.uuid, {
          ...this.data,
          body: newBody
        });
      this.fireCustomEvent(CustomEventType.SizeChanged, { uuid: this.uuid });
    }
    this.requestUpdate();
  }

  /* c8 ignore start -- touch-only handlers untestable in headless Chromium */
  private handleDragHandleTouchStart(event: TouchEvent): void {
    // Prevent Apple Pencil Scribble from activating on the adjacent
    // contenteditable fields when touching/dragging the handle.
    event.preventDefault();
  }

  /**
   * On touch devices, contenteditable is off by default. A tap on the
   * title or body enables it and focuses the element for editing.
   */
  private handleContentTap(event: TouchEvent): void {
    if (!this.isTouchDevice) return;
    const target = event.target as HTMLElement;
    if (
      !target.classList.contains('sticky-title') &&
      !target.classList.contains('sticky-body')
    )
      return;

    // Enable editing and focus
    target.setAttribute('contenteditable', 'true');
    this.editingField = target;
    target.focus();
    event.stopPropagation();
  }

  /**
   * When a contenteditable field loses focus on a touch device,
   * disable contenteditable again to prevent Scribble.
   */
  private handleContentBlurForTouch(event: FocusEvent): void {
    const target = event.target as HTMLElement;
    if (this.isTouchDevice && this.editingField === target) {
      target.setAttribute('contenteditable', 'false');
      this.editingField = null;
    }
  }
  /* c8 ignore stop */

  private handleContentMouseDown(event: MouseEvent): void {
    // Prevent contenteditable from gaining focus on right-click
    if (isRightClick(event)) {
      event.preventDefault();
      return;
    }
    // If this sticky note is selected, don't stop propagation
    // so that group dragging can work
    if (this.selected) {
      return;
    }
    // Otherwise, stop propagation to enable editing
    event.stopPropagation();
  }

  private handleTitleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.target as HTMLElement).blur();
    }
    if (event.key === 'Escape') {
      (event.target as HTMLElement).blur();
    }
  }

  private handleBodyKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      (event.target as HTMLElement).blur();
    }
    if (event.key === 'Escape') {
      (event.target as HTMLElement).blur();
    }
  }

  private handleColorPickerMouseEnter(): void {
    this.colorPickerExpanded = true;
  }

  private handleColorPickerMouseLeave(): void {
    this.colorPickerExpanded = false;
  }

  /* c8 ignore next 5 -- touch-only */
  private handleColorPickerTap(event: TouchEvent): void {
    event.stopPropagation();
    event.preventDefault();
    this.colorPickerExpanded = !this.colorPickerExpanded;
  }

  private handleColorOptionClick(
    event: MouseEvent | TouchEvent,
    color: 'yellow' | 'blue' | 'pink' | 'green' | 'gray'
  ): void {
    event.stopPropagation();
    event.preventDefault();

    if (this.data && color !== this.data.color) {
      getStore()
        .getState()
        .updateStickyNote(this.uuid, {
          ...this.data,
          color: color
        });
    }

    this.colorPickerExpanded = false;
    this.requestUpdate();
  }

  private handleRemoveClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    if (this.removing) {
      // Second click — delete the sticky note
      this.resetRemovingState();
      this.fireCustomEvent(CustomEventType.StickyNoteDeleted, {
        uuid: this.uuid
      });
      return;
    }

    // Preserve title height so it doesn't shrink
    const titleContainer = this.shadowRoot.querySelector(
      '.sticky-title-container'
    ) as HTMLElement;
    if (titleContainer) {
      titleContainer.style.minHeight = titleContainer.offsetHeight + 'px';
      titleContainer.style.boxSizing = 'border-box';
    }

    // First click — show confirmation
    this.removing = true;

    if (this.removalTimeout !== null) {
      clearTimeout(this.removalTimeout);
    }

    this.removalTimeout = window.setTimeout(() => {
      this.resetRemovingState();
    }, 1000);
  }

  private resetRemovingState(): void {
    this.removing = false;
    const titleContainer = this.shadowRoot?.querySelector(
      '.sticky-title-container'
    ) as HTMLElement;
    if (titleContainer) {
      titleContainer.style.minHeight = '';
      titleContainer.style.boxSizing = '';
    }
    if (this.removalTimeout !== null) {
      clearTimeout(this.removalTimeout);
      this.removalTimeout = null;
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resetRemovingState();
    this.cleanupResize();
  }

  private startResize(clientX: number, clientY: number): void {
    const stickyEl = this.shadowRoot.querySelector(
      '.sticky-note'
    ) as HTMLElement;
    if (!stickyEl) return;

    this.resizeStartX = clientX;
    this.resizeStartY = clientY;
    this.resizeStartWidth = stickyEl.offsetWidth;
    this.resizeStartHeight = stickyEl.offsetHeight;

    // Calculate zoom from screen vs layout dimensions
    const rect = stickyEl.getBoundingClientRect();
    this.resizeZoom = rect.width / stickyEl.offsetWidth;

    this.resizing = true;
    stickyEl.classList.add('resizing');
    document.body.style.userSelect = 'none';
  }

  private applyResize(clientX: number, clientY: number): void {
    const stickyEl = this.shadowRoot.querySelector(
      '.sticky-note'
    ) as HTMLElement;
    if (!stickyEl) return;

    const dx = (clientX - this.resizeStartX) / this.resizeZoom;
    const dy = (clientY - this.resizeStartY) / this.resizeZoom;

    const newWidth = Math.max(this.resizeStartWidth + dx, 200);
    const newHeight = Math.max(this.resizeStartHeight + dy, 80);

    stickyEl.style.setProperty('--sticky-width', `${newWidth}px`);
    stickyEl.style.minHeight = `${newHeight}px`;
  }

  private finishResize(clientX: number, clientY: number): void {
    const stickyEl = this.shadowRoot.querySelector(
      '.sticky-note'
    ) as HTMLElement;
    if (!stickyEl) return;

    const dx = (clientX - this.resizeStartX) / this.resizeZoom;
    const dy = (clientY - this.resizeStartY) / this.resizeZoom;

    let finalWidth = Math.max(this.resizeStartWidth + dx, 200);
    let finalHeight = Math.max(this.resizeStartHeight + dy, 80);

    // Snap up to content size if user dragged smaller
    finalWidth = Math.max(finalWidth, stickyEl.scrollWidth);
    finalHeight = Math.max(finalHeight, stickyEl.scrollHeight);

    this.cleanupResize();

    getStore()
      .getState()
      .updateStickyNote(this.uuid, {
        ...this.data,
        width: Math.round(finalWidth),
        height: Math.round(finalHeight)
      });

    this.updateCanvasSize();
    this.fireCustomEvent(CustomEventType.SizeChanged, { uuid: this.uuid });
  }

  private cleanupResize(): void {
    if (!this.resizing) return;
    this.resizing = false;
    const stickyEl = this.shadowRoot?.querySelector(
      '.sticky-note'
    ) as HTMLElement;
    if (stickyEl) {
      stickyEl.classList.remove('resizing');
    }
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', this.boundResizeMove);
    document.removeEventListener('mouseup', this.boundResizeEnd);
    document.removeEventListener('touchmove', this.boundResizeTouchMove);
    document.removeEventListener('touchend', this.boundResizeTouchEnd);
  }

  private handleResizeStart(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.startResize(event.clientX, event.clientY);
    document.addEventListener('mousemove', this.boundResizeMove);
    document.addEventListener('mouseup', this.boundResizeEnd);
  }

  private handleResizeMove(event: MouseEvent): void {
    if (!this.resizing) return;
    this.applyResize(event.clientX, event.clientY);
  }

  private handleResizeEnd(event: MouseEvent): void {
    if (!this.resizing) return;
    this.finishResize(event.clientX, event.clientY);
  }

  /* c8 ignore start -- touch-only */
  private handleResizeTouchStart(event: TouchEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const touch = event.touches[0];
    if (!touch) return;
    this.startResize(touch.clientX, touch.clientY);
    document.addEventListener('touchmove', this.boundResizeTouchMove, {
      passive: false
    });
    document.addEventListener('touchend', this.boundResizeTouchEnd);
  }

  private handleResizeTouchMove(event: TouchEvent): void {
    if (!this.resizing) return;
    event.preventDefault();
    const touch = event.touches[0];
    if (!touch) return;
    this.applyResize(touch.clientX, touch.clientY);
  }

  private handleResizeTouchEnd(event: TouchEvent): void {
    if (!this.resizing) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    this.finishResize(touch.clientX, touch.clientY);
  }
  /* c8 ignore stop */

  public render(): TemplateResult {
    if (!this.data) {
      return html`<div class="sticky-note" style="display: none;"></div>`;
    }

    const widthStyle = this.data.width
      ? `--sticky-width: ${this.data.width}px;`
      : '';
    const heightStyle = this.data.height
      ? `min-height: ${this.data.height}px;`
      : '';
    const style = `left: ${this.data.position.left}px; top: ${this.data.position.top}px; ${widthStyle} ${heightStyle}`;

    return html`
      <div
        class="sticky-note ${this.data.color} ${this.dragging
          ? 'dragging'
          : ''} ${this.removing ? 'removing' : ''} ${this.selected
          ? 'selected'
          : ''}"
        style="${style}"
        data-uuid="${this.uuid}"
      >
        <div class="sticky-title-container ${this.removing ? 'removing' : ''}">
          <temba-icon
            name="drag"
            class="drag-handle"
            @touchstart=${this.handleDragHandleTouchStart}
          ></temba-icon>
          <div
            class="sticky-title"
            contenteditable="${!this.isTranslating &&
            !this.isTouchDevice &&
            !this.removing}"
            @blur="${this.handleTitleBlur}"
            @keydown="${this.handleTitleKeyDown}"
            @mousedown="${this.handleContentMouseDown}"
            @touchend="${this.handleContentTap}"
            .textContent="${this.removing ? msg('Remove?') : this.data.title}"
          ></div>
          ${!this.isTranslating
            ? html`<div
                class="remove-button ${this.isTouchDevice
                  ? 'touch-visible'
                  : ''}"
                @click=${this.handleRemoveClick}
                @mousedown=${(e: MouseEvent) => e.stopPropagation()}
                @touchstart=${(e: TouchEvent) => e.stopPropagation()}
                title="${msg('Remove note')}"
              >
                ✕
              </div>`
            : ''}
        </div>
        <div class="sticky-body-container">
          <div
            class="sticky-body"
            contenteditable="${!this.isTranslating && !this.isTouchDevice}"
            @blur="${this.handleBodyBlur}"
            @keydown="${this.handleBodyKeyDown}"
            @mousedown="${this.handleContentMouseDown}"
            @touchend="${this.handleContentTap}"
            .textContent="${this.data.body}"
          ></div>
          ${!this.isTranslating
            ? html`<div class="edit-icon" title="${msg('Edit note')}"></div>`
            : ''}

          <!-- Color picker -->
          <div
            class="color-picker"
            @mouseenter="${this.handleColorPickerMouseEnter}"
            @mouseleave="${this.handleColorPickerMouseLeave}"
            @touchend="${this.handleColorPickerTap}"
          >
            <div
              class="color-options ${this.colorPickerExpanded
                ? 'expanded'
                : ''}"
            >
              <div
                class="color-option yellow"
                @click="${(e: MouseEvent) =>
                  this.handleColorOptionClick(e, 'yellow')}"
                @touchend="${(e: TouchEvent) =>
                  this.handleColorOptionClick(e, 'yellow')}"
              ></div>
              <div
                class="color-option blue"
                @click="${(e: MouseEvent) =>
                  this.handleColorOptionClick(e, 'blue')}"
                @touchend="${(e: TouchEvent) =>
                  this.handleColorOptionClick(e, 'blue')}"
              ></div>
              <div
                class="color-option pink"
                @click="${(e: MouseEvent) =>
                  this.handleColorOptionClick(e, 'pink')}"
                @touchend="${(e: TouchEvent) =>
                  this.handleColorOptionClick(e, 'pink')}"
              ></div>
              <div
                class="color-option green"
                @click="${(e: MouseEvent) =>
                  this.handleColorOptionClick(e, 'green')}"
                @touchend="${(e: TouchEvent) =>
                  this.handleColorOptionClick(e, 'green')}"
              ></div>
              <div
                class="color-option gray"
                @click="${(e: MouseEvent) =>
                  this.handleColorOptionClick(e, 'gray')}"
                @touchend="${(e: TouchEvent) =>
                  this.handleColorOptionClick(e, 'gray')}"
              ></div>
            </div>
          </div>

          <!-- Resize handle -->
          ${!this.isTranslating
            ? html`<div
                class="resize-handle"
                @mousedown="${this.handleResizeStart}"
                @touchstart="${this.handleResizeTouchStart}"
              ></div>`
            : ''}
        </div>
      </div>
    `;
  }
}
