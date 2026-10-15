import { html, render, TemplateResult } from 'lit-html';
import { css, PropertyValueMap, PropertyValues, unsafeCSS } from 'lit';
import { msg, str } from '@lit/localize';
import { property, state } from 'lit/decorators.js';
import {
  FlowDefinition,
  FlowPosition,
  Action,
  Node,
  NodeUI
} from '../store/flow-definition';
import { getStore, Store } from '../store/Store';
import { AppState, FlowIssue, fromStore, zustand } from '../store/AppState';
import { RapidElement } from '../RapidElement';
import { repeat } from 'lit-html/directives/repeat.js';
import { CustomEventType, DirtyTrackable, Workspace } from '../interfaces';
import {
  generateUUID,
  getClasses,
  getCookie,
  setCookie,
  WebResponse
} from '../utils';
import { TEMBA_COMPONENTS_VERSION } from '../version';
import {
  getNodeBounds,
  calculateReflowPositions,
  NodeBounds,
  showErrorDialog,
  showLoadErrorDialog,
  snapToGrid
} from './utils';
import { getLanguageLabel, getLanguageName } from '../languages';
import {
  ACTION_CONFIG,
  NODE_CONFIG,
  isEditableAction,
  isUnsupportedAction
} from './config';
import { PRIMARY_LANGUAGE_OPTION_VALUE } from './EditorToolbar';
import {
  buildTranslationBundles,
  getTranslationCounts
} from './flow-translations';
import { calculateLayeredLayout, placeStickyNotes } from './reflow';
import type { RevisionsWindow } from './RevisionsWindow';

import {
  ACTION_GROUP_METADATA,
  CONTEXT_MENU_SHORTCUTS,
  FlowType,
  FlowTypes
} from './types';

import {
  Plumber,
  calculateFlowchartPath,
  ARROW_LENGTH,
  ARROW_HALF_WIDTH
} from './Plumber';
import { CanvasNode } from './CanvasNode';
import { DragManager } from './DragManager';
import { ZoomManager } from './ZoomManager';
import { ButtonType, Dialog } from '../layout/Dialog';

import { CanvasMenu, CanvasMenuSelection } from './CanvasMenu';
import { NodeTypeSelector, NodeTypeSelection } from './NodeTypeSelector';
import { FlowSearch, SearchResult } from './FlowSearch';
import { RealtimeSubscription, subscribeToFlow } from '../live/Realtime';
import { FlowDependency } from './dependencies';

export function findNodeForExit(
  definition: FlowDefinition,
  exitUuid: string
): string | null {
  for (const node of definition.nodes) {
    const exit = node.exits.find((e) => e.uuid === exitUuid);
    if (exit) {
      return node.uuid;
    }
  }
  return null;
}

const SAVE_QUIET_TIME = 2000;

export interface DraggableItem {
  uuid: string;
  position: FlowPosition;
  element: HTMLElement;
  type: 'node' | 'sticky';
}

export interface SelectionBox {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export type ToolbarAction =
  | { action: 'view-change'; view: 'flow' | 'table' }
  | { action: 'zoom-in' }
  | { action: 'zoom-out' }
  | { action: 'zoom-to-fit' }
  | { action: 'zoom-to-full' }
  | { action: 'revisions' }
  | { action: 'search' }
  | { action: 'language-change'; isPrimary?: boolean; languageCode?: string }
  | { action: 'auto-translate' }
  | { action: 'make-default-language' };
const EMPTY_FLOW_ISSUES: FlowIssue[] = [];

// How long the pending-changes auto-save countdown runs (in ms).
// Used in both the CSS animation and the JS setTimeout.
const PENDING_SAVE_DELAY = 5000;

// Shortest gap (in ms) between activity reads, however many changes the flow
// socket announces in that window.
const ACTIVITY_FETCH_INTERVAL = 3000;

/**
 * Manages a timed "pending changes" card that lets users discard or auto-save
 * after a delay.  Used for both auto-layout and shift+drag copy.
 */
class PendingChangesTimer {
  /** Whether the card is visible. */
  unsaved = false;

  /**
   * Flag consumed once per willUpdate cycle to suppress the debounced save
   * that would otherwise fire when dirtyDate changes.
   */
  pending = false;

  /** Counter incremented on every start/reset – used as a Lit template key
   *  so the CSS countdown animation restarts. */
  resetCount = 0;

  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    public readonly label: () => string,
    private readonly delay: number,
    private readonly host: { requestUpdate(): void },
    private readonly onExpire: () => void
  ) {}

  /** Show the card and start (or restart) the countdown timer. */
  start(requestRender = true): void {
    this.clearTimer();
    this.resetCount++;
    this.unsaved = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.unsaved) {
        this.unsaved = false;
        this.host.requestUpdate();
        this.onExpire();
      }
    }, this.delay);
    if (requestRender) {
      this.host.requestUpdate();
    }
  }

  /** Hide the card and cancel the timer without calling any callback. */
  dismiss(): void {
    this.unsaved = false;
    this.clearTimer();
    this.host.requestUpdate();
  }

  clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// Offset for positioning dropped action node relative to mouse cursor
// Keep small to make drop location close to cursor position
const DROP_PREVIEW_OFFSET_X = 20;
const DROP_PREVIEW_OFFSET_Y = 20;

export class Editor extends RapidElement {
  // connection SVGs are appended directly to the canvas, so we need light DOM
  createRenderRoot() {
    return this;
  }

  // this is the master plumber
  public plumber: Plumber;

  // drag/selection manager
  public dragManager: DragManager;

  // zoom/pan/loupe manager
  public zoomManager: ZoomManager;

  // timer for debounced saving
  private saveTimer: number | null = null;

  @property({ type: String })
  public flow: string;

  @property({ type: String })
  public version: string;

  @property({ type: String, attribute: 'spec-version' })
  public specVersion: string;

  @property({ type: String })
  public flowType: FlowType = FlowTypes.MESSAGE;

  @property({ type: Array })
  public features: string[] = [];

  private activityWatch: RealtimeSubscription = null;
  private watchedActivityFlow: string = null;
  private activityFetchTimer: number | null = null;
  private activityFetchInFlight = false;
  private activityFetchQueued = false;
  private activityFetchToken = 0;
  private assetWatch: RealtimeSubscription = null;
  private watchedAssetStore: Store = null;
  private flowInfoWatch: () => void = null;
  private assetResolveVersion = 0;
  private watchedAssetSignature = '';

  @fromStore(zustand, (state: AppState) => state.flowDefinition)
  public definition!: FlowDefinition;

  @fromStore(zustand, (state: AppState) => state.simulatorActive)
  private simulatorActive!: boolean;

  @fromStore(zustand, (state: AppState) => state.canvasSize)
  private canvasSize!: { width: number; height: number };

  @fromStore(zustand, (state: AppState) => state.dirtyDate)
  private dirtyDate!: Date;

  @fromStore(zustand, (state: AppState) => state.languageCode)
  private languageCode!: string;

  @fromStore(zustand, (state: AppState) => state.isTranslating)
  private isTranslating!: boolean;

  @fromStore(zustand, (state: AppState) => state.workspace)
  private workspace!: Workspace;

  @fromStore(zustand, (state: AppState) => state.getCurrentActivity())
  private activityData!: any;

  @fromStore(
    zustand,
    (state: AppState) => state.flowInfo?.issues ?? EMPTY_FLOW_ISSUES
  )
  private flowIssues!: FlowIssue[];

  // Drag state (managed by DragManager, kept on Editor for Lit reactivity)
  @state()
  public isDragging = false;

  // Public getter for drag state
  public get dragging(): boolean {
    return this.isDragging;
  }

  @state()
  public currentDragItem: DraggableItem | null = null;

  // Selection state
  @state()
  public selectedItems: Set<string> = new Set();

  @state()
  public isSelecting = false;

  @state()
  public selectionBox: SelectionBox | null = null;

  @state()
  public targetId: string | null = null;

  @state()
  public sourceId: string | null = null;

  @state()
  public dragFromNodeId: string | null = null;

  @state()
  public originalConnectionTargetId: string | null = null;

  @state()
  public isValidTarget = true;

  // Canvas-relative source exit position (set at drag start)
  public connectionSourceX: number | null = null;
  public connectionSourceY: number | null = null;

  @state()
  private issuesWindowHidden = true;

  @state()
  private revisionsWindowHidden = true;

  @state()
  private viewingRevision = false;

  @state()
  public isSaving = false;

  @state()
  private saveError: string | null = null;

  @state()
  public zoom = 1.0;

  @state()
  private autoTranslating = false;

  // Non-reactive flag set in willUpdate to suppress the debouncedSave
  // call in updated() when the dirtyDate change comes from a reflow/copy
  private _suppressDirtySave = false;

  // Tracks the in-flight save so disconnectedCallback can defer cleanup
  private savePromise: Promise<void> | null = null;

  // --- Pending-changes timer (shared by reflow + copy) ---

  public pendingTimer = new PendingChangesTimer(
    () => msg('Unsaved Changes'),
    PENDING_SAVE_DELAY,
    this,
    () => {
      this.pendingPositions = null;
      this.copiedItemUuids = [];
      this.saveChanges();
    }
  );

  /** Positions of all items captured before the first pending operation. */
  private pendingPositions: Record<string, FlowPosition> | null = null;

  /** UUIDs of items created by shift+drag copy during the pending window. */
  public copiedItemUuids: string[] = [];

  /** Save all current canvas positions if not already saved. */
  public capturePositionsOnce(): void {
    if (this.pendingPositions) return;
    const saved: Record<string, FlowPosition> = {};
    for (const node of this.definition.nodes) {
      const ui = this.definition._ui?.nodes[node.uuid];
      if (ui?.position) {
        saved[node.uuid] = { ...ui.position };
      }
    }
    const stickies = this.definition._ui?.stickies || {};
    for (const [uuid, sticky] of Object.entries(stickies)) {
      if (sticky.position) {
        saved[uuid] = { ...sticky.position };
      }
    }
    this.pendingPositions = saved;
  }

  public deleteDialog: Dialog | null = null;

  private dirtyAdapter: DirtyTrackable = {
    get dirtyMessage() {
      return msg(
        'Your flow is still saving. If you leave now, your latest changes may be lost.'
      );
    },
    markClean: () => {
      // no-op — the editor manages its own save lifecycle
    }
  };

