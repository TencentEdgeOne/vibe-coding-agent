import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectState } from '../_types.ts';
import { runSandboxCommand } from './_commands.ts';

export type MakersValidationRule = {
  skill: string;
  pathPatterns: string[];
  pattern: string;
  message: string;
};

const VALIDATION_SKILLS = [
  'makers-agents',
  'makers-cloud-functions',
  'makers-deploy',
  'makers-edge-functions',
  'makers-env-adaption',
  'makers-middleware',
  'makers-storage',
] as const;

export const SUPPORTED_MAKERS_AGENT_FRAMEWORKS = [
  'claude-agent-sdk',
  'openai-agents-sdk',
  'langgraph',
  'crewai',
  'deepagents',
] as const;

function parseFrontmatterScalar(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseMakersSkillValidationRules(
  skill: string,
  source: string,
): MakersValidationRule[] {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return [];

  const pathPatterns: string[] = [];
  const rules: Array<{ pattern: string; message: string }> = [];
  let section: 'paths' | 'validate' | null = null;
  let pendingPattern = '';

  for (const line of frontmatter.split(/\r?\n/)) {
    if (line === 'pathPatterns:') {
      section = 'paths';
      continue;
    }
    if (line === 'validate:') {
      section = 'validate';
      continue;
    }
    if (/^\S/.test(line)) {
      section = null;
      continue;
    }
    if (section === 'paths') {
      const match = line.match(/^\s{2}-\s+(.+)$/);
      if (match?.[1]) pathPatterns.push(parseFrontmatterScalar(match[1]));
      continue;
    }
    if (section === 'validate') {
      const patternMatch = line.match(/^\s{2}-\s+pattern:\s+(.+)$/);
      if (patternMatch?.[1]) {
        pendingPattern = parseFrontmatterScalar(patternMatch[1]);
        continue;
      }
      const messageMatch = line.match(/^\s{4}message:\s+(.+)$/);
      if (messageMatch?.[1] && pendingPattern) {
        rules.push({
          pattern: pendingPattern,
          message: parseFrontmatterScalar(messageMatch[1]),
        });
        pendingPattern = '';
      }
    }
  }

  return rules.map((rule) => ({
    skill,
    pathPatterns: [...pathPatterns],
    ...rule,
  }));
}

let validationRulesPromise: Promise<readonly MakersValidationRule[]> | undefined;

export function loadMakersValidationRules(): Promise<readonly MakersValidationRule[]> {
  if (!validationRulesPromise) {
    validationRulesPromise = Promise.all(VALIDATION_SKILLS.map(async (skill) => {
      const skillPath = path.join(
        process.cwd(),
        '.claude',
        'skills',
        'edgeone-makers-tools',
        'references',
        skill,
        'SKILL.md',
      );
      const source = await readFile(skillPath, 'utf8');
      return parseMakersSkillValidationRules(skill, source);
    })).then((groups) => {
      const rules = groups.flat();
      for (const rule of rules) {
        // Fail at the source if an official vendored rule is malformed instead
        // of silently dropping a compatibility check.
        new RegExp(rule.pattern);
      }
      return rules;
    });
  }
  return validationRulesPromise;
}

export function buildMakersCompatibilityScript(
  sourceRules: readonly MakersValidationRule[],
) {
  const rulesJson = JSON.stringify(sourceRules).replaceAll('<', '\\u003c');
  const frameworksJson = JSON.stringify(SUPPORTED_MAKERS_AGENT_FRAMEWORKS);
  return `'use strict';\nconst sourceRules = ${rulesJson};\nconst supportedAgentFrameworks = ${frameworksJson};\n${String.raw`
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

walk('.');

const packageJson = fs.existsSync('package.json') ? readJson('package.json') : {};
const dependencies = Object.assign(
  {},
  packageJson && packageJson.dependencies,
  packageJson && packageJson.devDependencies,
);
const frameworkPackages = ['next', 'nuxt', '@nuxt/core', 'astro', '@sveltejs/kit'];
const isFrameworkProject = frameworkPackages.some((name) => dependencies && dependencies[name]);

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
    const envExample = readSource('.env.example');
    for (const key of ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL']) {
      if (!new RegExp('^' + key + '\\s*=', 'm').test(envExample)) {
        addError('MKR006', '.env.example', 'missing ' + key + '= declaration.');
      }
    }
  }

  if (agentEntries.length === 0) {
    addError('MKR007', 'agents/', 'no route entry found; add agents/<name>.ts or agents/<name>/index.ts.');
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
  if (/\bfetch\s*\(\s*(['"])\/(?:api\/|chat(?:\1|[/?]))/.test(source)) {
    addError(
      'MKR011',
      file,
      'root-absolute fetch bypasses the sandbox /preview/ route. Resolve the API path from window.location.href and preserve access_token.',
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
    + sourceRules.length + ' skill rules).\n',
);
`}`;
}

export async function runMakersCompatibilityCheck(
  context: any,
  state: ProjectState,
) {
  const rules = await loadMakersValidationRules();
  const script = buildMakersCompatibilityScript(rules);
  const scriptPath = `${state.sessionDir}/.makers-compat-check.cjs`;
  await context.sandbox.files.write(scriptPath, script);
  return runSandboxCommand(
    context,
    'node ../.makers-compat-check.cjs',
    { cwd: state.appDir, timeout: 20 },
  );
}

/**
 * Keep fast, deterministic checks that the CLI cannot explain as clearly.
 * Browser API calls must retain the sandbox /preview/ prefix; the local proxy
 * strips it before Makers dev, while deployed applications continue to use /.
 */
export async function assertMakersProjectCompatible(
  context: any,
  state: ProjectState,
) {
  const result = await runMakersCompatibilityCheck(context, state);
  if (result.exitCode !== 0) {
    throw new Error(
      `Makers compatibility check failed:\n${result.stderr || result.stdout}\nFix only the reported project files, then rerun the same EdgeOne CLI command.`,
    );
  }
}
