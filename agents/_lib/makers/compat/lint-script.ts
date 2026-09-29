import { PREVIEW_ASSET_PREFIX_ENV } from '../../constants.ts';
import { SUPPORTED_MAKERS_AGENT_FRAMEWORKS, type MakersFrameworkProfile, type MakersValidationRule } from './skill-rules.ts';

export function buildMakersCompatibilityScript(
  sourceRules: readonly MakersValidationRule[],
  frameworkProfiles: readonly MakersFrameworkProfile[] = [],
) {
  const rulesJson = JSON.stringify(sourceRules).replaceAll('<', '\\u003c');
  const frameworksJson = JSON.stringify(SUPPORTED_MAKERS_AGENT_FRAMEWORKS);
  const profilesJson = JSON.stringify(frameworkProfiles).replaceAll('<', '\\u003c');
  return `'use strict';\nconst sourceRules = ${rulesJson};\nconst supportedAgentFrameworks = ${frameworksJson};\nconst frameworkProfiles = ${profilesJson};\nconst assetPrefixEnv = ${JSON.stringify(PREVIEW_ASSET_PREFIX_ENV)};\n${String.raw`
const fs = require('fs');
const path = require('path');
const errors = [];
const ignored = new Set(['node_modules', '.edgeone', '.git', 'dist', 'build', '.next', '.venv', 'venv']);
const files = [];
const sourceCache = new Map();

function addError(code, file, message) {
  errors.push('[' + code + '] ' + file + ': ' + message);
}

function walk(dir, relative = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const rel = relative ? relative + '/' + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, rel);
      continue;
    }
    if (entry.isFile()) files.push(rel);
  }
}

function readSource(file) {
  if (sourceCache.has(file)) return sourceCache.get(file);
  let source = '';
  try {
    if (fs.statSync(file).size <= 1024 * 1024) {
      source = fs.readFileSync(file, 'utf8');
      if (source.includes('\0')) source = '';
    }
  } catch {}
  sourceCache.set(file, source);
  return source;
}

function readLintSource(file) {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function matchesPathPattern(file, pattern) {
  if (pattern.endsWith('/**')) {
    return file.startsWith(pattern.slice(0, -2));
  }
  if (pattern.startsWith('*.')) {
    return !file.includes('/') && file.endsWith(pattern.slice(1));
  }
  return file === pattern;
}

function isRuleCandidate(file, rule) {
  if (
    rule.pathPatterns.some((pattern) => (
      pattern === 'agents/**'
      || pattern === 'cloud-functions/**'
      || pattern === 'edge-functions/**'
      || pattern === 'functions/**'
    ))
  ) {
    return /\.(?:js|jsx|mjs|cjs|ts|tsx|py|go)$/.test(file);
  }
  return true;
}

function isAgentSource(file) {
  return /^agents\/.+\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/.test(file);
}

function isAgentEntry(file) {
  const direct = file.match(/^agents\/([^/]+)\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/);
  if (direct) return !direct[1].startsWith('_');
  const nested = file.match(/^agents\/([^/]+)\/index\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/);
  return Boolean(nested && !nested[1].startsWith('_'));
}

function hasValidAgentEntry(source, file) {
  if (file.endsWith('.py')) {
    return /(?:^|\n)\s*async\s+def\s+handler\s*\(/m.test(source);
  }
  return /export\s+(?:default\s+)?(?:async\s+)?function\s+onRequest(?:Get|Post|Put|Patch|Delete|Head|Options)?\s*\(/.test(source)
    || /export\s+(?:const|let|var)\s+onRequest(?:Get|Post|Put|Patch|Delete|Head|Options)?\s*=/.test(source);
}

function localImportSpecifiers(source) {
  const specifiers = [];
  const pattern = /(?:from\s*|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source))) specifiers.push(match[1]);
  return specifiers;
}

function resolveLocalAgentFile(fromFile, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.mjs',
    base + '.cjs',
    base + '/index.ts',
    base + '/index.tsx',
    base + '/index.js',
    base + '/index.mjs',
    base + '/index.cjs',
  ];
  return candidates.find((candidate) => files.includes(candidate));
}

