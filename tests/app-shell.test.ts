import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { FILES_PANEL, LIVE_TURN, WORKSPACE, surface } from './helpers/source.ts';

const STYLES_DIR = 'app/styles';

function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

// The entry sheet only wires imports together; the rules live in the surface
// partials, so the invariants below are checked against all of them at once.
async function stylesheet(): Promise<string> {
  const entries = await readdir(STYLES_DIR);
  const partials = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.css'))
      .sort()
      .map((entry) => readFile(path.join(STYLES_DIR, entry), 'utf8')),
  );
  const entrySheet = await readFile('app/globals.css', 'utf8');
  return [entrySheet, ...partials].join('\n');
}

test('the page itself never scrolls, in any workspace state', async () => {
  const css = await stylesheet();
  const screen = await surface(WORKSPACE);

  assert.match(css, /html,\nbody \{[^}]*height: 100%;[^}]*overflow: hidden;/);
  assert.match(css, /\.app-shell \{[^}]*height: 100dvh;[^}]*overflow: hidden;/);
  assert.match(css, /\.home-stage \{[^}]*overflow-y: auto;/);
  assert.doesNotMatch(screen, /min-h-screen|h-screen/);
});

test('scroll containers are containing blocks, so sr-only labels cannot stretch the page', async () => {
  const css = await stylesheet();

  assert.match(css, /\.conversation-scroll \{[^}]*position: relative;/);
  assert.match(css, /\.conversation-skeleton \{[^}]*position: relative;/);
});

test('the stacked workspace fits one viewport instead of scrolling past its panes', async () => {
  const css = await stylesheet();
  const stacked = css.slice(css.indexOf('@media (max-width: 900px)'));

  assert.doesNotMatch(stacked, /52vh/);
  assert.doesNotMatch(stacked, /70vh/);
  assert.match(stacked, /\.workspace-shell \{[^}]*overflow: hidden;/);
  assert.match(stacked, /flex: 1 1 45%/);
  assert.match(stacked, /flex: 1 1 55%/);
});

