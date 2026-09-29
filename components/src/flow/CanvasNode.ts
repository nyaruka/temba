import { css, html, PropertyValueMap, TemplateResult } from 'lit';
import { msg, str } from '@lit/localize';
import { repeat } from 'lit/directives/repeat.js';
import {
  ACTION_CONFIG,
  ActionConfig,
  isUnsupportedAction,
  NODE_CONFIG,
  NodeConfig
} from './config';
import { ACTION_GROUP_METADATA, SPLIT_GROUP_METADATA } from './types';
import { Action, Exit, Node, NodeUI, Router } from '../store/flow-definition';
import { property } from 'lit/decorators.js';
import { RapidElement } from '../RapidElement';
import { generateUUID, getClasses } from '../utils';
import { SortableList } from '../list/SortableList';
import { isRightClick, localizeAction, renderClamped } from './utils';
import { Plumber } from './Plumber';
import { getStore } from '../store/Store';
import { CustomEventType } from '../interfaces';
import { AppState, FlowIssue, fromStore, zustand } from '../store/AppState';
import {
  getTranslatableCategoriesForNode,
  hasTranslatableCategoriesForNode
} from './categoryLocalization';

const DRAG_THRESHOLD = 5;

export class CanvasNode extends RapidElement {
  createRenderRoot() {
    return this;
  }

  @property({ type: Object })
  private plumber: Plumber;

  @property({ type: Object })
  private node: Node;

  @property({ type: Object })
  private ui: NodeUI;

  @fromStore(zustand, (state: AppState) => state.isTranslating)
  private isTranslating!: boolean;

  @fromStore(zustand, (state: AppState) => state.languageCode)
  private languageCode!: string;

  @fromStore(zustand, (state: AppState) => state.viewingRevision)
  private viewingRevision!: boolean;

  @fromStore(zustand, (state: AppState) => state.flowDefinition)
  private flowDefinition!: any;

  @fromStore(zustand, (state: AppState) => state.getCurrentActivity())
  private activity!: any;

  @fromStore(zustand, (state: AppState) => state.issuesByNode)
  private issuesByNode!: Map<string, FlowIssue[]>;

  @fromStore(zustand, (state: AppState) => state.issuesByAction)
  private issuesByAction!: Map<string, FlowIssue[]>;

  // Track exits that are in "removing" state
  private exitRemovalTimeouts: Map<string, number> = new Map();

  private connectionTimeout: number | null = null;

  // Set of exit UUIDs that are in the removing state
  private exitRemovingState: Set<string> = new Set();

  // Track actions that are in "removing" state
  private actionRemovalTimeouts: Map<string, number> = new Map();

  // Set of action UUIDs that are in the removing state
  private actionRemovingState: Set<string> = new Set();

  // Track action click state to distinguish from drag
  private actionClickStartPos: { x: number; y: number } | null = null;
  private pendingActionClick: { action: Action; event: MouseEvent } | null =
    null;

  // Track node click state to distinguish from drag
  private nodeClickStartPos: { x: number; y: number } | null = null;
  private pendingNodeClick: { event: MouseEvent } | null = null;

  // Track the height of the action being dragged (captured at drag start)
  private draggedActionHeight: number = 0;

  // ResizeObserver to revalidate plumbing when node size changes
  private resizeObserver: ResizeObserver | null = null;

  // Track external action drag (action being dragged from another node)
  private externalDragInfo: {
    action: Action;
    sourceNodeUuid: string;
    actionIndex: number;
    dropIndex: number;
    actionHeight: number;
  } | null = null;

  // Track if we're showing a placeholder for our own last action being dragged out
  private showLastActionPlaceholder = false;
  private lastActionPlaceholderHeight = 60;