// The terminal frame may live in the route or in a local helper it imports.
// Resolving those imports keeps the check from demanding a second copy of the
// protocol in every endpoint that already shares createSSEResponse.
function sourceSendsDone(file, seen) {
  if (!file || seen.has(file)) return false;
  seen.add(file);
  const source = readLintSource(file);
  if (/\[DONE\]/.test(source)) return true;
  return localImportSpecifiers(source).some((specifier) => (
    sourceSendsDone(resolveLocalAgentFile(file, specifier), seen)
  ));
}

walk('.');

const packageJson = fs.existsSync('package.json') ? readJson('package.json') : {};
const dependencies = Object.assign(
  {},
  packageJson && packageJson.dependencies,
  packageJson && packageJson.devDependencies,
);
const frameworkPackages = ['next', 'nuxt', '@nuxt/core', 'astro', '@sveltejs/kit'];
const isFrameworkProject = frameworkPackages.some((name) => dependencies && dependencies[name]);

// A page something rewrites before serving is not the asset rule's business:
// there index.html is a build input, and base or assetPrefix moves its URLs.
// What is left is the hand-written page the CLI serves byte for byte, where the
// URL in the markup is the URL the browser asks for.
const bundlerPackages = ['vite', 'webpack', 'parcel', 'rollup', 'esbuild', '@rsbuild/core', '@angular/cli'];
const hasBuildPipeline = isFrameworkProject
  || bundlerPackages.some((name) => dependencies && dependencies[name])
  || frameworkProfiles.some((profile) => profile.detect.some((name) => dependencies && dependencies[name]));

let edgeoneConfig = null;
const hasEdgeoneConfig = fs.existsSync('edgeone.json');
if (hasEdgeoneConfig) {
  edgeoneConfig = readJson('edgeone.json');
  if (!edgeoneConfig) {
    addError('MKR001', 'edgeone.json', 'invalid JSON.');
  }
}

