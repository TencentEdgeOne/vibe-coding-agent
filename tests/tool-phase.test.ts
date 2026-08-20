import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forbiddenSandboxCommandReason,
  isInstallCommand,
  isPreviewCommand,
  isVerificationCommand,
  parseEchoedExitCode,
  shortenToolName,
  stripEchoedExit,
  withExitCodeEcho,
} from '../agents/utils/_tool-phase.ts';

test('shortens MCP tool names', () => {
  assert.equal(shortenToolName('mcp__edgeone-sandbox__files_write'), 'files_write');
  assert.equal(shortenToolName('write_project_file'), 'write_project_file');
});

test('detects install, preview, and verification commands', () => {
  assert.equal(isInstallCommand('npm install'), true);
  assert.equal(isInstallCommand('pnpm install --frozen-lockfile'), true);
  assert.equal(isInstallCommand('npm run build'), false);
  assert.equal(isPreviewCommand('npm run dev'), true);
  assert.equal(isPreviewCommand('vite dev --host'), true);
  assert.equal(isPreviewCommand('edgeone makers dev --skip-env-sync'), true);
  assert.equal(isPreviewCommand('npm run lint'), false);
  assert.equal(isPreviewCommand('npm run build'), false);
  assert.equal(isVerificationCommand('npm run build'), true);
  assert.equal(isVerificationCommand('npx tsc -b'), true);
  assert.equal(isVerificationCommand('python -m compileall .'), true);
  assert.equal(isVerificationCommand('npm install'), false);
  assert.equal(isVerificationCommand('npm run dev'), false);
});

test('appends EXIT echo to verification commands once', () => {
  assert.equal(withExitCodeEcho('npm run build'), 'npm run build; echo EXIT:$?');
  assert.equal(
    withExitCodeEcho('npx tsc -b 2>&1; echo "EXIT:$?"'),
    'npx tsc -b 2>&1; echo "EXIT:$?"',
  );
  assert.equal(withExitCodeEcho('npm install'), 'npm install');
  assert.equal(parseEchoedExitCode('error TS6133\nEXIT:1\n'), 1);
  assert.equal(parseEchoedExitCode('{"stdout":"built\\nEXIT:0\\n","exitCode":0}'), 0);
  assert.equal(stripEchoedExit('error TS6133\nEXIT:1\n'), 'error TS6133');
});

test('forbids edgeone CLI, Pages APIs, and curlrc mutations', () => {
  assert.match(
    forbiddenSandboxCommandReason('edgeone makers deploy --json') || '',
    /publish_preview/,
  );
  assert.match(
    forbiddenSandboxCommandReason('curl https://pages-api.cloud.tencent.com/v1') || '',
    /Pages APIs/,
  );
  assert.match(
    forbiddenSandboxCommandReason('cat > ~/.curlrc <<EOF') || '',
    /curl defaults/,
  );
  assert.equal(forbiddenSandboxCommandReason('npm run build'), null);
  assert.equal(forbiddenSandboxCommandReason('npm view @edgeone/pages-blob versions --json'), null);
  assert.equal(forbiddenSandboxCommandReason('ls -R node_modules/@edgeone/pages-blob'), null);
  assert.equal(forbiddenSandboxCommandReason('npm install @edgeone/pages-blob'), null);
  assert.match(
    forbiddenSandboxCommandReason('npx edgeone makers deploy --json') || '',
    /publish_preview/,
  );
  assert.match(
    forbiddenSandboxCommandReason('edgeone makers dev --skip-env-sync') || '',
    /publish_preview/,
  );
  assert.match(
    forbiddenSandboxCommandReason('curl https://ai-gateway.edgeone.link/v1/models') || '',
    /Do not probe the AI Gateway/,
  );
  assert.match(
    forbiddenSandboxCommandReason('rg model .edgeone/agent-node/server.mjs') || '',
    /Do not inspect or modify generated .edgeone/,
  );
});