  static get styles() {
    return css`

      .node {
        background-color: #fff;
        box-shadow: 0 0 5px rgba(0, 0, 0, 0.2);
        min-width: 200px;
        border-radius: var(--curvature);
        color: #333;
        user-select: none;
      }

      .shift-held > temba-flow-node,
      .shift-held > temba-flow-node * {
        cursor: copy !important;
      }

      .shift-held > temba-flow-node .exit,
      .shift-held > temba-flow-node .exit *,
      .shift-held > temba-flow-node .linked-name,
      .shift-held > temba-flow-node .linked-name *,
      .shift-held > temba-flow-node .remove-button,
      .shift-held > temba-flow-node .remove-button * {
        cursor: pointer !important;
      }

      temba-flow-node.drag-copy .node {
        outline: 3px dashed var(--color-primary, #3b82f6);
        outline-offset: 2px;
        opacity: 0.7;
      }

      /* Flow start indicator */
      temba-flow-node.flow-start .node::before {
        content: 'FLOW START';
        position: absolute;
        top: -16px;
        left: 50%;
        transform: translateX(-50%);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.5px;
        color: var(--color-primary-dark, #3b82f6);
        opacity: 0.7;
        z-index: 10;
        white-space: nowrap;
      }

      /* Cap width for execute_actions nodes */
      .node.execute-actions {
        max-width: 200px;
      }

      .node .action:last-child {
        border-bottom-left-radius: var(--curvature);
        border-bottom-right-radius: var(--curvature);
      }

      .node .action:first-child {
        border-top-left-radius: var(--curvature);
        border-top-right-radius: var(--curvature);
      }

      .node.dragging {
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.4);
        transform: scale(1.02);
        z-index: 1000;
      }

      .action {
        position: relative;
      }


      .action .cn-title:hover .remove-button,
      .router:hover .remove-button {
        visibility: visible;
        opacity: 0.7;
      }

      .action.removing .cn-title,
      .router .cn-title.removing {
        background-color: var(--color-error, #dc3545) !important;
      }

      .action.removing .cn-title .name,
      .router .cn-title.removing .name {
        color: white;
      }

      .remove-button {
        background: transparent;
        color: white;
        visibility: hidden;
        cursor: pointer;
        font-size: 1em;
        font-weight: 600;
        line-height: 1;
        z-index: 10;
        transition: all 100ms ease-in-out;
        align-self: center;
        margin-right: 0.3em;
        border: 0px solid red;
        width: 1em;
        pointer-events: auto; /* Ensure remove button can receive events */
      }

      .remove-button:hover {
        visibility: visible;
        opacity: 1;
      }

      .read-only-hidden {
        visibility: hidden !important;
        pointer-events: none !important;
      }

      /* Issue indicators - hatched red title bar */
      .action-content.has-issues .cn-title,
      .node.has-issues > .router .cn-title {
        background: repeating-linear-gradient(120deg, tomato, tomato 6px, #ff7056 0, #ff7056 18px) !important;
      }

      /* Disable links on actions/nodes with issues so clicks fall through
         to open the editor instead of navigating. */
      .action-content.has-issues .linked-name div,
      .node.has-issues > .router .linked-name div {
        text-decoration: none !important;
        cursor: default !important;
        pointer-events: none;
      }
      .action-content.has-issues .linked-pill,
      .node.has-issues > .router .linked-pill {
        pointer-events: none;
      }

      .action.sortable {
        display: flex;
        align-items: stretch;
      }

      .action .action-content {
        flex-grow: 1;
        display: flex;
        flex-direction: column;
        min-width: 0; /* Allow flex item to shrink below its content size */
        overflow: hidden;
        background: #fff;
      }

      .action .body {
        padding: 0.75em;
        word-wrap: break-word;
        overflow-wrap: break-word;
        hyphens: auto;
        white-space: normal;
        overflow: hidden;
      }

      /* Localization indicators */
      .action.localizable:not(.has-localization) .action-content {
        background: #fff8dc !important; /* Light yellow background for localizable but not yet localized */
      }

      .non-localizable {
        opacity: 0.25;
        pointer-events: none;
      }

      .action.non-localizable .action-content {
        cursor: not-allowed;
      }      

      .action .drag-handle {
        visibility: hidden;
        transition: all 200ms ease-in-out;
        cursor: move;
        background: rgba(0, 0, 0, 0.02);
        width: 1em;
        padding: 0.25em;
        border: 0px solid red;
        pointer-events: auto; /* Ensure drag handle can receive events */
      }
      .title-spacer {
        width: 1.8em;
      }

      .action:hover .drag-handle {
        visibility: visible;
        opacity: 0.7;
      }

      .action .drag-handle:hover {
        visibility: visible;
        opacity: 1;
      }

      strong {
        font-weight: 500;
      }

      .action .cn-title,
      .router .cn-title {
        display: flex;
        color: #fff;
        text-align: center;
        font-size: 1em;
        font-weight: 500;
      }

      .cn-title .name {
      padding: 0.3em 0;

      }

      .router .cn-title {

      }

      .cn-title .name {
        flex-grow: 1;
      }

      .quick-replies {
        margin-top: 0.5em;
        display: flex;
        flex-wrap: wrap;
      }

      .quick-reply {
        background: white;
        border: 1px solid var(--color-quick-reply, rgb(60, 146, 221));
        border-radius: 18px;
        padding: 3px 7px;
        font-size: 10px;
        color: var(--color-quick-reply, rgb(60, 146, 221));
        margin: 0.2em;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .cn-attachments {
        margin-top: 0.5em;
        display: flex;
        flex-wrap: wrap;
        gap: 0.25em;
      }

      .cn-msg-footer {
        display: flex;
        align-items: center;
        gap: 0.5em;
        margin-top: 0.5em;
      }

      /* quick reply pills already carry their own bottom margin */
      .quick-replies + .cn-msg-footer {
        margin-top: 0.2em;
      }

      .cn-msg-footer .cn-attachments {
        margin-top: 0;
        min-width: 0;
      }

      /* the counter keeps its size and sits at the bottom right, attachments wrap around it */
      .cn-msg-footer temba-charcount {
        margin-left: auto;
        align-self: flex-end;
        flex-shrink: 0;
      }

      .cn-attachment {
        display: flex;
        background: #f3f4f6;
        border: 1px solid #e5e7eb;
        border-radius: 4px;
        padding: 3px;
        color: #666;
      }

      .router-section {
        /* Container for router and categories */
      }

      .categories {
        display: flex;
        flex-direction: row;
        border-collapse: collapse;

      }

      .category {
        border-collapse: collapse;
        border: 1px solid #f3f3f3;
        padding: 0.75em;
        flex-grow:1;
        text-align: center;
        display: flex;
        flex-direction: column;
      }

      /* Localizable category - yellow background */
      .category.localizable {
        background-color: #fff8dc;
        border-color: #e8daa0;
      }

      .action-exits {
        padding-bottom: 0.7em;
        margin-top: -0.7em;
      }

      .category .cn-title {
        font-weight: normal;
        font-size: 1em;
        max-width: 150px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .router .body {
        padding: 0.75em;
      }

      .router .body > div {
        max-width: 180px;
      }

      .result-name {
        font-weight: 500;
        display: inline-block;
      }

      .router {
        display: flex;
        flex-direction: column;
      }

      .rules-count {
        position: absolute;
        right: 4px;
        top: 50%;
        transform: translateY(-50%);
        background: #fff8dc;
        border-radius: 10px;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        font-size: 11px;
        font-weight: 600;
        color: #333;
        display: flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        box-sizing: border-box;
      }

      .exit-wrapper {
        display: flex;
        justify-content: center;
        align-items: center;
        position: relative;
        margin-bottom: -1.2em;
        padding-top:0.2em;
      }

      .exit {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background-color: tomato;
        position: relative;
        box-shadow: 0 2px 2px rgba(0, 0, 0, .1);
        cursor: pointer;
        pointer-events: all;
      }

      .exit::after {
        content: '';
        position: absolute;
        top: -6px;
        left: -6px;
        right: -6px;
        bottom: -6px;
        border-radius: 50%;
      }

      .exit.connected {
        background-color: #fff;
        pointer-events: all;
      }

      .exit.connected:hover {
        background-color: var(--color-connectors, #e6e6e6);
      }

      .exit.read-only, .exit.read-only:hover {
        pointer-events: none !important;
        cursor: default;
        visibility: hidden;
      }

      .exit.connected.read-only, .exit.connected.read-only:hover {
        background-color: #fff;
        visibility: hidden;
      }
      
      .exit.removing, .exit.removing:hover {
        background-color: var(--color-error);
        pointer-events: all;
      }
      
      .exit.removing::before {
        content: '✕';
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-size: 8px;
        color: white;
        line-height: 1;
      }
      
      /* Connector in removing state */
      :host {
        --color-connector-removing: var(--color-error);
      }
      
      body svg.plumb-connector.removing path {
        stroke: var(--color-connector-removing, tomato) !important;
        stroke-width: 3px;
      }
      
      body .plumb-connector.removing .plumb-arrow {
        fill: var(--color-connector-removing, tomato) !important;
        stroke: var(--color-connector-removing, transparent) !important;
      }

      .category:first-child {
        border-bottom-left-radius: var(--curvature);
      }

      .category:last-child {
        border-bottom-right-radius: var(--curvature);
      }

      .router .cn-title {
        border-top-left-radius: var(--curvature);
        border-top-right-radius: var(--curvature);
      }

      .action{
        overflow: hidden;
      }

      .action:first-child .cn-title {
        border-top-left-radius: var(--curvature);
        border-top-right-radius: var(--curvature);
      }

      /* Add action button */
      /* straddles the node's bottom-right corner so it never covers action content */
      .add-action-button {
        position: absolute;
        bottom: -0.6em;
        right: -0.6em;
        width: 1.2em;
        height: 1.2em;
        border-radius: 50%;
        background: var(--color-primary, #3b82f6);
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        transition: opacity 200ms ease-in-out;
        z-index: 10;
        pointer-events: auto;
        font-size: 0.8em;
      }

      .node.execute-actions:hover .add-action-button {
        opacity: 0.8;
      }

      .add-action-button:hover {
        opacity: 1 !important;
        transform: scale(1.1);
      }

      .empty-node-placeholder {
        height: 60px;
        background: #f3f4f6;
        border: 2px dashed #d1d5db;
        border-radius: var(--curvature);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #9ca3af;
        font-size: 0.9em;
      }

      /* On touch devices, always show interactive controls.
         The .touch-device class is added to the editor on first touch. */
      .touch-device .remove-button {
        visibility: visible !important;
        opacity: 0.7;
      }

      .touch-device .action .drag-handle {
        visibility: visible !important;
        opacity: 0.7;
      }

      .touch-device .add-action-button {
        opacity: 0.8 !important;
      }
  }`;
  }

  constructor() {
    super();
    this.handleActionOrderChanged = this.handleActionOrderChanged.bind(this);
    this.handleActionDragStart = this.handleActionDragStart.bind(this);
    this.handleActionDragExternal = this.handleActionDragExternal.bind(this);
    this.handleActionDragInternal = this.handleActionDragInternal.bind(this);
    this.handleActionDragStop = this.handleActionDragStop.bind(this);
    this.handleExternalActionDragOver =
      this.handleExternalActionDragOver.bind(this);
    this.handleExternalActionDrop = this.handleExternalActionDrop.bind(this);
    this.handleExternalActionDragLeave =
      this.handleExternalActionDragLeave.bind(this);
    this.handleActionShowGhost = this.handleActionShowGhost.bind(this);
    this.handleActionHideGhost = this.handleActionHideGhost.bind(this);
    this.handleActionShowOriginal = this.handleActionShowOriginal.bind(this);
    this.handleActionHideOriginal = this.handleActionHideOriginal.bind(this);
  }

