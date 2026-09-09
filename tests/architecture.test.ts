import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

/** Comments explain boundaries and legitimately name what they exclude. */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('frontend never imports the agent runtime', async () => {
  for (const file of await sourceFiles('app')) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"][^'"]*agents\//,
      `${file} crosses the app → agents boundary; move the contract to shared/`,
    );
    assert.doesNotMatch(
      source,
      /@edgeone\/makers-sdk/,
      `${file} must not import the Node-only Makers SDK`,
    );
  }
});

test('shared modules remain runtime agnostic', async () => {
  for (const file of await sourceFiles('shared')) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"](?:react|next|@anthropic-ai|\.\.\/app|\.\.\/agents)/,
      `${file} contains a framework or runtime dependency`,
    );
  }
});

test('agent implementation files are private to Makers file routing', async () => {
  for (const directory of ['core', 'pipelines', 'project', 'tools', 'utils']) {
    for (const file of await sourceFiles(path.join('agents', directory))) {
      assert.ok(
        path.basename(file).startsWith('_'),
        `${file} must start with _ or Makers will scan it as an endpoint`,
      );
    }
  }
});

// The core is the reusable engine: ports in, domain events out. If a `context`,
// a Request, or a Response reaches it, it has silently become Makers-only again
// and no CLI or SDK host can share it.
test('the agent core stays free of any host runtime', async () => {
  const coreFiles = await sourceFiles(path.join('agents', 'core'));
  assert.ok(coreFiles.length > 0, 'expected agents/core to contain source files');

  for (const file of coreFiles) {
    const source = stripComments(await readFile(file, 'utf8'));
    const isAdapter = file.includes(`${path.sep}adapters${path.sep}`);

    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"][^'"]*\.\.\/(?:app|pipelines)\//,
      `${file} must not depend on the frontend or the HTTP pipelines`,
    );
    assert.doesNotMatch(
      source,
      /@edgeone\/makers-sdk|(?:from\s+|import\s*)['"](?:react|next)/,
      `${file} must not import a host framework`,
    );

    // Only adapters are allowed to name a host's runtime objects.
    if (isAdapter) continue;
    assert.doesNotMatch(
      source,
      /\bcontext\s*:\s*any\b|\bcontext\?\.|new Response\(|createSSEResponse/,
      `${file} leaks a host runtime into the core; keep it behind a port or an adapter`,
    );
  }
});

// The core must stay reusable by a host that has no EdgeOne sandbox at all,
// which is what the local adapter stands in for.
test('the core has a working host besides Makers', async () => {
  const local = stripComments(
    await readFile(path.join('agents', 'core', 'adapters', '_local.ts'), 'utf8'),
  );

  assert.doesNotMatch(
    local,
    /context|sandbox\.|@edgeone/,
    'the local adapter must implement the ports without any Makers concept',
  );
  for (const capability of ['files', 'commands', 'persist', 'restore']) {
    assert.match(
      local,
      new RegExp(capability),
      `the local adapter must cover the ${capability} capability`,
    );
  }
});

// Conversation persistence now goes through ConversationStorePort. Reaching for
// `context.store` again would re-couple that logic to Makers one call at a time,
// which is exactly how the original coupling accumulated.
test('conversation persistence stays behind the store port', async () => {
  const offenders: string[] = [];

  for (const file of await sourceFiles('agents')) {
    // The adapter's whole job is to touch context.store; the ports file names it
    // in type documentation.
    if (file.endsWith(path.join('adapters', '_makers.ts'))) continue;
    if (file.endsWith(path.join('core', '_ports.ts'))) continue;

    const source = stripComments(await readFile(file, 'utf8'));
    if (/context[?.]*\.store\b/.test(source)) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    'these files reach context.store directly; go through createMakersStorePort instead',
  );
});

// Command execution is the chokepoint for every sandbox side effect. Once it is
// behind the workspace port, the whole project layer can run on another host.
test('sandbox command execution stays behind the workspace port', async () => {
  const offenders: string[] = [];

  for (const file of await sourceFiles('agents')) {
    if (file.endsWith(path.join('adapters', '_makers.ts'))) continue;
    if (file.endsWith(path.join('core', '_ports.ts'))) continue;

    const source = stripComments(await readFile(file, 'utf8'));
    if (/context[?.]*\.sandbox[?.]*\.commands\b/.test(source)) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    'these files run sandbox commands directly; go through runCommand instead',
  );
});

// The broadest of the three guards: no file outside the adapter may name the
// sandbox at all. This also catches the `const sandbox = context.sandbox`
// aliasing form, which a narrower pattern silently misses.
test('the sandbox is reachable only through the workspace port', async () => {
  const offenders: string[] = [];

  for (const file of await sourceFiles('agents')) {
    if (file.endsWith(path.join('adapters', '_makers.ts'))) continue;
    if (file.endsWith(path.join('core', '_ports.ts'))) continue;

    const source = stripComments(await readFile(file, 'utf8'));
    if (/context[?.]*\.sandbox\b/.test(source)) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    'these files reach context.sandbox directly; go through createMakersWorkspacePort instead',
  );
});

// The core describes what happened; hosts decide how it looks. A progress-bar
// phase or a prerendered summary string leaking back in is how the original
// coupling started, so the presenter is the only place allowed to name them.
test('the core carries no presentation vocabulary', async () => {
  const uiVocabulary = /\bphaseHint\b|\binputSummary\b|\boutputSummary\b|\bneedsWorkspace\b|\biframe\b/;
  const offenders: string[] = [];

  for (const file of await sourceFiles(path.join('agents', 'core'))) {
    // Translating domain events into the browser's wire format is this
    // directory's entire purpose.
    if (file.includes(`${path.sep}presenters${path.sep}`)) continue;

    const source = stripComments(await readFile(file, 'utf8'));
    if (uiVocabulary.test(source)) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    'these core files name a UI concern; keep it in a presenter or a host',
  );
});

// Localized copy in the runtime is what forced "右侧预览面板" into an agent
// reply. Failures cross the boundary as codes so each host writes its own words.
test('the core ships no user-facing prose', async () => {
  const offenders: string[] = [];

  for (const file of await sourceFiles(path.join('agents', 'core'))) {
    const source = stripComments(await readFile(file, 'utf8'));
    if (/[\u4e00-\u9fff]/.test(source)) offenders.push(file);
  }

  assert.deepEqual(offenders, [], 'these core files contain localized copy; return a reason code instead');
});
