import type { DeploymentInfo, PreviewKind, PreviewRoute } from '../../../shared/protocol.ts';
import { isMakersDeployUrl } from '../../../shared/makers-url.ts';
import type { PersistCapable } from '../runtime/context.ts';
import { saveProjectState } from '../session/store.ts';
import type { ProjectState } from '../types.ts';

export type PreviewPublication = {
  url: string;
  sandboxDebugUrl?: string;
  kind?: PreviewKind;
  routes?: PreviewRoute[];
};

/**
 * The only writer of ProjectState fields. Callers mutate through these
 * transitions, then persistWorkspace — saveProjectState has no other callers.
 */
export function publishPreview(state: ProjectState, preview: PreviewPublication) {
  state.previewUrl = preview.url;
  state.sandboxDebugUrl = preview.sandboxDebugUrl;
  state.previewKind = preview.kind || (isMakersDeployUrl(preview.url) ? 'makers' : 'sandbox');
  // Callers that only re-publish a URL keep the list the readiness layer
  // scanned; an explicit list (including an empty one) replaces it.
  if (preview.routes) state.previewRoutes = preview.routes;
  state.previewPublished = true;
  return state;
}

export function clearPreview(state: ProjectState) {
  state.previewUrl = undefined;
  state.sandboxDebugUrl = undefined;
  state.previewPublished = undefined;
  state.previewKind = undefined;
  state.previewRoutes = undefined;
  return state;
}

export function setDeployment(state: ProjectState, deployment: DeploymentInfo) {
  state.deployment = deployment;
  return state;
}

export function markCreated(state: ProjectState) {
  state.created = true;
  return state;
}

export function bindSiteDomain(state: ProjectState, siteDomain: string) {
  const next = siteDomain.trim();
  if (!next || state.siteDomain === next) return false;
  state.siteDomain = next;
  return true;
}

export function setGatewayPending(state: ProjectState, pending: boolean) {
  state.gatewayPromptPending = pending;
  return state;
}

export function setGatewaySkipped(state: ProjectState, skipped: boolean) {
  state.gatewaySkipped = skipped;
  if (skipped) state.gatewayPromptPending = false;
  return state;
}

export function bindMakersTenantId(state: ProjectState, tenantId: string) {
  if (!state.makersTenantId) {
    state.makersTenantId = tenantId;
  }
  return state.makersTenantId;
}

export function bindMakersApiRegion(state: ProjectState, region: 'china' | 'global') {
  state.makersApiRegion = region;
  return state;
}

/** Migrate persisted state from versions that rendered a deployment as preview. */
export function separateLegacyMakersDeployment(state: ProjectState) {
  const legacyUrl = state.previewUrl;
  if (
    !legacyUrl
    || (state.previewKind !== 'makers' && !isMakersDeployUrl(legacyUrl))
  ) {
    return state;
  }

  state.deployment ??= {
    status: 'success',
    startedAt: 0,
    finishedAt: 0,
    url: legacyUrl,
  };
  clearPreview(state);
  return state;
}

export async function persistWorkspace(
  context: PersistCapable,
  conversationId: string,
  state: ProjectState,
) {
  await saveProjectState(context, conversationId, state);
}
