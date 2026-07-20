import { getHeader, getOrigin, getQueryParam, oauthFinalizePage, oauthPopupResult } from '../../agents/utils/_request';

// GET /github/callback?code=&state=
// OAuth redirect target — a full-page GET from GitHub. Runs inside the OAuth popup.
// It does NOT do the slow work itself: it immediately returns a spinner page (so the
// popup is never blank) that POSTs code/state to /github/finalize and hands the result
// back to the opener. See oauthFinalizePage / cloud-functions/github/finalize.ts.
export async function onRequestGet(context: any) {
  const origin = getOrigin(context);
  const code = getQueryParam(context, 'code');
  const state = getQueryParam(context, 'state');
  if (!code || !state) {
    return oauthPopupResult(origin, 'github=error&reason=invalid_request');
  }
  const zh = /zh/i.test(getHeader(context, 'accept-language'));
  const label = zh ? '正在推送代码到 GitHub…' : 'Pushing your code to GitHub…';
  return oauthFinalizePage(origin, code, state, label);
}
