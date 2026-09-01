import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import {
  SMOKE_EXIT,
  buildGeneratedApiSmokeScript,
  buildGeneratedChatSmokeScript,
} from '../shared/makers-dev.ts';

test('preview address bar shows the application route without the gateway prefix', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  // The address chip renders the mirrored route (previewDisplayPath) rather than
  // the raw shareablePreviewUrl host, so the sandbox domain is never shown.
  assert.match(screen, /previewDisplayPath/);
  assert.doesNotMatch(
    screen,
    /shareablePreviewUrl\.replace/,
    'the address bar must not strip-and-display the sandbox host domain',
  );
  // Public previews carry /preview/, while the address bar presents paths
  // relative to the generated application root.
  assert.match(screen, /function previewDisplayPathFromPath/);
  assert.match(screen, /if \(!path\) return '\/';/);
  assert.match(screen, /path\.startsWith\(PREVIEW_PATH_PREFIX\)/);
});

test('parent listens for the preview route posted by the injected tracker', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  assert.match(screen, /__edgeonePreviewPath/);
  assert.match(screen, /addEventListener\('message'/);
});

test('sandbox preview strips the public prefix before forwarding to makers-dev', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  const makersDev = await readFile('shared/makers-dev.ts', 'utf8');
  assert.match(preview, /makers-dev/);
  assert.match(preview, /buildMakersDevLaunchCommand/);
  assert.match(preview, /assertMakersProjectCompatible/);
  assert.match(preview, /getHost\(PREVIEW_PUBLIC_PORT\)/);
  assert.match(makersDev, /edgeone makers dev/);
  assert.match(makersDev, /skip-env-sync/);
  assert.match(makersDev, /buildPreviewProxyScript/);
  assert.match(makersDev, /server\.on\('upgrade'/);
  assert.match(preview, /PREVIEW_PATH_PREFIX/);
  assert.doesNotMatch(preview, /python3 -m http\.server/);
});

