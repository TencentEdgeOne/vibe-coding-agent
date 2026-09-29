/**
 * A preview, once the sandbox is already holding the project.
 *
 * Callers that need code restored call `activateSandbox` first. What remains
 * here is: wait for the install that activation started, run `edgeone makers
 * dev` if the dev server is not already answering, then mint a public URL
 * from this request's host and token.
 */
import type { AgentContext } from '../runtime/context.ts';
import { PREVIEW_PUBLIC_PORT } from '../constants.ts';
import { isMakersDeployUrl } from '../../../shared/makers-url.ts';
import {
  previewRoutesFromFileTree,
} from '../../../shared/preview-routes.ts';
import type { PreviewKind, PreviewRoute } from '../../../shared/protocol.ts';
import type { ProjectState } from '../types.ts';
import { getFileTree } from '../project/fs.ts';
import { persistWorkspace, publishPreview } from '../project/workspace-store.ts';
import {
  assertPreviewServerReady,
  isPreviewServerReady,
  resolvePublicLinks,
  rewritePreviewAccessToken,
  startPreviewServer,
} from '../project/preview.ts';
import { withTimeout } from '../utils/timeout.ts';
import { timeStage } from '../utils/timing.ts';
import { READINESS_BUDGET_MS } from './budgets.ts';
import { once } from './inflight.ts';
import { dependenciesReady } from './sandbox.ts';

export type PreviewReadiness = {
  url?: string;
  sandboxDebugUrl?: string;
  kind?: PreviewKind;
  /** Frontend routes the address bar can offer. */
  routes?: PreviewRoute[];
  /** The dev server was (re)started, so an open iframe is pointing at a dead process. */
  restarted: boolean;
};

export type EnsurePreviewOptions = {
  /** Take down a healthy process first. For the callers that know it is stale. */
  forceRestart?: boolean;
  /** Live text for the row a person is watching. Absent callers stay quiet. */
  onProgress?: (text: string) => void;
};

function isMakersPreviewState(state: ProjectState) {
  return state.previewKind === 'makers' || isMakersDeployUrl(state.previewUrl);
}

export function ensurePreview(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  options: EnsurePreviewOptions = {},
): Promise<PreviewReadiness> {
  return once(context, `preview:${conversationId}`, () => withTimeout(
    resolvePreview(context, conversationId, state, options),
    READINESS_BUDGET_MS.preview,
    'preview',
  ));
}

async function resolvePreview(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  options: EnsurePreviewOptions,
): Promise<PreviewReadiness> {
  // A deployed preview is a Makers URL rather than a process in this sandbox.
  if (isMakersPreviewState(state) && state.previewUrl) {
    return {
      url: state.previewUrl,
      sandboxDebugUrl: state.sandboxDebugUrl,
      kind: 'makers',
      routes: state.previewRoutes,
      restarted: false,
    };
  }

  // A live server just needs a URL minted from this request's own token.
  if (!options.forceRestart && await isPreviewServerReady(context)) {
    const links = await mintPreviewLinks(context, state);
    if (links.url) {
      return publishReadyPreview(context, conversationId, state, links, false);
    }
  }

  const installed = await timeStage(
    'readiness:preview',
    { phase: 'dependencies' },
    () => dependenciesReady(context, state, { onProgress: options.onProgress }),
  );
  if (!installed) {
    throw new Error('Project dependencies are not available for the preview.');
  }

  const server = await timeStage(
    'readiness:preview',
    { phase: 'server' },
    () => startPreviewServer(context, state, {
      forceRestart: options.forceRestart,
      onProgress: options.onProgress,
    }),
  );
  await assertPreviewServerReady(context, server.readyPath);

  const links = await mintPreviewLinks(context, state);
  if (!links.url) {
    throw new Error(`The preview server is ready, but the sandbox did not return a public URL for port ${PREVIEW_PUBLIC_PORT}.`);
  }
  return publishReadyPreview(context, conversationId, state, links, server.restarted);
}

async function publishReadyPreview(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  links: { url: string; sandboxDebugUrl?: string },
  restarted: boolean,
): Promise<PreviewReadiness> {
  publishPreview(state, {
    url: links.url,
    sandboxDebugUrl: links.sandboxDebugUrl,
    kind: 'sandbox',
    // Always a fresh list, including an empty one: a project whose pages were
    // deleted must lose the entries the old tree had.
    routes: await listPreviewRoutes(context, state),
  });
  try {
    await persistWorkspace(context, conversationId, state);
  } catch {
    // The returned URL still works for this request. The next one mints again.
  }
  return {
    url: links.url,
    sandboxDebugUrl: links.sandboxDebugUrl,
    kind: 'sandbox',
    routes: state.previewRoutes,
    restarted,
  };
}

/**
 * The routes the project declares, read from the same file tree the Code pane
 * shows. A failure here is not a preview failure — the address bar falls back
 * to typing a path — so it resolves to an empty list.
 */
async function listPreviewRoutes(context: AgentContext, state: ProjectState) {
  try {
    return previewRoutesFromFileTree(await getFileTree(context, state));
  } catch {
    return [];
  }
}

async function mintPreviewLinks(context: AgentContext, state: ProjectState) {
  const links = await resolvePublicLinks(context);
  if (links.previewUrl) {
    return { url: links.previewUrl, sandboxDebugUrl: links.sandboxDebugUrl };
  }
  const token = typeof context.sandbox?.envdAccessToken === 'string'
    ? context.sandbox.envdAccessToken
    : '';
  const rewritten = state.previewUrl && token
    ? rewritePreviewAccessToken(state.previewUrl, token)
    : undefined;
  return rewritten
    ? { url: rewritten, sandboxDebugUrl: links.sandboxDebugUrl || state.sandboxDebugUrl }
    : {};
}
