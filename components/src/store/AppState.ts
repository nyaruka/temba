import { createStore, StoreApi } from 'zustand/vanilla';
import { msg } from '@lit/localize';
import { generateUUID } from '../utils';
import { getLanguageName } from '../languages';
import {
  Action,
  Exit,
  FlowDefinition,
  FlowPosition,
  Node,
  NodeUI,
  Router,
  StickyNote
} from './flow-definition';
import { immer } from 'zustand/middleware/immer';
import { subscribeWithSelector } from 'zustand/middleware';
import { property } from 'lit/decorators.js';
import { produce } from 'immer';
import {
  FlowDependency,
  replaceDependencies,
  resolveDependencyNames
} from '../flow/dependencies';

const CANVAS_PADDING = 800;

// how long a revision load will wait on canonical names before rendering the
// names embedded in the definition, which the editor heals asynchronously
const DEPENDENCY_RESOLVE_TIMEOUT = 3000;

export type DependencyResolver = (
  dependencies: FlowDependency[]
) => Promise<FlowDependency[]>;

let dependencyResolver: DependencyResolver | null = null;

/** Installs the page-level canonical-name resolver and returns the previous
 * resolver so a disconnected store can restore it in tests. */
export const setDependencyResolver = (
  resolver: DependencyResolver | null
): DependencyResolver | null => {
  const previous = dependencyResolver;
  dependencyResolver = resolver;
  return previous;
};

/** The currently installed resolver, so a store can tell whether it is still
 * the owner before restoring the one it replaced. */
export const getDependencyResolver = (): DependencyResolver | null =>
  dependencyResolver;

/** Resolves with null if the given promise hasn't settled in time. */
const withTimeout = async <T>(
  promise: Promise<T>,
  timeout: number
): Promise<T | null> => {
  let timer: any = null;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeout);
      })
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
};

/**
 * Temporary: Reclassify nodes based on whether they contain terminal actions.
 * - execute_actions nodes with a terminal action become "terminal"
 * - terminal nodes that no longer have a terminal action become "execute_actions"
 * This can be removed once we stop supporting terminal nodes.
 */
function reclassifyTerminalNodes(definition: FlowDefinition): void {
  if (!definition?.nodes || !definition?._ui?.nodes) return;

  for (const node of definition.nodes) {
    const nodeUI = definition._ui.nodes[node.uuid];
    if (!nodeUI) continue;

    const hasTerminalAction = node.actions?.some(
      (action) => (action as any).terminal === true
    );

    if (nodeUI.type === 'execute_actions' && hasTerminalAction) {
      nodeUI.type = 'terminal' as any;
    } else if (nodeUI.type === ('terminal' as any) && !hasTerminalAction) {
      nodeUI.type = 'execute_actions';
    }
  }
}

/**
 * Reclassify wait_for_response nodes that are actually voice-specific wait types.
 * The server stores all voice waits as wait_for_response, but we detect the specific
 * type from the router's wait hint:
 * - hint.type === 'digits' && hint.count === 1 → wait_for_menu
 * - hint.type === 'digits' (no count) → wait_for_digits
 * - hint.type === 'audio' → wait_for_audio
 */
function reclassifyVoiceWaitNodes(definition: FlowDefinition): void {
  if (!definition?.nodes || !definition?._ui?.nodes) return;

  for (const node of definition.nodes) {
    const nodeUI = definition._ui.nodes[node.uuid];
    if (!nodeUI || nodeUI.type !== 'wait_for_response') continue;

    const hint = node.router?.wait?.hint;
    if (!hint) continue;

    if (hint.type === 'digits' && hint.count === 1) {
      nodeUI.type = 'wait_for_menu' as any;
    } else if (hint.type === 'digits') {
      nodeUI.type = 'wait_for_digits' as any;
    } else if (hint.type === 'audio') {
      nodeUI.type = 'wait_for_audio' as any;
    }
  }
}

/**
 * Sorts nodes by their position - first by y (top), then by x (left)
 */