  private boundBeforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
  };

  // NodeEditor state - handles both node and action editing
  @state()
  public editingNode: Node | null = null;

  @state()
  public editingNodeUI: NodeUI | null = null;

  @state()
  public editingAction: Action | null = null;

  private dialogOrigin: { x: number; y: number } | null = null;

  // Message table view toggle
  @property({ type: Boolean, reflect: true, attribute: 'message-view' })
  showMessageTable = false;

  @state()
  private isCreatingNewNode = false;

  @state()
  private pendingNodePosition: FlowPosition | null = null;

  // Canvas drop state for dragging actions to canvas
  @state()
  private canvasDropPreview: {
    action: Action;
    nodeUuid: string;
    actionIndex: number;
    position: FlowPosition;
    actionHeight: number;
  } | null = null;
  @state()
  private addActionToNodeUuid: string | null = null;

  // Track target node for action drag
  @state()
  private actionDragTargetNodeUuid: string | null = null;

  // Track previous target node to clear placeholder when moving between nodes
  private previousActionDragTargetNodeUuid: string | null = null;

  // Track action external drag state for shift-copy support
  private isActionExternalDrag = false;
  private actionDragIsCopy = false;
  private actionDragLastDetail: {
    action: Action;
    nodeUuid: string;
    actionIndex: number;
    mouseX: number;
    mouseY: number;
    actionHeight: number;
    isLastAction: boolean;
  } | null = null;

  // Connection placeholder state for dropping connections on empty canvas
  @state()
  public connectionPlaceholder: {
    position: FlowPosition;
    visible: boolean;
    dragUp?: boolean;
  } | null = null;

  // Track pending connection when dropping on canvas
  private pendingCanvasConnection: {
    fromNodeId: string;
    exitId: string;
    position: FlowPosition;
  } | null = null;

  // Bound event handlers to maintain proper 'this' context
  private boundCanvasContextMenu = this.handleCanvasContextMenu.bind(this);
  private boundWheel = (e: WheelEvent) => this.zoomManager.handleWheel(e);
  private boundWindowResize = () =>
    this.zoomManager.updateZoomControlPositioning();

  static get styles() {
    return css`
      #editor-container {
        position: relative;
        flex: 1;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }

      #editor {
        overflow: scroll;
        flex: 1;
        -webkit-font-smoothing: antialiased;
      }

      /* On touch devices, disable native scroll-by-touch so canvas
         drag draws a selection rectangle. Users scroll via scrollbars. */
      #editor.touch-device {
        touch-action: none;
      }

      #editor.touch-device::-webkit-scrollbar {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
      }

      #editor.touch-device::-webkit-scrollbar-thumb {
        background: rgba(0, 0, 0, 0.3);
        border-radius: 6px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }

      #editor.touch-device::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.05);
      }

      #grid {
        position: relative;
        background-color: #f9f9f9;
        background-image: radial-gradient(
          circle,
          rgba(61, 177, 255, 0.3) 1px,
          transparent 1px
        );
        background-size: 20px 20px;
        background-position: 10px 10px;
        width: 100%;
        display: flex;
        padding-top: 20px;
        transform-origin: 0 0;
      }

      #canvas {
        position: relative;
        padding: 0px;
        flex-grow: 1;
        margin: 20px;
      }

      #canvas > .draggable {
        position: absolute;
        z-index: 100;
        touch-action: none;
      }

      #canvas > .draggable:hover {
        z-index: 200;
      }

      #canvas > .dragging {
        z-index: 99999 !important;
        transition: none !important;
      }

      #canvas.shift-held {
        --shift-held-cursor: copy;
        cursor: copy;
      }

      #canvas.viewing-revision {
        pointer-events: none;
      }

      #canvas.read-only svg {
        pointer-events: none;
      }

      #grid.viewing-revision {
        background-color: #fff9fc;
        background-image: radial-gradient(
          circle,
          rgba(166, 38, 164, 0.2) 1px,
          transparent 1px
        );
      }

      #grid.viewing-revision temba-flow-node,
      #grid.viewing-revision svg.plumb-connector {
        opacity: 0.5;
      }

      svg.plumb-connector {
        z-index: 10;
      }

      svg.plumb-connector path {
        stroke: var(--color-connectors);
        stroke-width: 3px;
      }

      svg.plumb-connector .plumb-arrow {
        fill: var(--color-connectors);
        stroke: none;
      }

      svg.plumb-connector.hover path {
        stroke: var(--color-success);
      }

      svg.plumb-connector.hover .plumb-arrow {
        fill: var(--color-success);
      }

      #canvas.read-only-connections svg.plumb-connector.hover path {
        stroke: var(--color-connectors);
      }

      #canvas.read-only-connections svg.plumb-connector.hover .plumb-arrow {
        fill: var(--color-connectors);
      }

      #canvas.read-only-connections svg.plumb-connector,
      #canvas.read-only-connections svg.plumb-connector * {
        pointer-events: none !important;
        cursor: default !important;
      }

      #canvas.read-only-connections svg.plumb-connector path {
        stroke: #e0e0e0;
      }

      #canvas.read-only-connections svg.plumb-connector .plumb-arrow {
        fill: #e0e0e0;
      }

      svg.plumb-connector.removing path {
        stroke: var(--color-error);
      }

      svg.plumb-connector.removing .plumb-arrow {
        fill: var(--color-error);
      }

      svg.plumb-connector.dragging {
        z-index: 99999;
      }

      /* Active contact count on nodes */
      .active-count {
        position: absolute;
        background: #3498db;
        border: 1px solid #2980b9;
        border-radius: 12px;
        padding: 3px 6px;
        color: #fff;
        font-weight: 500;
        top: -10px;
        left: -10px;
        font-size: 13px;

        text-align: center;
        z-index: 600;
        line-height: 1;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
      }

      /* Activity overlay badges on connection exit stubs */
      .activity-overlay {
        position: absolute;
        background: #f3f3f3;
        border: 1px solid #d9d9d9;
        color: #333;
        border-radius: 4px;
        padding: 2px 4px;
        font-size: 10px;
        font-weight: 600;
        line-height: 0.9;
        cursor: pointer;
        z-index: 10;
        pointer-events: auto;
        white-space: nowrap;
        user-select: none;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
      }

      #grid.viewing-revision .activity-overlay {
        opacity: 0.5;
        pointer-events: none;
      }

      /* Recent contacts popup */
      @keyframes popupBounceIn {
        0% {
          transform: scale(0.8);
          opacity: 0;
        }
        50% {
          transform: scale(1.05);
        }
        100% {
          transform: scale(1);
          opacity: 1;
        }
      }

      .recent-contacts-popup {
        display: none;
        position: absolute;
        width: 200px;
        background: #f3f3f3;
        border-radius: 10px;
        box-shadow: 0 1px 3px 1px rgba(130, 130, 130, 0.2);
        z-index: 1015;
        transform-origin: top center;
      }

      .recent-contacts-popup.show {
        display: block;
        animation: popupBounceIn 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55);
      }

      .recent-contacts-popup .popup-title {
        background: #999;
        color: #fff;
        padding: 6px 0;
        text-align: center;
        border-top-left-radius: 10px;
        border-top-right-radius: 10px;
        font-size: 12px;
      }

      .recent-contacts-popup .no-contacts-message {
        padding: 15px;
        text-align: center;
        color: #999;
        font-size: 12px;
      }

      .recent-contacts-popup .contact-row {
        padding: 8px 10px;
        border-top: 1px solid #e0e0e0;
        text-align: left;
      }

      .recent-contacts-popup .contact-row:last-child {
        border-bottom-left-radius: 10px;
        border-bottom-right-radius: 10px;
      }

      .recent-contacts-popup .contact-name {
        display: block;
        font-weight: 500;
        font-size: 12px;
        color: var(--color-link-primary, #1d4ed8);
        cursor: pointer;
      }

      .recent-contacts-popup .contact-name:hover {
        text-decoration: underline;
      }

      .recent-contacts-popup .contact-operand {
        padding-top: 3px;
        font-size: 11px;
        color: #666;
        word-wrap: break-word;
      }

      .recent-contacts-popup .contact-time {
        padding-top: 3px;
        font-size: 10px;
        color: #999;
      }

      /* Connection target feedback */
      temba-flow-node.connection-target-valid {
        outline: 3px solid var(--color-success, #22c55e) !important;
        outline-offset: 2px;
        border-radius: var(--curvature);
      }

      temba-flow-node.connection-target-invalid {
        outline: 3px solid var(--color-error, #ef4444) !important;
        outline-offset: 2px;
        border-radius: var(--curvature);
      }

      /* Selection box styles */
      .selection-box {
        position: absolute;
        border: 2px dashed #6298f0ff;
        background-color: rgba(59, 130, 246, 0.1);
        z-index: 9999;
        pointer-events: none;
      }

      /* Selected item styles */
      .draggable.selected {
        outline: 3px solid #6298f0ff;
        outline-offset: 0px;
        border-radius: var(--curvature);
      }

      .draggable.selected.drag-copy {
        outline: none;
      }

      /* Language banner replaced by toolbar language selector */

      .localization-window-content {
        display: flex;
        flex-direction: column;
        gap: 16px;
        height: 100%;
      }

      .localization-header {
        font-size: 13px;
        color: #4b5563;
        line-height: 1.4;
      }

      .localization-language-select {
        --color-widget-border: #d1d5db;
        --color-widget-background: #fff;
      }

      .localization-language-row {
        display: flex;
        align-items: flex-end;
        gap: 12px;
      }

      .localization-language-row temba-select {
        flex: 1;
      }

      .localization-progress {
        margin-top: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .localization-progress.disabled {
        opacity: 0.4;
        pointer-events: none;
      }

      .localization-progress-bar-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .localization-progress-trigger {
        flex: 1;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
      }

      .localization-progress-trigger:focus-visible {
        outline: 2px solid #94a3b8;
        outline-offset: 2px;
      }

      .localization-progress-trigger temba-progress {
        flex: 1;
      }

      .localization-progress h5 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        color: #374151;
      }

      .localization-progress-summary {
        font-size: 12px;
        color: #6b7280;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 20px;
      }

      .translation-settings-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: transparent;
        border: none;
        outline: none;
        color: #6b7280;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
      }

      .translation-settings-label {
        font-size: 12px;
        color: #6b7280;
      }

      .translation-settings-arrow {
        width: 8px;
        height: 8px;
        border-right: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: rotate(-45deg);
        transition: transform 0.2s ease;
        margin-left: 2px;
      }

      .translation-settings-arrow.expanded {
        transform: rotate(45deg);
      }

      .translation-settings {
      }

      .translation-settings-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .translation-settings-row temba-checkbox {
        width: 100%;
      }

      .revert-button {
        background: var(--color-primary-dark);
        border: none;
        color: #fff;
        padding: 6px 10px;
        border-radius: var(--curvature);
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.2s ease;
      }

      .localization-empty {
        font-size: 13px;
        color: #9ca3af;
        white-space: nowrap;
      }

      .issue-list-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 13px;
        color: #333;
      }

      .issue-list-item:hover {
        background: #fff5f5;
      }

      .issue-list-item temba-icon {
        color: tomato;
        flex-shrink: 0;
      }

      .empty-flow {
        position: sticky;
        top: 80px;
        left: 0;
        right: 0;
        height: 0;
        display: flex;
        justify-content: center;
        pointer-events: none;
        z-index: 50;
      }

      .empty-flow-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        text-align: center;
        pointer-events: auto;
      }

      .empty-flow-title {
        font-size: 18px;
        font-weight: 600;
        color: #374151;
      }

      .empty-flow-description {
        font-size: 14px;
        color: #6b7280;
        max-width: 320px;
        line-height: 1.5;
      }

      .empty-flow-button {
        background: var(--color-primary-dark);
        border: none;
        color: #fff;
        padding: 10px 20px;
        border-radius: var(--curvature);
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.2s ease;
      }

      .empty-flow-button:hover {
        opacity: 0.9;
      }

      /* Legacy zoom-controls kept for compat — now in toolbar */

      .loupe,
      .loupe * {
        pointer-events: none !important;
      }

      .loupe {
        position: fixed;
        width: 280px;
        height: 280px;
        border-radius: 50%;
        overflow: hidden;
        z-index: 10000;
        border: 2px solid rgba(0, 0, 0, 0.25);
        box-shadow:
          0 4px 16px rgba(0, 0, 0, 0.35),
          0 1px 4px rgba(0, 0, 0, 0.2),
          inset 0 0 0 2px rgba(255, 255, 255, 0.3),
          inset 0 0 20px rgba(0, 0, 0, 0.08);
        transform: translate(-50%, -50%) scale(0);
        opacity: 0;
        transition:
          transform 0.15s ease-out,
          opacity 0.15s ease-out;
      }

      .loupe.visible {
        transform: translate(-50%, -50%) scale(1);
        opacity: 1;
      }

      .loupe-content {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: #f9f9f9;
        background-image: radial-gradient(
          circle,
          rgba(61, 177, 255, 0.3) 1px,
          transparent 1px
        );
      }

      .loupe::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          transparent 45%,
          rgba(0, 0, 0, 0.03) 58%,
          rgba(0, 0, 0, 0.08) 68%,
          rgba(0, 0, 0, 0.18) 80%,
          rgba(0, 0, 0, 0.35) 90%,
          rgba(0, 0, 0, 0.55) 100%
        );
        z-index: 1;
      }

      .loupe-crosshair-h,
      .loupe-crosshair-v {
        position: absolute;
        background: rgba(0, 0, 0, 0.15);
      }

      .loupe-crosshair-h {
        width: 12px;
        height: 1px;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }

      .loupe-crosshair-v {
        width: 1px;
        height: 12px;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }

      .loupe-clone {
        position: absolute;
        transform-origin: 0 0;
        pointer-events: none;
      }

      .loupe-clone > .draggable {
        position: absolute;
        z-index: 100;
      }

      .loupe-clone > svg.plumb-connector {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
      }

      /* Force hovered appearance inside the loupe since :hover can't fire
         through pointer-events:none */
      .loupe-clone .action .cn-title .remove-button,
      .loupe-clone .router .remove-button {
        visibility: visible;
        opacity: 0.7;
      }

      .loupe-clone .action .drag-handle {
        visibility: visible;
        opacity: 0.7;
      }

      .loupe-clone .exit.connected {
        background-color: var(--color-connectors, #e6e6e6);
      }

      .loupe-clone .node.execute-actions .add-action-button {
        opacity: 0.8;
      }

      .drag-hint {
        position: absolute;
        bottom: 40px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 100000;
        pointer-events: none;
        background: rgba(255, 255, 255, 0.5);
        backdrop-filter: blur(6px);
        color: #555;
        font-size: 18px;
        font-weight: 300;
        padding: 10px 32px;
        border-radius: 10px;
        border: 1px solid rgba(0, 0, 0, 0.08);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
        white-space: nowrap;
        display: none;
      }

      .drag-hint.visible {
        display: block;
        animation: drag-hint-in 0.15s ease forwards;
      }

      @keyframes drag-hint-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      .reflow-card {
        position: absolute;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10000;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(8px);
        border-radius: 10px;
        padding: 12px 16px 8px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        color: white;
        font-size: 13px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      }

      .reflow-card .reflow-top {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .reflow-card .reflow-label {
        white-space: nowrap;
      }

      .reflow-card button {
        border: none;
        border-radius: 6px;
        padding: 6px 14px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
        transition: opacity 0.15s ease;
      }

      .reflow-card button:hover {
        opacity: 0.85;
      }

      .reflow-card .reflow-discard {
        background: rgba(255, 255, 255, 0.2);
        color: white;
      }

      .reflow-meter {
        height: 3px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.15);
        overflow: hidden;
      }

      .reflow-meter-fill {
        height: 100%;
        background: rgba(255, 255, 255, 0.5);
        border-radius: 2px;
        /* animation-name is set dynamically via style attribute */
        animation-duration: ${unsafeCSS(PENDING_SAVE_DELAY / 1000)}s;
        animation-timing-function: linear;
        animation-fill-mode: forwards;
      }
    `;
  }

  constructor() {
    super();
    this.dragManager = new DragManager(this);
    this.zoomManager = new ZoomManager(this);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.syncAssetWatch(zustand.getState().flowInfo);
    this.syncActivityWatch();
  }

  protected firstUpdated(
    changes: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.firstUpdated(changes);
    this.syncAssetWatch(zustand.getState().flowInfo);
    this.plumber = new Plumber(this.querySelector('#canvas'), this);
    this.plumber.zoom = this.zoom;
    this.setupGlobalEventListeners();
    getStore()?.getState().setFlushSave(this.flushSave);
    zustand.getState().setFeatures(this.features);

    // Eagerly detect touch capability so hover-only controls are visible
    // from the start and scrollbar/touch-action CSS is applied immediately.
    if (navigator.maxTouchPoints > 0) {
      this.querySelector('#canvas')?.classList.add('touch-device');
      this.querySelector('#editor')?.classList.add('touch-device');
    }
    this.zoomManager.updateZoomControlPositioning();
    this.zoomManager.setLoupeElements(
      this.querySelector('#loupe') as HTMLElement,
      this.querySelector('#loupe-content') as HTMLElement
    );
    this.zoomManager.initLoupe();
    if (changes.has('flow') && this.flow) {
      // Defer revision fetch so reactive state changes in fetchRevisions()
      // don't run inside firstUpdated().
      setTimeout(() => {
        if (!this.isConnected || !this.flow) {
          return;
        }
        const state = getStore().getState();
        state.setSpecVersion(this.specVersion);
        state
          .fetchRevision(`/flow/revisions/${this.flow}`)
          .catch(showLoadErrorDialog);
      }, 0);
    }

    this.plumber.on('connection:drag', (connection: any) => {
      this.dragFromNodeId = connection.data.nodeId;
      this.sourceId = connection.sourceId;
      this.connectionSourceX = connection.sourceX;
      this.connectionSourceY = connection.sourceY;
      this.originalConnectionTargetId = connection.target.id;
    });

    this.plumber.on('connection:abort', (info) => {
      this.makeConnection(info);
    });

    this.plumber.on('connection:detach', (info) => {
      // console.log('Connection detached', info);
      this.makeConnection(info);
    });
  }

  private makeConnection(info) {
    if (this.sourceId && this.targetId && this.isValidTarget) {
      // going to the same target, just put it back
      if (info.target.id === this.targetId) {
        this.plumber.connectIds(
          this.dragFromNodeId,
          this.sourceId,
          this.targetId
        );
      }
      // otherwise update the connection
      else {
        getStore()
          .getState()
          .updateConnection(this.dragFromNodeId, this.sourceId, this.targetId);
      }
    } else if (
      this.connectionPlaceholder &&
      this.connectionPlaceholder.visible &&
      this.sourceId
    ) {
      // Snap the placeholder position to grid
      const snappedPosition = {
        left: snapToGrid(this.connectionPlaceholder.position.left),
        top: snapToGrid(this.connectionPlaceholder.position.top)
      };
      const isDragUp = !!this.connectionPlaceholder.dragUp;

      // Update the placeholder to the snapped position
      this.connectionPlaceholder.position = snappedPosition;

      // Store the pending connection info
      this.pendingCanvasConnection = {
        fromNodeId: this.dragFromNodeId,
        exitId: this.sourceId,
        position: snappedPosition
      };

      // Show the context menu near the placeholder
      const canvas = this.querySelector('#canvas');
      if (canvas) {
        const canvasRect = canvas.getBoundingClientRect();
        const menuX = canvasRect.left + snappedPosition.left * this.zoom - 40;
        const menuY = isDragUp
          ? canvasRect.top + snappedPosition.top * this.zoom + 74 // just below placeholder bottom
          : canvasRect.top + snappedPosition.top * this.zoom + 80; // just below placeholder

        const canvasMenu = this.querySelector(
          'temba-canvas-menu'
        ) as CanvasMenu;
        if (canvasMenu) {
          canvasMenu.show(
            menuX,
            menuY,
            {
              x: snappedPosition.left,
              y: snappedPosition.top
            },
            false, // Don't show sticky note option for connection drops
            false,
            CONTEXT_MENU_SHORTCUTS[this.flowType]
          );
        }
      }

      // Request update to render the connection line
      this.requestUpdate();

      // Don't clear placeholder or connection info yet - keep them for menu interaction
      return;
    }

    // Clean up visual feedback
    document.querySelectorAll('temba-flow-node').forEach((node) => {
      node.classList.remove(
        'connection-target-valid',
        'connection-target-invalid'
      );
    });

    // Clear connection state (but keep sourceId/dragFromNodeId if we have a pending connection)
    if (!this.pendingCanvasConnection) {
      this.sourceId = null;
      this.connectionSourceX = null;
      this.connectionSourceY = null;
      this.dragFromNodeId = null;
    }
    this.targetId = null;
    this.isValidTarget = true;
  }

  protected willUpdate(changes: PropertyValues): void {
    super.willUpdate(changes);

    if (changes.has('definition')) {
      // Set flowType from the loaded definition
      if (this.definition?.type) {
        this.flowType = this.getFlowTypeFromDefinition(this.definition.type);
      }

      // Pre-sync zoom state so we don't mutate reactive state in updated().
      this.zoomManager.restoreInitialZoomFromSettings();
    }

    if (changes.has('dirtyDate')) {
      if (this.dirtyDate) {
        if (this.pendingTimer.pending) {
          // This dirtyDate is from a reflow/copy operation — consume the
          // flag and suppress the save in updated().
          this.pendingTimer.pending = false;
          this._suppressDirtySave = true;
        } else if (this.pendingTimer.unsaved) {
          // Additional change while the pending-changes card is showing —
          // reset the timer so all accumulated changes can be discarded.
          this.pendingTimer.start(false);
          this._suppressDirtySave = true;
        } else {
          this.isSaving = true;
        }
      }
    }
  }

  private setSimulatorTabHidden(hidden: boolean): void {
    const simulator = document.querySelector(
      'temba-simulator'
    ) as HTMLElement & {
      shadowRoot?: ShadowRoot;
    };
    const phoneTab = simulator?.shadowRoot?.querySelector('#phone-tab') as any;
    if (phoneTab) {
      phoneTab.hidden = hidden;
    }
  }

  protected updated(
    changes: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.updated(changes);
    if (changes.has('features')) {
      zustand.getState().setFeatures(this.features);
    }
    if (changes.has('revisionsWindowHidden')) {
      this.setSimulatorTabHidden(!this.revisionsWindowHidden);
    }
    if (changes.has('canvasSize')) {
      this.zoomManager.updateZoomControlPositioning();
    }

    if (
      changes.has('showMessageTable') &&
      !this.showMessageTable &&
      this.plumber
    ) {
      // Canvas was re-added to the DOM; rebind the plumber, listeners, and repaint
      requestAnimationFrame(() => {
        const canvas = this.querySelector('#canvas');
        if (canvas) {
          this.plumber.setContainer(canvas as HTMLElement);
          this.plumber.repaintEverything();
          canvas.addEventListener('contextmenu', this.boundCanvasContextMenu);
        }
      });
    }

    if (changes.has('showMessageTable')) {
      this.zoomManager.updateZoomControlPositioning();
    }

    if (changes.has('definition')) {
      // defer to avoid triggering a reactive canvasSize update during this cycle
      setTimeout(() => this.updateCanvasSize(), 0);

      this.syncActivityWatch();
    }

    if (changes.has('simulatorActive')) {
      if (this.simulatorActive) {
        // Close any open floating windows when simulator opens
        this.closeFloatingWindows();
      }
      this.syncActivityWatch();
    }

    if (changes.has('activityData')) {
      // Update plumber with new activity data
      if (this.plumber) {
        this.plumber.setActivityData(this.activityData);
      }
    }

    if (changes.has('dirtyDate')) {
      if (this.dirtyDate) {
        if (this._suppressDirtySave) {
          this._suppressDirtySave = false;
        } else {
          this.debouncedSave();
        }
      }
    }

    if (changes.has('isSaving')) {
      const store = document.querySelector('temba-store') as Store;
      if (this.isSaving) {
        window.addEventListener('beforeunload', this.boundBeforeUnload);
        if (store?.markDirty) {
          store.markDirty(this.dirtyAdapter);
        }
      } else {
        window.removeEventListener('beforeunload', this.boundBeforeUnload);
        if (store?.markClean) {
          store.markClean(this.dirtyAdapter);
        }
      }
    }

    if (changes.has('saveError') && this.saveError) {
      showErrorDialog(msg('Save Failed'), this.saveError);
      setTimeout(() => {
        this.saveError = null;
      }, 0);
    }
  }

  /**
   * Map FlowDefinition type to Editor flowType
   * FlowDefinition uses: 'messaging', 'messaging_background', 'messaging_offline', 'voice'
   * Editor uses: 'message', 'voice', 'background'
   */
  private getFlowTypeFromDefinition(definitionType: string): FlowType {
    if (definitionType === 'voice') {
      return FlowTypes.VOICE;
    } else if (
      definitionType === 'messaging_background' ||
      definitionType === 'messaging_offline'
    ) {
      return FlowTypes.BACKGROUND;
    } else {
      // 'messaging' or any other messaging type defaults to 'message'
      return FlowTypes.MESSAGE;
    }
  }

  /**
   * If there's a pending debounced save, cancel the timer and save immediately.
   * Called by the simulator to ensure the latest definition is persisted before
   * starting a simulation run.
   */
  private flushSave = async (): Promise<void> => {
    // Capture the definition eagerly before any async gap so it
    // survives even if the component unmounts and clearFlowData runs.
    const snapshot = this.definition ? { ...this.definition } : null;

    // Flush pending-changes timer (reflow/copy operations) if active
    if (this.pendingTimer.unsaved) {
      this.pendingPositions = null;
      this.copiedItemUuids = [];
      this.pendingTimer.dismiss();
    }

    // Cancel any pending debounce timer
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Wait for any in-flight POST to finish first
    if (this.savePromise) {
      await this.savePromise;
    }

    // Save if there are unsaved changes
    if (snapshot && this.dirtyDate) {
      await this.saveChanges(snapshot);
    }
  };

  private debouncedSave(): void {
    // Clear any existing timer
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = window.setTimeout(() => {
      // Don't auto-save while the pending-changes card is showing
      if (this.pendingTimer.unsaved) {
        this.saveTimer = null;
        return;
      }

      const now = new Date();
      const timeSinceLastChange = now.getTime() - this.dirtyDate.getTime();

      if (timeSinceLastChange >= SAVE_QUIET_TIME) {
        this.saveChanges();
        this.saveTimer = null;
      } else {
        this.debouncedSave();
      }
    }, SAVE_QUIET_TIME);
  }

  private definitionForSave(definition: FlowDefinition): FlowDefinition {
    return {
      ...definition,
      _ui: {
        ...definition._ui,
        editor: TEMBA_COMPONENTS_VERSION
      }
    };
  }

  private saveChanges(definitionOverride?: FlowDefinition): Promise<void> {
    const definition = this.definitionForSave(
      definitionOverride || this.definition
    );
    this.isSaving = true;

    const promise = getStore()
      .postJSON(`/flow/revisions/${this.flow}/`, definition)
      .then((response) => {
        if (response.status < 200 || response.status >= 300) {
          this.saveError = this.extractErrorMessage(response);
          return;
        }

        // Update flow info and revision with the response data
        if (response.json) {
          const state = getStore().getState();

          if (response.json.info) {
            state.setFlowInfo(response.json.info);
          }

          if (response.json.revision?.revision !== undefined) {
            state.setRevision(response.json.revision.revision);
          }
        }

        getStore().getState().setDirtyDate(null);

        // Refresh the revisions list if it's currently open.
        this.getRevisionsWindow()?.refresh();
      })
      .catch((error) => {
        console.error('Failed to save flow:', error);
        if (error instanceof Response) {
          this.saveError = msg(
            str`Server error (${error.status}). Your changes have not been saved.`
          );
        } else {
          this.saveError = msg(
            'Unable to reach the server. Please check your connection and try again.'
          );
        }
      })
      .finally(() => {
        this.isSaving = false;
        this.savePromise = null;
      });

    this.savePromise = promise;
    return promise;
  }

  private extractErrorMessage(response: WebResponse): string {
    if (response.json) {
      if (typeof response.json.detail === 'string') {
        return response.json.detail;
      }
      if (typeof response.json.error === 'string') {
        return response.json.error;
      }
      if (typeof response.json.description === 'string') {
        return response.json.description;
      }
    }
    return msg(str`Save failed with status ${response.status}.`);
  }

  private showUnsupportedActionDialog(): void {
    const dialog = document.createElement('temba-dialog') as Dialog;
    dialog.header = msg('Unsupported Action');
    dialog.primaryButtonName = '';
    dialog.cancelButtonName = msg('Ok');

    const content = document.createElement('div');
    content.style.cssText = 'padding: 20px; font-size: 14px; line-height: 1.5;';
    content.textContent = msg(
      'This action is no longer supported and should be removed.'
    );
    dialog.appendChild(content);

    document.body.appendChild(dialog);
    dialog.open = true;

    dialog.addEventListener('temba-dialog-hidden', () => {
      document.body.removeChild(dialog);
    });
  }

  private syncActivityWatch(): void {
    const flow = this.simulatorActive ? null : this.definition?.uuid;
    if (this.activityWatch && flow === this.watchedActivityFlow) {
      return;
    }

    if (this.activityWatch) {
      this.activityWatch.unsubscribe();
      this.activityWatch = null;
    }
    this.clearActivityFetch();
    this.watchedActivityFlow = flow;
    if (!flow) {
      return;
    }

    this.activityWatch = subscribeToFlow(
      flow,
      (event) => {
        if (event?.type === 'activity') {
          this.scheduleActivityFetch(flow);
        }
      },
      // fires on every (re)subscribe, so catch up on anything published while
      // we were disconnected
      () => this.scheduleActivityFetch(flow)
    );

    // the socket only tells us about *changes*, and it may never connect at
    // all, so the first read doesn't wait on it
    this.fetchActivityData(flow);
  }

  /**
   * Abandons any scheduled or in-flight read. The token makes the in-flight
   * one a no-op when it lands, so a read for the flow we've stopped watching
   * can neither hold up nor swallow the next flow's first read.
   */
  private clearActivityFetch(): void {
    if (this.activityFetchTimer !== null) {
      clearTimeout(this.activityFetchTimer);
      this.activityFetchTimer = null;
    }
    this.activityFetchQueued = false;
    this.activityFetchInFlight = false;
    this.activityFetchToken++;
  }

  /**
   * Coalesces activity publications into at most one request per window.
   * Mailroom publishes once per committed sprint batch, so a flow running
   * against a large group can otherwise announce many changes a second.
   */
  private scheduleActivityFetch(flow: string): void {
    if (flow !== this.watchedActivityFlow || this.activityFetchTimer !== null) {
      return;
    }
    this.activityFetchTimer = window.setTimeout(() => {
      this.activityFetchTimer = null;
      this.fetchActivityData(flow);
    }, ACTIVITY_FETCH_INTERVAL);
  }

  private fetchActivityData(flow: string): void {
    if (
      !this.isConnected ||
      this.simulatorActive ||
      flow !== this.watchedActivityFlow
    ) {
      return;
    }

    const store = getStore();
    if (!store) {
      return;
    }

    // one request at a time, so responses can't land out of order and a burst
    // of publications collapses into a single follow-up read
    if (this.activityFetchInFlight) {
      this.activityFetchQueued = true;
      return;
    }
    this.activityFetchInFlight = true;
    const token = ++this.activityFetchToken;
    const done = () => {
      // a flow change (or teardown) since this read started has already
      // reset the bookkeeping for the flow we now care about
      if (token !== this.activityFetchToken) {
        return;
      }
      this.activityFetchInFlight = false;
      if (this.activityFetchQueued) {
        this.activityFetchQueued = false;
        this.scheduleActivityFetch(flow);
      }
    };
    Promise.resolve(
      store.getState().fetchActivity(`/flow/activity/${flow}/`)
    ).then(done, done);
  }

  private syncAssetNames(): void {
    const store = getStore();
    const state = zustand.getState();
    if (!store || !state.flowDefinition || !state.flowInfo) {
      return;
    }

    const canonical: FlowDependency[] = [];
    for (const dependency of state.flowInfo.dependencies || []) {
      const identity = dependency.uuid || dependency.key;
      if (!identity) {
        continue;
      }
      const asset = store.getAsset(dependency.type, identity);
      if (asset) {
        canonical.push({ ...dependency, name: asset.name });
      }
    }
    state.updateDependencyNames(canonical);
  }

  private async resolveAssetNames(info: AppState['flowInfo']): Promise<void> {
    const store = getStore();
    if (!store || !info) {
      return;
    }
    const version = ++this.assetResolveVersion;
    try {
      const canonical = await store.resolveAssets(info.dependencies || []);
      if (version === this.assetResolveVersion && this.isConnected) {
        zustand.getState().updateDependencyNames(canonical);
      }
    } catch (error) {
      console.error('failed to resolve flow dependency assets', error);
    }
  }

  private syncAssetWatch(info: AppState['flowInfo']): void {
    if (!this.isConnected) {
      return;
    }
    const store = getStore();
    if (!store) {
      return;
    }
    const interests = info?.dependencies || [];
    const signature = interests
      .map(
        (dependency) =>
          `${dependency.type}:${dependency.uuid || dependency.key || ''}`
      )
      .sort()
      .join('|');
    // the store is part of the key: a replaced <temba-store> leaves us
    // watching a dead one otherwise
    if (
      this.assetWatch &&
      store === this.watchedAssetStore &&
      signature === this.watchedAssetSignature
    ) {
      return;
    }
    if (this.assetWatch) {
      this.assetWatch.unsubscribe();
    }
    this.watchedAssetStore = store;
    this.watchedAssetSignature = signature;
    // the store caches the changed asset before publishing, so applying
    // everything it has covers both a single change and a reconnect refresh
    this.assetWatch = store.watchAssets(interests, () => this.syncAssetNames());
    if (!this.flowInfoWatch) {
      this.flowInfoWatch = zustand.subscribe(
        (state) => state.flowInfo,
        (info) => {
          this.syncAssetWatch(info);
          this.resolveAssetNames(info);
        }
      );
      this.resolveAssetNames(zustand.getState().flowInfo);
    }
  }

  private handleLanguageChange(languageCode: string): void {
    zustand.getState().setLanguageCode(languageCode);
  }

  private buildMakeDefaultBody(
    newLanguage: string,
    currentLanguage: string
  ): HTMLElement {
    // Rendered as a lit template: language names fall back to the raw,
    // server-derived language code when Intl/ADDITIONAL_LANGUAGE_NAMES can't
    // resolve them, so they must only ever be bound as text expressions,
    // never interpolated into markup.
    const body = document.createElement('div');
    body.style.cssText = 'padding: 20px; line-height: 1.5;';
    render(
      msg(
        html`Make <b>${newLanguage}</b> the default language for this flow?
          <b>${currentLanguage}</b> will be kept as a translation.`
      ),
      body
    );
    return body;
  }

  private showMakeDefaultLanguageConfirmation(): void {
    if (this.viewingRevision) {
      return;
    }

    const languageCode = this.languageCode;
    const baseLanguage = this.definition?.language;
    if (!languageCode || !baseLanguage || languageCode === baseLanguage) {
      return;
    }

    // don't stack a second confirmation if one is already open
    if (document.body.querySelector('temba-dialog[data-make-default]')) {
      return;
    }

    const newLanguageName = getLanguageName(languageCode);
    const currentLanguageName = getLanguageName(baseLanguage);

    const dialog = document.createElement('temba-dialog') as Dialog;
    dialog.setAttribute('data-make-default', '');
    const updateName = msg('Update');
    dialog.header = msg('Change Default Language');
    dialog.primaryButtonName = updateName;
    dialog.cancelButtonName = msg('Cancel');
    dialog.submittingName = msg('Updating');
    dialog.appendChild(
      this.buildMakeDefaultBody(newLanguageName, currentLanguageName)
    );

    // closes the dialog and removes its node once the close animation finishes.
    // The dialog never fires temba-dialog-hidden (hideOnClick is not set), so we
    // must drive removal explicitly rather than relying on that event.
    const cleanup = () => {
      // drop the marker first so a fresh confirmation can be opened immediately,
      // even though the node lingers briefly for the close animation
      dialog.removeAttribute('data-make-default');
      dialog.open = false;
      window.setTimeout(() => dialog.remove(), 500);
    };

    // created lazily on first error and reused across retries so server-
    // controlled text is only ever set via textContent, never parsed as HTML.
    let errorNode: HTMLElement | null = null;
    const clearError = () => {
      if (errorNode) {
        errorNode.remove();
        errorNode = null;
      }
    };

    let submitting = false;
    dialog.addEventListener('temba-button-clicked', async (event: any) => {
      // Cancel/Escape route through this same event; tear the dialog down.
      // Ignore cancel while a swap is in flight — the request can't be recalled,
      // so closing here would let the change land after an apparent cancel.
      if (event.detail.detail.type !== ButtonType.PRIMARY) {
        if (submitting) {
          return;
        }
        cleanup();
        return;
      }

      // guard against double-submit: the primary button stays clickable while
      // the request is in flight, so ignore re-entrant clicks.
      if (submitting) {
        return;
      }
      submitting = true;
      dialog.submitting = true;
      dialog.disabled = true;
      // Drop the Cancel affordance while the request is in flight. A
      // `closes:true` button (Cancel, and Escape which clicks it) bypasses
      // `dialog.disabled`, so leaving it would let the user close the dialog
      // even though the POST can't be recalled — the swap would land after an
      // apparent cancel. Removing the name un-renders the button entirely.
      dialog.cancelButtonName = '';
      const { error, flushFailed } =
        await this.changeDefaultLanguage(languageCode);
      submitting = false;
      dialog.submitting = false;
      dialog.disabled = false;
      dialog.cancelButtonName = msg('Cancel');

      if (flushFailed) {
        // flushSave already surfaced its own "Save Failed" dialog via the
        // reactive saveError path; close this one rather than stacking a
        // duplicate message on top of it.
        cleanup();
        return;
      }

      if (error) {
        // keep the dialog open so the user can retry or cancel
        if (!errorNode) {
          errorNode = document.createElement('div');
          errorNode.style.cssText =
            'padding: 0 20px 16px; color: var(--color-error, #e34f4f);';
          dialog.appendChild(errorNode);
        }
        errorNode.textContent = error;
        return;
      }

      clearError();
      cleanup();
    });

    document.body.appendChild(dialog);
    dialog.open = true;
  }

  /**
   * Asks the backend to promote a fully-translated language to be the flow's
   * base language, then reloads the swapped definition. Resolves to null on
   * success or an error message string on failure.
   */
  private async changeDefaultLanguage(
    languageCode: string
  ): Promise<{ error: string | null; flushFailed: boolean }> {
    // persist any pending edits so mailroom swaps the latest saved definition
    await this.flushSave();

    // A successful save clears dirtyDate; saveChanges leaves it in place on
    // failure. So if it's still set the flush did not land — abort rather than
    // letting mailroom swap a stale definition and silently drop the latest
    // edits. dirtyDate alone is the signal: the failed save also sets saveError,
    // which surfaces the standard "Save Failed" dialog via updated(), so the
    // caller closes its own dialog instead of duplicating that message.
    if (this.dirtyDate) {
      return { error: null, flushFailed: true };
    }

    try {
      const response = await getStore().postJSON(
        `/flow/change_language/${this.flow}/`,
        { language: languageCode }
      );

      if (response.status < 200 || response.status >= 300) {
        return {
          error: this.extractErrorMessage(response),
          flushFailed: false
        };
      }

      // reload the swapped definition; fetchRevision resets the editing
      // language to the new base language
      try {
        await getStore()
          .getState()
          .fetchRevision(`/flow/revisions/${this.flow}`);
      } catch (error) {
        return { error: error.message, flushFailed: false };
      }

      // refresh the revisions list if it's currently open
      this.getRevisionsWindow()?.refresh();
      return { error: null, flushFailed: false };
    } catch (error) {
      console.error('Failed to change default language:', error);
      return {
        error: msg('Unable to change the default language. Please try again.'),
        flushFailed: false
      };
    }
  }

  private getAvailableLanguages(): Array<{ code: string; name: string }> {
    // Use languages from workspace if available
    if (this.workspace?.languages && this.workspace.languages.length > 0) {
      return this.workspace.languages
        .map((code) => ({ code, name: getLanguageLabel(code) }))
        .filter((lang) => lang.code && lang.name);
    }

    // Fall back to flow definition languages if available
    if (
      this.definition?._ui?.languages &&
      this.definition._ui.languages.length > 0
    ) {
      return this.definition._ui.languages.map((lang: any) => {
        const code = typeof lang === 'string' ? lang : lang.iso || lang.code;
        return { code, name: getLanguageLabel(code) };
      });
    }

    // No languages available
    return [];
  }

  private getLocalizationLanguages(): Array<{ code: string; name: string }> {
    if (!this.definition) {
      return [];
    }

    const baseLanguage = this.definition.language;
    return this.getAvailableLanguages().filter(
      (lang) => lang.code !== baseLanguage
    );
  }

  private getLocalizationProgress(languageCode: string): {
    total: number;
    localized: number;
  } {
    return getTranslationCounts(
      buildTranslationBundles(this.definition, languageCode)
    );
  }

  private hasAnyNodeWithLocalizeCategories(): boolean {
    if (!this.definition?._ui?.nodes) return false;
    return Object.values(this.definition._ui.nodes).some(
      (nodeUI: any) => nodeUI?.config?.localizeCategories
    );
  }

  private handleAutoTranslateClick(): void {
    if (this.viewingRevision) {
      return;
    }
    const at = this.querySelector('temba-auto-translate') as any;
    at?.start();
  }

  private handleAutoTranslateChanged(e: CustomEvent): void {
    this.autoTranslating = !!e.detail?.running;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.assetWatch) {
      this.assetWatch.unsubscribe();
      this.assetWatch = null;
    }
    if (this.activityWatch) {
      this.activityWatch.unsubscribe();
      this.activityWatch = null;
    }
    this.clearActivityFetch();
    this.watchedActivityFlow = null;
    this.watchedAssetStore = null;
    this.watchedAssetSignature = '';
    if (this.flowInfoWatch) {
      this.flowInfoWatch();
      this.flowInfoWatch = null;
    }
    this.assetResolveVersion++;
    this.zoomManager.teardownLoupe();
    getStore()?.getState().setFlushSave(null);
    this.dragManager.teardownListeners();
    window.removeEventListener('beforeunload', this.boundBeforeUnload);
    const store = document.querySelector('temba-store') as Store;
    if (store?.markClean) {
      store.markClean(this.dirtyAdapter);
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.pendingTimer.clearTimer();
    window.removeEventListener('resize', this.boundWindowResize);

    const canvas = this.querySelector('#canvas');
    if (canvas) {
      canvas.removeEventListener('contextmenu', this.boundCanvasContextMenu);
    }

    const editor = this.querySelector('#editor');
    if (editor) {
      editor.removeEventListener('wheel', this.boundWheel);
    }

    // Clear all flow-specific data from the store so stale data
    // isn't briefly visible when a different flow is opened.
    // If a save is in-flight, wait for it to complete first so the
    // definition isn't nulled out from under the POST.
    if (this.savePromise) {
      this.savePromise.then(() => zustand.getState().clearFlowData());
    } else {
      zustand.getState().clearFlowData();
    }
  }

  private setupGlobalEventListeners(): void {
    // Drag/selection listeners managed by DragManager
    this.dragManager.setupListeners();

    window.addEventListener('resize', this.boundWindowResize);

    const canvas = this.querySelector('#canvas');
    if (canvas) {
      canvas.addEventListener('contextmenu', this.boundCanvasContextMenu);
    }

    const editor = this.querySelector('#editor');
    if (editor) {
      editor.addEventListener('wheel', this.boundWheel, { passive: false });
    }

    // Listen for action edit requests from flow nodes
    this.addEventListener(
      CustomEventType.ActionEditRequested,
      this.handleActionEditRequested.bind(this)
    );

    // Listen for add action requests from flow nodes
    this.addEventListener(
      CustomEventType.AddActionRequested,
      this.handleAddActionRequested.bind(this)
    );

    // Listen for node edit requests from flow nodes
    this.addEventListener(
      CustomEventType.NodeEditRequested,
      this.handleNodeEditRequested.bind(this)
    );

    // Listen for node deletion events
    this.addEventListener(
      CustomEventType.NodeDeleted,
      this.handleNodeDeleted.bind(this)
    );

    // Listen for sticky note deletion events
    this.addEventListener(CustomEventType.StickyNoteDeleted, ((
      event: CustomEvent
    ) => {
      const uuid = event.detail?.uuid;
      if (uuid) {
        getStore().getState().removeStickyNotes([uuid]);
      }
    }) as EventListener);

    // Listen for canvas menu selections
    this.addEventListener(CustomEventType.Selection, (event: CustomEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'TEMBA-CANVAS-MENU') {
        this.handleCanvasMenuSelection(event);
      } else if (target.tagName === 'TEMBA-NODE-TYPE-SELECTOR') {
        this.handleNodeTypeSelection(event);
      }
    });

    // Listen for canvas menu cancel (close without selection)
    this.addEventListener(CustomEventType.Canceled, (event: CustomEvent) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'TEMBA-CANVAS-MENU') {
        this.handleCanvasMenuClosed();
      } else if (target.tagName === 'TEMBA-NODE-TYPE-SELECTOR') {
        this.handleNodeTypeSelectorClosed();
      }
    });

    // Listen for action drag events from nodes
    this.addEventListener(
      CustomEventType.DragExternal,
      this.handleActionDragExternal.bind(this)
    );

    this.addEventListener(
      CustomEventType.DragInternal,
      this.handleActionDragInternal.bind(this)
    );

    this.addEventListener(CustomEventType.DragStop, (event: CustomEvent) => {
      if (event.detail.isExternal) {
        this.handleActionDropExternal(event);
      }
    });

    this.addEventListener(CustomEventType.SizeChanged, (event: CustomEvent) => {
      const { uuid } = event.detail;
      if (uuid) {
        requestAnimationFrame(() => {
          this.checkCollisionsAndReflow([uuid]);
        });
      }
    });
  }

  private openFlowSearch(): void {
    if (this.viewingRevision) {
      return;
    }

    if (this.zoomManager.isDialogOrMenuOpen()) {
      return;
    }

    const search = this.querySelector('temba-flow-search') as FlowSearch;
    if (!search) {
      return;
    }

    search.definition = this.definition;
    search.languageCode = this.languageCode || '';
    search.scope = this.showMessageTable ? 'table' : 'flow';
    search.includeCategories =
      this.isTranslating && this.hasAnyNodeWithLocalizeCategories();
    search.show();
  }

  private closeFlowSearch(): void {
    const search = this.querySelector('temba-flow-search') as FlowSearch;
    if (search?.open) {
      search.hide();
    }
  }

  // Called by DragManager for non-drag keyboard handling
  public handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Shift') {
      // Toggle to copy mode mid-drag (actions)
      if (this.isActionExternalDrag && !this.actionDragIsCopy) {
        this.actionDragIsCopy = true;
        this.showActionOriginal(true);
        if (this.actionDragLastDetail?.isLastAction) {
          this.reprocessActionDrag();
        }
        this.requestUpdate();
      }
    }

    // Cmd/Ctrl+F opens flow search (unless a dialog is already open)
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault();
      this.openFlowSearch();
      return;
    }

    // Don't handle other keys while search overlay is open
    const search = this.querySelector('temba-flow-search') as FlowSearch;
    if (search?.open) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.deleteDialog?.open) {
        this.deleteSelectedItems();
        this.deleteDialog.open = false;
        return;
      }

      if (this.selectedItems.size > 0) {
        this.showDeleteConfirmation();
      }
    }
    if (event.key === 'Escape') {
      this.selectedItems.clear();
      this.requestUpdate();
    }
  }

  // Called by DragManager for action drag shift-copy
  public handleKeyUp(event: KeyboardEvent): void {
    if (event.key === 'Shift') {
      if (this.isActionExternalDrag && this.actionDragIsCopy) {
        this.actionDragIsCopy = false;
        this.showActionOriginal(false);
        if (this.actionDragLastDetail?.isLastAction) {
          this.reprocessActionDrag();
        }
        this.requestUpdate();
      }
    }
  }

  // Called by DragManager on window blur
  public handleWindowBlur(): void {
    if (this.isActionExternalDrag && this.actionDragIsCopy) {
      this.actionDragIsCopy = false;
      this.showActionOriginal(false);
      if (this.actionDragLastDetail?.isLastAction) {
        this.reprocessActionDrag();
      }
      this.requestUpdate();
    }
  }

  // --- Flow settings cookie (LRU, max 50 flows) ---

  static MAX_FLOW_SETTINGS = 50;

  public getFlowSettings(): Record<string, any> {
    try {
      return JSON.parse(getCookie('flow-settings') || '{}');
    } catch {
      return {};
    }
  }

  public saveFlowSetting(key: string, value: any): void {
    if (!this.flow) return;
    const settings = this.getFlowSettings();

    // Remove existing entry so re-inserting moves it to the end (most recent)
    delete settings[this.flow];
    settings[this.flow] = { ...(settings[this.flow] || {}), [key]: value };

    // Evict oldest entries if over the limit
    const keys = Object.keys(settings);
    if (keys.length > Editor.MAX_FLOW_SETTINGS) {
      for (const oldKey of keys.slice(
        0,
        keys.length - Editor.MAX_FLOW_SETTINGS
      )) {
        delete settings[oldKey];
      }
    }

    setCookie('flow-settings', JSON.stringify(settings));
  }

  public getFlowSetting<T>(key: string): T | undefined {
    if (!this.flow) return undefined;
    return this.getFlowSettings()[this.flow]?.[key];
  }

  private showDeleteConfirmation(): void {
    const itemCount = this.selectedItems.size;

    // Create and show confirmation dialog
    // Don't open a second dialog if one is already showing
    if (this.deleteDialog?.open) return;

    const deleteName = msg('Delete');
    const dialog = document.createElement('temba-dialog') as Dialog;
    dialog.header = msg('Delete Items');
    dialog.primaryButtonName = deleteName;
    dialog.cancelButtonName = msg('Cancel');
    dialog.destructive = true;

    const content = document.createElement('div');
    content.style.cssText = 'padding: 20px;';
    content.textContent =
      itemCount === 1
        ? msg('Are you sure you want to delete this item?')
        : msg(str`Are you sure you want to delete ${itemCount} items?`);
    dialog.appendChild(content);

    dialog.addEventListener('temba-button-clicked', (event: any) => {
      // matched by DialogButton type, not the element's primary flag: on a
      // destructive dialog the rendered button carries destructive instead of
      // primary, but its type stays primary
      if (event.detail.detail.type === ButtonType.PRIMARY) {
        this.deleteSelectedItems();
        dialog.open = false;
      }
    });

    // Add to document and show
    document.body.appendChild(dialog);
    dialog.open = true;
    this.deleteDialog = dialog;

    // Clean up dialog when closed
    dialog.addEventListener('temba-dialog-hidden', () => {
      document.body.removeChild(dialog);
      this.deleteDialog = null;
    });
  }

  private performReflow(): void {
    if (!this.definition || this.definition.nodes.length === 0) return;

    // Save current positions for discard (only on first pending operation)
    this.capturePositionsOnce();

    const stickies = this.definition._ui?.stickies || {};

    // Save old node positions before reflow for sticky proximity calculation
    const oldNodePositions: Record<string, FlowPosition> = {};
    for (const node of this.definition.nodes) {
      const ui = this.definition._ui?.nodes[node.uuid];
      if (ui?.position) {
        oldNodePositions[node.uuid] = { ...ui.position };
      }
    }

    // Identify start node (first in sorted array)
    const startNodeUuid = this.definition.nodes[0].uuid;

    // Gather node sizes from DOM
    const nodeSizes = new Map<string, { width: number; height: number }>();
    const getNodeSize = (uuid: string): { width: number; height: number } => {
      const element = this.querySelector(`[id="${uuid}"]`) as HTMLElement;
      if (element) {
        const size = {
          width: element.offsetWidth,
          height: element.offsetHeight
        };
        nodeSizes.set(uuid, size);
        return size;
      }
      const fallback = { width: 200, height: 100 };
      nodeSizes.set(uuid, fallback);
      return fallback;
    };

    // Compute new layout
    const newPositions = calculateLayeredLayout(
      this.definition.nodes,
      this.definition._ui.nodes,
      startNodeUuid,
      getNodeSize
    );

    // Place sticky notes next to their closest nodes
    if (Object.keys(stickies).length > 0) {
      const stickySizes = new Map<string, { width: number; height: number }>();
      for (const uuid of Object.keys(stickies)) {
        const el = this.querySelector(
          `temba-sticky-note[uuid="${uuid}"]`
        ) as HTMLElement;
        if (el) {
          stickySizes.set(uuid, {
            width: el.offsetWidth,
            height: el.offsetHeight
          });
        } else {
          const sticky = stickies[uuid];
          stickySizes.set(uuid, {
            width: sticky.width || 200,
            height: sticky.height || 100
          });
        }
      }

      const stickyPositions = placeStickyNotes(
        stickies,
        oldNodePositions,
        newPositions,
        nodeSizes,
        stickySizes,
        startNodeUuid
      );

      // Merge sticky positions into newPositions
      Object.assign(newPositions, stickyPositions);
    }

    // Cancel any in-flight save timer so it doesn't persist the reflowed
    // layout before the user has a chance to Save or Discard.
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Suppress the auto-save from this updateCanvasPositions call
    this.pendingTimer.pending = true;

    // Apply new positions
    getStore().getState().updateCanvasPositions(newPositions);

    // Update canvas size and repaint connections
    this.updateCanvasSize();
    requestAnimationFrame(() => {
      this.plumber.repaintEverything();
    });

    // Scroll to top-left so the start node is visible
    const editor = this.querySelector('#editor') as HTMLElement;
    if (editor) {
      editor.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
    }

    // Start/reset auto-save countdown
    this.pendingTimer.start();
  }

  private handlePendingDiscard(): void {
    this.pendingTimer.dismiss();

    const hasChanges = this.copiedItemUuids.length > 0 || this.pendingPositions;
    if (!hasChanges) return;

    // Cancel any pending save timer before reverting
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    // Remove any copied items first
    if (this.copiedItemUuids.length > 0) {
      const nodeUuids = this.copiedItemUuids.filter((uuid) =>
        this.definition.nodes.some((n) => n.uuid === uuid)
      );
      const stickyUuids = this.copiedItemUuids.filter(
        (uuid) => this.definition._ui?.stickies?.[uuid]
      );

      this.pendingTimer.pending = true;
      if (nodeUuids.length > 0) {
        getStore().getState().removeNodes(nodeUuids);
      }
      if (stickyUuids.length > 0) {
        this.pendingTimer.pending = true;
        getStore().getState().removeStickyNotes(stickyUuids);
      }
      this.copiedItemUuids = [];
    }

    // Restore all positions to pre-pending state
    if (this.pendingPositions) {
      this.pendingTimer.pending = true;
      getStore().getState().updateCanvasPositions(this.pendingPositions);
      this.pendingPositions = null;
    }

    // Clear dirty state since we reverted
    setTimeout(() => {
      getStore().getState().setDirtyDate(null);
      this.isSaving = false;
    }, 0);

    requestAnimationFrame(() => {
      this.plumber.repaintEverything();
    });
  }

  private renderPendingCard(): TemplateResult | string {
    if (!this.pendingTimer.unsaved) return '';
    // Each resetCount value produces a unique animation-name so the
    // CSS countdown restarts when the timer is reset.
    const anim = `pc-${this.pendingTimer.resetCount}`;
    return html`<div class="reflow-card">
      <div class="reflow-top">
        <span class="reflow-label">${this.pendingTimer.label()}</span>
        <button class="reflow-discard" @click=${this.handlePendingDiscard}>
          ${msg('Discard')}
        </button>
      </div>
      <div class="reflow-meter">
        <div class="reflow-meter-fill" style="animation-name: ${anim}"></div>
      </div>
      <style>
        @keyframes ${anim} {
          from {
            width: 100%;
          }
          to {
            width: 0%;
          }
        }
      </style>
    </div>`;
  }

  private deleteNodes(uuids: string[]): void {
    // Remove nodes from the definition - CanvasNode will handle plumber cleanup
    if (uuids.length > 0) {
      getStore().getState().removeNodes(uuids);
    }
  }

  private deleteSelectedItems(): void {
    const nodes = Array.from(this.selectedItems).filter((uuid) =>
      this.definition.nodes.some((node) => node.uuid === uuid)
    );
    this.deleteNodes(Array.from(nodes));

    const stickies = Array.from(this.selectedItems).filter(
      (uuid) => this.definition._ui?.stickies?.[uuid]
    );

    getStore().getState().removeStickyNotes(stickies);

    // Clear selection
    this.selectedItems.clear();
  }

  private renderCanvasDropPreview(): TemplateResult | string {
    if (!this.canvasDropPreview) return '';

    const { action, position } = this.canvasDropPreview;
    const actionConfig = ACTION_CONFIG[action.type];

    if (!actionConfig) return '';

    return html`<div
      class="canvas-drop-preview"
      style="position: absolute; left: ${position.left}px; top: ${position.top}px; opacity: 0.6; pointer-events: none; z-index: 10000;"
    >
      <div
        class="node execute-actions"
        style="outline: 3px dashed var(--color-primary, #3b82f6); outline-offset: 2px; border-radius: var(--curvature);"
      >
        <div class="action sortable ${action.type}">
          <div class="action-content">
            <div
              class="cn-title"
              style="background: ${actionConfig.group
                ? ACTION_GROUP_METADATA[actionConfig.group]?.color
                : '#aaaaaa'}"
            >
              <div class="title-spacer"></div>
              <div class="name">${actionConfig.name}</div>
              <div class="title-spacer"></div>
            </div>
            <div class="body">
              ${actionConfig.render
                ? actionConfig.render({ actions: [action] } as any, action)
                : html`<pre>${action.type}</pre>`}
            </div>
          </div>
        </div>
        <div class="action-exits">
          <div class="exit-wrapper">
            <div class="exit"></div>
          </div>
        </div>
      </div>
    </div>`;
  }

  private renderConnectionPlaceholder(): TemplateResult | string {
    if (!this.connectionPlaceholder || !this.connectionPlaceholder.visible)
      return '';

    const { position, dragUp } = this.connectionPlaceholder;

    // Render connection line when we have a pending connection (after drop)
    let svgPath = null;
    if (
      this.sourceId &&
      this.dragFromNodeId &&
      this.pendingCanvasConnection &&
      this.connectionSourceX != null &&
      this.connectionSourceY != null
    ) {
      const sourceX = this.connectionSourceX;
      const sourceY = this.connectionSourceY;
      const targetX = position.left + 100;
      // When dragging up, connect to the placeholder bottom; otherwise to the top
      const targetY = dragUp ? position.top + 64 : position.top;

      const routeFace: 'top' | 'left' | 'right' = dragUp
        ? targetX < sourceX
          ? 'left'
          : 'right'
        : 'top';

      const pathData = calculateFlowchartPath(
        sourceX,
        sourceY,
        targetX,
        targetY,
        20,
        dragUp ? 0 : 10,
        5,
        routeFace
      );

      const aw = ARROW_HALF_WIDTH;
      const al = ARROW_LENGTH;
      let arrowPoints: string;
      if (dragUp) {
        // Arrow tip pointing up, base at placeholder bottom
        arrowPoints = `${targetX},${targetY - al} ${targetX - aw},${targetY} ${
          targetX + aw
        },${targetY}`;
      } else {
        // Arrow pointing down into top of placeholder
        arrowPoints = `${targetX},${targetY} ${targetX - aw},${targetY - al} ${
          targetX + aw
        },${targetY - al}`;
      }

      svgPath = html`
        <svg
          style="position: absolute; left: 0; top: 0; width: 100%; height: 100%; pointer-events: none; z-index: 9999;"
        >
          <path
            d="${pathData}"
            fill="none"
            stroke="var(--color-connectors, #ccc)"
            stroke-width="3"
          />
          <polygon
            points="${arrowPoints}"
            fill="var(--color-connectors, #ccc)"
          />
        </svg>
      `;
    }

    return html`${svgPath}
      <div
        class="connection-placeholder"
        style="position: absolute; left: ${position.left}px; top: ${position.top}px; opacity: 0.6; pointer-events: none; z-index: 10000;"
      >
        <div
          class="node execute-actions"
          style="outline: 3px dashed var(--color-primary, #3b82f6); outline-offset: 2px; border-radius: var(--curvature); min-width: 200px;"
        >
          <div class="empty-node-placeholder" style="height: 60px;"></div>
          <div class="action-exits">
            <div class="exit-wrapper">
              <div class="exit" style="pointer-events: none;"></div>
            </div>
          </div>
        </div>
      </div>`;
  }

  /**
   * Checks for collisions between nodes and sticky notes, and reflows
   * as needed. Sacred items (just moved/dropped/resized) keep their
   * positions while other items are moved in the least-disruptive direction.
   */
  public checkCollisionsAndReflow(sacredUuids: string[] = []): void {
    if (!this.definition) return;

    const allBounds: NodeBounds[] = [];
    for (const node of this.definition.nodes) {
      const nodeUI = this.definition._ui?.nodes[node.uuid];
      if (!nodeUI?.position) continue;

      const bounds = getNodeBounds(node.uuid, nodeUI.position);
      if (bounds) {
        allBounds.push(bounds);
      }
    }

    const stickies = this.definition._ui?.stickies || {};
    for (const [uuid, sticky] of Object.entries(stickies)) {
      if (!sticky.position) continue;
      const el = this.querySelector(
        `temba-sticky-note[uuid="${uuid}"]`
      ) as HTMLElement;
      if (!el) continue;
      const bounds = getNodeBounds(uuid, sticky.position, el);
      if (bounds) {
        allBounds.push(bounds);
      }
    }

    const reflowPositions = calculateReflowPositions(sacredUuids, allBounds);

    if (reflowPositions.size > 0) {
      const positions: { [uuid: string]: FlowPosition } = {};
      for (const [uuid, position] of reflowPositions.entries()) {
        positions[uuid] = position;
      }
      getStore().getState().updateCanvasPositions(positions);
    }
  }

  /* c8 ignore start -- touch-only handlers */

  /**
   * Find the temba-flow-node element at the given viewport coordinates.
   * Uses elementFromPoint which works for both mouse and touch input.
   */
  public findTargetNodeAt(clientX: number, clientY: number): Element | null {
    const el = document.elementFromPoint(clientX, clientY);
    return el?.closest('temba-flow-node') ?? null;
  }

  private updateCanvasSize(): void {
    if (!this.definition) return;

    const store = getStore();
    if (!store) return;

    // Calculate required canvas size based on all elements
    let maxWidth = 0;
    let maxHeight = 0;

    // Check node positions
    this.definition.nodes.forEach((node) => {
      const ui = this.definition._ui.nodes[node.uuid];
      if (ui && ui.position) {
        const nodeElement = this.querySelector(
          `[id="${node.uuid}"]`
        ) as HTMLElement;
        if (nodeElement) {
          // Use offsetWidth/offsetHeight (unaffected by ancestor transforms)
          maxWidth = Math.max(
            maxWidth,
            ui.position.left + nodeElement.offsetWidth
          );
          maxHeight = Math.max(
            maxHeight,
            ui.position.top + nodeElement.offsetHeight
          );
        }
      }
    });

    // Check sticky note positions
    const stickies = this.definition._ui?.stickies || {};
    Object.entries(stickies).forEach(([uuid, sticky]) => {
      if (sticky.position) {
        const stickyElement = this.querySelector(
          `temba-sticky-note[uuid="${uuid}"]`
        ) as HTMLElement;
        if (stickyElement) {
          // Use clientWidth/clientHeight instead of getBoundingClientRect() to get element dimensions
          // This avoids the coordinate system mismatch between viewport and canvas coordinates
          const width = stickyElement.clientWidth;
          const height = stickyElement.clientHeight;

          // Both sticky.position and width/height are now in the same coordinate system
          maxWidth = Math.max(maxWidth, sticky.position.left + width);
          maxHeight = Math.max(maxHeight, sticky.position.top + height);
        } else {
          // Fallback to default sizes if element not found
          maxWidth = Math.max(
            maxWidth,
            sticky.position.left + (sticky.width || 200)
          );
          maxHeight = Math.max(
            maxHeight,
            sticky.position.top + (sticky.height || 100)
          );
        }
      }
    });

    // Update canvas size in store
    store.getState().expandCanvas(maxWidth, maxHeight);
  }

  private handleCanvasContextMenu(event: MouseEvent): void {
    if (this.isReadOnly()) {
      event.preventDefault();
      return;
    }

    // Check if we right-clicked on empty canvas space
    const target = event.target as HTMLElement;
    if (target.id !== 'canvas') {
      return;
    }

    // Prevent the default browser context menu
    event.preventDefault();
    event.stopPropagation();

    // Ensure no sticky note contenteditable retains focus
    this.dragManager.blurActiveContentEditable();

    this.showContextMenuAt(event.clientX, event.clientY);
  }

  /**
   * Show the canvas context menu at the given viewport coordinates.
   * Shared by right-click (mouse) and double-tap (touch).
   */
  public showContextMenuAt(clientX: number, clientY: number): void {
    if (this.isReadOnly()) return;

    const canvas = this.querySelector('#canvas');
    if (!canvas) return;

    const canvasRect = canvas.getBoundingClientRect();
    const relativeX = (clientX - canvasRect.left) / this.zoom - 10;
    const relativeY = (clientY - canvasRect.top) / this.zoom - 10;

    const snappedLeft = snapToGrid(relativeX);
    const snappedTop = snapToGrid(relativeY);

    const canvasMenu = this.querySelector('temba-canvas-menu') as CanvasMenu;
    if (canvasMenu) {
      const hasNodes = this.definition && this.definition.nodes.length > 0;
      canvasMenu.show(
        clientX,
        clientY,
        {
          x: snappedLeft,
          y: snappedTop
        },
        true,
        hasNodes,
        CONTEXT_MENU_SHORTCUTS[this.flowType]
      );
    }
  }

  private handleEmptyFlowClick(event: MouseEvent): void {
    const editor = this.querySelector('#editor') as HTMLElement;
    if (!editor) return;

    // Scroll to top-left
    editor.scrollTo({ left: 0, top: 0, behavior: 'smooth' });

    // Place node at top-left of the canvas
    const nodeLeft = 0;
    const nodeTop = 0;

    const canvasMenu = this.querySelector('temba-canvas-menu') as CanvasMenu;
    if (canvasMenu) {
      const button = event.currentTarget as HTMLElement;
      const rect = button.getBoundingClientRect();
      const menuWidth = 265;
      const menuX = rect.left + rect.width / 2 - menuWidth / 2;
      const menuY = rect.bottom + 8;
      canvasMenu.show(
        menuX,
        menuY,
        { x: nodeLeft, y: nodeTop },
        false,
        false,
        CONTEXT_MENU_SHORTCUTS[this.flowType]
      );
    }
  }

  private handleCanvasMenuSelection(event: CustomEvent): void {
    const selection = event.detail as CanvasMenuSelection;
    const store = getStore();

    if (selection.action === 'reflow') {
      this.performReflow();
      return;
    }

    if (selection.action === 'sticky') {
      // Create new sticky note
      const stickyUuid = store.getState().createStickyNote({
        left: selection.position.x,
        top: selection.position.y
      });

      // Check for collisions with the new sticky as sacred
      requestAnimationFrame(() => {
        this.checkCollisionsAndReflow([stickyUuid]);
      });

      // Clear all pending connection state and placeholder
      this.pendingCanvasConnection = null;
      this.connectionPlaceholder = null;
      this.sourceId = null;
      this.connectionSourceX = null;
      this.connectionSourceY = null;
      this.dragFromNodeId = null;
    } else if (selection.action === 'other') {
      // Show unified node type selector
      const selector = this.querySelector(
        'temba-node-type-selector'
      ) as NodeTypeSelector;
      if (selector) {
        selector.show('all', selection.position);
      }
      // Note: we don't clear pendingCanvasConnection or placeholder here,
      // they will be used in handleNodeTypeSelection
    } else {
      // Configured shortcut — go directly to the node editor with the
      // action/node type carried in selection.action.
      this.handleNodeTypeSelection(
        new CustomEvent(CustomEventType.Selection, {
          detail: {
            nodeType: selection.action,
            position: selection.position
          } as NodeTypeSelection
        })
      );
    }
  }

  private cleanUpConnection(): void {
    if (this.isCreatingNewNode) {
      this.isCreatingNewNode = false;
      this.pendingNodePosition = null;
    }

    // see if we need to put our connection back
    if (this.originalConnectionTargetId) {
      this.plumber.connectIds(
        this.dragFromNodeId,
        this.sourceId,
        this.originalConnectionTargetId
      );
      this.originalConnectionTargetId = null;
    }

    // Menu closed without selection - clear placeholder and pending connection
    if (this.pendingCanvasConnection) {
      this.pendingCanvasConnection = null;
      this.connectionPlaceholder = null;
      this.sourceId = null;
      this.connectionSourceX = null;
      this.connectionSourceY = null;
      this.dragFromNodeId = null;
      this.originalConnectionTargetId = null;
    }
  }

  private handleCanvasMenuClosed(): void {
    this.cleanUpConnection();
  }

  private handleNodeTypeSelectorClosed(): void {
    this.addActionToNodeUuid = null;
    this.cleanUpConnection();
  }

  private handleNodeTypeSelection(event: CustomEvent): void {
    const selection = event.detail as NodeTypeSelection;

    // Check if we have a pending canvas connection (from dropping on empty canvas)
    if (this.pendingCanvasConnection) {
      // Don't clear the placeholder yet - keep it visible while editing
      // The position is already stored in pendingCanvasConnection
      // Fall through to normal node creation flow below
    }

    // Check if we're adding an action to an existing node
    if (this.addActionToNodeUuid) {
      // Find the existing node
      const node = this.definition.nodes.find(
        (n) => n.uuid === this.addActionToNodeUuid
      );
      const nodeUI = this.definition._ui.nodes[this.addActionToNodeUuid];

      if (node && nodeUI) {
        // Create a new action to add to the existing node
        const actionUuid = generateUUID();
        this.editingAction = {
          uuid: actionUuid,
          type: selection.nodeType as any
        } as Action;

        // Set the editing node to the existing node (not creating new)
        this.editingNode = node;
        this.editingNodeUI = nodeUI;
        this.isCreatingNewNode = false;

        // Clear the addActionToNodeUuid flag
        this.addActionToNodeUuid = null;

        return;
      }

      // If we couldn't find the node, clear the flag and continue with normal flow
      this.addActionToNodeUuid = null;
    }

    // Create a temporary node structure for editing (not added to store yet)
    const nodeUuid = generateUUID();

    // Determine if this is an action type or a node type
    // Actions need to be wrapped in an execute_actions node
    const isActionType = selection.nodeType in ACTION_CONFIG;
    const nodeType = isActionType ? 'execute_actions' : selection.nodeType;

    // For nodes with routers, initialize an empty router to ensure fromFormData works correctly
    const nodeConfig = NODE_CONFIG[nodeType];
    const hasRouter =
      nodeConfig?.form &&
      Object.keys(nodeConfig.form).some(
        (key) =>
          ['rules', 'categories', 'cases'].includes(key) ||
          nodeConfig.form[key]?.type === 'array'
      );

    const tempNode: Node = {
      uuid: nodeUuid,
      actions: [],
      exits: hasRouter
        ? [] // Router-based nodes will generate their own exits
        : [
            {
              uuid: generateUUID(),
              destination_uuid: null
            }
          ]
    };

    if (hasRouter) {
      // This node uses a router - initialize it with empty structure
      tempNode.router = {
        type: 'switch',
        categories: [],
        cases: [],
        operand: '@input.text',
        default_category_uuid: undefined
      };
    }

    const tempNodeUI: NodeUI = {
      position: this.pendingCanvasConnection
        ? this.pendingCanvasConnection.position
        : {
            left: selection.position.x,
            top: selection.position.y
          },
      type: nodeType as any,
      config: {}
    };

    // Mark that we're creating a new node and store the position
    this.isCreatingNewNode = true;
    this.pendingNodePosition = this.pendingCanvasConnection
      ? this.pendingCanvasConnection.position
      : {
          left: selection.position.x,
          top: selection.position.y
        };

    // Open the node editor with the temporary node
    this.editingNode = tempNode;
    this.editingNodeUI = tempNodeUI;

    // If this is an action type, we also need to set up an editing action
    if (isActionType) {
      const actionUuid = generateUUID();
      this.editingAction = {
        uuid: actionUuid,
        type: selection.nodeType as any
      } as Action;
    }
  }

  private editForceBase = false;

  private handleActionEditRequested(event: CustomEvent): void {
    const requested = event.detail.action;
    if (isUnsupportedAction(requested)) {
      this.showUnsupportedActionDialog();
      return;
    }

    // Find the node that contains this action
    const nodeUuid = event.detail.nodeUuid;
    const node = this.definition.nodes.find((n) => n.uuid === nodeUuid);
    const nodeUI = node ? this.definition._ui.nodes[nodeUuid] : undefined;

    if (!isEditableAction(requested, nodeUI?.type)) {
      return;
    }

    // For action editing, we set the action and find the corresponding node
    this.editingAction = requested;
    this.editForceBase = !!event.detail.forceBase;
    this.dialogOrigin =
      event.detail.originX != null
        ? { x: event.detail.originX, y: event.detail.originY }
        : null;

    if (node) {
      this.editingNode = node;
      this.editingNodeUI = nodeUI;
    }
  }

  private handleAddActionRequested(event: CustomEvent): void {
    // Get the node where we want to add the action
    const nodeUuid = event.detail.nodeUuid;
    const node = this.definition.nodes.find((n) => n.uuid === nodeUuid);

    if (!node) {
      return;
    }

    // Get the node's position to place the selector near it
    const nodeUI = this.definition._ui.nodes[nodeUuid];
    if (!nodeUI) {
      return;
    }

    // Show the node type selector in action mode, excluding branching actions
    const selector = this.querySelector(
      'temba-node-type-selector'
    ) as NodeTypeSelector;
    if (selector) {
      // Show the selector near the node, using a mode that excludes branching actions
      selector.show('action-no-branching', {
        x: nodeUI.position.left,
        y: nodeUI.position.top
      });

      // Store the node UUID so we know which node to add the action to
      this.addActionToNodeUuid = nodeUuid;
    }
  }

  private handleNodeEditRequested(event: CustomEvent): void {
    this.editForceBase = !!event.detail.forceBase;
    this.editingAction = null;
    this.editingNode = event.detail.node;
    this.editingNodeUI = event.detail.nodeUI;
    this.dialogOrigin =
      event.detail.originX != null
        ? { x: event.detail.originX, y: event.detail.originY }
        : null;
  }

  private handleNodeDeleted(event: CustomEvent): void {
    const nodeUuid = event.detail.uuid;
    if (nodeUuid) {
      this.deleteNodes([nodeUuid]);
    }
  }

  private handleActionSaved(updatedAction: Action): void {
    if (this.editingNode && this.editingAction) {
      let updatedActions: Action[];

      // Check if this action already exists in the node
      const existingActionIndex = this.editingNode.actions.findIndex(
        (action) => action.uuid === this.editingAction.uuid
      );

      if (existingActionIndex >= 0) {
        // Update existing action
        updatedActions = this.editingNode.actions.map((action) =>
          action.uuid === this.editingAction.uuid ? updatedAction : action
        );
      } else {
        // Add new action
        updatedActions = [...this.editingNode.actions, updatedAction];
      }

      const updatedNode = { ...this.editingNode, actions: updatedActions };

      // Check if we're creating a new node or updating an existing one
      if (this.isCreatingNewNode) {
        // This is a new node with a new action - add it to the store
        const store = getStore();

        const nodeUI: NodeUI = {
          position: this.pendingNodePosition || { left: 0, top: 0 },
          type: this.editingNodeUI?.type,
          config: {}
        };

        // Add the node to the store
        store.getState().addNode(updatedNode, nodeUI);

        // If we have a pending canvas connection, connect it to this new node
        if (this.pendingCanvasConnection) {
          store
            .getState()
            .updateConnection(
              this.pendingCanvasConnection.fromNodeId,
              this.pendingCanvasConnection.exitId,
              updatedNode.uuid
            );

          // Clear the pending connection and placeholder
          this.pendingCanvasConnection = null;
          this.connectionPlaceholder = null;
          this.sourceId = null;
          this.connectionSourceX = null;
          this.connectionSourceY = null;
          this.dragFromNodeId = null;
        }

        // Reset the creation flags
        this.isCreatingNewNode = false;
        this.pendingNodePosition = null;

        // Check for collisions and reflow
        requestAnimationFrame(() => {
          this.checkCollisionsAndReflow([updatedNode.uuid]);
        });
      } else {
        const uuid = this.editingNode.uuid;
        // Update existing node in the store
        getStore()?.getState().updateNode(uuid, updatedNode);

        // Check for collisions and reflow in case node size changed
        requestAnimationFrame(() => {
          this.checkCollisionsAndReflow([uuid]);
        });
      }
    }
    this.closeNodeEditor();
  }

  private closeNodeEditor(): void {
    this.editingNode = null;
    this.editingNodeUI = null;
    this.editingAction = null;
    this.dialogOrigin = null;
    this.editForceBase = false;
  }

  private handleActionEditCanceled(): void {
    // If we were creating a new node, just discard it
    this.cleanUpConnection();
    this.closeNodeEditor();
  }

  private handleNodeSaved(
    updatedNode: Node,
    uiConfig?: Record<string, any>
  ): void {
    if (this.editingNode) {
      if (this.isCreatingNewNode) {
        // This is a new node - add it to the store for the first time
        const store = getStore();

        const nodeUI: NodeUI = {
          position: this.pendingNodePosition || { left: 0, top: 0 },
          type: this.editingNodeUI?.type,
          config: uiConfig || {}
        };

        // Add the node to the store
        store.getState().addNode(updatedNode, nodeUI);

        // If we have a pending canvas connection, connect it to this new node
        if (this.pendingCanvasConnection) {
          store
            .getState()
            .updateConnection(
              this.pendingCanvasConnection.fromNodeId,
              this.pendingCanvasConnection.exitId,
              updatedNode.uuid
            );

          // Clear the pending connection and placeholder
          this.pendingCanvasConnection = null;
          this.connectionPlaceholder = null;
          this.sourceId = null;
          this.connectionSourceX = null;
          this.connectionSourceY = null;
          this.dragFromNodeId = null;
        }

        // Reset the creation flags
        this.isCreatingNewNode = false;
        this.pendingNodePosition = null;

        // Check for collisions and reflow
        requestAnimationFrame(() => {
          this.checkCollisionsAndReflow([updatedNode.uuid]);
        });
      } else {
        // This is an existing node - update it
        // Clean up jsPlumb connections for removed exits before updating the node
        if (this.plumber) {
          const oldExits = this.editingNode.exits || [];
          const newExits = updatedNode.exits || [];

          // Find exits that were removed
          const removedExits = oldExits.filter(
            (oldExit) =>
              !newExits.find((newExit) => newExit.uuid === oldExit.uuid)
          );

          // Remove jsPlumb connections for removed exits
          removedExits.forEach((exit) => {
            this.plumber.removeExitConnection(exit.uuid);
          });
        }

        this.plumber.revalidate([updatedNode.uuid]);

        // Update the node in the store
        getStore()?.getState().updateNode(this.editingNode.uuid, updatedNode);

        // Update the UI config if provided
        if (uiConfig) {
          getStore()?.getState().updateNodeUIConfig(updatedNode.uuid, uiConfig);
        }

        // Check for collisions and reflow in case node size changed
        const nodeUuid = updatedNode.uuid;
        requestAnimationFrame(() => {
          this.checkCollisionsAndReflow([nodeUuid]);
        });
      }
    }
    this.closeNodeEditor();
  }

  private handleNodeEditCanceled(): void {
    this.cleanUpConnection();
    this.closeNodeEditor();
  }

  private getNodeAtPosition(mouseX: number, mouseY: number): string | null {
    // Get all node elements
    const nodeElements = this.querySelectorAll('temba-flow-node');

    for (const nodeElement of Array.from(nodeElements)) {
      const rect = nodeElement.getBoundingClientRect();

      if (
        mouseX >= rect.left &&
        mouseX <= rect.right &&
        mouseY >= rect.top &&
        mouseY <= rect.bottom
      ) {
        return nodeElement.getAttribute('data-node-uuid');
      }
    }

    return null;
  }

  private calculateCanvasDropPosition(
    mouseX: number,
    mouseY: number,
    applyGridSnapping: boolean = true
  ): FlowPosition {
    // calculate the position on the canvas
    const canvas = this.querySelector('#canvas');
    if (!canvas) return { left: 0, top: 0 };

    const canvasRect = canvas.getBoundingClientRect();

    // Convert viewport coordinates to canvas coordinates, accounting for zoom
    const left = (mouseX - canvasRect.left) / this.zoom - DROP_PREVIEW_OFFSET_X;
    const top = (mouseY - canvasRect.top) / this.zoom - DROP_PREVIEW_OFFSET_Y;

    // Apply grid snapping only if requested (for final drop position)
    if (applyGridSnapping) {
      return {
        left: snapToGrid(left),
        top: snapToGrid(top)
      };
    }

    return { left, top };
  }

  private handleActionDragExternal(event: CustomEvent): void {
    const {
      action,
      nodeUuid,
      actionIndex,
      mouseX,
      mouseY,
      actionHeight = 60,
      isLastAction = false
    } = event.detail;

    // Track action external drag state for shift-copy support
    const isFirstExternalEvent = !this.isActionExternalDrag;
    this.isActionExternalDrag = true;
    this.actionDragLastDetail = {
      action,
      nodeUuid,
      actionIndex,
      mouseX,
      mouseY,
      actionHeight,
      isLastAction
    };

    // Initialize copy mode from current shift state (handles shift held before drag)
    if (isFirstExternalEvent) {
      const shiftHeld =
        this.querySelector('#canvas')?.classList.contains('shift-held') ??
        false;
      if (shiftHeld) {
        this.actionDragIsCopy = true;
        this.showActionOriginal(true);
      } else {
        (this.querySelector('#drag-hint') as HTMLElement)?.classList.add(
          'visible'
        );
      }
    }

    // Check if mouse is over another execute_actions node
    const targetNode = this.getNodeAtPosition(mouseX, mouseY);

    if (targetNode && targetNode !== nodeUuid) {
      const targetNodeUI = this.definition._ui.nodes[targetNode];
      const targetNodeDef = this.definition.nodes.find(
        (n) => n.uuid === targetNode
      );

      // Only allow dropping on execute_actions nodes, and not the source node
      if (targetNodeUI?.type === 'execute_actions' && targetNodeDef) {
        // If we moved to a different target node, clear the previous one's placeholder
        if (
          this.previousActionDragTargetNodeUuid &&
          this.previousActionDragTargetNodeUuid !== targetNode
        ) {
          const previousElement = this.querySelector(
            `temba-flow-node[data-node-uuid="${this.previousActionDragTargetNodeUuid}"]`
          );
          if (previousElement) {
            previousElement.dispatchEvent(
              new CustomEvent('action-drag-leave', {
                detail: {},
                bubbles: false
              })
            );
          }
        }

        // Update target node for drop handling
        this.actionDragTargetNodeUuid = targetNode;
        this.previousActionDragTargetNodeUuid = targetNode;

        // Hide canvas preview when over a valid target
        this.canvasDropPreview = null;

        // Tell source node to show ghost (we're over a valid target)
        const sourceElement = this.querySelector(
          `temba-flow-node[data-node-uuid="${nodeUuid}"]`
        );
        if (sourceElement) {
          sourceElement.dispatchEvent(
            new CustomEvent('action-show-ghost', {
              detail: {},
              bubbles: false
            })
          );
        }

        // Notify the target node about the drag
        const targetElement = this.querySelector(
          `temba-flow-node[data-node-uuid="${targetNode}"]`
        );
        if (targetElement) {
          targetElement.dispatchEvent(
            new CustomEvent('action-drag-over', {
              detail: {
                action,
                sourceNodeUuid: nodeUuid,
                actionIndex,
                mouseX,
                mouseY,
                actionHeight
              },
              bubbles: false
            })
          );
        }

        this.requestUpdate();
        return;
      }
    }

    // Not over a valid target node, clear any previous target's placeholder
    if (this.previousActionDragTargetNodeUuid) {
      const previousElement = this.querySelector(
        `temba-flow-node[data-node-uuid="${this.previousActionDragTargetNodeUuid}"]`
      );
      if (previousElement) {
        previousElement.dispatchEvent(
          new CustomEvent('action-drag-leave', {
            detail: {},
            bubbles: false
          })
        );
      }
      this.previousActionDragTargetNodeUuid = null;
    }

    this.actionDragTargetNodeUuid = null;

    const sourceElement = this.querySelector(
      `temba-flow-node[data-node-uuid="${nodeUuid}"]`
    );

    // Show canvas drop preview if this is not the last action,
    // or if shift-copy is active (copying allows canvas drop for last action too)
    if (!isLastAction || this.actionDragIsCopy) {
      // Hide ghost when showing canvas preview (for canvas drops)
      if (sourceElement) {
        sourceElement.dispatchEvent(
          new CustomEvent('action-hide-ghost', {
            detail: {},
            bubbles: false
          })
        );
      }

      // Don't snap to grid for preview - let it follow cursor smoothly
      const position = this.calculateCanvasDropPosition(mouseX, mouseY, false);

      this.canvasDropPreview = {
        action,
        nodeUuid,
        actionIndex,
        position,
        actionHeight
      };
    } else {
      // For last action without copy, keep ghost visible (can't drop on canvas)
      if (sourceElement) {
        sourceElement.dispatchEvent(
          new CustomEvent('action-show-ghost', {
            detail: {},
            bubbles: false
          })
        );
      }

      // Clear any existing preview for last action
      this.canvasDropPreview = null;
    }

    // Force re-render to update preview position
    this.requestUpdate();
  }

  private handleActionDragInternal(_event: CustomEvent): void {
    // Clear any previous target's placeholder when returning to internal drag
    if (this.previousActionDragTargetNodeUuid) {
      const previousElement = this.querySelector(
        `temba-flow-node[data-node-uuid="${this.previousActionDragTargetNodeUuid}"]`
      );
      if (previousElement) {
        previousElement.dispatchEvent(
          new CustomEvent('action-drag-leave', {
            detail: {},
            bubbles: false
          })
        );
      }
      this.previousActionDragTargetNodeUuid = null;
    }

    this.canvasDropPreview = null;
    this.actionDragTargetNodeUuid = null;
    this.isActionExternalDrag = false;
    this.actionDragIsCopy = false;
    (this.querySelector('#drag-hint') as HTMLElement)?.classList.remove(
      'visible'
    );
    this.actionDragLastDetail = null;
  }

  /** Show or hide the original action element in the source node. */
  private showActionOriginal(visible: boolean): void {
    if (!this.actionDragLastDetail) return;
    const sourceElement = this.querySelector(
      `temba-flow-node[data-node-uuid="${this.actionDragLastDetail.nodeUuid}"]`
    );
    if (sourceElement) {
      sourceElement.dispatchEvent(
        new CustomEvent(
          visible ? 'action-show-original' : 'action-hide-original',
          { detail: {}, bubbles: false }
        )
      );
    }
  }

  /**
   * Reprocess the last action drag event with the current shift-copy state.
   * Used when shift is toggled mid-drag to show/hide the canvas preview
   * for last-action drags.
   */
  private reprocessActionDrag(): void {
    if (!this.actionDragLastDetail) return;
    const { action, nodeUuid, actionIndex, mouseX, mouseY, actionHeight } =
      this.actionDragLastDetail;

    const sourceElement = this.querySelector(
      `temba-flow-node[data-node-uuid="${nodeUuid}"]`
    );

    // Only relevant when not hovering a target node
    if (this.actionDragTargetNodeUuid) return;

    if (this.actionDragIsCopy) {
      // Shift pressed: show canvas preview
      if (sourceElement) {
        sourceElement.dispatchEvent(
          new CustomEvent('action-hide-ghost', {
            detail: {},
            bubbles: false
          })
        );
      }
      const position = this.calculateCanvasDropPosition(mouseX, mouseY, false);
      this.canvasDropPreview = {
        action,
        nodeUuid,
        actionIndex,
        position,
        actionHeight
      };
    } else {
      // Shift released: hide canvas preview, show ghost
      if (sourceElement) {
        sourceElement.dispatchEvent(
          new CustomEvent('action-show-ghost', {
            detail: {},
            bubbles: false
          })
        );
      }
      this.canvasDropPreview = null;
    }
  }

  private handleActionDropExternal(event: CustomEvent): void {
    const {
      action,
      nodeUuid,
      actionIndex,
      mouseX,
      mouseY,
      isLastAction = false
    } = event.detail;

    const isCopy = this.actionDragIsCopy;

    // Reset action drag state
    this.isActionExternalDrag = false;
    this.actionDragIsCopy = false;
    this.actionDragLastDetail = null;
    this.previousActionDragTargetNodeUuid = null;
    (this.querySelector('#drag-hint') as HTMLElement)?.classList.remove(
      'visible'
    );

    // Check if we're dropping on an existing execute_actions node
    const targetNodeUuid = this.actionDragTargetNodeUuid;

    if (targetNodeUuid && targetNodeUuid !== nodeUuid) {
      // Dropping on another node - notify the target node to handle the drop
      const targetElement = this.querySelector(
        `temba-flow-node[data-node-uuid="${targetNodeUuid}"]`
      );
      if (targetElement) {
        targetElement.dispatchEvent(
          new CustomEvent('action-drop', {
            detail: {
              action,
              sourceNodeUuid: nodeUuid,
              actionIndex,
              mouseX,
              mouseY,
              isCopy
            },
            bubbles: false
          })
        );
      }

      // Clear state
      this.canvasDropPreview = null;
      this.actionDragTargetNodeUuid = null;
      return;
    }

    // If this is the last action and not copying, do nothing
    // Last actions can only be moved to other nodes, not dropped on canvas
    if (isLastAction && !isCopy) {
      this.canvasDropPreview = null;
      this.actionDragTargetNodeUuid = null;
      return;
    }

    // Not dropping on another node, create a new one on canvas
    // Snap to grid for the final drop position
    const position = this.calculateCanvasDropPosition(mouseX, mouseY, true);

    if (!isCopy) {
      // remove the action from the original node
      const originalNode = this.definition.nodes.find(
        (n) => n.uuid === nodeUuid
      );
      if (!originalNode) return;

      const updatedActions = originalNode.actions.filter(
        (_a, idx) => idx !== actionIndex
      );

      // if no actions remain, delete the node
      if (updatedActions.length === 0) {
        // Use deleteNodes to properly clean up Plumber connections before removing
        this.deleteNodes([nodeUuid]);
      } else {
        // update the node
        const updatedNode = { ...originalNode, actions: updatedActions };
        getStore()?.getState().updateNode(nodeUuid, updatedNode);
      }
    }

    // create a new execute_actions node with the dropped action
    // When copying, generate a fresh UUID so the clone doesn't share the original's
    const droppedAction = isCopy ? { ...action, uuid: generateUUID() } : action;
    const newNode: Node = {
      uuid: generateUUID(),
      actions: [droppedAction],
      exits: [
        {
          uuid: generateUUID(),
          destination_uuid: null
        }
      ]
    };

    const newNodeUI: NodeUI = {
      position,
      type: 'execute_actions',
      config: {}
    };

    // add the new node
    getStore()?.getState().addNode(newNode, newNodeUI);

    // Copy localizations from the original action to the new one
    if (isCopy) {
      this.copyActionLocalizations(action.uuid, droppedAction.uuid);
    }

    // clear the preview
    this.canvasDropPreview = null;
    this.actionDragTargetNodeUuid = null;

    // Check for collisions and reflow after adding new node
    requestAnimationFrame(() => {
      this.checkCollisionsAndReflow([newNode.uuid]);
    });
  }

  /** Copy all localization entries from one action UUID to another. */
  private copyActionLocalizations(
    sourceUuid: string,
    targetUuid: string
  ): void {
    const localization = this.definition?.localization;
    if (!localization) return;
    const store = getStore()?.getState();
    if (!store) return;
    for (const langCode of Object.keys(localization)) {
      const entry = localization[langCode]?.[sourceUuid];
      if (entry) {
        store.updateLocalization(
          langCode,
          targetUuid,
          JSON.parse(JSON.stringify(entry))
        );
      }
    }
  }

  private closeOpenWindows(): void {
    if (!this.issuesWindowHidden) {
      this.issuesWindowHidden = true;
    }
    if (!this.revisionsWindowHidden) {
      this.getRevisionsWindow()?.close();
      this.revisionsWindowHidden = true;
    }
    if (this.simulatorActive) {
      const simulator = document.querySelector('temba-simulator') as any;
      simulator?.handleClose();
    }
  }

  private closeFloatingWindows(): void {
    if (!this.issuesWindowHidden) {
      this.issuesWindowHidden = true;
    }
    if (!this.revisionsWindowHidden) {
      this.getRevisionsWindow()?.close();
      this.revisionsWindowHidden = true;
    }
  }

  private getRevisionsWindow(): RevisionsWindow | null {
    return this.querySelector(
      'temba-revisions-window'
    ) as RevisionsWindow | null;
  }

  // --- Issues window event handlers ---

  private handleIssuesTabClick(): void {
    if (!this.issuesWindowHidden) {
      this.issuesWindowHidden = true;
      return;
    }
    this.closeOpenWindows();
    this.issuesWindowHidden = false;
  }

  private handleIssueSelected(e: CustomEvent): void {
    const { issue } = e.detail;
    this.issuesWindowHidden = true;

    this.focusNode(issue.node_uuid);

    const node = this.definition.nodes.find((n) => n.uuid === issue.node_uuid);
    if (!node) return;

    if (issue.action_uuid) {
      const action = node.actions?.find((a) => a.uuid === issue.action_uuid);
      // non-editable actions are focused on the canvas but have no dialog
      const nodeUI = this.definition._ui.nodes[issue.node_uuid];
      if (isEditableAction(action, nodeUI?.type)) {
        this.editingAction = action;
        this.editingNode = node;
        this.editingNodeUI = nodeUI;
      }
    } else {
      this.editingNode = node;
      this.editingNodeUI = this.definition._ui.nodes[issue.node_uuid];
    }
  }

  // --- Revisions window event handlers ---

  private handleRevisionViewed(): void {
    this.viewingRevision = true;
    this.closeFlowSearch();
    this.plumber?.reset();
  }

  private handleRevisionCancelled(): void {
    this.viewingRevision = false;
    this.plumber?.reset();
  }

  private handleRevisionsClosed(): void {
    this.viewingRevision = false;
    this.revisionsWindowHidden = true;
  }

  private async handleRevisionReverted(e: CustomEvent): Promise<void> {
    const { definition, languageCode } = e.detail;
    this.viewingRevision = false;
    this.revisionsWindowHidden = true;
    this.plumber?.reset();

    await this.saveChanges(definition);

    getStore()
      .getState()
      .fetchRevision(`/flow/revisions/${this.flow}`)
      .catch(showLoadErrorDialog)
      .finally(() => {
        if (languageCode) {
          this.handleLanguageChange(languageCode);
        }
      });
  }

  private renderToolbarElement(): TemplateResult {
    const languages = this.getLocalizationLanguages();
    const availableLanguages = this.getAvailableLanguages();
    const baseLanguage = this.definition?.language;
    const baseLanguageName =
      availableLanguages.find((lang) => lang.code === baseLanguage)?.name ||
      (baseLanguage ? getLanguageLabel(baseLanguage) : '') ||
      msg('Primary language');
    const isBaseSelected =
      !this.languageCode ||
      this.languageCode === baseLanguage ||
      !languages.some((lang) => lang.code === this.languageCode);
    const activeLanguage = !isBaseSelected
      ? languages.find((lang) => lang.code === this.languageCode)
      : null;
    const currentLanguage = activeLanguage || {
      code: baseLanguage || '',
      name: baseLanguageName
    };
    const progress = this.getLocalizationProgress(
      isBaseSelected ? '' : this.languageCode
    );
    const percent = Math.round(
      (progress.localized / Math.max(progress.total, 1)) * 100
    );
    const isEmptyFlow = !this.definition || this.definition.nodes.length === 0;
    const languageOptions = isEmptyFlow
      ? []
      : [
          {
            name: baseLanguageName,
            value: PRIMARY_LANGUAGE_OPTION_VALUE
          },
          ...languages.map((lang) => {
            const localizationProgress = this.getLocalizationProgress(
              lang.code
            );
            const localizationPercent = Math.round(
              (localizationProgress.localized /
                Math.max(localizationProgress.total, 1)) *
                100
            );
            return {
              name: lang.name,
              value: lang.code,
              percent: localizationPercent
            };
          })
        ];

    // shown whenever the active language has any localizable content, even
    // at 100% — the dialog's "update existing" option lets users re-run
    // translation on already-translated entries.
    const hasPendingTranslations =
      Boolean(activeLanguage) && progress.total > 0;

    // a fully-translated language can be promoted to be the flow's base
    // language (not while viewing a historical revision). Gate on the raw
    // counts rather than the rounded percent — e.g. 199/200 rounds to 100%
    // but is not actually complete, and the server does no completeness check.
    const canMakeDefault =
      Boolean(activeLanguage) &&
      progress.total > 0 &&
      progress.localized === progress.total &&
      !this.viewingRevision;

    return html`
      <temba-editor-toolbar
        ?message-view=${this.showMessageTable}
        .zoom=${this.zoom}
        ?zoom-initialized=${this.zoomManager.isZoomInitialized}
        ?zoom-fitted=${this.zoomManager.isZoomFitted}
        ?revisions-active=${!this.revisionsWindowHidden}
        ?is-saving=${this.isSaving}
        ?search-disabled=${this.getRevisionsWindow()?.isViewingRevision ??
        false}
        .languageOptions=${languageOptions}
        current-language-name=${currentLanguage.name}
        ?is-base-language=${isBaseSelected}
        .languagePercent=${percent}
        ?show-localization-tools=${Boolean(activeLanguage)}
        ?can-make-default=${canMakeDefault}
        ?has-pending-translations=${hasPendingTranslations ||
        this.autoTranslating}
        ?auto-translate-disabled=${this.viewingRevision}
        ?auto-translating=${this.autoTranslating}
        @temba-button-clicked=${this.handleToolbarAction}
      ></temba-editor-toolbar>
    `;
  }

  private handleToolbarAction(e: CustomEvent): void {
    const detail = e.detail as ToolbarAction;
    switch (detail.action) {
      case 'view-change':
        this.showMessageTable = detail.view === 'table';
        break;
      case 'zoom-in':
        this.zoomManager.zoomIn();
        break;
      case 'zoom-out':
        this.zoomManager.zoomOut();
        break;
      case 'zoom-to-fit':
        this.zoomManager.zoomToFit();
        break;
      case 'zoom-to-full':
        this.zoomManager.zoomToFull();
        break;
      case 'revisions':
        if (!this.revisionsWindowHidden) {
          this.getRevisionsWindow()?.close();
          this.revisionsWindowHidden = true;
        } else {
          this.closeOpenWindows();
          this.revisionsWindowHidden = false;
        }
        break;
      case 'search':
        this.openFlowSearch();
        break;
      case 'auto-translate':
        this.handleAutoTranslateClick();
        break;
      case 'make-default-language':
        this.showMakeDefaultLanguageConfirmation();
        break;
      case 'language-change':
        if (detail.isPrimary) {
          this.handleLanguageChange(this.definition?.language || '');
        } else if (detail.languageCode) {
          this.handleLanguageChange(detail.languageCode);
        }
        break;
    }
  }

  /**
   * Focus on a specific node by smoothly scrolling it to the center of the canvas
   */
  public focusNode(nodeUuid: string) {
    const nodeElement = this.querySelector(
      `temba-flow-node[uuid="${nodeUuid}"]`
    ) as HTMLElement;
    if (!nodeElement) {
      return;
    }

    const editor = this.querySelector('#editor') as HTMLElement;
    if (!editor) {
      return;
    }

    // Get the editor's dimensions and scroll position
    const editorRect = editor.getBoundingClientRect();
    const editorCenterX = editorRect.width / 2;
    const editorCenterY = editorRect.height / 2;

    // Use offsetWidth/offsetHeight (unaffected by ancestor transforms)
    const nodeCenterX = nodeElement.offsetLeft + nodeElement.offsetWidth / 2;
    const nodeCenterY = nodeElement.offsetTop + nodeElement.offsetHeight / 2;

    // Calculate the scroll position needed to center the node.
    // Multiply by zoom because scroll operates in visual (transformed) space
    // while offsetLeft/offsetTop are in layout space.
    const targetScrollX = nodeCenterX * this.zoom - editorCenterX;
    const targetScrollY = nodeCenterY * this.zoom - editorCenterY;

    // Smooth scroll the editor container to the target position
    editor.scrollTo({
      left: Math.max(0, targetScrollX),
      top: Math.max(0, targetScrollY),
      behavior: 'smooth'
    });
  }

  private handleSearchResultSelected(event: CustomEvent): void {
    const result = event.detail as SearchResult;

    // Handle sticky note results
    if (result.stickyField) {
      this.focusCanvasElement(
        `temba-sticky-note[uuid="${result.nodeUuid}"]`,
        result.stickyField
      );
      return;
    }

    const node = this.definition.nodes.find((n) => n.uuid === result.nodeUuid);
    if (!node) return;

    const nodeUI = this.definition._ui?.nodes[result.nodeUuid];

    if (this.showMessageTable) {
      const messageTable = this.querySelector('temba-message-table') as
        | (HTMLElement & {
            focusSearchResult?: (
              nodeUuid: string,
              actionUuid: string | null
            ) => void;
          })
        | null;
      messageTable?.focusSearchResult?.(
        result.nodeUuid,
        result.action?.uuid || null
      );
    } else {
      // Scroll to the node on canvas
      this.focusNode(result.nodeUuid);
    }

    // Non-editable actions stay searchable, but there's no dialog to open
    // for them — the focus above is all we do
    if (result.action && !isEditableAction(result.action, nodeUI?.type)) {
      return;
    }

    // Open editor after a short delay so scroll can start
    setTimeout(() => {
      if (result.action) {
        // Open the action editor
        this.editingAction = result.action;
        this.editingNode = node;
        this.editingNodeUI = nodeUI;
        this.dialogOrigin = null;
      } else {
        // Open the node editor (for splits, webhooks, etc.)
        this.editingNode = node;
        this.editingNodeUI = nodeUI;
        this.dialogOrigin = null;
      }
    }, 200);
  }

  /**
   * Scroll a canvas element into view and optionally focus a field inside it.
   */
  private focusCanvasElement(
    selector: string,
    stickyField?: 'title' | 'body'
  ): void {
    const el = this.querySelector(selector) as HTMLElement;
    if (!el) return;

    const editor = this.querySelector('#editor') as HTMLElement;
    if (!editor) return;

    const editorRect = editor.getBoundingClientRect();
    const centerX = el.offsetLeft + el.offsetWidth / 2;
    const centerY = el.offsetTop + el.offsetHeight / 2;
    const targetScrollX = centerX * this.zoom - editorRect.width / 2;
    const targetScrollY = centerY * this.zoom - editorRect.height / 2;

    editor.scrollTo({
      left: Math.max(0, targetScrollX),
      top: Math.max(0, targetScrollY),
      behavior: 'smooth'
    });

    if (stickyField) {
      setTimeout(() => {
        const fieldEl = el.shadowRoot?.querySelector(
          `.sticky-${stickyField}`
        ) as HTMLElement;
        if (fieldEl) {
          fieldEl.focus();
        }
      }, 300);
    }
  }

  public isReadOnly(): boolean {
    return this.viewingRevision || this.isTranslating;
  }

  public render(): TemplateResult {
    // we have to embed our own style since we are in light DOM
    const style = html`<style>
      ${unsafeCSS(Editor.styles.cssText)}
      ${unsafeCSS(CanvasNode.styles.cssText)}
    </style>`;

    const stickies = this.definition?._ui?.stickies || {};

    // Detect flows with missing UI metadata (e.g. stale _ui after UUID
    // regeneration during export/import). Flag as corrupted if any node
    // is missing a _ui entry, not just when all are.
    const hasCorruptedUI =
      this.definition &&
      this.definition.nodes.length > 0 &&
      this.definition.nodes.some((n) => !this.definition._ui?.nodes[n.uuid]);

    return html`${style}
      <temba-issues-window
        .issues=${this.flowIssues}
        ?hidden=${this.issuesWindowHidden}
        @temba-issue-selected=${this.handleIssueSelected}
        @temba-issues-closed=${() => (this.issuesWindowHidden = true)}
      ></temba-issues-window>
      <temba-revisions-window
        .flow=${this.flow}
        ?hidden=${this.revisionsWindowHidden}
        ?saving=${this.isSaving}
        @temba-revision-viewed=${this.handleRevisionViewed}
        @temba-revision-cancelled=${this.handleRevisionCancelled}
        @temba-revision-reverted=${this.handleRevisionReverted}
        @temba-revisions-closed=${this.handleRevisionsClosed}
      ></temba-revisions-window>
      <temba-auto-translate
        .definition=${this.definition}
        language-code=${this.languageCode}
        ?disabled=${this.viewingRevision}
        @temba-auto-translate-changed=${this.handleAutoTranslateChanged}
      ></temba-auto-translate>
      <div id="editor-container">
        ${this.renderToolbarElement()}
        <div id="editor">
          ${this.showMessageTable
            ? html`<temba-message-table></temba-message-table>`
            : html`
                ${hasCorruptedUI
                  ? html`<div class="empty-flow">
                      <div class="empty-flow-content">
                        <div class="empty-flow-title">
                          ${msg('Unable to display this flow')}
                        </div>
                        <div class="empty-flow-description">
                          ${msg(
                            "This flow's layout data does not match its nodes. It may have been corrupted during an export or migration. Please re-export the flow from the original workspace and try importing it again."
                          )}
                        </div>
                      </div>
                    </div>`
                  : this.definition &&
                      this.definition.nodes.length === 0 &&
                      !this.isReadOnly()
                    ? html`<div class="empty-flow">
                        <div class="empty-flow-content">
                          <div class="empty-flow-title">
                            ${msg('This flow is empty')}
                          </div>
                          <div class="empty-flow-description">
                            ${msg(
                              'Get started by adding your first action or split to define how this flow will work.'
                            )}
                          </div>
                          <button
                            class="empty-flow-button"
                            @click=${this.handleEmptyFlowClick}
                          >
                            ${msg('Add first step')}
                          </button>
                        </div>
                      </div>`
                    : ''}
                <div
                  id="grid"
                  class="${this.viewingRevision ? 'viewing-revision' : ''}"
                  style="min-width:${100 / this.zoom}%;min-height:${100 /
                  this.zoom}%;width:${this.canvasSize.width}px; height:${this
                    .canvasSize.height}px;transform:scale(${this.zoom})"
                >
                  <div
                    id="canvas"
                    class="${getClasses({
                      'viewing-revision': this.viewingRevision,
                      'read-only-connections':
                        this.viewingRevision || this.isTranslating
                    })}"
                  >
                    ${this.definition && !hasCorruptedUI
                      ? repeat(
                          [...this.definition.nodes].sort((a, b) =>
                            a.uuid.localeCompare(b.uuid)
                          ),
                          (node) => node.uuid,
                          (node) => {
                            const nodeUI = this.definition._ui?.nodes[
                              node.uuid
                            ] || {
                              position: { left: 0, top: 0 },
                              type: node.router?.wait
                                ? 'wait_for_response'
                                : 'execute_actions'
                            };
                            const position = nodeUI.position;

                            const dragging =
                              this.isDragging &&
                              this.currentDragItem?.uuid === node.uuid;

                            const selected = this.selectedItems.has(node.uuid);

                            // first node is the flow start (nodes are sorted by position)
                            const isFlowStart =
                              this.definition.nodes.length > 0 &&
                              this.definition.nodes[0].uuid === node.uuid;

                            return html`<temba-flow-node
                              class="draggable ${dragging
                                ? 'dragging'
                                : ''} ${selected
                                ? 'selected'
                                : ''} ${isFlowStart ? 'flow-start' : ''}"
                              @mousedown=${(e: MouseEvent) =>
                                this.dragManager.handleMouseDown(e)}
                              @touchstart=${(e: TouchEvent) =>
                                this.dragManager.handleItemTouchStart(e)}
                              uuid=${node.uuid}
                              data-node-uuid=${node.uuid}
                              style="left:${position.left}px; top:${position.top}px;transition: all 0.2s ease-in-out;"
                              .plumber=${this.plumber}
                              .node=${node}
                              .ui=${nodeUI}
                              @temba-node-deleted=${(event) => {
                                this.deleteNodes([event.detail.uuid]);
                              }}
                            ></temba-flow-node>`;
                          }
                        )
                      : hasCorruptedUI
                        ? ''
                        : html`<temba-loading></temba-loading>`}
                    ${repeat(
                      Object.entries(stickies),
                      ([uuid]) => uuid,
                      ([uuid, sticky]) => {
                        const position = sticky.position || { left: 0, top: 0 };
                        const dragging =
                          this.isDragging &&
                          this.currentDragItem?.uuid === uuid;
                        const selected = this.selectedItems.has(uuid);
                        return html`<temba-sticky-note
                          class="draggable ${dragging
                            ? 'dragging'
                            : ''} ${selected ? 'selected' : ''}"
                          @mousedown=${(e: MouseEvent) =>
                            this.dragManager.handleMouseDown(e)}
                          @touchstart=${(e: TouchEvent) =>
                            this.dragManager.handleItemTouchStart(e)}
                          style="left:${position.left}px; top:${position.top}px;"
                          uuid=${uuid}
                          .data=${sticky}
                          .dragging=${dragging}
                          .selected=${selected}
                        ></temba-sticky-note>`;
                      }
                    )}
                    ${this.dragManager.renderSelectionBox()}
                    ${this.renderCanvasDropPreview()}
                    ${this.renderConnectionPlaceholder()}
                  </div>
                </div>
              `}
        </div>
        ${this.renderPendingCard()}
        <div class="drag-hint" id="drag-hint">
          ${msg('Hold ⇧ to duplicate')}
        </div>
      </div>
      <div class="loupe" id="loupe">
        <div class="loupe-content" id="loupe-content"></div>
        <div class="loupe-crosshair-h"></div>
        <div class="loupe-crosshair-v"></div>
      </div>

      ${this.editingNode || this.editingAction
        ? html`<temba-node-editor
            .node=${this.editingNode}
            .nodeUI=${this.editingNodeUI}
            .action=${this.editingAction}
            .dialogOrigin=${this.dialogOrigin}
            ?force-base=${this.editForceBase}
            @temba-node-saved=${(e: CustomEvent) =>
              this.handleNodeSaved(e.detail.node, e.detail.uiConfig)}
            @temba-action-saved=${(e: CustomEvent) =>
              this.handleActionSaved(e.detail.action)}
            @temba-node-edit-cancelled=${this.handleNodeEditCanceled}
          ></temba-node-editor>`
        : ''}

      <temba-canvas-menu></temba-canvas-menu>
      ${!this.viewingRevision
        ? html`<temba-node-type-selector
            .flowType=${this.flowType}
            .features=${this.features}
          ></temba-node-type-selector>`
        : ''}
      <temba-flow-search
        .scope=${this.showMessageTable ? 'table' : 'flow'}
        .includeCategories=${this.isTranslating &&
        this.hasAnyNodeWithLocalizeCategories()}
        @temba-search-result-selected=${this.handleSearchResultSelected}
      ></temba-flow-search>
      ${!this.showMessageTable && this.flowIssues?.length
        ? html`
            <temba-floating-tab
              id="issues-tab"
              icon="alert_warning"
              label=${msg('Flow Issues')}
              color="tomato"
              order="2"
              .active=${!this.issuesWindowHidden}
              @temba-button-clicked=${() => this.handleIssuesTabClick()}
            ></temba-floating-tab>
          `
        : ''} `;
  }
}