  connectedCallback() {
    super.connectedCallback();

    // Listen for external action drag events from Editor
    this.addEventListener(
      'action-drag-over',
      this.handleExternalActionDragOver as EventListener
    );
    this.addEventListener(
      'action-drop',
      this.handleExternalActionDrop as EventListener
    );
    this.addEventListener(
      'action-drag-leave',
      this.handleExternalActionDragLeave as EventListener
    );
    this.addEventListener(
      'action-show-ghost',
      this.handleActionShowGhost as EventListener
    );
    this.addEventListener(
      'action-hide-ghost',
      this.handleActionHideGhost as EventListener
    );
    this.addEventListener(
      'action-show-original',
      this.handleActionShowOriginal as EventListener
    );
    this.addEventListener(
      'action-hide-original',
      this.handleActionHideOriginal as EventListener
    );

    // Observe size changes to revalidate plumbing connections
    this.resizeObserver = new ResizeObserver(() => {
      if (this.plumber && this.node) {
        this.plumber.revalidate([this.node.uuid]);
      }
    });
    this.resizeObserver.observe(this);
  }

  protected updated(
    changes: PropertyValueMap<any> | Map<PropertyKey, unknown>
  ): void {
    super.updated(changes);

    if (!!changes.get('ui') && changes.has('ui')) {
      // run revalidation every 50ms until 350ms to catch animation updates
      for (let delay = 25; delay <= 350; delay += 25) {
        setTimeout(() => {
          this.plumber.revalidate([this.node.uuid]);
        }, delay);
      }
    }

    if (changes.has('node')) {
      // Only proceed if plumber is available (for tests that don't set it up)
      if (this.plumber) {
        if (this.connectionTimeout) {
          clearTimeout(this.connectionTimeout);
        }

        // Pass exit IDs explicitly to avoid DOM querying dependency
        const exitIds = this.node.exits.map((e) => e.uuid);
        this.plumber.removeNodeConnections(this.node.uuid, exitIds);

        // make our initial connections
        // We use setTimeout to allow for DOM updates to complete before querying for exits
        this.connectionTimeout = window.setTimeout(() => {
          // Terminal nodes have no visible exits
          if (this.ui?.type !== 'terminal') {
            for (const exit of this.node.exits) {
              this.plumber.makeSource(exit.uuid);
              if (exit.destination_uuid) {
                this.plumber.connectIds(
                  this.node.uuid,
                  exit.uuid,
                  exit.destination_uuid
                );
              }
            }
          }
          // Note: revalidation is handled by plumber's processPendingConnections which calls repaintEverything
          this.connectionTimeout = null;
          this.plumber.revalidate([this.node.uuid]);
        }, 0);
      }

      const ele = this.parentElement;
      if (ele && this.ui) {
        const rect = ele.getBoundingClientRect();

        getStore()
          ?.getState()
          .expandCanvas(
            this.ui.position.left + rect.width,
            this.ui.position.top + rect.height
          );
      }
    }
  }

  disconnectedCallback() {
    // Force cleanup of connections for this node
    if (this.plumber && this.node) {
      if (this.connectionTimeout) {
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
      }
      this.plumber.forgetNode(this.node.uuid);
    }

    // Clean up resize observer
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }

    // Remove the event listener when the component is removed
    super.disconnectedCallback();

    // Remove external drag event listeners
    this.removeEventListener(
      'action-drag-over',
      this.handleExternalActionDragOver as EventListener
    );
    this.removeEventListener(
      'action-drop',
      this.handleExternalActionDrop as EventListener
    );
    this.removeEventListener(
      'action-drag-leave',
      this.handleExternalActionDragLeave as EventListener
    );
    this.removeEventListener(
      'action-show-ghost',
      this.handleActionShowGhost as EventListener
    );
    this.removeEventListener(
      'action-hide-ghost',
      this.handleActionHideGhost as EventListener
    );
    this.removeEventListener(
      'action-show-original',
      this.handleActionShowOriginal as EventListener
    );
    this.removeEventListener(
      'action-hide-original',
      this.handleActionHideOriginal as EventListener
    );

    // Clear any pending exit removal timeouts
    this.exitRemovalTimeouts.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    this.exitRemovalTimeouts.clear();

    // Clear any pending action removal timeouts
    this.actionRemovalTimeouts.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    this.actionRemovalTimeouts.clear();

    // Clear the removing state
    this.exitRemovingState.clear();
    this.actionRemovingState.clear();

