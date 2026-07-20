import { clearGithubNonce, getGithubNonce, getHistory, getProjectSnapshot } from '../../agents/_memory';
import {
  createRepoWithRetry,
  decompressSnapshot,
  exchangeCodeForToken,
  getAuthenticatedUser,
  pushFilesAsCommit,
} from '../../agents/utils/_github';
import { getOrigin, getQueryParam } from '../../agents/utils/_request';

const NONCE_TTL_MS = 10 * 60 * 1000;

const json = (obj: unknown) =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

// POST /github/finalize  { code, state }
// The slow half of the OAuth claim, split out of /github/callback so the popup can
// show a spinner while this runs (see oauthFinalizePage in agents/utils/_request.ts).
// Validates the CSRF nonce, exchanges the code for a token, reads the persisted
// project snapshot (metadata — never the sandbox), unpacks it, creates a repo, and
// pushes it as a single commit via the Git Data API. Returns JSON {ok, repo?|reason?}.
export async function onRequestPost(context: any) {
  const origin = getOrigin(context);
  const mem = { store: context.agent?.store ?? context.store };

  const body = await context.request?.json?.().catch(() => null) ?? null;
  const code = String(body?.code || getQueryParam(context, 'code') || '');
  const state = String(body?.state || getQueryParam(context, 'state') || '');
  if (!code || !state) {
    return json({ ok: false, reason: 'invalid_request' });
  }

  const sep = state.indexOf(':');
  const cid = sep > 0 ? state.slice(0, sep) : '';
  const nonce = sep > 0 ? state.slice(sep + 1) : '';
  if (!cid || !nonce) {
    return json({ ok: false, reason: 'invalid_request' });
  }

  // Validate the CSRF nonce (one-shot, short TTL), then clear it.
  const stored = await getGithubNonce(mem, cid);
  if (!stored || stored.nonce !== nonce) {
    return json({ ok: false, reason: 'state_mismatch' });
  }
  if (Date.now() - stored.ts > NONCE_TTL_MS) {
    await clearGithubNonce(mem, cid);
    return json({ ok: false, reason: 'state_expired' });
  }
  await clearGithubNonce(mem, cid);

  const clientId = context?.env?.GITHUB_CLIENT_ID || '';
  const clientSecret = context?.env?.GITHUB_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    return json({ ok: false, reason: 'not_configured' });
  }

  let phase: 'token' | 'snapshot' | 'repo' | 'push' = 'token';
  try {
    const redirectUri = context?.env?.GITHUB_OAUTH_REDIRECT_URI || `${origin}/github/callback`;
    const token = await exchangeCodeForToken({ clientId, clientSecret, code, redirectUri });

    // Code comes only from the persisted snapshot (metadata). No sandbox fallback:
    // a missing snapshot means persistence failed and should surface, not hide.
    phase = 'snapshot';
    const snapshot = await getProjectSnapshot(mem, cid);
    if (!snapshot?.base64) {
      return json({ ok: false, reason: 'not_ready' });
    }

    const isTar = snapshot.filename.endsWith('.tar.gz') || snapshot.contentType === 'application/gzip';
    const files = decompressSnapshot(snapshot.base64, isTar);
    if (!files.length) {
      return json({ ok: false, reason: 'not_ready' });
    }

    const { login } = await getAuthenticatedUser(token);
    phase = 'repo';
    const repoName = buildRepoName(cid);
    const repo = await createRepoWithRetry(token, login, repoName);

    phase = 'push';
    const message = await buildCommitMessage(mem, cid);
    await pushFilesAsCommit({
      token,
      owner: repo.owner,
      repo: repo.name,
      files,
      message,
      branch: repo.defaultBranch,
    });

    return json({ ok: true, repo: repo.htmlUrl });
  } catch (error: any) {
    // Server-side diagnostics only (appears in the cloud-function logs, never sent to
    // the client). error.body is GitHub's JSON response (see _github.ts:ghRequest) —
    // it holds message/documentation_url, never the token or client_secret.
    console.error('[github/finalize] failed', {
      phase,
      status: error?.status,
      message: error?.message,
      body: error?.body,
    });
    // Never leak the token/secret — only a coarse, phase-derived reason.
    const nameExists = error?.status === 422
      && /already exists|name already/i.test(String(error?.message || ''));
    const reason = phase === 'token'
      ? 'token_exchange_failed'
      : phase === 'repo' && nameExists
        ? 'repo_exists'
        : 'push_failed';
    return json({ ok: false, reason });
  }
}

// Repo name derived from the conversation id: GitHub allows [A-Za-z0-9._-].
function buildRepoName(cid: string): string {
  const slug = cid.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'project';
  return `vibe-coding-${slug}`;
}

// Use the first user prompt as the commit message when available; else a default.
async function buildCommitMessage(mem: { store: any }, cid: string): Promise<string> {
  try {
    const history = await getHistory(mem, cid);
    const firstUser = history.find((m) => m.role === 'user')?.content?.trim();
    if (firstUser) {
      const oneLine = firstUser.replace(/\s+/g, ' ').slice(0, 72);
      return `Initial commit: ${oneLine}`;
    }
  } catch {
    // Fall through to default.
  }
  return 'Initial commit from Vibe Coding Agent';
}
