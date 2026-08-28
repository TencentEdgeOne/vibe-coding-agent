import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  buildMakersDeployCommand,
  formatMakersDeployFailure,
  isMakersDeployUrl,
  parseMakersDeployExitCode,
  parseMakersDeployJson,
  redactSecret,
  shellQuote,
} from '../shared/makers-deploy.ts';
import { resolveMakersProjectName } from '../agents/project/_makers-deploy.ts';
import type { ProjectState } from '../agents/_types.ts';

function projectState(sessionDir: string): ProjectState {
  return { created: true, sessionDir, appDir: `${sessionDir}/app` };
}

test('builds a non-interactive direct CLI deploy command', () => {
  const production = buildMakersDeployCommand('vibe-coding-playground');
  const preview = buildMakersDeployCommand('demo', 'edgeone makers deploy -e preview');
  assert.match(production, /edgeone makers deploy -n 'vibe-coding-playground' --json/);
  assert.match(preview, /edgeone makers deploy -n 'demo' --json -e preview/);
  assert.match(production, /MAKERS_DEPLOY_EXIT:\$deploy_status/);
  assert.match(production, /exit 0/);
});

test('parses captured direct CLI deploy exit codes', () => {
  assert.equal(parseMakersDeployExitCode('log\nMAKERS_DEPLOY_EXIT:1\n'), 1);
  assert.equal(parseMakersDeployExitCode('MAKERS_DEPLOY_EXIT:0\n'), 0);
  assert.equal(parseMakersDeployExitCode('no marker'), undefined);
});

test('parses --json success from the last JSON line', () => {
  const parsed = parseMakersDeployJson([
    '[cli] Deploying...',
    '{"status":"success","url":"https://vibe-coding-playground.edgeone.cool?eo_token=abc","projectId":"makers-1","deploymentId":"dp-1"}',
  ].join('\n'));
  assert.equal(parsed.status, 'success');
  if (parsed.status !== 'success') return;
  assert.equal(parsed.url, 'https://vibe-coding-playground.edgeone.cool?eo_token=abc');
  assert.equal(parsed.projectId, 'makers-1');
});

test('parses --json error without treating earlier log lines as the result', () => {
  const parsed = parseMakersDeployJson(
    'building...\n{"status":"error","error":"Project name conflict"}',
  );
  assert.deepEqual(parsed, {
    status: 'error',
    error: 'Project name conflict',
  });
});

test('falls back to EDGEONE_DEPLOY_URL text output', () => {
  const parsed = parseMakersDeployJson(
    '[cli][✔] Deploy Success\nEDGEONE_DEPLOY_URL=https://demo.edgeone.cool?eo_token=keep-me\n',
  );
  assert.equal(parsed.status, 'success');
  if (parsed.status !== 'success') return;
  assert.equal(parsed.url, 'https://demo.edgeone.cool?eo_token=keep-me');
});

test('detects Makers deploy hosts and rejects sandbox /preview/ URLs', () => {
  assert.equal(
    isMakersDeployUrl('https://vibe-coding-playground.edgeone.cool?eo_token=1'),
    true,
  );
  assert.equal(
    isMakersDeployUrl('https://sandbox.example.com/preview/?access_token=1'),
    false,
  );
  assert.equal(isMakersDeployUrl('not a url'), false);
});

test('redacts secrets from CLI output', () => {
  assert.equal(redactSecret('edgeone makers deploy -t secret-token --json', 'secret-token'), 'edgeone makers deploy -t [redacted] --json');
});

test('parses quota errors from CLI text when --json is missing', () => {
  const parsed = parseMakersDeployJson(
    '[cli][✘] Error creating pages project: Error: Makers project exceeds 40 limit\n',
  );
  assert.deepEqual(parsed, {
    status: 'error',
    error: 'Makers project exceeds 40 limit',
  });
});

test('formatMakersDeployFailure tells the model not to delete other projects', () => {
  const message = formatMakersDeployFailure(
    '{"status":"error","error":"Makers project exceeds 40 limit"}',
  );
  assert.match(message, /exceeds 40 limit/);
  assert.match(message, /Do not delete other Makers projects/);
});

// Both CLI commands create the project when the lookup misses, and a tenant
// token only sees what its own tenant created. A name shared between
// conversations therefore misses on lookup and collides on create — preview
// never starts, and a deploy that did start would land on another user's site.
test('each conversation owns one project, for preview and deploy alike', () => {
  const first = projectState('projects/conversation-a');
  const second = projectState('projects/conversation-b');

  const name = resolveMakersProjectName({ env: {} }, first);
  assert.match(name, /^vibe-coding-[0-9a-f]{10}$/);
  assert.notEqual(name, resolveMakersProjectName({ env: {} }, second));
  // Stable without being stored: later turns have to reach the same project.
  assert.equal(resolveMakersProjectName({ env: {} }, projectState('projects/conversation-a')), name);
  // The conversation ID ends up in a public hostname, so it is hashed first.
  assert.doesNotMatch(name, /conversation-a/);

  // An operator who names the project explicitly gets exactly that name, and
  // with it the single shared project that implies.
  const pinned = { env: { MAKERS_DEPLOY_PROJECT_NAME: 'my-site' } };
  assert.equal(resolveMakersProjectName(pinned, first), 'my-site');
  assert.equal(resolveMakersProjectName(pinned, second), 'my-site');
});

// Preview and deploy write the same .edgeone/project.json. If they disagreed
// about the name, whichever ran first would pin the link file and the other
// would either be silently ignored or repoint it mid-conversation.
test('preview and deploy resolve the project through the same function', async () => {
  const [previewSource, commandSource] = await Promise.all([
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
  ]);

  assert.match(previewSource, /resolveMakersProjectName\(context, state\)/);
  assert.match(commandSource, /resolveMakersProjectName\(lifecycle\.context, lifecycle\.state\)/);
  // One resolution per command, reused by both branches.
  assert.equal(commandSource.match(/resolveMakersProjectName\(/g)?.length, 1);
  for (const source of [previewSource, commandSource]) {
    assert.doesNotMatch(source, /vibe-coding-playground/);
  }
});

test('uses the sandbox-provided CLI without installing or prewarming it', async () => {
  const paths = [
    'shared/makers-deploy.ts',
    'agents/tools/_commands-wrap.ts',
    'agents/project/_makers-deploy.ts',
    'agents/project/_preview.ts',
    'agents/project/_scaffold.ts',
    'agents/pipelines/_chat.ts',
    'agents/pipelines/_resume.ts',
  ];
  const source = (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');

  assert.doesNotMatch(source, /npm install -g edgeone/);
  assert.doesNotMatch(source, /edgeone-cli-install/);
  assert.doesNotMatch(source, /prewarmEdgeoneCli|ensureEdgeoneCli/);
  assert.match(source, /edgeone makers deploy/);
  assert.match(source, /edgeone makers dev/);
  assert.doesNotMatch(source, /buildDeployToMakersTool|buildPublishPreviewTool/);
});
