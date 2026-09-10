import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('chat uses one route for direct POST streaming and GET reconnect', async () => {
  const route = await readFile('agents/chat.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(route, /onRequestPost/);
  assert.match(route, /createChatTaskAndStreamResponse/);
  assert.match(route, /onRequestGet/);
  assert.match(route, /createChatTaskStreamResponse/);
  assert.match(client, /return fetch\('\/chat'/);
  await assert.rejects(access('agents/chat/index.ts'));
});

test('initial resume is one progressive SSE request', async () => {
  const route = await readFile('agents/resume.ts', 'utf8');
  const pipeline = await readFile('agents/pipelines/_resume.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(route, /onRequestGet/);
  assert.match(route, /createProjectResumeStreamResponse/);
  assert.match(pipeline, /type: 'resume_history'/);
  assert.match(pipeline, /type: 'resume_workspace'/);
  assert.match(client, /fetch\('\/resume',[\s\S]*?method: 'GET'/);
});

test('file panel performs no automatic or hover prefetch', async () => {
  const source = await readFile('app/components/files-panel.tsx', 'utf8');
  assert.doesNotMatch(source, /prefetch/i);
  assert.doesNotMatch(source, /onMouseEnter/);
  assert.match(source, /fetch\(`\/file\?path=/);
});

test('an untouched new project does not persist an empty conversation', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const start = screen.indexOf('function startNewProject()');
  const end = screen.indexOf('function handleNewProject()', start);
  const startBlock = screen.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(startBlock, /clearCachedConversationId\(\)/);
  assert.match(startBlock, /setConversationId\(null\)/);
  assert.doesNotMatch(startBlock, /cacheConversationId\(/);
  assert.doesNotMatch(startBlock, /createConversationId\(/);
});

test('starting a new project does not wait for the old stop request', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const stopRoute = await readFile('agents/stop.ts', 'utf8');
  const start = screen.indexOf('function confirmNewProject()');
  const end = screen.indexOf('// Hold the first paint', start);
  const confirmBlock = screen.slice(start, end);
  const abortIndex = stopRoute.indexOf('abortActiveRun');
  const snapshotIndex = stopRoute.indexOf('if (!discardProject)');

  assert.ok(start >= 0 && end > start);
  assert.match(confirmBlock, /void stopCurrentTask\(\{ discardProject: true \}\)/);
  assert.match(confirmBlock, /startNewProject\(\)/);
  assert.doesNotMatch(confirmBlock, /await/);
  assert.match(client, /options\.discardProject \? \{ discardProject: true \} : \{\}/);
  assert.ok(abortIndex >= 0 && snapshotIndex > abortIndex);
  assert.match(stopRoute, /if \(!discardProject\) \{[\s\S]*?persistProjectSnapshot/);
});

test('workspace persistence uses the sandbox SDK and metadata snapshots are read-only migration data', async () => {
  const helpers = await readFile('agents/pipelines/_helpers.ts', 'utf8');
  const persistence = await readFile('agents/project/_persistence.ts', 'utf8');
  const memory = await readFile('agents/_memory.ts', 'utf8');

  // Persistence still goes through the sandbox snapshot API, now reached via the
  // workspace port rather than a raw context reference.
  assert.match(helpers, /\.persist\(\{ path: state\.appDir \}\)/);
  assert.match(persistence, /\.restore\(\{ path: state\.appDir \}\)/);
  assert.match(persistence, /getLegacyProjectSnapshot/);
  assert.match(persistence, /clearLegacyProjectSnapshot/);
  assert.doesNotMatch(memory, /saveProjectSnapshot/);
  assert.doesNotMatch(memory, /listConversations/);
  assert.doesNotMatch(memory, /deleteConversation/);
});

test('publish is an MCP deploy tool instead of a dedicated HTTP route', async () => {
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const deploy = await readFile('agents/project/_deploy.ts', 'utf8');
  const tool = await readFile('agents/tools/_deploy-tools.ts', 'utf8');

  await assert.rejects(access('agents/publish.ts'));
  await assert.rejects(access('agents/pipelines/_publish.ts'));
  await access('agents/project/_deploy.ts');
  await access('agents/tools/_deploy-tools.ts');

  assert.doesNotMatch(client, /fetch\('\/publish'/);
  assert.match(client, /siteDomain/);
  assert.match(screen, /sendMessage\(t\.workspace\.publishPrompt/);
  assert.match(screen, /origin: 'agent-action'/);
  assert.match(screen, /upsertPublishActivity/);
  assert.match(await readFile('app/components/agent-conversation.tsx', 'utf8'), /function PublishSiteCard/);
  assert.match(await readFile('app/globals.css', 'utf8'), /\.publish-site-card/);
  assert.match(screen, /extractProjectName\(\)/);
  assert.match(deploy, /deployProjectToMakers/);
  assert.match(deploy, /rewritePublishZip/);
  assert.match(deploy, /resolveMakersPublishTarget/);
  assert.match(deploy, /makersProjectId/);
  assert.match(deploy, /context\.env/);
  assert.match(deploy, /env\?\.API_TOKEN/);
  assert.doesNotMatch(deploy, /process\.env/);
  assert.doesNotMatch(deploy, /MAKERS_REGION/);
  assert.match(tool, /publish_project/);
  assert.match(tool, /type: 'tool_output'/);
});

test('publish is offered above the composer after a finished project turn', async () => {
  const header = await readFile('app/features/workspace/components/site-header.tsx', 'utf8');
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const conversation = await readFile('app/components/agent-conversation.tsx', 'utf8');
  const styles = await readFile('app/globals.css', 'utf8');

  assert.doesNotMatch(header, /onPublish/);
  assert.doesNotMatch(header, /site-publish-button/);
  assert.doesNotMatch(header, /workspace-publish-button/);
  assert.doesNotMatch(screen, /<PublishControl/);
  assert.doesNotMatch(screen, /workspace-publish-chip/);
  assert.doesNotMatch(screen, /function PublishControl/);
  assert.doesNotMatch(styles, /workspace-publish-chip/);
  assert.match(screen, /resolveDeployOffer/);
  assert.match(screen, /deployOffer=\{deployOffer\}/);
  assert.match(screen, /onDeployOffer=\{\(\) => void handlePublish\(\)\}/);
  assert.match(conversation, /className="deploy-offer"/);
  assert.match(conversation, /className="conversation-composer-dock"/);
  assert.match(styles, /\.deploy-offer/);
  assert.match(screen, /!hasWorkspace \|\| !canDownload \|\| loading/);
  assert.doesNotMatch(screen, /Globe/);
  assert.doesNotMatch(screen, /workspace-publish-button/);
  assert.doesNotMatch(screen, /<PublishDialog/);
  assert.match(screen, /showDeploy=\{CLAIM_DEPLOY_ENABLED\}/);
  assert.doesNotMatch(screen, /showDeploy=\{true\}/);
  assert.match(header, /href=\{templateSourceUrl\}/);
  assert.match(header, /href=\{templateDeployUrl\}/);
  assert.match(screen, /templateSourceUrl=\{TEMPLATE_SOURCE_URL\}/);
  assert.match(screen, /templateDeployUrl=\{deployUrl\}/);
  assert.doesNotMatch(screen, /makersPreviewUrl/);
  assert.match(screen, /setLastPublishUrl\(null\)/);
  assert.doesNotMatch(screen, /eo_token/);
  assert.doesNotMatch(screen, /publishCannotClose/);

  const i18n = await readFile('app/i18n.ts', 'utf8');
  assert.match(i18n, /publishOffer/);
  assert.match(i18n, /publishOfferAgain/);
  assert.match(i18n, /publishOfferDismiss/);
  assert.match(i18n, /publishRetry/);
  assert.doesNotMatch(i18n, /publishCannotClose/);
  assert.doesNotMatch(i18n, /签名参数/);
});
