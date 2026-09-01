import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { presentToolActivity } from '../app/lib/tool-activity.ts';

// Publishing and generating both drive the same sandbox, so they share the one
// task slot: whichever starts first makes the other wait, and a refresh
// mid-publish reconnects through the stream the frontend already knows.
test('publishing occupies the chat task slot instead of a route of its own', async () => {
  const [tasks, route, resume, client] = await Promise.all([
    readFile('agents/_chat-tasks.ts', 'utf8'),
    readFile('agents/chat.ts', 'utf8'),
    readFile('agents/pipelines/_resume.ts', 'utf8'),
    readFile('app/features/workspace/workspace-api.ts', 'utf8'),
  ]);

  assert.match(tasks, /intent === 'deploy'[\s\S]*?runDeployPipeline/);
  assert.match(route, /body\?\.intent === 'deploy'/);
  assert.match(client, /\.\.\.\(options\.intent \? \{ intent: options\.intent \} : \{\}\)/);
  assert.match(resume, /streamUrl: `\/chat\?runId=/);
});

// The project, the credential and the target project are all decided before
// the button is even enabled, so there is nothing here for a model to choose.
test('the deploy pipeline publishes without the model in the loop', async () => {
  const pipeline = await readFile('agents/pipelines/_deploy.ts', 'utf8');

  assert.doesNotMatch(pipeline, /runCodingAgent|from '\.\.\/_agent'/);
  assert.match(pipeline, /buildMakersDeployCommand\(resolveMakersProjectName\(context, state\)\)/);
  assert.match(pipeline, /readMakersDeployOutcome\(stdout, stderr, sandboxToken\)/);
  // Same short-lived tenant credential as every other sandbox CLI call.
  assert.match(pipeline, /resolveSandboxMakersToken\(/);
  assert.match(pipeline, /buildSandboxMakersEnv\(sandboxToken\)/);
  // Nothing to publish is answered before the CLI is ever started.
  assert.match(pipeline, /if \(!files\.some\(\(item\) => item\.type === 'file'\)\)/);
  // The live URL is the deliverable, so the reply carries it in full.
  assert.match(pipeline, /withLiveDeploymentUrl\(copy\.success, outcome\.url\)/);
});

test('a publish reads as one row in the transcript, whoever started it', () => {
  // What the pipeline records for its own run.
  assert.equal(
    presentToolActivity({ name: 'commands', inputSummary: 'edgeone makers deploy' }).action,
    'Deploy project',
  );
  // What the model's command tool records for the same work.
  assert.equal(
    presentToolActivity({
      name: 'mcp__sandbox__commands',
      inputSummary: JSON.stringify({ command: "edgeone makers deploy -n 'vibe-coding-1234' --json" }),
    }).action,
    'Deploy project',
  );
});

test('the deploy button is disabled until a project exists and nothing is running', async () => {
  const [screen, header] = await Promise.all([
    readFile('app/features/workspace/workspace-screen.tsx', 'utf8'),
    readFile('app/features/workspace/components/site-header.tsx', 'utf8'),
  ]);

  assert.match(screen, /const hasDeployableProject = Boolean\(download\?\.url\)/);
  assert.match(screen, /const deployRunning = loading \|\| deployment\?\.status === 'running'/);
  assert.match(
    screen,
    /const canDeployProject = hasDeployableProject && !deployRunning && !workspaceRestoring/,
  );
  assert.match(screen, /sendMessage\(t\.workspace\.deployRequest, \{ intent: 'deploy' \}\)/);
  assert.match(header, /disabled=\{!canDeploy\}/);
  // A disabled button that says nothing is a dead end; the hint names what is
  // still missing, and stands down once the button works.
  assert.match(header, /data-hint=\{canDeploy \? undefined : deployHint\}/);
});

// Resume hands back whatever deployment the stored conversation carries, so the
// card has to follow the payload down as well as up. While every handler only set
// it on presence, a URL published in an earlier session stayed on screen through a
// session that never published anything.
test('resumed history decides the deployment card, including when there is none', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const start = screen.indexOf('const applyHistory = (data: ResumeData) => {');
  const body = screen.slice(start, screen.indexOf('const applyWorkspace = (data: ResumeData) => {', start));

  assert.ok(start >= 0 && body.length > 0);
  assert.match(body, /setDeployment\(data\.deployment \?\? null\)/);
  assert.doesNotMatch(body, /if \(data\.deployment\) \{\s*setDeployment/);
});

// The same stale card from the other direction: a resume already streaming when
// the user starts a new project used to keep applying its events, restoring the
// previous conversation — id, history and deployment — over the fresh one.
test('starting a new project stops the resume that was already in flight', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const reset = screen.slice(
    screen.indexOf('function startNewProject() {'),
    screen.indexOf('function handleNewProject() {'),
  );

  assert.ok(reset.length > 0);
  assert.match(reset, /resumeAbortControllerRef\.current\?\.abort\(\)/);
  // Aborting only stops the fetch; events already in hand still need the epoch.
  assert.match(
    screen,
    /if \(cancelled \|\| workspaceEpoch !== workspaceEpochRef\.current \|\| event\.type === 'ping'\) return;/,
  );
});

// The composer is a text field the user may be mid-sentence in, and the Files
// panel is not waiting on anything a publish does.
test('publishing leaves the composer and the files panel alone', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const start = screen.indexOf('async function sendMessage(');
  const body = screen.slice(start, screen.indexOf('async function handleSubmit(', start));

  assert.ok(start >= 0 && body.length > 0);
  assert.match(body, /const isStartingFromHome = !isDeploy && !hasWorkspace/);
  assert.match(body, /if \(!isDeploy\) \{\s*setFilesRefreshing\(true\);\s*setInput\(''\);/);
});
