// GET /github/config — tells the frontend whether the "Export to GitHub" button
// should render. Returns only { enabled }; never the client id or secret.
// Cloud-function (not agent): no conversation-id requirement, so a plain fetch or
// navigation reaches it. See plan/github-oauth-claim.md §5.1.
export async function onRequestGet(context: any) {
  const clientId = context?.env?.GITHUB_CLIENT_ID || '';
  return new Response(
    JSON.stringify({ enabled: Boolean(clientId) }),
    { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
