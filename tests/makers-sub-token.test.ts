import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildSandboxMakersEnv,
  describeMissingMakersRuntimeToken,
  ensureMakersTenantId,
  prepareSandboxGatewayEnv,
  resolveMakersMasterToken,
  resolveSandboxGatewayEnv,
  resolveSandboxMakersToken,
} from '../agents/_lib/makers/token.ts';
import { projectState } from './helpers/fixtures.ts';
import { readCommandsWrapSource } from './helpers/fixtures.ts';

test('sandbox Makers tenant IDs are generated server-side and remain stable', () => {
  const first = projectState();
  const second = projectState();
  const firstId = ensureMakersTenantId(first);

  assert.match(firstId, /^vibe-[a-f0-9]{32}$/);
  assert.equal(ensureMakersTenantId(first), firstId);
  assert.notEqual(ensureMakersTenantId(second), firstId);
  assert.ok(firstId.length <= 64);
});

// A generated store reaches production through a credential baked into the
// deployed artifact, but reaches preview through a live exchange scoped to
// PAGES_BLOB_STS_ENV. Left to the sandbox CLI's compiled default, that is what
// makes a guestbook read fine on the live site and fail in preview with
// "credential exchange failed (code=-1): Invalid credential".
test('the sandbox is handed the credential and the storage environment', () => {
  assert.deepEqual(buildSandboxMakersEnv('tenant-token'), {
    PAGES_SOURCE: 'skills',
    EDGEONE_PAGES_API_TOKEN: 'tenant-token',
    PAGES_BLOB_STS_ENV: 'prod',
  });
  assert.deepEqual(buildSandboxMakersEnv('tenant-token', 'china'), {
    PAGES_SOURCE: 'skills',
    EDGEONE_PAGES_API_TOKEN: 'tenant-token',
    EDGEONE_PAGES_API_REGION: 'china',
    PAGES_BLOB_STS_ENV: 'prod',
  });
  assert.deepEqual(buildSandboxMakersEnv(), {
    PAGES_SOURCE: 'skills',
    PAGES_BLOB_STS_ENV: 'prod',
  });
});

test('parent runtime gateway values are not written into the generated tree', async () => {
  const files = new Map<string, string>([
    ['projects/demo/app/.env.example', 'APP_TITLE=Demo\nAI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n'],
  ]);
  const context = {
    env: {
      AI_GATEWAY_API_KEY: 'parent-key',
      AI_GATEWAY_BASE_URL: 'https://ai-gateway.edgeone.link/v1',
    },
    sandbox: {
      files: {
        read: async (target: string) => {
          const content = files.get(target);
          if (content == null) throw new Error('File does not exist.');
          return content;
        },
        write: async (target: string, content: string) => {
          files.set(target, content);
        },
        remove: async (target: string) => {
          files.delete(target);
        },
      },
    },
  };

  assert.deepEqual(resolveSandboxGatewayEnv(context), {
    AI_GATEWAY_API_KEY: 'parent-key',
    AI_GATEWAY_BASE_URL: 'https://ai-gateway.edgeone.link/v1',
  });

  const gateway = await prepareSandboxGatewayEnv(context, projectState());
  assert.deepEqual(gateway, {});
  assert.equal(
    files.get('projects/demo/app/.env.example'),
    'APP_TITLE=Demo\nAI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
  );
  assert.equal(files.has('projects/demo/app/.env'), false);
});

test('the runtime credential is read from API_TOKEN', () => {
  assert.equal(resolveMakersMasterToken({ env: { API_TOKEN: '  abc  ' } }), 'abc');
  // The CLI still consumes EDGEONE_PAGES_API_TOKEN inside the sandbox. That is
  // a different name on a different process, not an alias for the runtime key.
  assert.equal(resolveMakersMasterToken({ env: { EDGEONE_PAGES_API_TOKEN: 'old' } }), '');
  assert.equal(resolveMakersMasterToken({ env: {} }), '');
});

// The token issuer and the sandbox CLI verify against separate hosts, and a
// switch that moves only one of them surfaces as a bare "Your token is not
// valid" with nothing pointing at the split. Both ends default to production,
// so the way to keep them together is to leave nothing to configure.
test('no environment switch is left for a deployment to get wrong', async () => {
  const tokenSource = await readFile('agents/_lib/makers/token.ts', 'utf8');

  for (const name of [
    'MAKERS_API_ENV',
    'MAKERS_API_REGION',
    'MAKERS_SUB_TOKEN_TTL_SECONDS',
  ]) {
    assert.doesNotMatch(tokenSource, new RegExp(name), `${name} must not come back`);
  }
  // Region is probed by the SDK, then copied into the sandbox so the CLI can
  // pick a CAPI host. It is never an operator-facing switch.
  assert.doesNotMatch(tokenSource, /pickEnvValue\(context, 'EDGEONE_PAGES_API_REGION'\)/);
  assert.match(tokenSource, /EDGEONE_PAGES_API_REGION: region/);
  assert.match(tokenSource, /client\.region/);
  assert.doesNotMatch(tokenSource, /baseUrl/);
  assert.match(tokenSource, /new Makers\(\{ token: masterToken \}\)/);
  assert.doesNotMatch(tokenSource, /resolveMakersPublishTarget/);
});

