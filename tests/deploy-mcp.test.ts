import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { deployProjectToMakers, formatDeployStage } from '../agents/project/_deploy.ts';
import { buildDeployConclusionFallback } from '../agents/pipelines/_helpers.ts';
import { isAgentActionPublishPrompt, TRANSLATIONS } from '../app/i18n.ts';

test('the Claude driver registers every MCP server it is given', async () => {
  const source = await readFile('agents/core/drivers/_claude.ts', 'utf8');
  assert.match(source, /input\.servers\.map/);
  assert.match(source, /createSdkMcpServer/);
  assert.match(source, /alwaysLoad: true/);
  assert.doesNotMatch(source, /toolNamespace/);
});

test('the agent registers a dedicated deploy MCP server', async () => {
  const agent = await readFile('agents/_agent.ts', 'utf8');
  assert.match(agent, /DEPLOY_MCP_SERVER_NAME/);
  assert.match(agent, /buildPublishProjectTool/);
  assert.match(agent, /mcp__\$\{DEPLOY_MCP_SERVER_NAME\}__publish_project/);
  assert.match(agent, /name: DEPLOY_MCP_SERVER_NAME/);
});

test('publish_project reports deploy stages as tool_output', async () => {
  const source = await readFile('agents/tools/_deploy-tools.ts', 'utf8');
  assert.match(source, /type: 'tool_output'/);
  assert.match(source, /deployProjectToMakers/);
  assert.match(source, /onStage: reportStage/);
  assert.match(source, /extractToolUseId/);
  assert.match(source, /onPublished\?\.\(\{ ok: false, error: message \}\)/);
  assert.doesNotMatch(source, /url: result\.previewUrl/);
});

test('deploy stages have stable labels the chip can parse', () => {
  assert.equal(formatDeployStage('packaging'), 'Packaging the project');
  assert.equal(formatDeployStage('uploading'), 'Uploading the artifact');
  assert.equal(formatDeployStage('deploying'), 'Deploying to EdgeOne Makers');
  assert.equal(formatDeployStage('deploying', 'building'), 'Deploying to EdgeOne Makers (building)');
});

test('deploying without a token fails before packaging', async () => {
  await assert.rejects(
    () => deployProjectToMakers(
      { env: {} },
      'conversation-1',
      { created: true, sessionDir: 'projects/c1', appDir: 'projects/c1/app' },
      { siteDomain: '', onStage: () => {} },
    ),
    /API_TOKEN/,
  );
});

test('deploy conclusions stay in the request language and omit the URL', () => {
  assert.equal(buildDeployConclusionFallback('帮我把当前项目部署上线', true), '项目已部署上线。');
  assert.equal(buildDeployConclusionFallback('帮我把当前项目部署上线', false), '项目部署失败。');
  assert.equal(buildDeployConclusionFallback('Deploy this project to production', true), 'The project is live.');
  assert.equal(
    buildDeployConclusionFallback('Deploy this project to production', false),
    'The project failed to deploy.',
  );
});

test('the simulated publish prompts are recognized in both locales', () => {
  assert.equal(isAgentActionPublishPrompt(TRANSLATIONS.zh.workspace.publishPrompt), true);
  assert.equal(isAgentActionPublishPrompt(TRANSLATIONS.en.workspace.publishPrompt), true);
  assert.equal(isAgentActionPublishPrompt('make the button blue'), false);
});
