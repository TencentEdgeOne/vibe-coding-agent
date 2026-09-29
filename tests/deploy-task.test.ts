import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { presentToolActivity } from '../app/lib/tool-activity.ts';
import { readCommandsWrapSource } from './helpers/fixtures.ts';
import { CONVERSATION, I18N, LIVE_TURN, NEW_PROJECT, WORKSPACE, surface } from './helpers/source.ts';

// Publishing and generating both drive the same sandbox, so they share the one
// task slot: whichever starts first makes the other wait, and a refresh
// mid-publish reconnects through the stream the frontend already knows.
test('publishing occupies the chat task slot instead of a route of its own', async () => {
  const [tasks, resume, client] = await Promise.all([
    readFile('agents/_lib/session/task.ts', 'utf8'),
    readFile('agents/_lib/session/resume.ts', 'utf8'),
    surface('app/features/workspace/workspace-api.ts'),
  ]);

  assert.match(tasks, /kind === 'deploy'[\s\S]*?runDeployPipeline/);
  assert.doesNotMatch(client, /fetch\('\/deploy'/);
  assert.doesNotMatch(client, /siteDomain: options\.siteDomain/);
  assert.doesNotMatch(resume, /streamUrl: `\/chat\?runId=/);
  assert.match(resume, /iterateLiveChatTaskEvents/);
});

// The project, the credential and the target project are all decided before
// the button is even enabled, so there is nothing here for a model to choose.
test('the deploy pipeline publishes the static site from the host', async () => {
  const pipeline = await readFile('agents/_lib/turn/deploy.ts', 'utf8');
  const publish = await readFile('agents/_lib/site/publish.ts', 'utf8');

  assert.match(pipeline, /publishStaticSite/);
  assert.match(pipeline, /runCodingAgent/);
  assert.match(pipeline, /shouldPauseForGatewayCredentials/);
  assert.doesNotMatch(pipeline, /buildMakersDeployLaunchCommand/);
  assert.doesNotMatch(pipeline, /edgeone makers deploy/);
  assert.match(pipeline, /withLiveDeploymentUrl\(copy\.success, published\.url\)/);
  assert.match(publish, /API_TOKEN/);
  assert.doesNotMatch(publish, /edgeone makers deploy/);
});

// The preview dev server and the deploy build write to the same directory, and
// the build loses: it fails on a file the dev server removed between writing it
// and copying it. Publishing stops the server first, and both ways of
// publishing get that from the one command builder rather than remembering to
// do it separately.
test('publishing stops the preview dev server before the build starts', async () => {
  const publish = await readFile('agents/_lib/site/publish.ts', 'utf8');
  const stop = publish.indexOf('fuser -k');
  const build = publish.indexOf('npm run build');
  assert.ok(stop >= 0 && build >= 0 && stop < build, 'the preview port is freed before the static build');
  assert.match(publish, /PREVIEW_SERVER_PORT/);
});

// Stopping the preview is a means, not an outcome. Both publishing paths bring
// it back, and neither reports a publish as failed because it did not come back.
// The restart goes through the same launcher as every other preview, and that
// launcher no longer probes generated routes at all.
test('publishing restarts the preview without probing generated routes', async () => {
  const [preview, pipeline, wrapper] = await Promise.all([
    readFile('agents/_lib/project/preview.ts', 'utf8'),
    readFile('agents/_lib/turn/deploy.ts', 'utf8'),
    readCommandsWrapSource(),
  ]);

  assert.doesNotMatch(preview, /verifyRoutes|assertGeneratedRoutesReady/);
  for (const source of [pipeline, wrapper]) {
    assert.match(source, /startPreviewServer\(/);
    assert.doesNotMatch(source, /verifyRoutes/);
  }

  // Restarted before the result is reported, so a failed publish still leaves a
  // preview to inspect.
  const restart = pipeline.indexOf('await startPreviewServer(context, state)');
  assert.ok(restart >= 0 && restart < pipeline.indexOf('if (commandError || !published)'));
});

// Publishing stops the preview server, but nothing reloads the iframe, so the
// frame keeps showing a page whose server is gone and still looks live. The
// frame itself is left alone on purpose — a scrim over a page that still
// renders was more intrusive than the dead links it was covering for — so the
// refusal rides on the two controls that would otherwise walk into the stopped
// server.
test('a publish closes the routes out of the preview without covering it', async () => {
  const [screen, frame, controls, i18n] = await Promise.all([
    surface(WORKSPACE),
    surface('app/features/workspace/components/preview-frame.tsx'),
    surface('app/features/workspace/components/preview-address-bar.tsx'),
    surface(I18N),
  ]);

  // The frame is not told a publish is running, which is the whole of it: with
  // no publishing prop there is no state it could cover the page for, and the
  // loading and expired states it does own are unreachable from a publish.
  assert.ok(
    !frame.includes('publishing'),
    'the preview frame should not dim, blur, or block during a publish',
  );

  // Reconnecting during a publish fails and then blames an expired connection,
  // which is the one explanation that is not true here, so both routes out of
  // the frame are closed for the duration. They live in the address bar now.
  assert.equal(controls.match(/disabled=\{publishing\}/g)?.length, 2);
  // An icon button says nothing on its own, so the refusal is named too — and it
  // is the accessible name, not only the tooltip.
  assert.match(controls, /const linkHint = publishing \? copy\.pausedForDeploy : ''/);
  assert.equal(controls.match(/aria-label=\{linkHint \|\| copy\.\w+\}/g)?.length, 2);

  // Only the address bar is told, and the phrase is assembled for it alone.
  assert.match(screen, /<PreviewAddressBar[\s\S]*?publishing=\{publishing\}/);
  assert.equal(screen.match(/pausedForDeploy: t\.workspace\.previewPausedForDeploy/g)?.length, 1);

  for (const language of ['zh', 'en']) {
    assert.ok(i18n.includes('previewPausedForDeploy'), language);
  }
  assert.equal(i18n.match(/previewPausedForDeploy:/g)?.length, 2);
});

// A failed publish is diagnosed from the CLI output, which only reaches the user
// if the pipeline forwards it. Discarding it here is what left a failed deploy
// showing one sentence that named no cause.
test('a failed publish keeps one line in the chat', async () => {
  const pipeline = await readFile('agents/_lib/turn/deploy.ts', 'utf8');
  assert.match(pipeline, /summarizeDeployError\(error\)/);
  assert.match(pipeline, /\$\{copy\.failedPrefix\}\$\{summarizeDeployError\(error\)\}/);
});

test('the deploy button sends product language while the tool carries the constraints', async () => {
  const [zh, en, assemble, deployTool, prompt] = await Promise.all([
    surface(I18N),
    readFile('app/i18n/en.ts', 'utf8'),
    readFile('agents/_lib/tools/assemble.ts', 'utf8'),
    readFile('agents/_lib/tools/deploy-tools.ts', 'utf8'),
    readFile('agents/_lib/prompt.ts', 'utf8'),
  ]);

  const { TRANSLATIONS } = await import('../app/i18n.ts');
  assert.equal(TRANSLATIONS.zh.workspace.deployRequest, '把当前站点发布上线');
  assert.equal(TRANSLATIONS.en.workspace.deployRequest, 'Publish this site');
  assert.match(deployTool, /Do not modify files in this turn/);
  assert.match(assemble, /buildDeployProjectTool/);
  assert.match(assemble, /mcp__\$\{mcpServerName\}__\$\{DEPLOY_PROJECT_TOOL_NAME\}/);
  assert.match(prompt, /deploy_project/);
  assert.doesNotMatch(prompt, /edgeone makers deploy --json once/);
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
  assert.equal(
    presentToolActivity({ name: 'mcp__edgeone-sandbox__deploy_project' }).action,
    'Deploy project',
  );
});

test('publish is offered above the composer after a finished project turn', async () => {
  const [screen, conversation, styles, i18n] = await Promise.all([
    surface(WORKSPACE),
    surface(CONVERSATION),
    readFile('app/styles/conversation.css', 'utf8'),
    surface(I18N),
  ]);

  assert.match(screen, /resolveDeployOffer/);
  assert.match(screen, /deployOffer=\{workspace\.gatewayNeeded \? null : deployOffer\}/);
  assert.match(screen, /onDeployOffer=\{handleDeployProject\}/);
  assert.match(conversation, /className="deploy-offer"/);
  assert.match(conversation, /className="conversation-composer-dock"/);
  assert.match(styles, /\.deploy-offer/);
  assert.match(i18n, /deployOfferAgain: '项目有更新，要重新部署吗？'/);
  assert.match(i18n, /deployOfferAgain: 'The project has updates. Deploy again\?'/);
});

test('the deploy button is disabled until a project exists and nothing is running', async () => {
  const [screen, live] = await Promise.all([
    surface(WORKSPACE),
    surface(LIVE_TURN),
  ]);

  assert.match(screen, /const hasDeployableProject = Boolean\(workspace\.download\?\.url\)/);
  assert.match(screen, /const publishing = workspace\.deployment\?\.status === 'running'/);
  assert.match(
    screen,
    /const deployRunning = live\.loading \|\| live\.stopping \|\| publishing/,
  );
  assert.match(
    screen,
    /const canDeployProject = hasDeployableProject && !deployRunning;/,
  );
  assert.match(screen, /sendMessage\(t\.workspace\.deployRequest, \{ deploy: true \}\)/);
  assert.match(live, /language,/);
  assert.doesNotMatch(live, /siteDomain: extractProjectName\(\)\.domain/);
  assert.match(screen, /disabled=\{!canDeployProject\}/);
  assert.match(screen, /className="workspace-icon-button is-publish"/);
  assert.doesNotMatch(screen, /is-running/);
  assert.match(screen, /<Rocket className="size-3\.5" \/>/);
  assert.match(screen, /className="workspace-icon-button is-publish"[\s\S]*?<Rocket className="size-3\.5" \/>\s*<\/button>/);
  assert.match(screen, /data-tooltip=\{deployHint\}/);
  assert.match(
    screen,
    /canDeployProject \? t\.deployLabel : t\.workspace\.deployNeedsIdle/,
  );
});

// The button reads `workspace.download`, so every path that learns a project
// exists has to deliver that link. Two of them were silent: a finished turn
// omitted it once the file-tree cache went away, and a resumed session never
// consumed the field at all. Either one left Deploy disabled on a project that
// was sitting right there.
test('a project that exists reaches the deploy button on every path', async () => {
  const [chat, snapshot, resume, screen] = await Promise.all([
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
    readFile('agents/_lib/project/snapshot.ts', 'utf8'),
    readFile('app/features/workspace/hooks/use-session-resume.ts', 'utf8'),
    surface(WORKSPACE),
  ]);

  // A finished turn names what makes the link available, without a listing.
  assert.match(chat, /hasDownload: state\.created/);
  // The snapshot builder honors that flag as well as a real listing.
  assert.match(snapshot, /options\.hasDownload \?\? hasFiles/);
  // A resumed session restores what the server sent.
  assert.match(resume, /workspace\.setDownload\(data\.download\?\.url \? data\.download : null\)/);
  // And the button's one source of truth is unchanged.
  assert.match(screen, /const hasDeployableProject = Boolean\(workspace\.download\?\.url\)/);
});

// Two deployments, one word between them. Publishing the user's project runs
// here and needs a finished project; taking a copy of the template is a console
// flow that has nothing to do with this session, so it is a plain link that is
// never disabled and never reads the project state.
test('the header ships the template, the panel ships the project', async () => {
  const [screen, header] = await Promise.all([
    surface(WORKSPACE),
    surface('app/features/workspace/components/site-header.tsx'),
  ]);

  assert.match(header, /href=\{templateDeployUrl\}/);
  assert.match(header, /href=\{templateSourceUrl\}/);
  assert.doesNotMatch(header, /canDeploy|onDeploy|onDownload/);
  assert.match(screen, /onClick=\{handleDeployProject\}/);
  assert.match(screen, /onClick=\{\(\) => void workspace\.handleDownload\(conversationId, t\.workspace\.downloadFailed\)\}/);
});

// Resume hands back whatever deployment the stored conversation carries, so the
// card has to follow the payload down as well as up. While every handler only set
// it on presence, a URL published in an earlier session stayed on screen through a
// session that never published anything.
test('resumed history decides the deployment card, including when there is none', async () => {
  const resume = await surface('app/features/workspace/hooks/use-session-resume.ts');
  const start = resume.indexOf('const applyHistory = (data: ResumeData)');
  const body = resume.slice(start, resume.indexOf('const resumeController = new AbortController()', start));

  assert.ok(start >= 0 && body.length > 0);
  assert.match(body, /workspace\.setDeployment\(data\.deployment \?\? null\)/);
  assert.doesNotMatch(body, /if \(data\.deployment\) \{\s*setDeployment/);
});

// The same stale card from the other direction: a resume already streaming when
// the user starts a new project used to keep applying its events, restoring the
// previous conversation — id, history and deployment — over the fresh one.
test('starting a new project stops the resume that was already in flight', async () => {
  const [screen, resume] = await Promise.all([
    surface(NEW_PROJECT),
    surface('app/features/workspace/hooks/use-session-resume.ts'),
  ]);
  const reset = screen.slice(
    screen.indexOf('function startNewProject() {'),
    screen.indexOf('function handleNewProject() {'),
  );

  assert.ok(reset.length > 0);
  assert.match(reset, /resumeAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(
    resume,
    /if \(cancelled \|\| workspaceEpoch !== workspaceEpochRef\.current \|\| event\.type === 'ping'\) return;/,
  );
});

// The composer is a text field the user may be mid-sentence in, and the Files
// panel is not waiting on anything a publish does.
test('publishing leaves the composer and the files panel alone', async () => {
  const live = await surface(LIVE_TURN);
  const start = live.indexOf('async function sendMessage(');
  const body = live.slice(start, live.indexOf('function stopCurrentTask(', start));

  assert.ok(start >= 0 && body.length > 0);
  assert.match(body, /const isStartingFromHome = !isDeploy/);
  assert.doesNotMatch(body, /runCreateSessionPrep|sessionPreparing|openSessionStream/);
  assert.match(body, /startPromptTurn\(/);
  assert.match(body, /message: displayMessage/);
  // The click is a user turn. This hook never opens a route of its own.
  assert.doesNotMatch(body, /startDeployTurn\(/);
  // Only the composer is cleared, and only for a generation turn. A deploy
  // click and an API key card both send a prompt without touching the draft.
  assert.match(body, /if \(!isDeploy && !providedKey\) \{\s*setInput\(''\);\s*\}/);
  assert.doesNotMatch(body, /setFilesRefreshing/);
  assert.doesNotMatch(body, /setFileTree/);
  assert.doesNotMatch(body, /isGatewayCard/);
  assert.doesNotMatch(body, /gatewaySkip/);
});