test('phones switch between full-height chat and result surfaces', async () => {
  const [workspace, code, files, content] = await Promise.all([
    readFile(path.join(STYLES_DIR, 'workspace.css'), 'utf8'),
    readFile(path.join(STYLES_DIR, 'code.css'), 'utf8'),
    readFile('app/features/workspace/components/files/index.tsx', 'utf8'),
    readFile('app/features/workspace/components/files/file-content-view.tsx', 'utf8'),
  ]);

  assert.match(
    workspace,
    /\.workspace-shell:not\(\.is-chat-only\) > \.agent-conversation \{[^}]*display: none;/,
  );
  assert.match(
    code,
    /\.files-panel\.is-file-open \.files-panel-tree,\s*\.files-panel:not\(\.is-file-open\) \.files-panel-content \{\s*display: none;/,
  );
  assert.match(files, /className=\{`files-panel\$\{fileOpen \? ' is-file-open' : ''\}`\}/);
  assert.match(content, /onBack=\{onBack\}/);
});

test('the result panel plays a real exit before it unmounts', async () => {
  const [canvas, panel, css] = await Promise.all([
    readFile('app/features/workspace/components/workspace-canvas.tsx', 'utf8'),
    readFile('app/features/workspace/components/result-panel/index.tsx', 'utf8'),
    readFile(path.join(STYLES_DIR, 'workspace.css'), 'utf8'),
  ]);

  assert.match(canvas, /usePresence\(hasWorkspace && workspace\.resultPanelOpen/);
  assert.match(canvas, /resultPanelPresence\.exiting/);
  assert.match(canvas, /presence=\{resultPanelPresence\.exiting \? 'exiting' : 'entering'\}/);
  assert.match(canvas, /onExited=\{resultPanelPresence\.finishExit\}/);
  assert.match(panel, /data-presence=\{presence\}/);
  assert.match(panel, /event\.target === event\.currentTarget/);
  assert.match(panel, /presence === 'exiting'/);

  assert.match(css, /\.workspace-result-panel\[data-presence='exiting'\]/);
  assert.match(css, /@keyframes workspace-panel-enter/);
  assert.match(css, /@keyframes workspace-panel-exit/);
  assert.match(css, /@keyframes workspace-panel-enter-stacked/);
  assert.match(css, /@keyframes workspace-panel-exit-stacked/);
  assert.match(css, /@keyframes workspace-panel-enter-full/);
  assert.match(css, /@keyframes workspace-panel-exit-full/);
  assert.match(css, /\.workspace-shell\.is-panel-exiting \.workspace-split-handle/);
});

test('the landing hero centers without clipping its own top', async () => {
  const stage = await surface('app/features/workspace/components/home-stage.tsx');

  assert.doesNotMatch(stage, /home-stage[^"]*justify-center/);
  assert.match(stage, /className="home-inner my-auto"/);
});

// An action that vanishes when it is *unavailable* teaches nothing: the user is
// left looking for a button that was there a moment ago. So the buttons stay put
// and explain themselves when disabled. Tabs are a different axis — Download
// ships the source the Code tab is showing, so it belongs to that tab rather
// than to the bar as a whole.
test('workspace actions stay in place and go quiet instead of disappearing', async () => {
  const [screen, header, css] = await Promise.all([
    surface(WORKSPACE),
    surface('app/features/workspace/components/site-header.tsx'),
    readFile(path.join(STYLES_DIR, 'workspace.css'), 'utf8'),
  ]);

  // Acting on the project belongs to the panel that shows the project.
  assert.match(screen, /disabled=\{workspace\.downloadBusy \|\| !workspace\.download\?\.url\}/);
  assert.match(screen, /disabled=\{!canDeployProject\}/);
  assert.doesNotMatch(screen, /\{download\?\.url && /);
  // A native title is dropped on a disabled control, so the tooltip is CSS on an
  // attribute. It only stays readable while disabled because the panel icon does
  // not suppress its own pointer events the way the header buttons do.
  assert.match(screen, /data-tooltip=\{downloadHint\}/);
  assert.doesNotMatch(screen, /title=\{(downloadHint|exportHint|deployHint)\}/);
  const disabledIcon = css.slice(
    css.indexOf('.workspace-icon-button:disabled'),
    css.indexOf('.workspace-icon-spinner'),
  );
  assert.doesNotMatch(disabledIcon, /pointer-events/);
  // Scoped to Code: on Preview there is no source view for it to belong to.
  assert.match(screen, /\{workspace\.sandboxTab === 'files' && \(\s*<button[\s\S]*?Download/);
  // Leaving the project reads as going back, and lives next to the wordmark
  // rather than among the actions that operate on the project.
  const brandCluster = header.slice(
    header.indexOf('site-brand-cluster'),
    header.indexOf('site-topbar-actions'),
  );
  assert.match(brandCluster, /onClick=\{onBack\}/);
  assert.match(brandCluster, /<ArrowLeft \/>/);
});

// Tailwind emits its utilities inside @layer utilities and unlayered CSS
// outranks every layer, so the handwritten chrome never needs !important to
// win. Reintroducing one means a selector is fighting itself again.
test('surface styles override the utility layer without !important', async () => {
  const css = withoutComments(await stylesheet());

  assert.doesNotMatch(css, /!important/);
});

test('surfaces consume design tokens instead of raw colour values', async () => {
  const entries = await readdir(STYLES_DIR);
  const surfaces = entries.filter((entry) => entry.endsWith('.css') && entry !== 'tokens.css');

  for (const surfaceName of surfaces) {
    const css = withoutComments(await readFile(path.join(STYLES_DIR, surfaceName), 'utf8'));
    assert.doesNotMatch(
      css,
      /#[0-9a-fA-F]{3,8}\b|\brgba?\(/,
      `${surfaceName} hardcodes a colour; add it to tokens.css instead`,
    );
  }
});

// The topbar's tooltips hang below the bar and land on the preview iframe, and
// a publish disables the button it is explaining for the whole run. Both rules
// below exist to keep that overlap from becoming a translucent compositing
// layer over the iframe, which is what flickered while a deploy was running.
test('the topbar overlays the preview from its own layer, and never through opacity', async () => {
  const css = await readFile('app/styles/workspace.css', 'utf8');
  const topbar = css.slice(
    css.indexOf('.workspace-topbar {'),
    css.indexOf('.workspace-topbar-tabs,'),
  );

  assert.match(topbar, /position: relative/);

  // Asserted as a relationship, not a number. The number is what let the bug
  // through: the bar sat at 1, the preview scrim came along at 10, and the
  // scrim's backdrop-filter blurred the tooltip hanging into it. The tooltip's
  // own z-index cannot settle this — this layer traps it — so the only thing
  // worth pinning is that the bar out-numbers the overlay it hangs over.
  const layerOf = (selector: string) => {
    const rule = css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)));
    const found = /z-index:\s*(\d+)/.exec(rule);
    assert.ok(found, `${selector} declares no z-index`);
    return Number(found![1]);
  };
  assert.ok(
    layerOf('.workspace-topbar {') > layerOf('.workspace-preview-loading {'),
    'the preview overlay covers the topbar and the tooltips hanging into it',
  );

  // Dimming the button would dim the tooltip that explains why it is disabled,
  // and would make the button a stacking context while it did.
  const disabled = css.slice(
    css.indexOf('.workspace-icon-button:disabled {'),
    css.indexOf('.workspace-icon-button[data-tooltip]::after'),
  );
  assert.doesNotMatch(
    disabled.slice(0, disabled.indexOf('}')),
    /opacity/,
  );
  assert.match(disabled, /:disabled svg,\s*\.workspace-icon-button:disabled \.workspace-icon-spinner \{\s*opacity: 0\.45/);
});

// The canvas starts with the result column closed. Opening it defaults to
// Preview, and a ready preview opens it onto that tab; nothing else in the
// stream may open the panel or pick a tab.
test('the result panel opens on the preview tab by default', async () => {
  const [screen, live, resume, state] = await Promise.all([
    surface(WORKSPACE),
    surface(LIVE_TURN),
    surface('app/features/workspace/hooks/use-session-resume.ts'),
    surface('app/features/workspace/hooks/use-workspace-state.ts'),
  ]);

  assert.match(screen, /function ResultPanelToggle\(/);
  assert.match(screen, /workspace\.setResultPanelOpen\(true\)/);
  assert.match(screen, /workspace\.setResultPanelOpen\(false\)/);
  assert.match(
    screen,
    /if \(workspace\.unseenPanel \|\| !workspace\.sandboxTab\) \{\s*workspace\.setSandboxTab\('preview'\);/,
  );
  assert.match(screen, /onValueChange=\{\(value\) => workspace\.setSandboxTab\(value as SandboxTab\)\}/);
  assert.match(state, /\[resultPanelOpen, setResultPanelOpen\] = useState\(false\)/);
  assert.match(state, /useState<SandboxTab \| null>\(null\)/);
  assert.doesNotMatch(state, /useState<SandboxTab \| null>\('preview'\)/);
  assert.doesNotMatch(state, /useState<SandboxTab \| null>\('files'\)/);
  const previewReady = live.slice(live.indexOf("event.type === 'preview_ready'"));
  assert.match(previewReady, /if \(!workspace\.resultPanelOpen\) \{[\s\S]*?setSandboxTab\('preview'\)[\s\S]*?setResultPanelOpen\(true\)/);
  assert.doesNotMatch(live.replace(previewReady, ''), /setResultPanelOpen\(|setSandboxTab\(/);
  assert.doesNotMatch(resume, /setResultPanelOpen\(/);
  assert.doesNotMatch(resume, /setSandboxTab\(/);
});

// The strip is a set of destinations, so the tabs that are not in view stay as
// icons; the open one names itself. Opening and closing must run at the same
// speed — a max-width cap only animates the text past the cap, so the two
// directions took visibly different times on one duration. An animated grid
// track interpolates 0fr to 1fr over the whole span in both directions.
test('the selected tab shows its label while the others stay icons', async () => {
  const [screen, css] = await Promise.all([
    surface(WORKSPACE),
    readFile('app/styles/workspace.css', 'utf8'),
  ]);

  // Every tab carries its text in the animatable box, with an inner element
  // that does the clipping — a track can only shrink past text that overflows.
  assert.equal(screen.match(/className="workspace-tab-label"/g)?.length, 3);
  assert.equal(screen.match(/<span className="workspace-tab-label">\s*<span>/g)?.length, 3);

  // Only the collapsed rule itself — the active rule further down legitimately
  // declares the transition.
  const label = css.slice(
    css.indexOf('.workspace-tab-label {'),
    css.indexOf(".workspace-tab[data-state='active']"),
  );
  // Collapsed to a zero-width track, so a hidden label takes up no room.
  assert.match(label, /display:\s*grid/);
  assert.match(label, /grid-template-columns:\s*0fr/);
  assert.match(label, /margin-left:\s*0/);
  assert.match(label, /opacity:\s*0/);
  // The transition lives on the base rule, so it applies in both directions.
  const baseTransition = /transition:([^;]*);/.exec(label)?.[1] ?? '';
  assert.match(baseTransition, /grid-template-columns var\(--t-base\) var\(--ease\)/);
  assert.match(baseTransition, /margin-left var\(--t-base\) var\(--ease\)/);
  assert.match(baseTransition, /opacity var\(--t-base\) ease/);

  const activeStart = css.indexOf(".workspace-tab[data-state='active'] .workspace-tab-label");
  const active = css.slice(activeStart, css.indexOf('.workspace-tab svg', activeStart));
  assert.match(active, /grid-template-columns:\s*1fr/);
  assert.match(active, /margin-left:\s*5px/);
  assert.match(active, /opacity:\s*1/);
  // No override here: a second transition would let the directions diverge.
  assert.doesNotMatch(active, /transition:/);

  // The container measures its tabs rather than reserving a fixed track, which
  // is what lets the width animate with them.
  const strip = css.slice(css.indexOf('.workspace-tabs {'), css.indexOf('.workspace-tab {'));
  assert.match(strip, /display:\s*flex/);
  assert.match(strip, /width:\s*max-content/);
  assert.doesNotMatch(strip, /width:\s*\d+px/);
  assert.doesNotMatch(strip, /transition:[^;]*width/);
});

// Selection is the white pill with a shadow; hover must not read as the same
// state on a tab that is only being pointed at.
test('hovering a tab does not imitate the selected state', async () => {
  const css = await readFile('app/styles/workspace.css', 'utf8');
  const hover = css.slice(
    css.indexOf(".workspace-tab:hover:not([data-state='active'])"),
    css.indexOf(".workspace-tab[data-state='active'],"),
  );

  // The hover rule is limited to unselected tabs and is a darker, flat recess —
  // the opposite direction from the lifted white pill the open tab keeps.
  assert.match(hover, /background:\s*var\(--n-200\)/);
  assert.match(hover, /color:\s*var\(--n-900\)/);
  assert.doesNotMatch(hover, /box-shadow/);
  assert.doesNotMatch(hover, /background:\s*var\(--n-0\)/);
  assert.doesNotMatch(hover, /var\(--shadow-1\)/);

  // And the selected state keeps the pill and its shadow.
  const active = css.slice(css.indexOf(".workspace-tab[data-state='active'],"));
  assert.match(active, /background:\s*var\(--n-0\)/);
  assert.match(active, /box-shadow:\s*var\(--shadow-1\)/);
});

test('opening the workspace does not show a prep overlay, and files can load', async () => {
  const [screen, resume, live, state, files] = await Promise.all([
    surface(WORKSPACE),
    surface('app/features/workspace/hooks/use-session-resume.ts'),
    surface(LIVE_TURN),
    surface('app/features/workspace/hooks/use-workspace-state.ts'),
    surface(FILES_PANEL),
  ]);

  assert.doesNotMatch(screen, /SessionPrepLoading|sessionPreparing|workspaceRestoring|prepStage/);
  assert.doesNotMatch(live, /sessionPreparing|runCreateSessionPrep|setPrepStage/);
  assert.doesNotMatch(resume, /workspaceRestoring|setPrepStage|applyWorkspace/);
  assert.match(screen, /useLazyPanel\(/);
  assert.match(state, /filesLoading/);
  assert.match(files, /copy\.loadingTree/);
  assert.match(screen, /attention=\{workspace\.unseenPanel\}/);
});

// Opening the Preview tab used to boot a sandbox for any conversation, because
// the only gate was "the tab is showing and this visit has no URL yet". A
// conversation whose agent never asked for a preview then showed a spinner and
// started a dev server nobody requested. The resume payload already knows
// whether one was published; that fact is what has to gate the lazy boot.
test('preview boots lazily only for a conversation that published one', async () => {
  const [panel, resume, snapshot, state] = await Promise.all([
    readFile('app/features/workspace/hooks/use-lazy-panel.ts', 'utf8'),
    readFile('app/features/workspace/hooks/use-session-resume.ts', 'utf8'),
    readFile('app/features/workspace/hooks/use-workspace-snapshot.ts', 'utf8'),
    readFile('app/features/workspace/hooks/use-workspace-state.ts', 'utf8'),
  ]);

  // The fact travels from the resume payload into workspace state...
  assert.match(resume, /setHasPublishedPreview\(data\.hasPreview === true\)/);
  assert.match(state, /const \[hasPublishedPreview, setHasPublishedPreview\]/);
  // ...and the lazy boot requires it before it will call /preview.
  assert.match(
    panel,
    /workspace\.hasPublishedPreview[\s\S]*?fetchPreviewRefresh\(conversationId\)/,
  );
  // A snapshot that carries a stored URL is also proof, and restores it.
  assert.match(snapshot, /setHasPublishedPreview\(true\)/);
});

test('the split workspace defaults to a 4:6 chat-to-panel ratio and can be dragged', async () => {
  const [css, screen] = await Promise.all([
    readFile('app/styles/workspace.css', 'utf8'),
    surface(WORKSPACE),
  ]);
  const stacked = css.slice(css.indexOf('@media (max-width: 900px)'));

  assert.match(css, /--workspace-chat-share:\s*40%/);
  assert.match(css, /flex: 0 0 var\(--workspace-chat-share\)/);
  assert.match(screen, /function WorkspaceSplitHandle\(/);
  assert.match(screen, /role="separator"/);
  assert.match(screen, /clampWorkspaceChatShare/);
  assert.match(stacked, /\.workspace-split-handle \{[^}]*display: none;/);
});
