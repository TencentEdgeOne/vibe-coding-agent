import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildSandboxMakersEnv,
  ensureMakersTenantId,
  resolveMakersEndpoint,
  resolveMakersSubTokenTtl,
  resolveSandboxMakersToken,
} from '../agents/project/_makers-token.ts';
import type { ProjectState } from '../agents/_types.ts';

function projectState(): ProjectState {
  return {
    created: true,
    sessionDir: 'projects/test',
    appDir: 'projects/test/app',
  };
}

test('sandbox Makers tenant IDs are generated server-side and remain stable', () => {
  const first = projectState();
  const second = projectState();
  const firstId = ensureMakersTenantId(first);

  assert.match(firstId, /^vibe-[a-f0-9]{32}$/);
  assert.equal(ensureMakersTenantId(first), firstId);
  assert.notEqual(ensureMakersTenantId(second), firstId);
  assert.ok(firstId.length <= 64);
});

test('temporary token TTL defaults to one hour and rejects unsafe ranges', () => {
  assert.equal(resolveMakersSubTokenTtl({ env: {} }), 3600);
  assert.equal(resolveMakersSubTokenTtl({
    env: { MAKERS_SUB_TOKEN_TTL_SECONDS: '1800' },
  }), 1800);
  assert.throws(
    () => resolveMakersSubTokenTtl({
      env: { MAKERS_SUB_TOKEN_TTL_SECONDS: '30' },
    }),
    /between 900 and 86400/,
  );
});

test('production stays on the endpoints both ends already default to', () => {
  assert.deepEqual(resolveMakersEndpoint({ env: {} }), {
    apiEnv: 'prod',
    region: '',
    baseUrl: '',
  });
  assert.deepEqual(buildSandboxMakersEnv({ env: {} }, 'tenant-token'), {
    PAGES_SOURCE: 'skills',
    EDGEONE_PAGES_API_TOKEN: 'tenant-token',
  });
  assert.deepEqual(buildSandboxMakersEnv({ env: {} }), {
    PAGES_SOURCE: 'skills',
  });
});

// The token issuer and the sandbox CLI verify against separate hosts. When only
// one of them is switched, the sandbox reports a bare "Your token is not valid"
// with nothing pointing at the split, so a single variable has to move both.
test('a non-production environment moves the issuer and the sandbox together', () => {
  const testContext = { env: { MAKERS_API_ENV: 'test' } };
  assert.deepEqual(resolveMakersEndpoint(testContext), {
    apiEnv: 'test',
    region: 'china',
    baseUrl: 'https://eo-test.qcloud.com/v1',
  });
  assert.deepEqual(buildSandboxMakersEnv(testContext, 'tenant-token'), {
    PAGES_SOURCE: 'skills',
    EDGEONE_PAGES_API_TOKEN: 'tenant-token',
    API_ENV: 'test',
    EDGEONE_PAGES_API_REGION: 'china',
  });

  // Hosts mirror the CLI's own URL tables. A china test credential sent to the
  // global test host comes back as "The Token usage region is incorrect", so
  // the region has to be pinned rather than left to the CLI's own detection.
  assert.equal(
    resolveMakersEndpoint({
      env: { MAKERS_API_ENV: 'test', MAKERS_API_REGION: 'global' },
    }).baseUrl,
    'https://test-api.edgeone.ai/v1',
  );
  assert.equal(
    resolveMakersEndpoint({ env: { MAKERS_API_ENV: 'pre' } }).baseUrl,
    'https://pre-api.edgeone.ai/v1',
  );
  assert.equal(
    resolveMakersEndpoint({
      env: { MAKERS_API_ENV: 'prod', MAKERS_API_REGION: 'china' },
    }).baseUrl,
    'https://pages-api.cloud.tencent.com/v1',
  );
});

test('unknown environment and region values fail before a token is minted', () => {
  assert.throws(
    () => resolveMakersEndpoint({ env: { MAKERS_API_ENV: 'staging' } }),
    /prod, pre, test/,
  );
  assert.throws(
    () => resolveMakersEndpoint({ env: { MAKERS_API_REGION: 'apac' } }),
    /china or global/,
  );
});

// "…tenant token: Automatic region detection failed." trips the activity
// scrubber, which blanks whatever follows a "token:" label and leaves the
// operator staring at "[REDACTED] region detection failed."
test('token issue failures survive the activity scrubber', async () => {
  const tokenSource = await readFile('agents/project/_makers-token.ts', 'utf8');
  const messages = tokenSource.match(/Failed to issue a temporary Makers[^`]*/g) || [];

  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.doesNotMatch(message, /token\s*[:=]/i);
  }
});

// The master credential is the one thing the sandbox must never hold: it is
// account-wide and long-lived, while a CLI process is neither.
test('the master credential is exchanged, never handed to the sandbox', async () => {
  const tokenSource = await readFile('agents/project/_makers-token.ts', 'utf8');
  const resolver = tokenSource.match(
    /export async function resolveSandboxMakersToken[\s\S]*?\n}/,
  )?.[0] || '';

  assert.ok(resolver, 'the resolver must stay the single entry point');
  assert.match(resolver, /issueSandboxMakersSubToken\(context, state, masterToken\)/);
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
  assert.equal(await resolveSandboxMakersToken({ env: {} }, state, ''), '');
  assert.equal(state.makersTenantId, undefined);
});

test('the tenant token is redacted out of CLI output', async () => {
  const [previewSource, commandSource] = await Promise.all([
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
  ]);

  assert.match(previewSource, /redactSecret\(\s*failure,\s*sandboxToken,?\s*\)/);
  assert.match(commandSource, /redactToolResult\(result, makers\.sandboxToken\)/);
  assert.match(commandSource, /redactSecret\(/);
});

test('direct CLI calls route the runtime credential through one resolver', async () => {
  const [tokenSource, previewSource, commandSource, packageSource] = await Promise.all([
    readFile('agents/project/_makers-token.ts', 'utf8'),
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
    readFile('package.json', 'utf8'),
  ]);

  assert.match(tokenSource, /\.tokens\.create\(\{/);
  assert.match(tokenSource, /tenantId/);
  assert.match(tokenSource, /expiresIn/);
  // Resume starts Makers dev without an LLM command, while normal preview and
  // deploy calls are intercepted on the generic sandbox commands tool. Neither
  // may reach past the resolver for a credential of its own.
  assert.match(previewSource, /resolveSandboxMakersToken\(context, state, masterToken\)/);
  assert.match(previewSource, /env: buildSandboxMakersEnv\(context, sandboxToken\)/);
  assert.match(commandSource, /resolveSandboxMakersToken\(/);
  assert.match(commandSource, /buildSandboxMakersEnv\(lifecycle\.context, sandboxToken\)/);
  for (const source of [previewSource, commandSource]) {
    assert.doesNotMatch(source, /issueSandboxMakersSubToken/);
  }
  assert.doesNotMatch(commandSource, /makers deploy[^\n]* -t /);

  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.dependencies['@edgeone/makers-sdk'], '0.1.0-beta.3');
});