function sortNodesByPosition(
  nodes: Node[],
  nodePositions: Record<string, NodeUI>
): void {
  nodes.sort((a, b) => {
    const posA = nodePositions[a.uuid]?.position;
    const posB = nodePositions[b.uuid]?.position;

    // if either position is missing, maintain current order
    if (!posA || !posB) {
      return 0;
    }

    // sort by y (top) first
    if (posA.top !== posB.top) {
      return posA.top - posB.top;
    }

    // if y is same, sort by x (left)
    return posA.left - posB.left;
  });
}

export interface InfoResult {
  key: string;
  name: string;
  categories: string[];
  node_uuids: string[];
}

export interface Language {
  code: string;
  name: string;
}

export interface FlowIssue {
  type: string;
  node_uuid: string;
  action_uuid?: string;
  description: string;
  dependency?: {
    key: string;
    name: string;
    type: string;
  };
}

export interface FlowInfo {
  results: InfoResult[];
  dependencies: FlowDependency[];
  counts: { nodes: number; languages: number };
  locals: string[];
  issues?: FlowIssue[];
}

function buildIssueMaps(issues: FlowIssue[] = []): {
  byNode: Map<string, FlowIssue[]>;
  byAction: Map<string, FlowIssue[]>;
} {
  const byNode = new Map<string, FlowIssue[]>();
  const byAction = new Map<string, FlowIssue[]>();
  for (const issue of issues) {
    if (issue.action_uuid) {
      const actionList = byAction.get(issue.action_uuid) || [];
      actionList.push(issue);
      byAction.set(issue.action_uuid, actionList);
    } else {
      const nodeList = byNode.get(issue.node_uuid) || [];
      nodeList.push(issue);
      byNode.set(issue.node_uuid, nodeList);
    }
  }
  return { byNode, byAction };
}

export interface FlowContents {
  definition: FlowDefinition;
  info: FlowInfo;
}

export interface Workspace {
  anon: boolean;
  country: string;
  date_style: string;
  languages: string[];
  name: string;
  primary_language: string;
  timezone: string;
  uuid: string;
}

export interface CanvasPositions {
  [uuid: string]: FlowPosition;
}

export interface Activity {
  segments: { [exitToDestinationKey: string]: number };
  nodes: { [nodeUuid: string]: number };
}

export interface AppState {
  features: string[];

  flowDefinition: FlowDefinition;
  flowInfo: FlowInfo;
  issuesByNode: Map<string, FlowIssue[]>;
  issuesByAction: Map<string, FlowIssue[]>;

  languageCode: string;
  workspace: Workspace;
  isTranslating: boolean;
  viewingRevision: boolean;

  dirtyDate: Date | null;

  canvasSize: { width: number; height: number };
  activity: Activity | null;
  simulatorActivity: Activity | null;
  activityEndpoint: string | null;
  simulatorActive: boolean;

  // spec version to request revisions at, from the server which served the editor
  specVersion: string | null;
  setSpecVersion: (version: string) => void;

  getCurrentActivity: () => Activity | null;
  fetchRevision: (endpoint: string, id?: string) => Promise<void>;
  fetchWorkspace: (endpoint: string) => Promise<void>;
  fetchActivity: (endpoint: string) => Promise<void>;
  setActivityEndpoint: (endpoint: string) => void;
  updateActivity: (activity: Activity) => void;
  updateSimulatorActivity: (activity: Activity) => void;
  setSimulatorActive: (active: boolean) => void;

  getFlowResults: () => InfoResult[];
  getResultByKey(id: any): InfoResult;

  setFlowContents: (flow: FlowContents) => void;
  setFlowInfo: (info: FlowInfo) => void;
  updateDependencyNames: (dependencies: FlowDependency[]) => void;
  setRevision: (revision: number) => void;
  setLanguageCode: (languageCode: string) => void;
  setDirtyDate: (date: Date) => void;
  expandCanvas: (width: number, height: number) => void;

  flushSave: (() => Promise<void>) | null;
  setFlushSave: (fn: (() => Promise<void>) | null) => void;