const agentFiles = files.filter(isAgentSource);
const agentEntries = agentFiles.filter(isAgentEntry);
if (agentFiles.length > 0) {
  if (!hasEdgeoneConfig) {
    addError('MKR002', 'edgeone.json', 'required for an agents/ project and must declare agents.framework.');
  } else if (edgeoneConfig) {
    const framework = edgeoneConfig.agents && edgeoneConfig.agents.framework;
    if (!framework) {
      addError('MKR003', 'edgeone.json', 'agents.framework is required.');
    } else if (!supportedAgentFrameworks.includes(framework)) {
      addError(
        'MKR004',
        'edgeone.json',
        'agents.framework must be one of: ' + supportedAgentFrameworks.join(', ') + '.',
      );
    }
  }

  if (!fs.existsSync('.env.example')) {
    addError(
      'MKR005',
      '.env.example',
      'required for an agents/ project and must declare AI_GATEWAY_API_KEY and AI_GATEWAY_BASE_URL.',
    );
  } else {
    const envExample = fs.readFileSync('.env.example', 'utf8');
    if (!/^\s*(?:export\s+)?AI_GATEWAY_API_KEY\s*=/m.test(envExample)) {
      addError('MKR005', '.env.example', 'must declare AI_GATEWAY_API_KEY.');
    }
    if (!/^\s*(?:export\s+)?AI_GATEWAY_BASE_URL\s*=/m.test(envExample)) {
      addError('MKR006', '.env.example', 'must declare AI_GATEWAY_BASE_URL.');
    }
  }

  if (agentEntries.length === 0) {
    addError('MKR007', 'agents/', 'no route entry found; add agents/<name>.ts or agents/<name>/index.ts.');
  }
  const entriesByRoute = new Map();
  for (const file of agentEntries) {
    const direct = file.match(/^agents\/([^/]+)\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/);
    const nested = file.match(/^agents\/([^/]+)\/index\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/);
    const name = (direct && !direct[1].startsWith('_') && direct[1])
      || (nested && !nested[1].startsWith('_') && nested[1])
      || '';
    if (!name) continue;
    const group = entriesByRoute.get(name) || [];
    group.push(file);
    entriesByRoute.set(name, group);
  }
  for (const [name, group] of entriesByRoute) {
    if (group.length < 2) continue;
    group.sort();
    addError(
      'MKR021',
      group.join(', '),
      'agents/' + name + '.ts and agents/' + name + '/index.ts both map to POST /' + name
        + '; keep one entry file.',
    );
  }
  for (const file of agentEntries) {
    if (!hasValidAgentEntry(readSource(file), file)) {
      addError(
        'MKR008',
        file,
        'agent route must export onRequest/onRequestGet/onRequestPost (or async def handler for Python).',
      );
    }
  }
  for (const file of agentFiles) {
    if (/gpt-4o-mini/.test(readSource(file))) {
      addError(
        'MKR009',
        file,
        'gpt-4o-mini is not a valid Makers default; use the model documented by the makers-agents skill.',
      );
    }
  }

  // A generated /chat stream that never closes is invisible until the exact
  // moment a user starts trying to chat: the request stays open and the UI
  // waits forever. Nothing in the preview path exercises that now, so this lint
  // is the only thing that catches the omission before makers dev starts.
  for (const file of agentEntries) {
    const source = readLintSource(file);
    const usesSseHelper = /\bcreateSSEResponse\s*\(/.test(source)
      || /\bsseEvent\s*\(/.test(source);
    if (usesSseHelper && !sourceSendsDone(file, new Set())) {
      addError(
        'MKR023',
        file,
        'this agent streams SSE but never sends the terminal data: [DONE] frame. Every generated '
          + 'agent stream must close with data: [DONE] on success, error, and abort paths — put it in '
          + 'the stream generator finally block or in the shared createSSEResponse helper, not only '
          + 'after the happy-path loop.',
      );
    }
  }

  // The deployed runtime resolves the packages it externalizes from what
  // package.json declares, while npm 7+ installs peer dependencies whether they
  // are declared or not. An undeclared peer is therefore present everywhere
  // this project is tested and absent in production, where the import fails
  // before onRequest and the whole endpoint answers nothing until the gateway
  // times out. Preview cannot catch it: the chat probe runs against a sandbox
  // that has the peer.
  //
  // Read off the installed tree rather than a table of known frameworks. The
  // table would be the bug: deepagents 1.13 moved langchain and langgraph from
  // dependencies to peers, and a project generated against a list written for
  // 1.9 declared four packages too few. An absent node_modules skips this
  // silently, which is correct — nothing has been resolved yet to check.
  const declaredPackages = Object.keys(dependencies || {}).sort();
  for (const name of declaredPackages) {
    const manifest = readJson('node_modules/' + name + '/package.json');
    const peers = manifest && manifest.peerDependencies;
    if (!peers) continue;
    const meta = manifest.peerDependenciesMeta || {};
    const missing = Object.keys(peers)
      .filter((peer) => (
        !Object.prototype.hasOwnProperty.call(dependencies, peer)
        && !(meta[peer] && meta[peer].optional)
      ))
      .sort();
    if (missing.length > 0) {
      addError(
        'MKR020',
        'package.json',
        'declares ' + name + ' without its required peer dependencies: ' + missing.join(', ')
        + '. Add them to dependencies — the deployed agent runtime resolves externalized'
        + ' packages from package.json, so an undeclared peer imports fine in preview and'
        + ' fails at module load in production.',
      );
    }
  }
}

for (const file of files) {
  if (
    (file.startsWith('cloud-functions/') || file.startsWith('edge-functions/'))
    && path.extname(path.basename(file)) === ''
    && !path.basename(file).startsWith('.')
  ) {
    addError(
      'MKR010',
      file,
      'function files require a language extension such as .js, .py, or .go.',
    );
  }
}

for (const middlewareFile of ['middleware.js', 'middleware.ts']) {
  if (!files.includes(middlewareFile) || isFrameworkProject) continue;
  const source = readLintSource(middlewareFile);
  const exportsMiddleware =
    /export\s+(?:async\s+)?function\s+middleware\s*\(/.test(source)
    || /export\s+(?:const|let|var)\s+middleware\s*=/.test(source);
  if (/export\s+(?:async\s+)?function\s+onRequest\w*\s*\(/.test(source)) {
    addError(
      'MKR012',
      middlewareFile,
      'platform middleware must export middleware(context), not onRequest.',
    );
  } else if (!exportsMiddleware) {
    addError(
      'MKR013',
      middlewareFile,
      'platform middleware must export a middleware(context) function.',
    );
  }
}

for (const file of files) {
  if (!/\.(?:html|js|jsx|ts|tsx|vue|svelte)$/.test(file)) continue;
  if (
    file.startsWith('agents/')
    || file.startsWith('cloud-functions/')
    || file.startsWith('edge-functions/')
  ) {
    continue;
  }
  const source = readLintSource(file);
  // MKR011 and MKR014 lived here and rejected the root-absolute fetch and the
  // root-absolute link. The preview proxy now restores the prefix in the
  // browser, so those are the correct, deploy-ready forms and the rules would
  // fail every project on its first preview. The IDs stay retired rather than
  // reused, so an old report never reads as a current one.
  //
  // The trailing slash is what keeps this off a project whose own route is
  // named preview: that is written href="/preview", while the mistake this
  // catches is a prefix with a path after it.
  if (/(['"\`])\/preview\//.test(source)) {
    addError(
      'MKR015',
      file,
      'the sandbox /preview/ prefix is hard-coded. The host adds it while previewing and the deployed site is served from /, so this path doubles the prefix once deployed. Write the path the deployed site needs.',
    );
  }
  if (/\bbasePath\s*:/.test(source)) {
    addError(
      'MKR016',
      file,
      'basePath makes the framework expect a prefix the preview proxy has already stripped, so every route 404s. Remove it; assetPrefix is the only prefix the framework needs.',
    );
  }

  // The one root-absolute path the host cannot rescue. Its shim reaches links,
  // form actions, fetch, and XHR, all of which are resolved by code it has
  // already wrapped by the time they run. A subresource URL is resolved by the
  // HTML parser instead, which fetches it during the same parse that is still
  // on its way to the shim, and a <script src> cannot even be redirected after
  // the fact — assigning src again does not re-fetch. So this reads as the
  // worst kind of green: the document answers 200, the build passes, and the
  // page arrives unstyled with no script having run.
  if (!hasBuildPipeline && /\.html$/.test(file)) {
    const markup = readSource(file).replace(/<!--[\s\S]*?-->/g, '');
    const subresource = /<(?:script|link|img|source)\b[^>]*?\s(?:src|href)\s*=\s*["'](\/(?!\/)[^"']*)["']/gi;
    const reported = new Set();
    let found;
    while ((found = subresource.exec(markup))) {
      const url = found[1];
      if (reported.has(url)) continue;
      reported.add(url);
      addError(
        'MKR019',
        file,
        'this page has no build step behind it, so "' + url + '" is fetched exactly as written and resolves against the '
          + 'sandbox host root, outside the prefix the preview is published under. The gateway serves nothing above that '
          + 'prefix, so the asset 404s while the document itself still loads. Write the URL relative to this page instead '
          + '("' + url.replace(/^\/+/, '') + '" for a sibling file, "../" per directory of depth): that resolves under the '
          + 'prefix while previewing and at / once deployed. Links and fetch in this file stay root-absolute — the host '
          + 'restores those in the browser.',
      );
    }
  }
}

// The adapter check, and the reason it is worth its weight: the dev command
// starts the framework's own dev server, which does not involve the platform
// adapter at all. A project that needs one and lacks it previews perfectly and
// deploys broken, with every other gate green. Nothing else here catches it.
for (const profile of frameworkProfiles) {
  if (!profile.adapter) continue;
  if (!profile.detect.some((name) => dependencies[name])) continue;

  if (profile.adapter.required === 'server-output') {
    const rendering = profile.serverOutput;
    let mode = rendering ? rendering.default : 'server';
    if (rendering) {
      for (const candidate of rendering.files) {
        if (!files.includes(candidate)) continue;
        const source = readLintSource(candidate);
        if (rendering.serverPattern && new RegExp(rendering.serverPattern).test(source)) {
          mode = 'server';
          break;
        }
        if (rendering.staticPattern && new RegExp(rendering.staticPattern).test(source)) {
          mode = 'static';
          break;
        }
      }
    }
    // A static build has no server bundle to emit, so the adapter is genuinely
    // optional and demanding it would fail a correct project.
    if (mode === 'static') continue;
  }

  const adapterPackage = profile.adapter.package;
  if (!dependencies[adapterPackage]) {
    addError(
      'MKR017',
      'package.json',
      profile.label + ' renders on the server here, which requires the ' + adapterPackage
        + ' platform adapter. It is missing, so the preview will look correct and the deployment will not: '
        + 'the dev server never loads the adapter, and the build has nothing to emit platform output with. '
        + 'Add ' + adapterPackage + ' to dependencies.',
    );
  }

  // One config file decides, and which one is not always the first that exists.
  // An override claims that role only in the shape that earns it, so a project
  // keeping its config in the ordinary place is still read from there.
  const override = profile.adapter.configOverride;
  let configFile;
  let overrode = false;
  if (override) {
    const overridePattern = new RegExp(override.pattern);
    configFile = override.files.find(
      (candidate) => files.includes(candidate) && overridePattern.test(readLintSource(candidate)),
    );
    overrode = Boolean(configFile);
  }
  if (!configFile) {
    configFile = profile.adapter.configFiles.find((candidate) => files.includes(candidate));
  }

  if (!configFile) {
    addError(
      'MKR018',
      profile.adapter.configFiles[0],
      profile.label + ' needs ' + adapterPackage + ' wired in here, but no config file exists.',
    );
  } else if (!readLintSource(configFile).includes(adapterPackage)) {
    addError(
      'MKR018',
      configFile,
      adapterPackage + ' is not referenced in this config, so the build emits output the platform cannot serve. '
        + 'Import it and register it the way the makers-frameworks skill documents for ' + profile.label + '.'
        + (overrode ? ' ' + override.reason : ''),
    );
  }
}

// Independent of the adapter: preview is the framework's own dev server, and
// Astro emits /_astro and /@vite URLs from base in astro.config — not from
// vite.config, and not only when output is server. Missing the env leaves the
// document answering 200 while every chunk 404s outside the published prefix.
const astroConfigFiles = ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'];
if (dependencies.astro) {
  const astroConfig = astroConfigFiles.find((candidate) => files.includes(candidate));
  if (!astroConfig) {
    addError(
      'MKR022',
      astroConfigFiles[0],
      'Astro must set base from process.env.' + assetPrefixEnv + ' in astro.config so preview '
        + 'assets resolve under the published prefix. Omit the key when the variable is unset.',
    );
  } else if (!readLintSource(astroConfig).includes(assetPrefixEnv)) {
    addError(
      'MKR022',
      astroConfig,
      'Astro must set base from process.env.' + assetPrefixEnv + ' in this config so preview '
        + 'assets resolve under the published prefix. The document still answers 200 when they '
        + 'do not, which is why a curl cannot see the failure. Omit the key when the variable is unset.',
    );
  }
}

sourceRules.forEach((rule, index) => {
  const matcher = new RegExp(rule.pattern);
  for (const file of files) {
    if (!rule.pathPatterns.some((pattern) => matchesPathPattern(file, pattern))) continue;
    if (!isRuleCandidate(file, rule)) continue;
    if (
      isFrameworkProject
      && (file === 'middleware.js' || file === 'middleware.ts')
    ) {
      continue;
    }
    if (matcher.test(readLintSource(file))) {
      addError(
        'MKR' + String(100 + index),
        file,
        rule.message + ' [source: ' + rule.skill + ']',
      );
    }
  }
});

if (errors.length) {
  process.stderr.write(
    'Makers compatibility lint found ' + errors.length + ' issue(s):\n'
      + errors.join('\n'),
  );
  process.exit(2);
}

process.stdout.write(
  'Makers compatibility lint passed (' + files.length + ' files, '
    + sourceRules.length + ' skill rules, ' + frameworkProfiles.length + ' framework profiles).\n',
);
`}`;
}