// "…tenant token: Automatic region detection failed." trips the activity
// scrubber, which blanks whatever follows a "token:" label and leaves the
// operator staring at "[REDACTED] region detection failed."
test('token issue failures survive the activity scrubber', async () => {
  const tokenSource = await readFile('agents/_lib/makers/token.ts', 'utf8');
  const messages = tokenSource.match(/Failed to issue a temporary Makers[^`]*/g) || [];

  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.doesNotMatch(message, /token\s*[:=]/i);
  }
});

test('a sandbox CLI login failure names the runtime key, not a browser login', () => {
  const rewritten = describeMissingMakersRuntimeToken(
    'You are not authenticated, and browser login is unavailable in a non-interactive environment.\n'
    + 'Please provide a token via `-t <token>` or set the EDGEONE_PAGES_API_TOKEN environment variable.',
  );

  assert.match(rewritten, /Missing API_TOKEN in the Agent Runtime/);
  assert.doesNotMatch(rewritten, /token\s*[:=]/i);
  assert.equal(describeMissingMakersRuntimeToken('edgeone makers dev bound port 8090'), '');
});

// The master credential is the one thing the sandbox must never hold: it is
// account-wide and long-lived, while a CLI process is neither.
test('the master credential is exchanged, never handed to the sandbox', async () => {
  const tokenSource = await readFile('agents/_lib/makers/token.ts', 'utf8');
  const resolver = tokenSource.match(
    /export async function resolveSandboxMakersToken[\s\S]*?\n}/,
  )?.[0] || '';

  assert.ok(resolver, 'the resolver must stay the single entry point');
  assert.match(resolver, /issueSandboxMakersSubToken\(state, masterToken\)/);
  assert.doesNotMatch(
    resolver,
    /return masterToken/,
    'no branch may pass the master credential through to the CLI',
  );
  // No opt-in left: a switch here is a switch that can be left in the wrong
  // position on a deployment nobody is watching.
  assert.doesNotMatch(tokenSource, /MAKERS_SANDBOX_TENANT_TOKEN/);

  // Nothing configured to exchange stays an empty injection, not an exchange
  // that throws: the CLI reports the missing credential better than we can.
  const state = projectState();
  assert.equal(await resolveSandboxMakersToken(state, ''), '');
  assert.equal(state.makersTenantId, undefined);
});

test('the tenant token is redacted out of CLI output', async () => {
  const [previewSource, commandSource] = await Promise.all([
    readFile('agents/_lib/project/preview.ts', 'utf8'),
    readCommandsWrapSource(),
  ]);

  assert.doesNotMatch(previewSource, /sandboxToken/);
  assert.match(commandSource, /redactToolResult\(result, makers\.sandboxToken\)/);
});

test('direct CLI calls route the runtime credential through one resolver', async () => {
  const [tokenSource, previewSource, commandSource, sessionSource, packageSource] = await Promise.all([
    readFile('agents/_lib/makers/token.ts', 'utf8'),
    readFile('agents/_lib/project/preview.ts', 'utf8'),
    readCommandsWrapSource(),
    readFile('agents/_lib/makers/session.ts', 'utf8'),
    readFile('package.json', 'utf8'),
  ]);

  assert.match(tokenSource, /\.tokens\.create\(\{/);
  assert.match(tokenSource, /tenantId/);
  assert.match(tokenSource, /expiresIn/);
  // Resume starts Makers dev without an LLM command, while normal preview and
  // deploy calls are intercepted on the generic sandbox commands tool. Neither
  // may reach past the resolver for a credential of its own.
  assert.match(sessionSource, /resolveSandboxMakersToken\(state, masterToken\)/);
  assert.match(sessionSource, /prepareSandboxGatewayEnv\(context, state\)/);
  assert.match(sessionSource, /buildSandboxMakersEnv\(sandboxToken, state\.makersApiRegion\)/);
  assert.doesNotMatch(sessionSource, /buildSandboxMakersEnv\([^)]*gateway/);
  assert.doesNotMatch(previewSource, /prepareMakersSession/);
  assert.doesNotMatch(previewSource, /API_TOKEN/);
  assert.match(commandSource, /prepareMakersSession\(lifecycle\.context, lifecycle\.state/);
  assert.match(commandSource, /pauseForGatewayCredentialsIfNeeded/);
  assert.doesNotMatch(previewSource, /buildSandboxMakersEnv\([^)]*gateway/);
  assert.doesNotMatch(commandSource, /buildSandboxMakersEnv\([^)]*gateway/);
  assert.doesNotMatch(tokenSource, /\.\.\.gateway/);
  for (const source of [previewSource, commandSource]) {
    assert.doesNotMatch(source, /issueSandboxMakersSubToken/);
  }
  assert.doesNotMatch(commandSource, /makers deploy[^\n]* -t /);

  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.dependencies['@edgeone/makers-sdk'], '0.1.0');
});
