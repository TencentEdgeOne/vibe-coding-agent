import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_MAKERS_DEPLOY_PROJECT_NAME,
  buildEdgeoneCliEnsureScript,
  buildEdgeoneCliPrewarmScript,
  buildMakersPreviewVerifyScript,
  formatMakersDeployFailure,
  isMakersDeployUrl,
  parseMakersDeployJson,
  redactSecret,
  shellQuote,
} from '../shared/makers-deploy.ts';

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

test('CLI ensure script cleans leftover global installs and always exits 0', () => {
  const script = buildEdgeoneCliEnsureScript();
  assert.match(script, /edgeone-cli-install\.pid/);
  assert.match(script, /seq 1 420/);
  assert.match(script, /rm -rf "\$prefix\/lib\/node_modules\/edgeone"/);
  assert.match(script, /echo EXIT:\$status/);
  assert.match(script, /exit 0/);
});

test('CLI prewarm installs once in the background while files are generated', () => {
  const script = buildEdgeoneCliPrewarmScript();
  assert.match(script, /nohup sh -c/);
  assert.match(script, /edgeone-cli-install\.pid/);
  assert.match(script, /edgeone-cli-install\.status/);
  assert.match(script, /npm install -g edgeone@latest/);
});

test('preview verify script follows cookies and uses a browser user agent', () => {
  const script = buildMakersPreviewVerifyScript(shellQuote('https://demo.edgeone.cool?eo_token=abc'));
  assert.match(script, /-c \/tmp\/makers-cookies\.txt/);
  assert.match(script, /-b \/tmp\/makers-cookies\.txt/);
  assert.match(script, /Mozilla\/5\.0/);
  assert.match(script, /echo EXIT:2/);
});

test('CLI ensure retries timeouts and budgets more than 3 minutes', async () => {
  const source = await readFile('agents/project/_makers-deploy.ts', 'utf8');
  assert.match(source, /CLI_INSTALL_TIMEOUT_S = 420/);
  assert.match(source, /CLI_ENSURE_ATTEMPTS = 2/);
  assert.match(source, /isRetryableCliEnsureError/);
  assert.match(source, /deadline_exceeded/);
});
