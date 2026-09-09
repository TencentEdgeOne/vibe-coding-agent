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

test('publish is a dedicated agent route with a private pipeline', async () => {
  const route = await readFile('agents/publish.ts', 'utf8');
  const pipeline = await readFile('agents/pipelines/_publish.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  assert.match(route, /onRequestPost/);
  assert.match(route, /runProjectPublishPipeline/);
  const sseCall = pipeline.lastIndexOf('return createSSEResponse');
  const packCall = pipeline.indexOf('await createProjectArchive');
  assert.ok(sseCall >= 0 && packCall > sseCall, 'packaging must start after the SSE stream opens');
  assert.match(pipeline, /type: 'status'/);
  assert.match(pipeline, /stage: 'packaging'/);
  assert.match(pipeline, /stage: 'uploading'/);
  assert.match(pipeline, /stage: 'deploying'/);
  assert.match(pipeline, /onStatusChange/);
  assert.match(pipeline, /rewritePublishZip/);
  assert.match(pipeline, /resolveMakersPublishTarget/);
  assert.match(pipeline, /makersProjectId/);
  assert.match(pipeline, /context\.env/);
  assert.match(pipeline, /MAKERS_API_TOKEN/);
  assert.doesNotMatch(pipeline, /process\.env/);
  assert.doesNotMatch(pipeline, /MAKERS_REGION/);
  assert.match(client, /fetch\('\/publish'/);
  assert.match(client, /makers-conversation-id/);
  assert.match(client, /siteDomain/);
  assert.match(screen, /extractProjectName\(\)/);
  await assert.rejects(access('agents/pipelines/publish.ts'));
  await access('agents/pipelines/_publish.ts');
  await access('agents/publish.ts');
});

test('publish button sits in the workspace topbar and disables while the agent is running', async () => {
  const header = await readFile('app/features/workspace/components/site-header.tsx', 'utf8');
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  assert.doesNotMatch(header, /onPublish/);
  assert.doesNotMatch(header, /site-publish-button/);
  assert.doesNotMatch(header, /workspace-publish-button/);
  assert.match(screen, /disabled=\{publishDisabled\}/);
  assert.match(screen, /loading \|\| publishBusy/);
  assert.match(screen, /publishDisabledAgentRunning/);
  assert.match(screen, /handleOpenPublishUrl/);
  assert.doesNotMatch(screen, /Globe/);
  assert.doesNotMatch(screen, /workspace-publish-button/);
  assert.doesNotMatch(screen, /<PublishDialog/);
  assert.match(screen, /<PublishControl/);
  assert.match(screen, /onPublish=\{\(\) => void handlePublish\(\)\}/);
  const actionsIndex = screen.indexOf('workspace-topbar-actions');
  const publishChip = screen.indexOf('<PublishControl');
  assert.ok(actionsIndex >= 0 && publishChip > actionsIndex);
  assert.match(screen, /showDeploy=\{CLAIM_DEPLOY_ENABLED\}/);
  assert.doesNotMatch(screen, /showDeploy=\{true\}/);
  assert.match(screen, /const url = publishResult\?\.previewUrl \|\| lastPublishUrl/);
  assert.match(screen, /clipboard\.writeText\(url\)/);
  assert.doesNotMatch(screen, /makersPreviewUrl/);
  assert.match(screen, /setLastPublishUrl\(null\)/);

  assert.match(screen, /workspace-publish-chip/);
  assert.match(screen, /displayPublishOrigin/);
  assert.match(screen, /republishLabel/);
  assert.match(screen, /function PublishControl/);
  assert.doesNotMatch(screen, /eo_token/);
  assert.doesNotMatch(screen, /publishCannotClose/);

  const i18n = await readFile('app/i18n.ts', 'utf8');
  assert.match(i18n, /republishLabel/);
  assert.match(i18n, /publishRetry/);
  assert.doesNotMatch(i18n, /publishCannotClose/);
  assert.match(i18n, /publishDisabledNoProject/);
  assert.match(i18n, /publishStagePackaging/);
  assert.doesNotMatch(i18n, /签名参数/);
});