test('agent chat previews are smoke-tested before being published', async () => {
  const [preview, makersDev] = await Promise.all([
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('shared/makers-dev.ts', 'utf8'),
  ]);
  assert.match(preview, /assertGeneratedAgentChatReady/);
  assert.match(preview, /buildGeneratedChatSmokeScript/);
  assert.match(makersDev, /Generated \/chat endpoint returned an SSE error event/);
  assert.match(makersDev, /DONE/);
  // A fixed id would accumulate history in the generated app's own store, so
  // every later probe would pay for a longer prompt and get a less predictable
  // reply to assert on.
  assert.match(preview, /preview-smoke-\$\{Date\.now\(\)/);
  assert.doesNotMatch(preview, /makers-conversation-id: preview-smoke-test/);
});

function startStubChatServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  return new Promise<{ server: http.Server; port: number }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

function runShell(script: string) {
  return new Promise<number>((resolve) => {
    execFile('sh', ['-c', script], { timeout: 120_000 }, (error) => {
      resolve(typeof error?.code === 'number' ? error.code : 0);
    });
  });
}

function endSse(res: http.ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(body);
}

const HEALTHY_STREAM = 'data: {"type":"ai_response","content":"OK"}\n\ndata: [DONE]\n\n';

// The smoke test decides whether a failing preview gets its dev server restarted,
// so the exit code it picks is load-bearing rather than cosmetic.
test('the chat smoke script separates a rebuilding server from a broken reply', async () => {
  const cases: Array<{ name: string; expected: number; handler: http.RequestListener }> = [
    {
      name: 'healthy stream',
      expected: 0,
      handler: (_req, res) => endSse(res, HEALTHY_STREAM),
    },
    {
      // makers dev answers 502 while it rebuilds the agent worker after a save.
      // Retrying costs one sleep; failing here costs a restart and a second probe.
      name: '502 once, then healthy',
      expected: 0,
      handler: (() => {
        let seen = 0;
        return (_req: http.IncomingMessage, res: http.ServerResponse) => {
          seen += 1;
          if (seen === 1) {
            res.writeHead(502).end('Bad Gateway');
            return;
          }
          endSse(res, HEALTHY_STREAM);
        };
      })(),
    },
    {
      name: 'never a 200',
      expected: SMOKE_EXIT.transport,
      handler: (_req, res) => {
        res.writeHead(502).end('Bad Gateway');
      },
    },
    {
      // A stream that arrives over 200 proves the server and proxy work, so the
      // fault is the generated agent's and a restart would only delay the news.
      name: '200 without the [DONE] terminator',
      expected: SMOKE_EXIT.application,
      handler: (_req, res) => endSse(res, 'data: {"type":"ai_response","content":"OK"}\n\n'),
    },
    {
      name: '200 carrying an SSE error event',
      expected: SMOKE_EXIT.application,
      handler: (_req, res) => endSse(res, 'data: {"type":"error","error":"boom"}\n\ndata: [DONE]\n\n'),
    },
  ];

  // Each case owns its stub server and its own shell, and two of them have to sit
  // through the retry sleeps, so run them at once rather than adding up the waits.
  const results = await Promise.all(cases.map(async (testCase) => {
    const { server, port } = await startStubChatServer(testCase.handler);
    try {
      const script = buildGeneratedChatSmokeScript({
        endpoint: `http://127.0.0.1:${port}/preview/chat`,
        payload: JSON.stringify({ message: 'Reply with OK.' }),
        conversationId: 'preview-smoke-test-run',
        retrySleepSeconds: 0,
      });
      return { name: testCase.name, expected: testCase.expected, actual: await runShell(script) };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));

  for (const result of results) {
    assert.equal(result.actual, result.expected, result.name);
  }
});

// Cloud functions have no other functional gate: assertPreviewServerReady only
// proves the proxy and the home page answer. The probe therefore has to be narrow
// enough that a route answering 401 or 405 to an anonymous GET is not a failure.
test('the API route probe only fails on server errors and hangs', async () => {
  const answer = (code: number): http.RequestListener => (_req, res) => {
    res.writeHead(code, { 'content-type': 'application/json' }).end('{}');
  };
  const cases: Array<{
    name: string;
    expected: number;
    routes: string[];
    handler: http.RequestListener;
  }> = [
    { name: '200', expected: 0, routes: ['/api/messages'], handler: answer(200) },
    { name: '301 redirect', expected: 0, routes: ['/api/messages'], handler: answer(301) },
    { name: '401 auth required', expected: 0, routes: ['/api/messages'], handler: answer(401) },
    { name: '404 not mounted for GET', expected: 0, routes: ['/api/messages'], handler: answer(404) },
    { name: '405 POST-only endpoint', expected: 0, routes: ['/api/messages'], handler: answer(405) },
    {
      name: '500 on every attempt',
      expected: SMOKE_EXIT.application,
      routes: ['/api/messages'],
      handler: answer(500),
    },
    {
      name: '500 once, then 200',
      expected: 0,
      routes: ['/api/messages'],
      handler: (() => {
        let seen = 0;
        return (_req: http.IncomingMessage, res: http.ServerResponse) => {
          seen += 1;
          res.writeHead(seen === 1 ? 500 : 200, { 'content-type': 'application/json' }).end('{}');
        };
      })(),
    },
    {
      name: 'one healthy route and one broken one',
      expected: SMOKE_EXIT.application,
      routes: ['/api/ok', '/api/broken'],
      handler: (req, res) => {
        const code = (req.url || '').includes('/api/broken') ? 500 : 200;
        res.writeHead(code, { 'content-type': 'application/json' }).end('{}');
      },
    },
  ];

  const results = await Promise.all(cases.map(async (testCase) => {
    const { server, port } = await startStubChatServer(testCase.handler);
    try {
      const script = buildGeneratedApiSmokeScript({
        baseUrl: `http://127.0.0.1:${port}/preview`,
        routes: testCase.routes,
        retrySleepSeconds: 0,
      });
      return {
        name: testCase.name,
        expected: testCase.expected,
        actual: await runShell(script),
      };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));

  for (const result of results) {
    assert.equal(result.actual, result.expected, result.name);
  }
});

// The behavioural tests above build their scripts with a zero pause, which is the
// one thing about the retry they cannot then observe. Production waits.
test('probes really pause between attempts outside the tests', () => {
  const chat = buildGeneratedChatSmokeScript({
    endpoint: 'http://127.0.0.1:3000/preview/chat',
    payload: '{}',
    conversationId: 'preview-smoke-default',
  });
  const api = buildGeneratedApiSmokeScript({
    baseUrl: 'http://127.0.0.1:3000/preview',
    routes: ['/api/messages'],
  });

  assert.match(chat, /sleep 2;/);
  assert.match(api, /sleep 2;/);
});

test('only static routes are probed, and they come from the shared route mapping', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');

  // Reuse the mapping the Files panel shows rather than a second copy of the
  // cloud-functions path rules.
  assert.match(preview, /makersFileSemantic\(\{ path, type: 'file' \}\)/);
  // /api/:id has no id to invent, and a wildcard says nothing about what is
  // mounted underneath it.
  assert.match(preview, /!route\.includes\(':'\)/);
  assert.match(preview, /!route\.includes\('\*'\)/);
});

test('a preview publish never probes the generated agent twice in a row', async () => {
  const [preview, wrap] = await Promise.all([
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
  ]);

  // Each probe is a real model call against the generated agent, so the publish
  // that follows a restart trusts the check the restart already ran.
  assert.match(preview, /if \(!options\.routesAlreadyVerified\) \{/);
  assert.match(wrap, /if \(!previewFailureWarrantsRestart\(error\)\) throw error;/);
  assert.match(wrap, /routesAlreadyVerified: true/);
});

test('healthy makers-dev previews are reused on follow-up turns', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  const warmBranch = preview.match(/if \(warm\.exitCode === 0\) \{[\s\S]*?\n  \}/)?.[0] || '';

  assert.ok(warmBranch, 'the warm-probe branch must stay');
  assert.match(warmBranch, /await assertGeneratedRoutesReady\(context, state\)/);
  assert.match(warmBranch, /return previewServerInfo\(launchCommand\)/);
  // A warm port that never answers is a stale server, so the next turn restarts
  // it instead of publishing a preview nobody can load. One that answers in the
  // wrong shape is a generated-code bug, and that reply is itself proof the
  // server works, so the restart is skipped and the failure reported as-is.
  assert.match(warmBranch, /if \(!previewFailureWarrantsRestart\(error\)\) throw error;/);
  assert.match(warmBranch, /forceRestart = true/);
});

test('cold preview probes do not throw on curl connection refused', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  assert.match(preview, /probePreviewReadyCommand/);
  assert.match(preview, /runCommandCapturingExit/);
  assert.match(preview, /set \+e/);
  assert.match(preview, /echo EXIT:\$\?/);
});

test('expired preview credentials never fall back to the stale iframe URL', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  assert.match(screen, /PREVIEW_CREDENTIAL_REFRESH_MS/);
  assert.match(screen, /isMakersPreviewRef/);
  assert.match(screen, /setPreviewRefreshFailed\(true\)/);
  assert.match(screen, /previewUnavailable/);
  assert.doesNotMatch(
    screen,
    /setActivePreviewUrl\(previousActiveUrl\)/,
    'a failed credential remint must not reveal the gateway auth response',
  );
  assert.doesNotMatch(
    screen,
    /reload the current iframe src \(same token\)/,
    'manual refresh must not retry an expired access token',
  );
});
