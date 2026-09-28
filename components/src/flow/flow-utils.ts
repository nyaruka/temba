import { zustand } from '../store/AppState';

/**
 * Canonical flow types, keyed by the type names used in flow definitions.
 */
const DEFINITION_FLOW_TYPES: { [type: string]: string } = {
  messaging: 'messaging',
  messaging_background: 'messaging_background',
  messaging_offline: 'messaging_offline',
  voice: 'voice'
};

/**
 * Canonical flow types, keyed by the type names used by the flows endpoint.
 */
const API_FLOW_TYPES: { [type: string]: string } = {
  message: 'messaging',
  background: 'messaging_background',
  survey: 'messaging_offline',
  voice: 'voice'
};

/**
 * Excludes flows which the engine wouldn't let us enter from the flow being
 * edited. A session can only enter a flow of its own type, except for
 * background flows which can never wait and so are enterable from anywhere.
 */
export function shouldExcludeFlow(flow: any): boolean {
  const definition = zustand.getState().flowDefinition;
  if (!definition) return false;

  const currentType = DEFINITION_FLOW_TYPES[definition.type];
  const candidateType = API_FLOW_TYPES[flow?.type];

  // if either side is a type we don't know about, leave the flow visible
  if (!currentType || !candidateType) return false;

  return (
    currentType !== candidateType && candidateType !== 'messaging_background'
  );
}

export type LLMRole = 'translation' | 'generation' | 'classification';

export interface LLMModel {
  uuid: string;
  name: string;
  type?: string;
  description?: string;
  roles?: LLMRole[];
}

export function hasLLMRole(
  model: { roles?: string[] } | null | undefined,
  role: LLMRole
): boolean {
  return model?.roles?.includes(role) ?? false;
}
