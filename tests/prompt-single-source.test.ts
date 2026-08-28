import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildPrompt } from '../agents/_prompt.ts';
import {
  MAKERS_DEV_PORT,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../agents/_constants.ts';
import { MAKERS_REFERENCE_SKILL_NAMES } from '../agents/tools/_makers-skills.ts';
import type { ProjectState } from '../agents/_types.ts';

// Platform contracts that the vendored skills own. Restating any of these in
// the system prompt creates a second source of truth that drifts silently when
// the platform ships new skills, so the prompt must stay clear of them.
const PLATFORM_OWNED_IDENTIFIERS = [
  'onRequestGet',
  'onRequestPost',
  'Response.json()',
  'my_kv',
  'context.env.KV',
  'context.request.body',
  'export function middleware',
  'export const config',
  'context.rewrite(',
  'makers-conversation-id',
  'text/event-stream',
  'data: [DONE]',
  'agents.framework',
  '@makers/hy3-preview',
  '@edgeone/pages-blob',
];

const state: ProjectState = {
  created: true,
  sessionDir: 'projects/demo',
  appDir: 'projects/demo/app',
};
const makersProjectName = 'vibe-coding-playground';

function renderPrompt(isNewProject = true) {
  return buildPrompt(
    '做一个带留言板的网站',
    [],
    state,
    isNewProject,
    'edgeone-sandbox',
    makersProjectName,
  );
}

async function readAllVendoredSkills() {
  const root = '.claude/skills';
  const chunks: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.md')) {
        chunks.push(await readFile(full, 'utf8'));
      }
    }
  }

  await walk(root);
  return chunks.join('\n');
}

test('the system prompt does not restate platform contracts owned by the skills', () => {
  const prompt = renderPrompt();
  const leaked = PLATFORM_OWNED_IDENTIFIERS.filter((identifier) => prompt.includes(identifier));
  assert.deepEqual(
    leaked,
    [],
    `these belong in the vendored skills, not the prompt: ${leaked.join(', ')}`,
  );
});

test('everything the prompt refuses to restate is actually documented in a skill', async () => {
  const skills = await readAllVendoredSkills();
  const undocumented = PLATFORM_OWNED_IDENTIFIERS.filter(
    (identifier) => !skills.includes(identifier),
  );
  assert.deepEqual(
    undocumented,
    [],
    `the prompt was stripped of knowledge no skill provides: ${undocumented.join(', ')}`,
  );
});

test('the prompt routes the model to the right reference before it writes code', () => {
  const prompt = renderPrompt();
  assert.match(prompt, /load_makers_skill/);
  assert.match(prompt, /load the reference first, then write/i);
  for (const skill of [
    'makers-recipes',
    'makers-cloud-functions',
    'makers-edge-functions',
    'makers-agents',
    'makers-storage',
    'makers-middleware',
    'makers-migration',
  ]) {
    assert.ok(prompt.includes(skill), `prompt should route to ${skill}`);
  }
  assert.match(prompt, /passing ref/);
  assert.match(prompt, /no file-reading tool can open them/);
});

// A routing hint that names a skill which does not exist would send the model
// after a reference load_makers_skill can never satisfy.
test('every skill the prompt names is one the loader can actually serve', () => {
  const named = new Set(renderPrompt().match(/(?<![\w-])makers-[a-z]+(?:-[a-z]+)*/g) ?? []);
  assert.ok(named.size >= 7, `expected the prompt to route to several skills, found ${named.size}`);
  for (const name of named) {
    assert.ok(
      (MAKERS_REFERENCE_SKILL_NAMES as readonly string[]).includes(name),
      `prompt routes to "${name}", which is not a vendored skill`,
    );
  }
});

// The official skills describe a normal developer machine. Dropping these
// corrections would send the model down documented-but-unavailable paths.
test('the prompt keeps the sandbox corrections the skills cannot know about', () => {
  const prompt = renderPrompt();
  assert.match(prompt, /target sandbox image is expected to provide the EdgeOne CLI/);
  assert.match(prompt, /Run it directly with the commands tool/);
  assert.match(
    prompt,
    new RegExp(`edgeone makers dev --port ${MAKERS_DEV_PORT} --skip-env-sync`),
  );
  assert.match(prompt, new RegExp(`path adapter on port ${PREVIEW_SERVER_PORT}`));
  assert.match(
    prompt,
    new RegExp(`sandbox\\.getHost\\(${PREVIEW_PUBLIC_PORT}\\).*${PREVIEW_PATH_PREFIX}`),
  );
  // The host owns the deploy project name, so the prompt must not hand the
  // model a -n to copy, edit, or replace after a name conflict.
  assert.match(prompt, /edgeone makers deploy --json once/);
  assert.match(prompt, /Never pass -n, invent a project name/);
  assert.match(prompt, /one read-only edgeone --version check is allowed/);
  assert.match(prompt, /errorCode=MAKERS_CLI_UNAVAILABLE, stop immediately/);
  assert.match(prompt, /Do not inspect PATH or installation directories/);
  assert.match(prompt, /host injects a short-lived tenant credential/i);
  assert.ok(prompt.includes(makersProjectName));
  assert.match(prompt, /Normalize it to end in exactly \/v1/);
  assert.match(
    prompt,
    new RegExp(`public development preview starts under ${PREVIEW_PATH_PREFIX}`),
  );
  // Left to prose, the model reinvents this URL every project and gets it
  // wrong in a way that only shows up in the browser: the prompt spells out
  // the one form that survives the preview prefix and the deployed root.
  assert.match(prompt, /new URL\('api\/example', window\.location\.href\)/);
  assert.match(prompt, /copy the page's access_token query parameter/);
  assert.match(prompt, /Never use a root-absolute fetch/);
  assert.match(prompt, /cannot vary the visitor region, client IP, or device/);
  assert.match(prompt, /must re-render from content the page already holds/);
  assert.match(prompt, /host strips that prefix before forwarding to Makers dev/);
  assert.match(prompt, /echo EXIT:\$\?/);
});

test('the prompt keeps its tool contracts and workspace boundary', () => {
  const prompt = renderPrompt();
  assert.ok(prompt.includes(state.appDir), 'prompt must name the writable project directory');
  assert.match(prompt, /ensure_project_scaffold as the first tool/);
  assert.match(prompt, /write_project_file accepts exactly one file per call/);
  assert.match(prompt, /When the command result reports a successful preview URL, stop/);
  assert.match(prompt, /Run edgeone makers deploy only when the user explicitly asks/);
  assert.doesNotMatch(prompt, /publish_preview|deploy_to_makers|get_preview_link/);
  assert.match(prompt, /I can only help create or modify web projects/);
});

test('the prompt reflects whether the workspace already exists', () => {
  assert.match(renderPrompt(true), /workspace may not have been prepared yet/);
  assert.match(renderPrompt(false), /already prepared a project workspace/);
});

test('recent conversation history is included when present', () => {
  const withHistory = buildPrompt(
    '再加一个深色模式',
    [
      { role: 'user', content: '做一个待办列表' },
      { role: 'assistant', content: '已完成，右侧可以预览。' },
    ],
    state,
    false,
    'edgeone-sandbox',
    makersProjectName,
  );
  assert.match(withHistory, /Recent conversation:/);
  assert.match(withHistory, /User: 做一个待办列表/);
  assert.doesNotMatch(renderPrompt(), /Recent conversation:/);
});