    // only proceed if plumber is available (for tests that don't set it up)
    if (this.plumber) {
      this.plumber.removeNodeConnections(
        this.node.uuid,
        this.node.exits.map((e) => e.uuid)
      );
    }
  }

  private handleExitClick(event: MouseEvent, exit: Exit) {
    event.preventDefault();
    event.stopPropagation();
    const exitId = exit.uuid;

    // If exit is not connected, do nothing
    if (!exit.destination_uuid) return;

    // If the exit is already in removing state, perform the disconnect
    if (this.exitRemovingState.has(exitId)) {
      this.disconnectExit(exit);
      return;
    }

    // Start removal UI state
    this.exitRemovingState.add(exitId);
    this.requestUpdate();

    // Set the connection to removing state
    this.plumber.setConnectionRemovingState(exitId, true);

    // Clear any existing timeout for this exit
    if (this.exitRemovalTimeouts.has(exitId)) {
      clearTimeout(this.exitRemovalTimeouts.get(exitId));
    }

    // Set timeout to reset UI if user doesn't click
    const timeoutId = window.setTimeout(() => {
      this.exitRemovingState.delete(exitId);
      this.exitRemovalTimeouts.delete(exitId);

      // Reset the connection to normal state
      this.plumber.setConnectionRemovingState(exitId, false);

      this.requestUpdate();
    }, 1500);

    this.exitRemovalTimeouts.set(exitId, timeoutId);
  }

  private disconnectExit(exit: Exit) {
    const exitId = exit.uuid;

    // Clear the UI state
    this.exitRemovingState.delete(exitId);

    // Reset the connection to normal state (this will be redundant as we're about to remove it,
    // but it's safer to do this in case there's any timing issue)
    this.plumber.setConnectionRemovingState(exitId, false);

    // Clear any timeout
    if (this.exitRemovalTimeouts.has(exitId)) {
      clearTimeout(this.exitRemovalTimeouts.get(exitId));
      this.exitRemovalTimeouts.delete(exitId);
    }

    // Remove the JSPlumb connection
    this.plumber.removeExitConnection(exitId);

    // Update the flow definition
    const updatedExit = { ...exit, destination_uuid: null };
    const updatedExits = this.node.exits.map((e) =>
      e.uuid === exitId ? updatedExit : e
    );

    // Update the node
    const updatedNode = { ...this.node, exits: updatedExits };
    getStore()?.getState().updateNode(this.node.uuid, updatedNode);

    // Request update to reflect changes
    this.requestUpdate();
  }

  private handleActionRemoveClick(
    event: MouseEvent,
    action: Action,
    index: number
  ) {
    event.preventDefault();
    event.stopPropagation();

    const actionId = action.uuid;

    // If the action is already in removing state, perform the removal
    if (this.actionRemovingState.has(actionId)) {
      this.removeAction(action, index);
      return;
    }

    // Start removal UI state
    this.actionRemovingState.add(actionId);
    this.requestUpdate();

    // Clear any existing timeout for this action
    if (this.actionRemovalTimeouts.has(actionId)) {
      clearTimeout(this.actionRemovalTimeouts.get(actionId));
    }

    // Set timeout to reset UI if user doesn't click
    const timeoutId = window.setTimeout(() => {
      this.actionRemovingState.delete(actionId);
      this.actionRemovalTimeouts.delete(actionId);
      this.requestUpdate();
    }, 1000); // 1 second as per requirements

    this.actionRemovalTimeouts.set(actionId, timeoutId);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private removeAction(action: Action, _index: number) {
    const actionId = action.uuid;

    // Clear the UI state
    this.actionRemovingState.delete(actionId);

    // Clear any timeout
    if (this.actionRemovalTimeouts.has(actionId)) {
      clearTimeout(this.actionRemovalTimeouts.get(actionId));
      this.actionRemovalTimeouts.delete(actionId);
    }

    // Remove the action from the node
    const updatedActions = this.node.actions.filter((a) => a.uuid !== actionId);

    // If no actions remain, remove the entire node
    if (updatedActions.length === 0) {
      this.fireCustomEvent(CustomEventType.NodeDeleted, {
        uuid: this.node.uuid
      });
    } else {
      // Update the node with remaining actions
      const updatedNode = { ...this.node, actions: updatedActions };
      getStore()?.getState().updateNode(this.node.uuid, updatedNode);

      // Request update to reflect changes
      this.requestUpdate();
    }
  }

  private handleNodeRemoveClick(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();

    const nodeId = this.node.uuid;

    // If the node is already in removing state, perform the removal
    if (this.actionRemovingState.has(nodeId)) {
      this.removeNode();
      return;
    }

    // Start removal UI state
    this.actionRemovingState.add(nodeId);
    this.requestUpdate();

    // Clear any existing timeout for this node
    if (this.actionRemovalTimeouts.has(nodeId)) {
      clearTimeout(this.actionRemovalTimeouts.get(nodeId));
    }

    // Set timeout to reset UI if user doesn't click
    const timeoutId = window.setTimeout(() => {
      this.actionRemovingState.delete(nodeId);
      this.actionRemovalTimeouts.delete(nodeId);
      this.requestUpdate();
    }, 1000); // 1 second as per requirements

    this.actionRemovalTimeouts.set(nodeId, timeoutId);
  }

  private removeNode() {
    const nodeId = this.node.uuid;

    // Clear the UI state
    this.actionRemovingState.delete(nodeId);

    // Clear any timeout
    if (this.actionRemovalTimeouts.has(nodeId)) {
      clearTimeout(this.actionRemovalTimeouts.get(nodeId));
      this.actionRemovalTimeouts.delete(nodeId);
    }

    // Fire the node deleted event
    // The Editor will handle cleanup (Plumber connections) and call store.removeNodes()
    // The store's removeNodes method handles rerouting of connections
    this.fireCustomEvent(CustomEventType.NodeDeleted, {
      uuid: this.node.uuid
    });
  }

  private handleActionOrderChanged(event: CustomEvent) {
    const [fromIdx, toIdx] = event.detail.swap;

    // If we have an external drag in progress, ignore internal order changes
    // as they'll be handled by the external drop handler
    if (this.externalDragInfo) {
      return;
    }

    // swap our actions
    const newActions = [...this.node.actions];
    const movedAction = newActions.splice(fromIdx, 1)[0];
    newActions.splice(toIdx, 0, movedAction);

    // udate our internal reprensentation, this isn't strictly necessary
    // since the editor will update us from it's definition subscription
    // but it makes testing a lot easier
    this.node = { ...this.node, actions: newActions };

    getStore()
      ?.getState()
      .updateNode(this.node.uuid, { ...this.node, actions: newActions });
  }

  private handleActionDragStart(event: CustomEvent) {
    // Capture the height of the action being dragged
    const actionId = event.detail.id;
    const actionElement = this.querySelector(`#${actionId}`) as HTMLElement;

    if (actionElement) {
      // Use offsetHeight (unaffected by ancestor CSS transforms like zoom)
      this.draggedActionHeight = actionElement.offsetHeight;
    } else {
      // Fallback to a reasonable default
      this.draggedActionHeight = 60;
    }

    // If this is the last action, show placeholder
    if (this.node.actions.length === 1) {
      this.showLastActionPlaceholder = true;
      this.lastActionPlaceholderHeight = this.draggedActionHeight;
      this.requestUpdate();
    }
  }

  private handleActionDragExternal(event: CustomEvent) {
    // stop propagation of the original event from SortableList
    event.stopPropagation();

    // get the action being dragged
    const actionId = event.detail.id;
    const splitId = actionId.split('-');
    if (splitId.length < 2 || isNaN(parseInt(splitId[1], 10))) {
      // invalid format, do not proceed
      return;
    }
    const actionIndex = parseInt(splitId[1], 10);
    const action = this.node.actions[actionIndex];

    // Check if this is the last action
    const isLastAction = this.node.actions.length === 1;

    // fire event to editor to show canvas drop preview, including the captured height
    this.fireCustomEvent(CustomEventType.DragExternal, {
      action,
      nodeUuid: this.node.uuid,
      actionIndex,
      mouseX: event.detail.mouseX,
      mouseY: event.detail.mouseY,
      actionHeight: this.draggedActionHeight,
      isLastAction
    });
  }

  private handleActionDragInternal(_event: CustomEvent) {
    // stop propagation of the original event from SortableList
    _event.stopPropagation();

    // fire event to editor to hide canvas drop preview
    this.fireCustomEvent(CustomEventType.DragInternal, {});
  }

  private handleActionDragStop(event: CustomEvent) {
    const isExternal = event.detail.isExternal;

    // Clear last action placeholder when drag stops
    this.showLastActionPlaceholder = false;

    if (isExternal) {
      // stop propagation of the original event from SortableList
      event.stopPropagation();

      // get the action being dragged
      const actionId = event.detail.id;
      const split = actionId.split('-');
      if (split.length < 2 || isNaN(Number(split[1]))) {
        // invalid actionId format, do not proceed
        return;
      }
      const actionIndex = parseInt(split[1], 10);
      const action = this.node.actions[actionIndex];

      // Check if this is the last action in the node
      const isLastAction = this.node.actions.length === 1;

      // Always fire the DragStop event so the Editor can handle drops on other nodes
      // The Editor will decide whether to create a new node or drop on existing node
      this.fireCustomEvent(CustomEventType.DragStop, {
        action,
        nodeUuid: this.node.uuid,
        actionIndex,
        isExternal: true,
        isLastAction,
        mouseX: event.detail.mouseX,
        mouseY: event.detail.mouseY
      });
    }

    this.requestUpdate();
  }

  private getTopCenter(el: Element): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top };
  }

  /**
   * Returns true if the click target is inside a `.linked-name` or
   * `.linked-pill` whose containing action/node has no issues. Active
   * links handle their own navigation, so click-vs-drag and node-edit
   * handlers bail out on them. When the action/node has issues, links are
   * visually disabled (see CSS) and clicks fall through to open the
   * editor instead.
   */
  private isActiveLink(target: HTMLElement, action?: Action): boolean {
    if (!target.closest('.linked-name') && !target.closest('.linked-pill'))
      return false;
    if (action) {
      return (
        !this.issuesByAction?.has(action.uuid) && !isUnsupportedAction(action)
      );
    }
    return !(
      this.issuesByNode?.has(this.node.uuid) ||
      this.node.actions?.some(
        (a) => this.issuesByAction?.has(a.uuid) || isUnsupportedAction(a)
      )
    );
  }

  private handleActionMouseDown(event: MouseEvent, action: Action): void {
    if (isRightClick(event)) return;

    // Don't handle clicks on the remove button, drag handle, active linked elements, or when action is in removing state
    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      target.closest('.drag-handle') ||
      this.isActiveLink(target, action) ||
      this.actionRemovingState.has(action.uuid)
    ) {
      return;
    }

    // Store the starting position and action for later comparison
    // Don't prevent default - let the Editor's drag system work normally
    this.actionClickStartPos = { x: event.clientX, y: event.clientY };
    this.pendingActionClick = { action, event };
  }

  private handleActionMouseUp(event: MouseEvent, action: Action): void {
    // Don't handle if we don't have a pending click or if it's not the same action
    if (
      !this.pendingActionClick ||
      this.pendingActionClick.action.uuid !== action.uuid
    ) {
      this.actionClickStartPos = null;
      this.pendingActionClick = null;
      return;
    }

    // Don't handle clicks on the remove button, drag handle, active linked elements, or when action is in removing state
    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      target.closest('.drag-handle') ||
      this.isActiveLink(target, action) ||
      this.actionRemovingState.has(action.uuid)
    ) {
      this.actionClickStartPos = null;
      this.pendingActionClick = null;
      return;
    }

    // Check if the mouse moved beyond the drag threshold
    if (this.actionClickStartPos) {
      const deltaX = event.clientX - this.actionClickStartPos.x;
      const deltaY = event.clientY - this.actionClickStartPos.y;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      // Check if the Editor is currently in dragging mode
      const editor = this.closest('temba-flow-editor') as any;
      const editorWasDragging = editor?.dragging;

      // Only fire the action edit event if we haven't dragged beyond the threshold
      // AND either there's no Editor parent (test case) or the Editor didn't drag the node
      if (distance <= DRAG_THRESHOLD && (!editor || !editorWasDragging)) {
        // Use top-center of the action element as the dialog origin
        const actionEl = event.currentTarget as Element;
        const origin = actionEl
          ? this.getTopCenter(actionEl)
          : { x: event.clientX, y: event.clientY };

        // Fire event to request action editing
        this.fireCustomEvent(CustomEventType.ActionEditRequested, {
          action,
          nodeUuid: this.node.uuid,
          originX: origin.x,
          originY: origin.y
        });
      }
    }

    // Clean up
    this.actionClickStartPos = null;
    this.pendingActionClick = null;
  }

  /* c8 ignore start -- touch-only handlers untestable in headless Chromium */
  private handleActionTouchStart(event: TouchEvent, action: Action): void {
    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      target.closest('.drag-handle') ||
      this.isActiveLink(target, action) ||
      this.actionRemovingState.has(action.uuid)
    ) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) return;
    this.actionClickStartPos = { x: touch.clientX, y: touch.clientY };
    this.pendingActionClick = { action, event: event as any };
  }

  private handleActionTouchEnd(event: TouchEvent, action: Action): void {
    if (
      !this.pendingActionClick ||
      this.pendingActionClick.action.uuid !== action.uuid
    ) {
      this.actionClickStartPos = null;
      this.pendingActionClick = null;
      return;
    }

    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      target.closest('.drag-handle') ||
      this.isActiveLink(target, action) ||
      this.actionRemovingState.has(action.uuid)
    ) {
      this.actionClickStartPos = null;
      this.pendingActionClick = null;
      return;
    }

    const touch = event.changedTouches[0];
    if (this.actionClickStartPos && touch) {
      const deltaX = touch.clientX - this.actionClickStartPos.x;
      const deltaY = touch.clientY - this.actionClickStartPos.y;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      const editor = this.closest('temba-flow-editor') as any;
      const editorWasDragging = editor?.dragging;

      if (distance <= DRAG_THRESHOLD && (!editor || !editorWasDragging)) {
        const actionEl = event.currentTarget as Element;
        const origin = actionEl
          ? this.getTopCenter(actionEl)
          : { x: touch.clientX, y: touch.clientY };

        this.fireCustomEvent(CustomEventType.ActionEditRequested, {
          action,
          nodeUuid: this.node.uuid,
          originX: origin.x,
          originY: origin.y
        });
      }
    }

    this.actionClickStartPos = null;
    this.pendingActionClick = null;
  }
  /* c8 ignore stop */

  private handleActionClick(event: MouseEvent, action: Action): void {
    // This method is kept for backward compatibility but should not be used
    // The new mousedown/mouseup approach handles click vs drag properly
    event.preventDefault();
    event.stopPropagation();

    // Don't handle clicks on the remove button or when action is in removing state
    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      this.actionRemovingState.has(action.uuid)
    ) {
      return;
    }

    // Fire event to request action editing
    this.fireCustomEvent(CustomEventType.ActionEditRequested, {
      action,
      nodeUuid: this.node.uuid
    });
  }

  private handleNodeEditClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    // Don't handle clicks on the remove button or when node is in removing state
    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      this.actionRemovingState.has(this.node.uuid)
    ) {
      return;
    }

    // Fire node edit requested event if the node has a router
    if (this.node.router) {
      // If router node has exactly one action, open the action editor directly
      if (this.node.actions && this.node.actions.length === 1) {
        this.fireCustomEvent(CustomEventType.ActionEditRequested, {
          action: this.node.actions[0],
          nodeUuid: this.node.uuid
        });
      } else {
        // Otherwise open the node editor as before
        this.fireCustomEvent(CustomEventType.NodeEditRequested, {
          node: this.node,
          nodeUI: this.ui
        });
      }
    }
  }

  private handleNodeMouseDown(event: MouseEvent): void {
    if (isRightClick(event)) return;

    // Don't handle clicks on the remove button, exits, drag handle, active linked elements, or when node is in removing state
    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      target.closest('.exit') ||
      target.closest('.exit-wrapper') ||
      target.closest('.drag-handle') ||
      this.isActiveLink(target) ||
      this.actionRemovingState.has(this.node.uuid)
    ) {
      return;
    }

    // Store the starting position for later comparison
    // Don't prevent default - let the Editor's drag system work normally
    this.nodeClickStartPos = { x: event.clientX, y: event.clientY };
    this.pendingNodeClick = { event };
  }

  private handleNodeMouseUp(event: MouseEvent): void {
    // Don't handle if we don't have a pending click
    if (!this.pendingNodeClick) {
      this.nodeClickStartPos = null;
      this.pendingNodeClick = null;
      return;
    }

    // Don't handle clicks on the remove button, exits, drag handle, active linked elements, or when node is in removing state
    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      target.closest('.exit') ||
      target.closest('.exit-wrapper') ||
      target.closest('.drag-handle') ||
      this.isActiveLink(target) ||
      this.actionRemovingState.has(this.node.uuid)
    ) {
      this.nodeClickStartPos = null;
      this.pendingNodeClick = null;
      return;
    }

    // Check if the mouse moved beyond the drag threshold
    if (this.nodeClickStartPos) {
      const deltaX = event.clientX - this.nodeClickStartPos.x;
      const deltaY = event.clientY - this.nodeClickStartPos.y;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      // Check if the Editor is currently in dragging mode
      const editor = this.closest('temba-flow-editor') as any;
      const editorWasDragging = editor?.dragging;

      // Only fire the node edit event if we haven't dragged beyond the threshold
      // AND either there's no Editor parent (test case) or the Editor didn't drag the node
      if (distance <= 5 && (!editor || !editorWasDragging)) {
        // Using literal 5 instead of DRAG_THRESHOLD since it's not imported
        // Fire event to request node editing if the node has a router
        if (this.node.router) {
          // Use top-center of the node as the dialog origin
          const origin = this.getTopCenter(this);

          // If router node has exactly one action, open the action editor directly
          if (this.node.actions && this.node.actions.length === 1) {
            this.fireCustomEvent(CustomEventType.ActionEditRequested, {
              action: this.node.actions[0],
              nodeUuid: this.node.uuid,
              originX: origin.x,
              originY: origin.y
            });
          } else {
            // Otherwise open the node editor as before
            this.fireCustomEvent(CustomEventType.NodeEditRequested, {
              node: this.node,
              nodeUI: this.ui,
              originX: origin.x,
              originY: origin.y
            });
          }
        }
      }
    }

    // Clean up
    this.nodeClickStartPos = null;
    this.pendingNodeClick = null;
  }

  /* c8 ignore start -- touch-only handlers */
  private handleNodeTouchStart(event: TouchEvent): void {
    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      target.closest('.exit') ||
      target.closest('.exit-wrapper') ||
      target.closest('.drag-handle') ||
      this.isActiveLink(target) ||
      this.actionRemovingState.has(this.node.uuid)
    ) {
      return;
    }

    const touch = event.touches[0];
    if (!touch) return;
    this.nodeClickStartPos = { x: touch.clientX, y: touch.clientY };
    this.pendingNodeClick = { event: event as any };
  }

  private handleNodeTouchEnd(event: TouchEvent): void {
    if (!this.pendingNodeClick) {
      this.nodeClickStartPos = null;
      this.pendingNodeClick = null;
      return;
    }

    const target = event.target as HTMLElement;
    if (
      target.closest('.remove-button') ||
      target.closest('.exit') ||
      target.closest('.exit-wrapper') ||
      target.closest('.drag-handle') ||
      this.isActiveLink(target) ||
      this.actionRemovingState.has(this.node.uuid)
    ) {
      this.nodeClickStartPos = null;
      this.pendingNodeClick = null;
      return;
    }

    const touch = event.changedTouches[0];
    if (this.nodeClickStartPos && touch) {
      const deltaX = touch.clientX - this.nodeClickStartPos.x;
      const deltaY = touch.clientY - this.nodeClickStartPos.y;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      const editor = this.closest('temba-flow-editor') as any;
      const editorWasDragging = editor?.dragging;

      if (distance <= 5 && (!editor || !editorWasDragging)) {
        if (this.node.router) {
          const origin = this.getTopCenter(this);

          if (this.node.actions && this.node.actions.length === 1) {
            this.fireCustomEvent(CustomEventType.ActionEditRequested, {
              action: this.node.actions[0],
              nodeUuid: this.node.uuid,
              originX: origin.x,
              originY: origin.y
            });
          } else {
            this.fireCustomEvent(CustomEventType.NodeEditRequested, {
              node: this.node,
              nodeUI: this.ui,
              originX: origin.x,
              originY: origin.y
            });
          }
        }
      }
    }

    this.nodeClickStartPos = null;
    this.pendingNodeClick = null;
  }
  /* c8 ignore stop */

  private handleAddActionClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    // Fire event to request adding a new action to this node
    this.fireCustomEvent(CustomEventType.AddActionRequested, {
      nodeUuid: this.node.uuid
    });
  }

  private calculateDropIndex(mouseY: number): number {
    // Get the sortable list element
    const sortableList = this.querySelector('temba-sortable-list');
    if (!sortableList || !this.node.actions)
      return this.node.actions?.length ?? 0;

    // Get all action elements, excluding any existing placeholder so its
    // space doesn't shift positions and feed back into the calculation.
    const actionElements = Array.from(
      sortableList.querySelectorAll('.action.sortable:not(.drop-placeholder)')
    );

    if (actionElements.length === 0) {
      return 0;
    }

    // Find where to insert based on mouse Y position
    for (let i = 0; i < actionElements.length; i++) {
      const actionElement = actionElements[i] as HTMLElement;
      const rect = actionElement.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;

      if (mouseY < centerY) {
        return i;
      }
    }

    // If past all elements, insert at the end
    return actionElements.length;
  }

  private handleExternalActionDragOver(event: CustomEvent): void {
    // Only handle if this is an execute_actions node
    if (this.ui.type !== 'execute_actions') return;

    const { action, sourceNodeUuid, actionIndex, mouseY, actionHeight } =
      event.detail;

    // Don't accept drops from the same node
    if (sourceNodeUuid === this.node.uuid) return;

    // Calculate where to drop
    const dropIndex = this.calculateDropIndex(mouseY);

    // Store the drag info
    this.externalDragInfo = {
      action,
      sourceNodeUuid,
      actionIndex,
      dropIndex,
      actionHeight: actionHeight || 60 // fallback to 60px if not provided
    };

    // Request update to show placeholder
    this.requestUpdate();
  }

  private handleExternalActionDragLeave(_event: CustomEvent): void {
    // Clear external drag state when drag leaves this node
    this.externalDragInfo = null;
    this.requestUpdate();
  }

  private handleActionShowGhost(_event: CustomEvent): void {
    // Show the ghost element in the sortable list
    const sortableList = this.querySelector('temba-sortable-list');
    if (sortableList) {
      const ghostElement = document.querySelector('.ghost') as HTMLElement;
      if (ghostElement) {
        ghostElement.style.display = 'block';
      }
    }
  }

  private handleActionHideGhost(_event: CustomEvent): void {
    // Hide the ghost element in the sortable list
    const sortableList = this.querySelector('temba-sortable-list');
    if (sortableList) {
      const ghostElement = document.querySelector('.ghost') as HTMLElement;
      if (ghostElement) {
        ghostElement.style.display = 'none';
      }
    }
  }

  private handleActionShowOriginal(_event: CustomEvent): void {
    const sortableList = this.querySelector(
      'temba-sortable-list'
    ) as SortableList;
    sortableList?.setOriginalVisible(true);
    this.showLastActionPlaceholder = false;
    this.requestUpdate();
  }

  private handleActionHideOriginal(_event: CustomEvent): void {
    const sortableList = this.querySelector(
      'temba-sortable-list'
    ) as SortableList;
    sortableList?.setOriginalVisible(false);
    // Restore the placeholder if this is the last action
    if (this.node.actions.length === 1) {
      this.showLastActionPlaceholder = true;
    }
    this.requestUpdate();
  }

  private handleExternalActionDrop(event: CustomEvent): void {
    // Only handle if this is an execute_actions node
    if (this.ui.type !== 'execute_actions') return;

    const { action, sourceNodeUuid, actionIndex, isCopy } = event.detail;

    // Don't accept drops from the same node
    if (sourceNodeUuid === this.node.uuid) return;

    // Get the drop index from our tracking state
    const dropIndex =
      this.externalDragInfo?.dropIndex ?? this.node.actions?.length ?? 0;

    // Clear external drag state
    this.externalDragInfo = null;

    const store = getStore();
    if (!store) return;

    const flowDefinition = store.getState().flowDefinition;
    if (!flowDefinition) return;

    const sourceNode = flowDefinition.nodes.find(
      (n) => n.uuid === sourceNodeUuid
    );

    if (!sourceNode) return;

    // IMPORTANT: Add the action to this node FIRST, before removing from source
    // This ensures we don't lose the action if the source node gets deleted
    const droppedAction = isCopy ? { ...action, uuid: generateUUID() } : action;
    const newActions = [...this.node.actions];
    newActions.splice(dropIndex, 0, droppedAction);

    const updatedNode = { ...this.node, actions: newActions };
    getStore()?.getState().updateNode(this.node.uuid, updatedNode);

    // Copy localizations from the original action to the new one
    if (isCopy) {
      const localization = flowDefinition.localization;
      if (localization) {
        for (const langCode of Object.keys(localization)) {
          const entry = localization[langCode]?.[action.uuid];
          if (entry) {
            store
              .getState()
              .updateLocalization(
                langCode,
                droppedAction.uuid,
                JSON.parse(JSON.stringify(entry))
              );
          }
        }
      }
    }

    if (!isCopy) {
      // Remove the action from the source node
      const updatedSourceActions = sourceNode.actions.filter(
        (_a, idx) => idx !== actionIndex
      );

      // If source node has no actions left, remove it
      if (updatedSourceActions.length === 0) {
        // Fire event to Editor so it can clean up jsPlumb connections properly
        this.fireCustomEvent(CustomEventType.NodeDeleted, {
          uuid: sourceNodeUuid
        });
      } else {
        // Update source node
        const updatedSourceNode = {
          ...sourceNode,
          actions: updatedSourceActions
        };
        getStore()?.getState().updateNode(sourceNodeUuid, updatedSourceNode);
      }
    }

    // Request update and notify that this node's size changed
    this.requestUpdate();
    this.fireCustomEvent(CustomEventType.SizeChanged, {
      uuid: this.node.uuid
    });
  }

  private renderTitle(
    config: ActionConfig,
    action: Action,
    index: number,
    isRemoving: boolean = false
  ) {
    const color = config.group
      ? ACTION_GROUP_METADATA[config.group]?.color
      : '#aaaaaa';
    const isTerminal = this.ui?.type === 'terminal';
    return html`<div class="cn-title" style="background:${color}">
      ${isTerminal
        ? html`<div class="title-spacer"></div>`
        : this.ui?.type === 'execute_actions' || this.node?.actions?.length > 1
          ? html`<temba-icon
              class="drag-handle ${this.isReadOnly() ? 'read-only-hidden' : ''}"
              name="sort"
            ></temba-icon>`
          : html`<div class="title-spacer"></div>`}

      <div class="name">${isRemoving ? msg('Remove?') : config.name}</div>
      <div
        class="remove-button ${isTerminal || this.isReadOnly()
          ? 'read-only-hidden'
          : ''}"
        @click=${(e: MouseEvent) =>
          this.handleActionRemoveClick(e, action, index)}
        title=${msg('Remove action')}
      >
        ✕
      </div>
    </div>`;
  }

  private renderNodeTitle(
    config: NodeConfig,
    node: Node,
    ui: NodeUI,
    isRemoving: boolean = false
  ) {
    // Get color from the appropriate metadata (either ACTION or SPLIT)
    const color = config.group
      ? ACTION_GROUP_METADATA[config.group]?.color ||
        SPLIT_GROUP_METADATA[config.group]?.color
      : '#aaaaaa';
    const untranslatedRules = this.getUntranslatedRulesCount();
    return html`<div
      class="cn-title ${isRemoving ? 'removing' : ''}"
      style="background:${color}; position: relative;"
    >
      <div class="title-spacer"></div>
      <div class="name">
        ${isRemoving
          ? msg('Remove?')
          : config.renderTitle
            ? config.renderTitle(node, ui)
            : html`${config.name}`}
      </div>
      <div
        class="remove-button ${this.isReadOnly() ? 'read-only-hidden' : ''}"
        @click=${(e: MouseEvent) => this.handleNodeRemoveClick(e)}
        title=${msg('Remove node')}
      >
        ✕
      </div>
      ${untranslatedRules > 0
        ? html`<div class="rules-count">${untranslatedRules}</div>`
        : null}
    </div>`;
  }

  private renderDropPlaceholder() {
    const height = this.externalDragInfo?.actionHeight || 60;
    return html`<div
      class="action sortable drop-placeholder"
      style="height: ${height}px; background: #f3f4f6; border: 2px dashed #d1d5db; border-radius: var(--curvature);"
    ></div>`;
  }

  /**
   * Get the localized version of an action if translating, otherwise return the original action.
   * Falls back to base language values if no localization exists for a field.
   */
  private getLocalizedAction(action: Action): Action {
    if (
      !this.isTranslating ||
      !this.flowDefinition ||
      !this.languageCode ||
      this.languageCode === this.flowDefinition.language
    ) {
      return action;
    }

    return localizeAction(
      action,
      this.flowDefinition?.localization?.[this.languageCode]?.[action.uuid]
    );
  }

  private renderAction(node: Node, action: Action, index: number) {
    const config = ACTION_CONFIG[action.type];
    const isRemoving = this.actionRemovingState.has(action.uuid);
    const isLocalizable = config?.localizable && config.localizable.length > 0;
    const isDisabled = this.isTranslating && !isLocalizable;

    // Check if this action has localization data
    const hasLocalization =
      this.isTranslating &&
      this.flowDefinition?.localization?.[this.languageCode]?.[action.uuid];

    // Get the localized action if translating
    const displayAction = this.getLocalizedAction(action);

    if (config) {
      const hasIssues =
        this.issuesByAction?.has(action.uuid) || isUnsupportedAction(action);
      const classes = [
        'action',
        'sortable',
        action.type,
        isRemoving ? 'removing' : '',
        isLocalizable && this.isTranslating ? 'localizable' : '',
        hasLocalization ? 'has-localization' : '',
        isDisabled ? 'non-localizable' : ''
      ]
        .filter(Boolean)
        .join(' ');

      return html`<div class="${classes}" id="action-${index}">
        <div
          class="action-content ${hasIssues ? 'has-issues' : ''}"
          @mousedown=${(e: MouseEvent) =>
            !isDisabled && this.handleActionMouseDown(e, action)}
          @mouseup=${(e: MouseEvent) =>
            !isDisabled && this.handleActionMouseUp(e, action)}
          @touchstart=${(e: TouchEvent) =>
            !isDisabled && this.handleActionTouchStart(e, action)}
          @touchend=${(e: TouchEvent) =>
            !isDisabled && this.handleActionTouchEnd(e, action)}
          style="cursor: ${isDisabled ? 'not-allowed' : 'pointer'}"
        >
          ${this.renderTitle(config, action, index, isRemoving)}
          <div class="body">
            ${config.render
              ? config.render(node, displayAction)
              : html`<pre>${action.type}</pre>`}
          </div>
        </div>
      </div>`;
    }
    return html`<div
      class="action sortable ${isRemoving ? 'removing' : ''}"
      id="action-${index}"
    >
      <div
        class="remove-button"
        @click=${(e: MouseEvent) =>
          this.handleActionRemoveClick(e, action, index)}
        title=${msg('Remove action')}
      >
        ✕
      </div>
      ${action.type}
    </div>`;
  }

  private renderActionsWithPlaceholder() {
    if (!this.externalDragInfo) {
      // No external drag, render normally
      return this.node.actions.map((action, index) =>
        this.renderAction(this.node, action, index)
      );
    }

    // Insert placeholder at the drop index
    const result = [];
    for (let i = 0; i < this.node.actions.length; i++) {
      if (i === this.externalDragInfo.dropIndex) {
        result.push(this.renderDropPlaceholder());
      }
      result.push(this.renderAction(this.node, this.node.actions[i], i));
    }

    // If dropping at the end, add placeholder after all actions
    if (this.externalDragInfo.dropIndex >= this.node.actions.length) {
      result.push(this.renderDropPlaceholder());
    }

    return result;
  }

  private getUntranslatedRulesCount(): number {
    if (!this.isTranslating || !this.ui?.config?.localizeRules) return 0;
    const cases = this.node?.router?.cases;
    if (!cases?.length) return 0;

    const langLocalization =
      this.flowDefinition?.localization?.[this.languageCode] || {};

    return cases.filter((c) => {
      if (!c.arguments?.length || !c.arguments.some((a) => a)) return false;
      const localized = langLocalization[c.uuid]?.arguments;
      return !Array.isArray(localized) || !localized.some((a: string) => a);
    }).length;
  }

  private renderRouter(router: Router, ui: NodeUI) {
    const nodeConfig = NODE_CONFIG[ui.type];
    if (nodeConfig) {
      return html`<div class="router" style="position: relative;">
        ${router.result_name
          ? html`<div
              class="body"
              @mousedown=${(e: MouseEvent) => this.handleNodeMouseDown(e)}
              @mouseup=${(e: MouseEvent) => this.handleNodeMouseUp(e)}
              @touchstart=${(e: TouchEvent) => this.handleNodeTouchStart(e)}
              @touchend=${(e: TouchEvent) => this.handleNodeTouchEnd(e)}
              style="cursor: pointer;"
            >
              ${renderClamped(
                msg(
                  html`Save as
                    <span class="result-name">${router.result_name}</span>`
                ),
                msg(str`Save as ${router.result_name}`)
              )}
            </div>`
          : null}
      </div>`;
    }
  }

  private renderCategories(node: Node) {
    if (!node.router || !node.router.categories) {
      return null;
    }

    // Check if this node type supports category localization
    const nodeConfig = NODE_CONFIG[this.ui?.type];
    const supportsLocalization = nodeConfig?.localizable === 'categories';
    const translatableCategoryUuids = new Set(
      getTranslatableCategoriesForNode(
        this.ui?.type,
        node.router.categories
      ).map((category) => category.uuid)
    );

    return html`<div class="categories">
      ${repeat(
        node.router.categories,
        (category) => category.uuid,
        (category) => {
          const exit = node.exits.find(
            (exit: Exit) => exit.uuid == category.exit_uuid
          );

          // Get localized category name if translating
          let displayName = category.name;
          let isLocalized = false;

          if (
            this.isTranslating &&
            this.languageCode !== 'eng' &&
            supportsLocalization &&
            translatableCategoryUuids.has(category.uuid)
          ) {
            const localization =
              this.flowDefinition?.localization?.[this.languageCode];
            if (localization && localization[category.uuid]) {
              const categoryLocalization = localization[category.uuid];
              if (categoryLocalization.name && categoryLocalization.name[0]) {
                displayName = categoryLocalization.name[0];
                isLocalized = true;
              }
            }
          }

          // Category is localizable if: translating, supports localization, categories enabled per-node, and not base language
          const nodeLocalizeCategories = !!this.ui?.config?.localizeCategories;
          const isLocalizable =
            this.isTranslating &&
            this.languageCode !== 'eng' &&
            supportsLocalization &&
            translatableCategoryUuids.has(category.uuid) &&
            nodeLocalizeCategories &&
            !isLocalized;

          return html`<div
            class=${getClasses({
              category: true,
              localizable: isLocalizable
            })}
            @mousedown=${(e: MouseEvent) => this.handleNodeMouseDown(e)}
            @mouseup=${(e: MouseEvent) => this.handleNodeMouseUp(e)}
            @touchstart=${(e: TouchEvent) => this.handleNodeTouchStart(e)}
            @touchend=${(e: TouchEvent) => this.handleNodeTouchEnd(e)}
            style="cursor: pointer;"
          >
            <div class="cn-title" title="${displayName}">${displayName}</div>
            ${this.renderExit(exit)}
          </div>`;
        }
      )}
    </div>`;
  }

  private renderExit(exit: Exit): TemplateResult {
    return html`<div class="exit-wrapper">
      <div
        id="${exit.uuid}"
        class=${getClasses({
          exit: true,
          connected: !!exit.destination_uuid,
          removing: this.exitRemovingState.has(exit.uuid),
          'read-only': this.isReadOnly()
        })}
        @click=${(e: MouseEvent) => this.handleExitClick(e, exit)}
      ></div>
    </div>`;
  }

  private isReadOnly(): boolean {
    return this.viewingRevision || this.isTranslating;
  }

  public render() {
    if (!this.node || !this.ui) {
      return html`<div class="node">${msg('Loading...')}</div>`;
    }

    const nodeConfig = NODE_CONFIG[this.ui.type];

    // A node is non-localizable in translation mode if it has no translatable
    // content (actions or categories), or if all translatable categories are
    // currently hidden by the categories toggle.
    const hasTranslatableCategories =
      nodeConfig?.localizable === 'categories' &&
      hasTranslatableCategoriesForNode(
        this.ui.type,
        this.node.router?.categories
      );
    const hasTranslatableActions = (this.node.actions || []).some((action) => {
      const actionConfig = ACTION_CONFIG[action.type];
      return !!actionConfig?.localizable?.length;
    });
    const nodeLocalizeCategories = !!this.ui?.config?.localizeCategories;
    const nodeLocalizeRules = !!this.ui?.config?.localizeRules;
    const hasActiveTranslatableContent =
      hasTranslatableActions ||
      (hasTranslatableCategories && nodeLocalizeCategories) ||
      nodeLocalizeRules;
    const isNodeDisabled = this.isTranslating && !hasActiveTranslatableContent;

    // Get active contact count for this node
    const activeCount =
      (this.activity?.nodes && this.activity.nodes[this.node.uuid]) || 0;

    // Check for node-level issues or action-level issues on any action in this node
    const nodeHasIssues =
      this.issuesByNode?.has(this.node.uuid) ||
      this.node.actions?.some(
        (a) => this.issuesByAction?.has(a.uuid) || isUnsupportedAction(a)
      );

    return html`
      <div
        id="${this.node.uuid}"
        class=${getClasses({
          node: true,
          'execute-actions': this.ui.type === 'execute_actions',
          'non-localizable': isNodeDisabled,
          'has-issues': nodeHasIssues
        })}
        style="left:${this.ui.position.left}px;top:${this.ui.position.top}px"
      >
        ${activeCount > 0
          ? html`<div class="active-count">
              <temba-counter value=${activeCount}></temba-counter>
            </div>`
          : ''}
        ${nodeConfig &&
        nodeConfig.type !== 'execute_actions' &&
        nodeConfig.type !== 'terminal'
          ? html`<div class="router" style="position: relative;">
              <div
                @mousedown=${(e: MouseEvent) => this.handleNodeMouseDown(e)}
                @mouseup=${(e: MouseEvent) => this.handleNodeMouseUp(e)}
                @touchstart=${(e: TouchEvent) => this.handleNodeTouchStart(e)}
                @touchend=${(e: TouchEvent) => this.handleNodeTouchEnd(e)}
                style="cursor: pointer;"
              >
                ${this.renderNodeTitle(
                  nodeConfig,
                  this.node,
                  this.ui,
                  this.actionRemovingState.has(this.node.uuid)
                )}
                ${nodeConfig.render
                  ? nodeConfig.render(this.node, this.ui)
                  : null}
              </div>
            </div>`
          : this.node.actions?.length > 0
            ? this.ui.type === 'execute_actions'
              ? html`<temba-sortable-list
                    dragHandle="drag-handle"
                    externalDrag
                    @temba-order-changed="${this.handleActionOrderChanged}"
                    @temba-drag-start="${this.handleActionDragStart}"
                    @temba-drag-external="${this.handleActionDragExternal}"
                    @temba-drag-internal="${this.handleActionDragInternal}"
                    @temba-drag-stop="${this.handleActionDragStop}"
                  >
                    ${this.renderActionsWithPlaceholder()}
                  </temba-sortable-list>
                  ${this.showLastActionPlaceholder
                    ? html`<div
                        class="empty-node-placeholder"
                        style="height: ${this.lastActionPlaceholderHeight}px;"
                      ></div>`
                    : ''}`
              : html`${this.node.actions.map((action, index) =>
                  this.renderAction(this.node, action, index)
                )}`
            : this.ui.type === 'execute_actions'
              ? html`<div class="empty-node-placeholder"></div>`
              : ''}
        ${this.node.router
          ? html`<div class="router-section">
              ${this.renderRouter(this.node.router, this.ui)}
              ${this.renderCategories(this.node)}
            </div>`
          : this.ui.type === 'terminal'
            ? ''
            : html`<div class="action-exits">
                ${repeat(
                  this.node.exits,
                  (exit) => exit.uuid,
                  (exit) => this.renderExit(exit)
                )}
              </div>`}
        ${this.ui.type === 'execute_actions' && !this.isReadOnly()
          ? html`<div
              class="add-action-button"
              @click=${(e: MouseEvent) => this.handleAddActionClick(e)}
              title=${msg('Add action')}
            >
              <temba-icon name="add"></temba-icon>
            </div>`
          : ''}
      </div>
    `;
  }
}
