import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPreviewProxyScript,
} from '../agents/_lib/makers/cli-dev.ts';
import { formatPreviewProgress } from '../agents/_lib/project/preview.ts';
import {
  previewDisplayPathFromPath,
  previewTrackedPathFromDisplayPath,
} from '../shared/preview-display-path.ts';
import { readCommandsWrapSource } from './helpers/fixtures.ts';
import { LIVE_TURN, PREVIEW_SURFACE, WORKSPACE, surface } from './helpers/source.ts';

test('a preview that is still starting shows the stage and then the server log', () => {
  assert.equal(formatPreviewProgress('Starting the preview server'), 'Starting the preview server');
  assert.equal(
    formatPreviewProgress('Starting the preview server', 'Running at: http://localhost:8088\n'),
    'Starting the preview server\n\nRunning at: http://localhost:8088',
  );
});

test('start_preview paints the dev server log on its own row while it boots', async () => {
  const [tool, preview, live, deployTool] = await Promise.all([
    readFile('agents/_lib/tools/preview-tools.ts', 'utf8'),
    readFile('agents/_lib/project/preview.ts', 'utf8'),
    readFile('agents/_lib/session/live.ts', 'utf8'),
    readFile('agents/_lib/tools/deploy-tools.ts', 'utf8'),
  ]);
  assert.match(tool, /onProgress: report/);
  assert.match(preview, /followSandboxLog\(context, SITE_PREVIEW_LOG/);
  assert.match(preview, /Installing dependencies|Starting the preview server/);
  assert.match(live, /keepPaintedLog/);
  assert.match(deployTool, /onProgress:/);
});

test('preview address bar shows the application route without the gateway prefix', async () => {
  const screen = await surface(WORKSPACE);

  // The address chip renders the mirrored route (previewDisplayPath) rather than
  // the raw shareablePreviewUrl host, so the sandbox domain is never shown.
  assert.match(screen, /previewDisplayPath/);
  assert.match(screen, /previewDisplayPathFromPath/);
  assert.doesNotMatch(
    screen,
    /shareablePreviewUrl\.replace/,
    'the address bar must not strip-and-display the sandbox host domain',
  );
});

test('preview address chip hides the gateway prefix and access_token', () => {
  assert.equal(previewDisplayPathFromPath(''), '/');
  assert.equal(previewDisplayPathFromPath('/preview/'), '/');
  assert.equal(
    previewDisplayPathFromPath('/preview/?access_token=sit_EopBYgXXf5X2fz2kx1gl0U5BEtTEzf240kR7BWuzCLQ'),
    '/',
  );
  assert.equal(
    previewDisplayPathFromPath('/?access_token=sit_secret'),
    '/',
  );
  assert.equal(
    previewDisplayPathFromPath('/preview/about?q=docs&access_token=sit_secret#intro'),
    '/about?q=docs#intro',
  );
  assert.equal(previewDisplayPathFromPath('/preview/blog/first-post'), '/blog/first-post');
});

// Open and copy build a deep link from the route the address bar shows, and
// `previewDeepLink` resolves that argument against the preview base — so the
// display form has to go back inside the gateway prefix first.
test('a displayed route is put back inside the gateway prefix for a deep link', () => {
  assert.equal(previewTrackedPathFromDisplayPath('/'), '/preview/');
  assert.equal(previewTrackedPathFromDisplayPath('/about'), '/preview/about');
  assert.equal(
    previewTrackedPathFromDisplayPath('/search?q=1#hit'),
    '/preview/search?q=1#hit',
  );
  assert.equal(previewTrackedPathFromDisplayPath(''), '');
  // Already tracked: adding the prefix twice would ask for a path no route has.
  assert.equal(previewTrackedPathFromDisplayPath('/preview/about'), '/preview/about');
});

test('display and tracked forms round-trip', () => {
  for (const tracked of [
    '/preview/',
    '/preview/about',
    '/preview/search?q=1#hit',
  ]) {
    assert.equal(
      previewTrackedPathFromDisplayPath(previewDisplayPathFromPath(tracked)),
      tracked,
    );
  }
});

// The address bar is a picker, not an input. A hand-typed route would let the
// pane show an address the project never declared, and turning a client-side
// navigation into a full document load is how a working SPA route 404s.
test('the preview address bar offers routes but cannot be edited', async () => {
  const source = await readFile(
    'app/features/workspace/components/preview-address-bar.tsx',
    'utf8',
  );

  assert.doesNotMatch(source, /<input/, 'the route must not be typeable');
  assert.doesNotMatch(source, /contentEditable/);
  assert.match(source, /onSelectRoute/);
  assert.doesNotMatch(source, /onSubmit|onInputChange/);
});

// The bar is one row of controls, and their order is the one a person reads:
// history, then how the preview is sized, then where it is, then what leaves.
test('the address bar orders its controls and toggles size with one button', async () => {
  const source = await readFile(
    'app/features/workspace/components/preview-address-bar.tsx',
    'utf8',
  );

  const back = source.indexOf('<ArrowLeft />');
  const forward = source.indexOf('<ArrowRight />');
  const size = source.indexOf("viewport === 'desktop' ? <Laptop /> : <Smartphone />");
  const route = source.indexOf('className="workspace-address-route"');
  const open = source.indexOf('<ExternalLink />');
  const refresh = source.indexOf('<RefreshCw />');
  for (const [name, at] of [
    ['back', back],
    ['forward', forward],
    ['size', size],
    ['route', route],
    ['open', open],
    ['refresh', refresh],
  ] as const) {
    assert.ok(at >= 0, `${name} must render`);
  }
  assert.ok(
    back < forward && forward < size && size < route && route < open && open < refresh,
    'controls must read back, forward, size, route, open, refresh',
  );

  // One size button, not a two-state switch: the icon shows the current width
  // and the label names where a click leads.
  assert.doesNotMatch(source, /aria-pressed/);
  assert.equal(source.match(/<Laptop \/>/g)?.length, 1);
  assert.equal(source.match(/<Smartphone \/>/g)?.length, 1);
  assert.match(source, /viewportHint/);

  // Open replaced copy, and refresh sits to its right.
  assert.doesNotMatch(source, /<Copy \/>|copyPath|pathCopied/);
});

// The bar shares one row with the tab strip, so it stays the narrow side of the
// pair; the route button ellipsizes instead of the bar taking more room.
test('the address bar stays narrower than the tab strip it sits beside', async () => {
  const css = await readFile('app/styles/workspace.css', 'utf8');
  const bar = css.slice(
    css.indexOf('.workspace-preview-address {'),
    css.indexOf('.workspace-preview-nav {'),
  );

  // It fills its grid track and caps itself, rather than measuring the viewport.
  // A viewport unit is what let a narrow panel ask for a wide bar and overpaint
  // the tab strip.
  assert.match(bar, /width:\s*100%/);
  const cap = /max-width:\s*(\d+)px/.exec(bar);
  assert.ok(cap, 'the bar must keep a bounded width');
  assert.ok(Number(cap[1]) <= 440, `cap is ${cap[1]}px, which crowds the tabs`);
  assert.doesNotMatch(bar, /vw\b/);
});

// The three columns have to add up at every panel width, or the bar lands on the
// tab strip. Centring takes equal side tracks, and equal tracks are only safe
// where both flanks still fit — below that the bar takes its own row.
test('the topbar centres the address bar without ever overlapping the tabs', async () => {
  const css = await readFile('app/styles/workspace.css', 'utf8');

  // Single row: equal sides put the bar on the panel's midline, with a definite
  // centre track — `auto` would size to the bar's contents and leave the route
  // field at about half the width it is allowed.
  assert.match(
    css,
    /\.workspace-topbar \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(0, 420px\) minmax\(0, 1fr\)/,
  );
  // The panel is the query container, so the breakpoint follows the panel the
  // user dragged rather than the window.
  assert.match(css, /\.workspace-result-panel \{[\s\S]*?container-type:\s*inline-size/);
  // Narrow: the bar takes a full-width second row, which is centred by
  // construction and cannot touch the tabs.
  const narrow = css.slice(css.indexOf('@container (max-width: 849px)'));
  assert.match(narrow, /'tabs actions'\s*'address address'/);
  assert.match(narrow, /\.workspace-topbar-center \{[\s\S]*?grid-area: address/);
  // Only the layout that has a bar reflows.
  assert.match(narrow, /\.workspace-topbar\.has-preview-bar/);
  assert.doesNotMatch(narrow, /\.workspace-topbar \{\s*grid-template-areas/);
  // The threshold is derived from the pieces, so it has to move with them: two
  // side tracks + the centre cap + two gaps + the bar's padding. A breakpoint
  // that under-triggers lets the strip touch the bar, which is the whole bug.
  const capPx = Number(/minmax\(0, (\d+)px\)/.exec(css)?.[1] ?? 0);
  const threshold = Number(/@container \(max-width: (\d+)px\)/.exec(css)?.[1] ?? 0);
  assert.ok(capPx > 0 && threshold > 0, 'both numbers must be declared');
  // Two side tracks (the widest tab strip each), the centre cap, the two column
  // gaps, and the bar's horizontal padding. `max-width: 849px` means the single
  // row begins at 850, so the last stacked width is the requirement minus one.
  const needed = 2 * 188 + capPx + 2 * 12 + 30;
  assert.ok(
    threshold + 1 >= needed,
    `the ${threshold + 1}px single-row start is below the ${needed}px it needs`,
  );
});

// Back and Forward are the pane's own two stacks, so the only command that ever
// reaches the frame is a navigation to a route already recorded.
test('preview navigation keeps its own history and only ever navigates', async () => {
  const [hook, history] = await Promise.all([
    readFile('app/features/workspace/hooks/use-preview-navigation.ts', 'utf8'),
    readFile('shared/preview-history.ts', 'utf8'),
  ]);

  // The stacks and the wait on top of them live in the shared module, so the
  // hook runs those rules rather than keeping a second copy of them.
  assert.match(hook, /previewNavigationBack/);
  assert.match(hook, /previewNavigationForward/);
  assert.match(history, /back: string\[\]/);
  assert.match(history, /forward: string\[\]/);
  assert.match(hook, /options\.navigate/);
  // No call statement, as opposed to the prose that explains why not.
  assert.doesNotMatch(hook, /history\.(?:back|forward)\(\);/);
});

// A listener is half a mirror. Asserting only that the parent subscribes let the
// sender go missing when the preview moved off Vite, and the address bar sat on
// the route the preview opened with for as long as the tests stayed green. So
// run the real proxy against a stub upstream and read what reaches the browser.
test('the preview proxy feeds the route mirror the parent listens for', async () => {
  const preview = await surface(PREVIEW_SURFACE);
  assert.match(preview, /__edgeonePreviewPath/);
  assert.match(preview, /addEventListener\('message'/);

  const upstream = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/asset.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript' }).end('console.log(1)');
      return;
    }
    if ((req.url || '').startsWith('/streaming')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<!DOCTYPE html><html><head><title>s</title></head><body><p>shell</p>');
      setTimeout(() => res.end('<p>late</p></body></html>'), STREAM_GAP_MS);
      return;
    }
    const body = '<!DOCTYPE html><html><head><title>t</title></head><body>home</body></html>';
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    }).end(body);
  });

  const upstreamPort = await listenOnFreePort(upstream);
  const listenPort = await reserveFreePort();
  const directory = await mkdtemp(join(tmpdir(), 'preview-proxy-'));
  const scriptPath = join(directory, 'proxy.cjs');
  await writeFile(scriptPath, buildPreviewProxyScript(listenPort, upstreamPort, '/preview'));
  const proxy = spawn(process.execPath, [scriptPath], { stdio: 'ignore' });

  try {
    const base = `http://127.0.0.1:${listenPort}`;
    await waitForServer(`${base}/preview/`);

    const home = await fetch(`${base}/preview/`, { headers: { accept: 'text/html' } });
    const html = await home.text();
    assert.match(html, /__edgeonePreviewPath/, 'the document must carry the tracker');
    // Ahead of <head> the script would precede the doctype and trip quirks mode.
    assert.match(html, /<head><script data-edgeone-preview-tracker>/);
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'the doctype must still lead');
    // The body grew, so a forwarded length would truncate the page.
    assert.equal(home.headers.get('content-length'), null);

    const asset = await fetch(`${base}/preview/asset.js`, { headers: { accept: '*/*' } });
    assert.equal(await asset.text(), 'console.log(1)', 'only HTML may be rewritten');

    // Buffering to find <head> must not swallow a body that arrives in pieces:
    // a page streaming from a Suspense boundary has to reach the browser as one.
    const streamed = await fetch(`${base}/preview/streaming`, { headers: { accept: 'text/html' } });
    assert.ok(streamed.body, 'the streamed response must carry a body');
    const reader = streamed.body.getReader();
    const arrivals: Array<{ at: number; text: string }> = [];
    const startedAt = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push({ at: Date.now() - startedAt, text: Buffer.from(value).toString() });
    }
    const shell = arrivals.find((arrival) => arrival.text.includes('shell'));
    const late = arrivals.find((arrival) => arrival.text.includes('late'));
    assert.ok(shell && late, 'both halves of the streamed page must arrive');
    assert.ok(
      late.at - shell.at > STREAM_GAP_MS / 2,
      `the shell was held back until the late chunk (shell ${shell.at}ms, late ${late.at}ms)`,
    );
    assert.match(arrivals.map((arrival) => arrival.text).join(''), /__edgeonePreviewPath/);
  } finally {
    proxy.kill();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

const STREAM_GAP_MS = 150;

function listenOnFreePort(server: http.Server) {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

// The proxy binds the port itself, so hand it one nothing else is holding.
function reserveFreePort() {
  return new Promise<number>((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(url, { headers: { accept: 'text/html' } });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`preview proxy never came up at ${url}`);
}

test('sandbox preview starts the site dev server, not makers dev', async () => {
  const preview = await readFile('agents/_lib/project/preview.ts', 'utf8');
  assert.match(preview, /buildSitePreviewLaunch/);
  assert.match(preview, /getHost\?\.\(PREVIEW_PUBLIC_PORT\)/);
  assert.match(preview, /PREVIEW_PATH_PREFIX/);
  assert.doesNotMatch(preview, /buildMakersDevLaunchCommand/);
  assert.doesNotMatch(preview, /assertMakersProjectCompatible/);
});

// The preview's contract is: start the dev server and hand back a URL. Route
// probing used to live here, and a slow boot or a broken route then surfaced to
// the user as "no preview at all". Verification is the agent's job now, against
// the local URL the tool returns.
test('preview publishes without probing generated routes', async () => {
  const [preview, readiness, previewTool, prompt] = await Promise.all([
    readFile('agents/_lib/project/preview.ts', 'utf8'),
    readFile('agents/_lib/lazy/preview.ts', 'utf8'),
    readFile('agents/_lib/tools/preview-tools.ts', 'utf8'),
    readFile('agents/_lib/prompt.ts', 'utf8'),
  ]);

  // No probe script, no route listing, no restart driven by a probe verdict.
  for (const source of [preview, readiness]) {
    assert.doesNotMatch(source, /assertGeneratedRoutesReady/);
    assert.doesNotMatch(source, /buildGenerated(Chat|Api)SmokeScript/);
    assert.doesNotMatch(source, /verifyRoutes/);
    assert.doesNotMatch(source, /previewFailureWarrantsRestart/);
  }
  assert.doesNotMatch(preview, /makersFileSemantic|CLOUD_FUNCTION_DIRECTORIES/);
  assert.doesNotMatch(preview, /smoke/i);

  // The tool hands the model the address it can actually request.
  assert.match(previewTool, /local_url/);
  assert.match(previewTool, /PREVIEW_SERVER_PORT/);
  assert.match(prompt, /verify the parts you changed yourself from inside the sandbox/);
});

// Healthy previews are still reused, and that reuse must stay a fast path: no
// probe, no model call, just the same URL minted again.
test('healthy makers-dev previews are reused on follow-up turns', async () => {
  const preview = await readFile('agents/_lib/project/preview.ts', 'utf8');
  const warmBranch = preview.match(/if \(warm\.exitCode === 0\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.ok(warmBranch, 'the warm-probe branch must stay');
  // `false`: a reused process is still serving the page the client already has,
  // so the iframe must not be remounted for it.
  assert.match(warmBranch, /return previewServerInfo\('reuse', 'vite', false\)/);
  assert.doesNotMatch(warmBranch, /assertGeneratedRoutesReady/);
  assert.match(preview, /forceRestart/);
});

test('the host does no preview work after the coding agent returns', async () => {
  const [chat, snapshot, live, apply, assemble, resume, preview, prompt] = await Promise.all([
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
    readFile('agents/_lib/project/snapshot.ts', 'utf8'),
    surface(LIVE_TURN),
    surface('app/features/workspace/hooks/use-workspace-snapshot.ts'),
    readFile('agents/_lib/tools/assemble.ts', 'utf8'),
    readFile('agents/_lib/session/resume.ts', 'utf8'),
    surface(PREVIEW_SURFACE),
    readFile('agents/_lib/prompt.ts', 'utf8'),
  ]);

  // The model owns preview, verification, and fixing inside its turn. Once the
  // SDK result is back, the host answers and persists; it does not start work
  // that would leave the conversation reading "running" after the model stopped.
  assert.doesNotMatch(chat, /startHostPreview|ensurePreview\(/);
  assert.doesNotMatch(chat, /runVerification|runAutoFixTurn/);
  assert.doesNotMatch(chat, /setLastBuild|previewLinkFromState/);
  assert.doesNotMatch(chat, /createFileTreePushController|fileTreePush/);
  assert.match(chat, /const handlePreviewReady = async/);
  assert.match(chat, /await persistWorkspace\(context, conversationId, state\)/);
  // The final snapshot lands before the result, which ends the request the
  // turn runs in; nothing is left to run after it.
  assert.doesNotMatch(chat, /void checkpoint\.flush\(\)/);
  assert.ok(
    chat.lastIndexOf('withSnapshot: true') < chat.lastIndexOf('finishResult({'),
    'the last snapshot precedes the result',
  );
  assert.doesNotMatch(assemble, /onWorkspaceReady/);
  const sessionOpen = resume.slice(resume.indexOf('export async function createProjectResumeStreamResponse'));
  assert.match(sessionOpen, /type: 'resume_history'/);
  assert.doesNotMatch(sessionOpen, /activateSandbox|ensurePreview|willRestorePreview|iterateWorkspaceResumeEvents/);
  assert.match(resume, /iterateLiveChatTaskEvents/);
  assert.doesNotMatch(resume, /&& hadPreview/);
  assert.match(preview, /revision === undefined \|\| nextPreview\.restarted/);
  assert.match(prompt, /call start_preview/);
  assert.match(snapshot, /\.\.\.\(preview\.url \? \{ preview \} : \{\}\)/);
  // A stored URL still restores the preview, and now also records that this
  // conversation published one — the fact the lazy tab boot is gated on.
  assert.match(
    apply,
    /if \(data\.preview\?\.url\) \{\s*\n[\s\S]*?preview\.applyResumedPreview\(data\.preview\);/,
  );
  assert.match(apply, /setHasPublishedPreview\(true\)/);
  assert.match(
    live,
    /if \(event\.type === 'file_changed' && event\.data\?\.paths\?\.length\) \{\s*\n\s*sawProjectActivity = true;/,
  );
});
