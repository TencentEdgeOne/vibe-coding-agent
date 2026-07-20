import { saveGithubNonce } from '../../agents/_memory';
import { getHeader, getOrigin, getQueryParam, oauthPopupResult, oauthRedirectPage } from '../../agents/utils/_request';

// GET /github/start?cid=<conversationId>
// Cloud-function (plan/github-oauth-claim.md §5.2): generates a CSRF nonce, stores
// it on the conversation, and 302-redirects to the GitHub OAuth authorize page.
// Runs as a cloud-function — not an agent — so a full-page navigation (which can't
// set the makers-conversation-id header agent endpoints demand) reaches it.
export async function onRequestGet(context: any) {
  const origin = getOrigin(context);
  // Errors here surface inside the OAuth popup, so report them back to the opener the
  // same way the callback does (postMessage + close) instead of navigating the popup.
  const fail = (reason: string) => oauthPopupResult(origin, `github=error&reason=${reason}`);

  const clientId = context?.env?.GITHUB_CLIENT_ID || '';
  if (!clientId) {
    return fail('not_configured');
  }

  const cid = getQueryParam(context, 'cid');
  if (!cid) {
    return fail('missing_cid');
  }

  // Cloud-functions read the conversation store via context.agent.store (same data
  // as the agent runtime's context.store). Shim it so the shared _memory helpers work.
  const mem = { store: context.agent?.store ?? context.store };
  const nonce = generateNonce();
  await saveGithubNonce(mem, cid, { nonce, ts: Date.now() });

  const redirectUri = context?.env?.GITHUB_OAUTH_REDIRECT_URI || `${origin}/github/callback`;
  const authorizeUrl = 'https://github.com/login/oauth/authorize'
    + `?client_id=${encodeURIComponent(clientId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + '&scope=repo'
    + `&state=${encodeURIComponent(`${cid}:${nonce}`)}`
    + '&allow_signup=true';

  // Show a spinner in the popup while it hops to GitHub, instead of a blank 302.
  const zh = /zh/i.test(getHeader(context, 'accept-language'));
  return oauthRedirectPage(authorizeUrl, zh ? '正在连接 GitHub…' : 'Connecting to GitHub…');
}

function generateNonce(): string {
  const cryptoObj = (globalThis as any).crypto;
  if (cryptoObj?.randomUUID) {
    return String(cryptoObj.randomUUID()).replace(/-/g, '');
  }
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${(Date.now() * 7).toString(16)}`;
}