  updateNode(
    uuid: string,
    node: { actions: Action[]; uuid: string; exits: Exit[]; router?: Router }
  ): unknown;
  updateNodeUIConfig(uuid: string, config: Record<string, any>): unknown;
  updateConnection(
    nodeUuid: string,
    exitUuid: string,
    destinationNodeUuid: string
  ): unknown;
  updateCanvasPositions: (positions: CanvasPositions) => void;
  removeNodes: (uuids: string[]) => void;
  removeStickyNotes: (uuids: string[]) => void;
  updateStickyNote(uuid: string, sticky: StickyNote): void;
  createStickyNote(position: FlowPosition): string;
  createNode(nodeType: string, position: FlowPosition): string;
  addNode(node: Node, nodeUI: NodeUI): void;
  duplicateNodes(uuids: string[]): Record<string, string>;
  updateLocalization(
    languageCode: string,
    actionUuid: string,
    localizationData: Record<string, any>
  ): void;
  setFeatures: (features: string[]) => void;
  clearFlowData: () => void;
  setTranslationFilters: (filters: { categories: boolean }) => void;
  markAutoTranslated: (
    languageCode: string,
    uuid: string,
    attributes: string[]
  ) => void;
}

export const zustand = createStore<AppState>()(
  subscribeWithSelector(
    immer((set, get) => ({
      features: [] as string[],
      canvasSize: { width: 0, height: 0 },
      languageCode: '',
      workspace: null,
      flowDefinition: null,
      flowInfo: null,
      issuesByNode: new Map(),
      issuesByAction: new Map(),
      isTranslating: false,
      viewingRevision: false,
      dirtyDate: null,
      activity: null,
      simulatorActivity: null,
      activityEndpoint: null,
      simulatorActive: false,
      specVersion: null,
      flushSave: null,

      setFlushSave: (fn: (() => Promise<void>) | null) => {
        set({ flushSave: fn });
      },

      setDirtyDate: (date: Date) => {
        set((state: AppState) => {
          state.dirtyDate = date;
        });
      },

      fetchRevision: async (endpoint: string, id: string = null) => {
        const viewingRevision = !!id && id !== 'latest';
        if (!id) {
          id = 'latest';
        }
        const specVersion = get().specVersion;
        const response = await fetch(
          specVersion
            ? `${endpoint}/${id}/?version=${specVersion}`
            : `${endpoint}/${id}/`
        ).catch(() => null);

        if (!response?.ok) {
          // surface the server's explanation, e.g. that the flow was upgraded
          // and this editor needs reloading
          const body = await response?.json().catch(() => null);
          throw new Error(
            body?.error || msg('Unable to load the flow. Please try again.')
          );
        }
        const data = (await response.json()) as FlowContents;
        // reclassify while the definition is still the mutable response JSON -
        // resolveDependencyNames below returns an immer-frozen definition that
        // in-place reclassification would throw on
        reclassifyTerminalNodes(data.definition);
        reclassifyVoiceWaitNodes(data.definition);
        if (dependencyResolver && data.info?.dependencies?.length) {
          try {
            // resolving before the first paint avoids a visible flash of stale
            // names, but a slow endpoint must never hold the editor hostage -
            // past the timeout we render and let the editor's watcher heal it
            const canonical = await withTimeout(
              dependencyResolver(data.info.dependencies),
              DEPENDENCY_RESOLVE_TIMEOUT
            );
            if (canonical) {
              // the info list only changes when a name actually changed, but
              // resolving always runs: a reference can be missing a name
              // without any name having changed
              const dependencies = replaceDependencies(
                data.info.dependencies,
                canonical
              );
              if (dependencies) {
                data.info = { ...data.info, dependencies };
              }
              data.definition = resolveDependencyNames(
                data.definition,
                canonical
              );
            }
          } catch (error) {
            // A name lookup shouldn't make an otherwise valid flow unusable.
            // Keep its embedded names and let a later socket/reconnect heal it.
            console.error('failed to resolve flow dependency names', error);
          }
        }
        const issueMaps = buildIssueMaps(data.info?.issues);
        const flowLang = data.definition.language;
        set({
          flowInfo: data.info,
          flowDefinition: data.definition,
          viewingRevision,
          issuesByNode: issueMaps.byNode,
          issuesByAction: issueMaps.byAction,
          languageCode: flowLang,
          isTranslating: false
        });
      },

      fetchWorkspace: async (endpoint) => {
        const response = await fetch(endpoint);
        if (!response.ok) {
          throw new Error('Network response was not ok');
        }
        const data = await response.json();
        set({ workspace: data });
      },

      setActivityEndpoint: (endpoint: string) => {
        set({ activityEndpoint: endpoint });
      },

      setSpecVersion: (version: string) => {
        set({ specVersion: version });
      },

      fetchActivity: async (endpoint: string) => {
        try {
          const response = await fetch(endpoint);
          if (!response.ok) {
            return;
          }
          const data = await response.json();
          set({ activity: data });
        } catch (error) {
          console.error('Failed to fetch activity:', error);
        }
      },

      updateActivity: (activity: Activity) => {
        set({ activity });
      },

      updateSimulatorActivity: (activity: Activity) => {
        set({ simulatorActivity: activity });
      },

      setSimulatorActive: (active: boolean) => {
        set({ simulatorActive: active });
      },

      getCurrentActivity: () => {
        const state = get();
        return state.simulatorActive ? state.simulatorActivity : state.activity;
      },

      getFlowResults: () => {
        const state = get();
        return state.flowInfo.results;
      },

      getResultByKey: (id: any) => {
        const state = get();
        const results = state.flowInfo.results;
        return results.find((result) => result.key === id);
      },

      getLanguage: () => {
        const state = get();
        const languageCode = state.languageCode;
        return { name: getLanguageName(languageCode), code: languageCode };
      },

      setFeatures: (features: string[]) => {
        set({ features });
      },

      clearFlowData: () => {
        set({
          flowDefinition: null,
          flowInfo: null,
          issuesByNode: new Map(),
          issuesByAction: new Map(),
          activity: null,
          simulatorActivity: null,
          simulatorActive: false,
          dirtyDate: null,
          viewingRevision: false
        });
      },

      // todo: eventually we should be doing the fetching
      setFlowContents: (flow: FlowContents) => {
        set((state: AppState) => {
          const flowLang = flow.definition.language;
          // the definition handed in may be frozen store state (e.g. restoring
          // a pre-revision-view snapshot), so reclassify and sort on a draft
          state.flowDefinition = produce(
            flow.definition,
            (draft: FlowDefinition) => {
              reclassifyTerminalNodes(draft);
              reclassifyVoiceWaitNodes(draft);
              if (draft.nodes && draft._ui?.nodes) {
                sortNodesByPosition(draft.nodes, draft._ui.nodes);
              }
            }
          );
          state.flowInfo = flow.info;
          const issueMaps = buildIssueMaps(flow.info?.issues);
          state.issuesByNode = issueMaps.byNode;
          state.issuesByAction = issueMaps.byAction;
          // Reset to the flow's default language when loading a new flow
          state.languageCode = flowLang;
          state.isTranslating = false;
          state.viewingRevision = false;
        });
      },

      setFlowInfo: (info: FlowInfo) => {
        set((state: AppState) => {
          state.flowInfo = info;
          const issueMaps = buildIssueMaps(info?.issues);
          state.issuesByNode = issueMaps.byNode;
          state.issuesByAction = issueMaps.byAction;
        });
      },

      updateDependencyNames: (changed: FlowDependency[]) => {
        set((state: AppState) => {
          if (!state.flowInfo || !state.flowDefinition) {
            return;
          }
          const dependencies = replaceDependencies(
            state.flowInfo.dependencies,
            changed
          );
          if (dependencies) {
            state.flowInfo.dependencies = dependencies;
          }
          state.flowDefinition = resolveDependencyNames(
            state.flowDefinition,
            changed
          );
        });
      },

      setRevision: (revision: number) => {
        set((state: AppState) => {
          state.flowDefinition.revision = revision;
        });
      },

      setLanguageCode: (languageCode: string) => {
        set((state: AppState) => {
          state.languageCode = languageCode;
          state.isTranslating = state.flowDefinition.language !== languageCode;
        });
      },

      expandCanvas: (width: number, height: number) => {
        set((state: AppState) => {
          const minWidth = Math.max(
            state.canvasSize.width,
            width + CANVAS_PADDING
          );
          const minHeight = Math.max(
            state.canvasSize.height,
            height + CANVAS_PADDING
          );

          state.canvasSize.width = minWidth;
          state.canvasSize.height = minHeight;
        });
      },

      updateCanvasPositions: (positions: CanvasPositions) => {
        set((state: AppState) => {
          for (const uuid in positions) {
            if (state.flowDefinition._ui.nodes[uuid]) {
              state.flowDefinition._ui.nodes[uuid].position = positions[uuid];
            } else if (state.flowDefinition._ui.stickies[uuid]) {
              state.flowDefinition._ui.stickies[uuid].position =
                positions[uuid];
            }
          }

          // Sort nodes by position since positions may have changed
          sortNodesByPosition(
            state.flowDefinition.nodes,
            state.flowDefinition._ui.nodes
          );

          state.dirtyDate = new Date();
        });
      },

      removeNodes: (uuids: string[]) => {
        set((state: AppState) => {
          for (const uuid of uuids) {
            delete state.flowDefinition._ui.nodes[uuid];
          }

          state.flowDefinition = produce(state.flowDefinition, (draft) => {
            // For each node being removed, check if we should reroute connections
            uuids.forEach((removedUuid) => {
              const removedNode = draft.nodes.find(
                (n) => n.uuid === removedUuid
              );

              if (!removedNode || !removedNode.exits.length) return;

              // Get all destinations (filter out null/undefined)
              const destinations = removedNode.exits
                .map((exit) => exit.destination_uuid)
                .filter((dest) => dest);

              // Only proceed if all exits have destinations and they all point to the same place
              if (
                destinations.length === removedNode.exits.length &&
                destinations.every((dest) => dest === destinations[0])
              ) {
                const targetDestination = destinations[0];
                // Don't reroute if the target is also being removed
                if (uuids.includes(targetDestination)) return;

                // Find all nodes with exits pointing to the node being removed
                draft.nodes.forEach((node) => {
                  node.exits.forEach((exit) => {
                    if (exit.destination_uuid === removedUuid) {
                      // Reroute to the same destination the removed node was going to
                      exit.destination_uuid = targetDestination;
                    }
                  });
                });
              }
            });

            // Remove the nodes
            draft.nodes = draft.nodes.filter(
              (node) => !uuids.includes(node.uuid)
            );

            // Clear any remaining connections to removed nodes that weren't rerouted
            draft.nodes.forEach((node) => {
              node.exits.forEach((exit) => {
                if (uuids.includes(exit.destination_uuid)) {
                  exit.destination_uuid = null;
                }
              });
            });

            // Sort nodes by position
            sortNodesByPosition(draft.nodes, draft._ui.nodes);
          });

          state.dirtyDate = new Date();
        });
      },

      removeStickyNotes: (uuids: string[]) => {
        set((state: AppState) => {
          if (state.flowDefinition._ui?.stickies) {
            for (const uuid of uuids) {
              delete state.flowDefinition._ui.stickies[uuid];
            }
          }
          state.dirtyDate = new Date();
        });
      },

      updateNode: (uuid: string, newNode: Node) => {
        set((state: AppState) => {
          const node = state.flowDefinition?.nodes.find((n) => n.uuid === uuid);
          if (node) {
            node.actions = newNode.actions;
            node.uuid = newNode.uuid;
            node.exits = newNode.exits;
            node.router = newNode.router;
          }
          state.dirtyDate = new Date();
        });
      },

      updateNodeUIConfig: (uuid: string, config: Record<string, any>) => {
        set((state: AppState) => {
          if (state.flowDefinition._ui.nodes[uuid]) {
            // Handle type separately if provided
            if (config.type !== undefined) {
              state.flowDefinition._ui.nodes[uuid].type = config.type;
            }

            // Update config (excluding type)
            if (!state.flowDefinition._ui.nodes[uuid].config) {
              state.flowDefinition._ui.nodes[uuid].config = {};
            }
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { type, ...configWithoutType } = config;
            Object.assign(
              state.flowDefinition._ui.nodes[uuid].config,
              configWithoutType
            );
          }
          state.dirtyDate = new Date();
        });
      },

      updateConnection: (
        nodeUuid: string,
        exitUuid: string,
        destinationNodeUuid: string
      ) => {
        /* console.log('Upating connection:', {
          nodeUuid,
          exitUuid,
          destinationNodeUuid
        });*/
        set((state: AppState) => {
          // Find the exit with this UUID
          const node = state.flowDefinition.nodes.find(
            (node) => node.uuid === nodeUuid
          );

          const exit = node?.exits.find((e) => e.uuid === exitUuid);
          if (exit) {
            // Update the destination
            exit.destination_uuid = destinationNodeUuid;
            state.dirtyDate = new Date();
          }
        });
      },

      updateStickyNote: (uuid: string, sticky: StickyNote) => {
        set((state: AppState) => {
          if (!state.flowDefinition._ui.stickies) {
            state.flowDefinition._ui.stickies = {};
          }
          state.flowDefinition._ui.stickies[uuid] = sticky;
          state.dirtyDate = new Date();
        });
      },

      createStickyNote: (position: FlowPosition): string => {
        const uuid = generateUUID();
        set((state: AppState) => {
          if (!state.flowDefinition._ui.stickies) {
            state.flowDefinition._ui.stickies = {};
          }

          const newSticky: StickyNote = {
            position,
            title: '',
            body: '',
            color: 'yellow'
          };

          state.flowDefinition._ui.stickies[uuid] = newSticky;
          state.dirtyDate = new Date();
        });
        return uuid;
      },

      createNode: (nodeType: string, position: FlowPosition): string => {
        const uuid = generateUUID();
        const exitUuid = generateUUID();

        set((state: AppState) => {
          // Create a basic node with a single exit
          const newNode: Node = {
            uuid,
            actions: [],
            exits: [
              {
                uuid: exitUuid,
                destination_uuid: null
              }
            ]
          };

          // Add the node to the flow definition
          state.flowDefinition.nodes.push(newNode);

          // Set up UI for the node
          if (!state.flowDefinition._ui.nodes) {
            state.flowDefinition._ui.nodes = {};
          }

          state.flowDefinition._ui.nodes[uuid] = {
            position,
            type: nodeType as any,
            config: {}
          };

          // Sort nodes by position
          sortNodesByPosition(
            state.flowDefinition.nodes,
            state.flowDefinition._ui.nodes
          );

          state.dirtyDate = new Date();
        });

        return uuid;
      },

      addNode: (node: Node, nodeUI: NodeUI) => {
        set((state: AppState) => {
          // Add the node to the flow definition
          state.flowDefinition.nodes.push(node);

          // Set up UI for the node
          if (!state.flowDefinition._ui.nodes) {
            state.flowDefinition._ui.nodes = {};
          }

          state.flowDefinition._ui.nodes[node.uuid] = nodeUI;

          // Sort nodes by position
          sortNodesByPosition(
            state.flowDefinition.nodes,
            state.flowDefinition._ui.nodes
          );

          state.dirtyDate = new Date();
        });
      },

      duplicateNodes: (uuids: string[]): Record<string, string> => {
        const currentState = get();
        const uuidsSet = new Set(uuids);
        const uuidMapping: Record<string, string> = {};
        const stickies = currentState.flowDefinition._ui.stickies || {};

        // First pass: build UUID mapping for all internal UUIDs
        for (const uuid of uuids) {
          // Check if it's a sticky note
          if (stickies[uuid]) {
            uuidMapping[uuid] = generateUUID();
            continue;
          }

          const node = currentState.flowDefinition.nodes.find(
            (n) => n.uuid === uuid
          );
          if (!node) continue;

          uuidMapping[uuid] = generateUUID();

          for (const action of node.actions) {
            uuidMapping[action.uuid] = generateUUID();
          }

          for (const exit of node.exits) {
            uuidMapping[exit.uuid] = generateUUID();
          }

          if (node.router) {
            for (const category of node.router.categories) {
              uuidMapping[category.uuid] = generateUUID();
            }
            for (const c of node.router.cases || []) {
              uuidMapping[c.uuid] = generateUUID();
            }
          }
        }

        // Second pass: deep clone and remap UUIDs
        const newNodes: Array<{ node: Node; ui: NodeUI }> = [];
        const newStickies: Array<{ uuid: string; sticky: StickyNote }> = [];

        for (const uuid of uuids) {
          // Handle sticky notes
          if (stickies[uuid]) {
            const clonedSticky: StickyNote = JSON.parse(
              JSON.stringify(stickies[uuid])
            );
            newStickies.push({ uuid: uuidMapping[uuid], sticky: clonedSticky });
            continue;
          }

          const node = currentState.flowDefinition.nodes.find(
            (n) => n.uuid === uuid
          );
          const nodeUI = currentState.flowDefinition._ui.nodes[uuid];
          if (!node || !nodeUI) continue;

          const cloned: Node = JSON.parse(JSON.stringify(node));
          cloned.uuid = uuidMapping[uuid];

          for (const action of cloned.actions) {
            action.uuid = uuidMapping[action.uuid];
          }

          for (const exit of cloned.exits) {
            exit.uuid = uuidMapping[exit.uuid];
            if (exit.destination_uuid && uuidsSet.has(exit.destination_uuid)) {
              exit.destination_uuid = uuidMapping[exit.destination_uuid];
            } else {
              exit.destination_uuid = null;
            }
          }

          if (cloned.router) {
            for (const category of cloned.router.categories) {
              category.uuid = uuidMapping[category.uuid];
              category.exit_uuid = uuidMapping[category.exit_uuid];
            }
            if (cloned.router.cases) {
              for (const c of cloned.router.cases) {
                c.uuid = uuidMapping[c.uuid];
                c.category_uuid = uuidMapping[c.category_uuid];
              }
            }
            if (cloned.router.default_category_uuid) {
              cloned.router.default_category_uuid =
                uuidMapping[cloned.router.default_category_uuid];
            }
            if (cloned.router.wait?.timeout?.category_uuid) {
              cloned.router.wait.timeout.category_uuid =
                uuidMapping[cloned.router.wait.timeout.category_uuid];
            }
          }

          const clonedUI: NodeUI = JSON.parse(JSON.stringify(nodeUI));
          newNodes.push({ node: cloned, ui: clonedUI });
        }

        // Copy localization entries for duplicated actions
        const localizationCopies: Record<string, Record<string, any>> = {};
        const localization = currentState.flowDefinition.localization;
        if (localization) {
          for (const langCode of Object.keys(localization)) {
            const langEntries = localization[langCode];
            for (const oldUuid of Object.keys(uuidMapping)) {
              if (langEntries[oldUuid]) {
                if (!localizationCopies[langCode]) {
                  localizationCopies[langCode] = {};
                }
                localizationCopies[langCode][uuidMapping[oldUuid]] = JSON.parse(
                  JSON.stringify(langEntries[oldUuid])
                );
              }
            }
          }
        }

        // Mutate store
        set((state: AppState) => {
          for (const { node, ui } of newNodes) {
            state.flowDefinition.nodes.push(node);
            state.flowDefinition._ui.nodes[node.uuid] = ui;
          }

          // Add duplicated sticky notes
          if (!state.flowDefinition._ui.stickies) {
            state.flowDefinition._ui.stickies = {};
          }
          for (const { uuid, sticky } of newStickies) {
            state.flowDefinition._ui.stickies[uuid] = sticky;
          }

          // Apply localization copies
          for (const langCode of Object.keys(localizationCopies)) {
            if (!state.flowDefinition.localization[langCode]) {
              state.flowDefinition.localization[langCode] = {};
            }
            for (const [newUuid, data] of Object.entries(
              localizationCopies[langCode]
            )) {
              state.flowDefinition.localization[langCode][newUuid] = data;
            }
          }

          sortNodesByPosition(
            state.flowDefinition.nodes,
            state.flowDefinition._ui.nodes
          );

          // Don't set dirtyDate here — the caller (shift+drag) will trigger
          // the save via updateCanvasPositions once the drag completes.
        });

        return uuidMapping;
      },

      updateLocalization: (
        languageCode: string,
        actionUuid: string,
        localizationData: Record<string, any>
      ) => {
        set((state: AppState) => {
          // Initialize localization structure if it doesn't exist
          if (!state.flowDefinition.localization) {
            state.flowDefinition.localization = {};
          }

          if (!state.flowDefinition.localization[languageCode]) {
            state.flowDefinition.localization[languageCode] = {};
          }

          // Update or remove the localization for this action
          if (Object.keys(localizationData).length > 0) {
            state.flowDefinition.localization[languageCode][actionUuid] =
              localizationData;
          } else {
            // If no localized values, remove the entry
            delete state.flowDefinition.localization[languageCode][actionUuid];
          }

          // Clean up empty language sections
          if (
            Object.keys(state.flowDefinition.localization[languageCode])
              .length === 0
          ) {
            delete state.flowDefinition.localization[languageCode];
          }

          // Clean up empty localization object
          if (Object.keys(state.flowDefinition.localization).length === 0) {
            delete state.flowDefinition.localization;
          }

          state.dirtyDate = new Date();
        });
      },

      setTranslationFilters: (filters: { categories: boolean }) => {
        set((state: AppState) => {
          if (!state.flowDefinition?._ui) {
            return;
          }

          const currentFilters = state.flowDefinition._ui
            .translation_filters || {
            categories: false
          };

          const newCategories = !!filters.categories;
          if (currentFilters.categories === newCategories) {
            return;
          }

          state.flowDefinition._ui.translation_filters = {
            ...currentFilters,
            categories: newCategories
          };

          state.dirtyDate = new Date();
        });
      },

      markAutoTranslated: (
        languageCode: string,
        uuid: string,
        attributes: string[]
      ) => {
        set((state: AppState) => {
          if (!state.flowDefinition?._ui) {
            return;
          }

          if (!state.flowDefinition._ui.auto_translations) {
            state.flowDefinition._ui.auto_translations = {};
          }

          if (!state.flowDefinition._ui.auto_translations[languageCode]) {
            state.flowDefinition._ui.auto_translations[languageCode] = {};
          }

          const existing =
            state.flowDefinition._ui.auto_translations[languageCode][uuid] ||
            [];

          const merged = Array.from(
            new Set([...existing, ...(attributes || [])])
          );

          state.flowDefinition._ui.auto_translations[languageCode][uuid] =
            merged;
          state.dirtyDate = new Date();
        });
      }
    }))
  )
);

