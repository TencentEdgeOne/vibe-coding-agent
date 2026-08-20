import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { MAKERS_SKILL_NAMES } from '../agents/_constants.ts';

const skillsRoot = '.claude/skills';

test('vendored Makers skills exist and match the SDK skill list', async () => {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(dirs, [...MAKERS_SKILL_NAMES].sort());
  for (const name of MAKERS_SKILL_NAMES) {
    const skill = await readFile(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\nname:/);
    assert.doesNotMatch(skill, /edgeone login --/);
    assert.doesNotMatch(skill, /makers deploy -t /);
  }
});

test('official Makers router and progressive references are vendored unchanged in structure', async () => {
  const router = await readFile(path.join(skillsRoot, 'edgeone-makers-tools', 'SKILL.md'), 'utf8');
  assert.match(router, /version: "2\.0\.0"/);
  assert.match(router, /This SKILL is a routing table/);
  assert.match(router, /references\/makers-agents\/SKILL\.md/);
  assert.match(router, /references\/makers-recipes\/SKILL\.md/);
  await readFile(path.join(
    skillsRoot,
    'edgeone-makers-tools',
    'references',
    'makers-agents',
    'references',
    'platform',
    'conversation-id.md',
  ));
});

test('agent prompt requires Makers-compatible output and forbids /preview/ hardcoding', async () => {
  const source = await readFile('agents/_agent.ts', 'utf8');
  assert.match(source, /skills: \[\.\.\.MAKERS_SKILL_NAMES\]/);
  assert.match(source, /tools: \['Skill'\]/);
  assert.match(source, /publish_preview/);
  assert.match(source, /deploy_to_makers/);
  assert.match(source, /cloud-functions/);
  assert.match(source, /Do not hard-code \/preview\//);
  assert.match(source, /including Skill, load_makers_skill/);
  assert.match(source, /call load_makers_skill once for each specific reference/);
  assert.match(source, /Never invoke the edgeone-makers-tools router through Skill/);
  assert.match(source, /execute in parallel/);
  assert.match(source, /Never load the same reference twice/);
  assert.match(source, /load makers-agents/);
  assert.match(source, /normalize the injected AI_GATEWAY_BASE_URL to end in exactly \/v1/);
  assert.match(source, /local project Read\/Write\/Edit\/Bash, present_files, and direct edgeone CLI commands are unavailable/);
  assert.match(source, /Response\.json\(\) is unavailable/);
  assert.match(source, /never context\.env\.KV/);
  assert.match(source, /export function middleware\(context\)/);
  assert.match(source, /Never export onRequest from middleware\.js/);
  assert.match(source, /agents\/chat\.ts/);
  assert.match(source, /makers-conversation-id/);
  assert.match(source, /@makers\/hy3-preview/);
  assert.match(source, /window\.location\.href/);
  assert.match(source, /copy the current access_token/);
  assert.match(source, /Do not write a \.env file/);
  assert.match(source, /Use at most one focused reproduction command/);
  assert.match(source, /Do not run the edgeone CLI, curl Pages APIs/);
  assert.match(source, /scripts": \{ "build": "echo skip" \}/);
  assert.doesNotMatch(
    source,
    /Vite projects must support sandbox preview under/,
    'generated Vite apps must not be forced onto the sandbox /preview/ base',
  );
  assert.doesNotMatch(
    source,
    /basePath: process\.env\.EDGEONE_PREVIEW_BASE_PATH/,
    'generated Next.js apps must not require the sandbox preview basePath',
  );
});

test('package.json without scripts.build is not a thrown verification failure', async () => {
  const source = await readFile('agents/project/_scaffold.ts', 'utf8');
  assert.doesNotMatch(source, /process\.exit\(p\.scripts && p\.scripts\.build \? 0 : 2\)/);
  assert.match(source, /buildFlag === 'yes'/);
});

test('publish_preview rejects known preview-breaking generated code before CLI startup', async () => {
  const source = await readFile('agents/tools/_project-tools.ts', 'utf8');
  const paths = await readFile('agents/utils/_paths.ts', 'utf8');
  assert.match(source, /assertPreviewCompatibility/);
  assert.match(source, /root-absolute fetch bypasses sandbox preview/);
  assert.match(source, /gpt-4o-mini is not a valid default/);
  assert.doesNotMatch(source, /fs\.existsSync\('\.env'\)/);
  assert.match(paths, /runtime environment files must not be generated/);
});

test('CLI prewarm starts concurrently with environment preparation', async () => {
  const source = await readFile('agents/project/_scaffold.ts', 'utf8');
  const chat = await readFile('agents/pipelines/_chat.ts', 'utf8');
  assert.match(source, /buildEdgeoneCliPrewarmScript/);
  assert.match(source, /CLI installation dominates first preview latency/);
  assert.match(chat, /const cliPrewarm = isLikelyProjectRequest\(message\)/);
  assert.match(chat, /const state = await prepareProjectWorkspace/);
  assert.match(chat, /await cliPrewarm/);
  assert.ok(chat.indexOf('const cliPrewarm') < chat.indexOf('const state = await prepareProjectWorkspace'));
});

test('specific Makers skill loader reads official references without changing them', async () => {
  const source = await readFile('agents/tools/_makers-skills.ts', 'utf8');
  const agent = await readFile('agents/_agent.ts', 'utf8');
  assert.match(source, /'load_makers_skill'/);
  assert.match(source, /references/);
  assert.match(source, /SKILL\.md/);
  assert.match(source, /readFile\(skillPath, 'utf8'\)/);
  assert.match(agent, /buildLoadMakersSkillTool/);
  assert.match(agent, /__load_makers_skill/);
});

test('cold resume overlaps dependency restore with CLI prewarm and has matching budgets', async () => {
  const resume = await readFile('agents/pipelines/_resume.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  assert.match(resume, /Promise\.all\(\[\s*ensureProjectDependencies\(context, state\),\s*prewarmEdgeoneCli\(context\)/);
  assert.match(resume, /WORKSPACE_RESUME_BUDGET_MS = 600_000/);
  assert.match(resume, /PREVIEW_RESTART_BUDGET_MS = 540_000/);
  assert.match(client, /RESUME_CLIENT_TIMEOUT_MS = 620_000/);
});

test('official storage reference covers pages-blob', async () => {
  const skill = await readFile(path.join(
    skillsRoot,
    'edgeone-makers-tools',
    'references',
    'makers-storage',
    'SKILL.md',
  ), 'utf8');
  assert.match(skill, /@edgeone\/pages-blob/);
});

test('official makers-agents reference covers the agent contract', async () => {
  const skill = await readFile(path.join(
    skillsRoot,
    'edgeone-makers-tools',
    'references',
    'makers-agents',
    'SKILL.md',
  ), 'utf8');
  assert.match(skill, /export async function onRequest/);
  assert.match(skill, /makers-conversation-id/);
  assert.match(skill, /context\.request\.body/);
  assert.match(skill, /AI_GATEWAY_MODEL/);
});

test('agent prompt stops after a successful publish_preview', async () => {
  const source = await readFile('agents/_agent.ts', 'utf8');
  assert.match(source, /If publish_preview returns a url, stop/);
  assert.match(source, /without a 0\.1\.x pin/);
});