type SelectorAwareStoreApi<S extends object> = StoreApi<S> & {
  subscribe: <U>(
    selector: (state: S) => U,
    listener: (value: U, previous: U) => void
  ) => () => void;
};

/**
 * Custom Lit property decorator that binds a property to a Zustand store subscription.
 *
 * @param store - The Zustand store to subscribe to.
 * @param selector - A function selecting the slice of state to bind to the property.
 */
export function fromStore<S extends object, V = unknown>(
  store: SelectorAwareStoreApi<S>,
  selector: (state: S) => V
): PropertyDecorator {
  return (proto: any, name: string | symbol) => {
    property()(proto, name as string);

    const connectedKey = 'connectedCallback';
    const disconnectedKey = 'disconnectedCallback';

    const userConnected = proto[connectedKey];
    const userDisconnected = proto[disconnectedKey];

    proto[connectedKey] = function () {
      this._zustandUnsubscribe ??= {};
      this[name] = selector(store.getState());

      this._zustandUnsubscribe[name] = store.subscribe(selector, (val: V) => {
        this[name] = val;
      });

      if (userConnected) userConnected.call(this);
    };

    proto[disconnectedKey] = function () {
      this._zustandUnsubscribe?.[name]?.();
      if (userDisconnected) userDisconnected.call(this);
    };
  };
}
