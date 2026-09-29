import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_PREVIEW_HISTORY,
  PREVIEW_HISTORY_LIMIT,
  previewHistoryBack,
  previewHistoryForward,
  previewHistoryReset,
  previewHistoryVisit,
  previewNavigationBack,
  previewNavigationForward,
  previewNavigationInit,
  previewNavigationIsBusy,
  previewNavigationReport,
  previewNavigationSelect,
  previewNavigationTarget,
  type PreviewNavigationState,
} from '../shared/preview-history.ts';
import { readFile } from 'node:fs/promises';

test('a visit pushes the previous route onto the back stack', () => {
  let history = previewHistoryReset('/preview/');
  history = previewHistoryVisit(history, '/preview/about');
  history = previewHistoryVisit(history, '/preview/blog');

  assert.equal(history.current, '/preview/blog');
  assert.deepEqual(history.back, ['/preview/', '/preview/about']);
  assert.deepEqual(history.forward, []);
});

test('back and forward move routes between the two stacks', () => {
  let history = previewHistoryVisit(
    previewHistoryVisit(previewHistoryReset('/preview/'), '/preview/about'),
    '/preview/blog',
  );

  const back = previewHistoryBack(history);
  assert.ok(back);
  assert.equal(back.target, '/preview/about');
  history = back.state;
  assert.deepEqual(history.back, ['/preview/']);
  assert.deepEqual(history.forward, ['/preview/blog']);

  const forward = previewHistoryForward(history);
  assert.ok(forward);
  assert.equal(forward.target, '/preview/blog');
  assert.deepEqual(forward.state.back, ['/preview/', '/preview/about']);
  assert.deepEqual(forward.state.forward, []);
});

// A browser drops everything ahead of the current entry as soon as it visits a
// new route; keeping it would make Forward jump into an abandoned branch.
test('a new visit after going back drops the forward stack', () => {
  const back = previewHistoryBack(previewHistoryVisit(
    previewHistoryVisit(previewHistoryReset('/preview/'), '/preview/about'),
    '/preview/blog',
  ));
  assert.ok(back);

  const visited = previewHistoryVisit(back.state, '/preview/pricing');
  assert.equal(visited.current, '/preview/pricing');
  assert.deepEqual(visited.back, ['/preview/', '/preview/about']);
  assert.deepEqual(visited.forward, []);
});

test('there is nowhere to go at either edge', () => {
  assert.equal(previewHistoryBack(EMPTY_PREVIEW_HISTORY), null);
  assert.equal(previewHistoryForward(EMPTY_PREVIEW_HISTORY), null);
  assert.equal(previewHistoryBack(previewHistoryReset('/preview/')), null);
  assert.equal(previewHistoryForward(previewHistoryReset('/preview/')), null);
});

// The tracker repeats the route it is already on — a replaceState, or the
// report that answers this pane's own navigation. That must not push a
// duplicate entry or clear Forward.
test('re-reporting the current route changes nothing', () => {
  let history = previewHistoryVisit(previewHistoryReset('/preview/'), '/preview/about');
  history = previewHistoryBack(history)?.state ?? history;
  const before = history;

  assert.equal(previewHistoryVisit(before, before.current), before);
  assert.deepEqual(before.forward, ['/preview/about']);
});

test('the back stack is capped so a long session cannot grow it forever', () => {
  let history = previewHistoryReset('/preview/');
  for (let index = 0; index < PREVIEW_HISTORY_LIMIT + 10; index += 1) {
    history = previewHistoryVisit(history, `/preview/page-${index}`);
  }
  assert.equal(history.back.length, PREVIEW_HISTORY_LIMIT);
  // The oldest entries are the ones dropped.
  assert.equal(history.back[0], '/preview/page-9');
});

// The state machine that decides when the progress track runs. It lives in the
// shared module rather than the hook so these branches can be driven directly:
// every case below was a way to leave the track spinning.
function applyReport(
  state: PreviewNavigationState,
  path: string,
): PreviewNavigationState {
  return previewNavigationReport(state, path);
}

// The reported bug. The route list marks the current entry, and choosing it
// again has no report that could answer it — the answer would name the route the
// request "left", which is also the route it was going to, so it read as a stale
// report and was dropped. The track then ran until the safety timeout.
test('re-selecting the route already showing does not start a wait', () => {
  const arrived = applyReport(previewNavigationInit(), '/abc');
  assert.equal(arrived.history.current, '/abc');
  assert.equal(previewNavigationIsBusy(arrived), false);

  const reselected = previewNavigationSelect(arrived, '/abc');

  assert.equal(reselected, arrived, 'it must be a no-op, not a pending request');
  assert.equal(previewNavigationIsBusy(reselected), false);
  assert.equal(previewNavigationTarget(reselected), null);
});

// The mirror: a selection that does move opens a wait, and the report for the
// route left is stale while the report for the target answers it.
test('a selection opens a wait that only its own report can close', () => {
  const arrived = applyReport(previewNavigationInit(), '/abc');
  const pending = previewNavigationSelect(arrived, '/settings');

  assert.equal(previewNavigationIsBusy(pending), true);
  assert.equal(previewNavigationTarget(pending), '/preview/settings');
  assert.equal(pending.history.current, '/settings', 'the bar moves on the click');

  // A report for the route we left was already in flight: dropped whole, so the
  // wait stays open and the stacks are untouched — `/abc` is already in `back`
  // from the selection itself, and a second copy of it would be the bug.
  const stale = applyReport(pending, '/abc');
  assert.equal(stale, pending);
  assert.equal(previewNavigationIsBusy(stale), true);
  assert.deepEqual(stale.history.back, ['/abc']);
  assert.equal(stale.history.current, '/settings');

  // The answer itself.
  const answered = applyReport(stale, '/settings');
  assert.equal(previewNavigationIsBusy(answered), false);
});

// A redirect lands somewhere other than the target; that report still answers,
// and the new route is the one recorded.
test('a report for a redirected route closes the wait', () => {
  const pending = previewNavigationSelect(
    applyReport(previewNavigationInit(), '/abc'),
    '/settings',
  );

  const answered = applyReport(pending, '/login');

  assert.equal(previewNavigationIsBusy(answered), false);
  assert.equal(answered.history.current, '/login');
});

// Back and Forward are the same mechanism and have to close the same way.
test('back and forward open waits their reports close', () => {
  let state = applyReport(previewNavigationInit(), '/');
  state = applyReport(state, '/abc');
  state = applyReport(state, '/settings');

  const back = previewNavigationBack(state);
  assert.equal(previewNavigationIsBusy(back), true);
  assert.equal(back.history.current, '/abc');
  assert.equal(previewNavigationIsBusy(applyReport(back, '/abc')), false);

  const forward = previewNavigationForward(applyReport(back, '/abc'));
  assert.equal(previewNavigationIsBusy(forward), true);
  assert.equal(forward.history.current, '/settings');
  assert.equal(previewNavigationIsBusy(applyReport(forward, '/settings')), false);
});

// A report arriving with nothing in flight is an ordinary in-app navigation.
test('an unsolicited report is recorded without a wait', () => {
  const state = applyReport(previewNavigationInit(), '/abc');
  const next = applyReport(state, '/about');
  assert.equal(next.history.current, '/about');
  assert.equal(previewNavigationIsBusy(next), false);
});

// The hook keeps its side of the same contract, and the bounds that stop the
// track from running forever.
test('the hook uses the shared state and bounds its wait', async () => {
  const [hook, bar, css] = await Promise.all([
    readFile('app/features/workspace/hooks/use-preview-navigation.ts', 'utf8'),
    readFile('app/features/workspace/components/preview-address-bar.tsx', 'utf8'),
    readFile('app/styles/workspace.css', 'utf8'),
  ]);

  // Every transition goes through the shared module, so the rules exercised
  // above are the ones the hook runs rather than a second copy of them.
  assert.match(hook, /previewNavigationSelect\(stateRef\.current, path\)/);
  assert.match(hook, /previewNavigationReport\(stateRef\.current, display\)/);
  assert.match(hook, /previewNavigationTarget\(next\)/);
  assert.doesNotMatch(hook, /previewHistoryVisit|previewHistoryBack\(/);
  // A bounded wait: an injected tracker is absent whenever the loaded document
  // is not one the proxy rewrote, and the track must not run forever.
  assert.match(hook, /PREVIEW_NAVIGATION_MAX_MS = 15_000/);
  assert.match(hook, /setTimeout\(clearNavigation, PREVIEW_NAVIGATION_MAX_MS\)/);
  // A remount ends it too, rather than leaving the bar claiming a stale wait.
  assert.match(hook, /commit\(previewNavigationInit\(path\)\)/);

  // The bar renders the track only while the wait is open, and names it.
  assert.match(bar, /navigating && \(/);
  assert.match(bar, /className="workspace-address-progress"/);
  assert.match(bar, /role="progressbar"/);

  // The sweep is decorative: the accessible signal is the element appearing.
  assert.match(css, /\.workspace-address-progress \{[\s\S]*?position: absolute/);
  // Visible as a trough: a 2px hairline in a tinted colour read as a smudge.
  assert.match(css, /\.workspace-address-progress \{[\s\S]*?height: 3px/);
  assert.match(css, /\.workspace-address-progress \{[\s\S]*?background: var\(--n-200\)/);
  assert.match(css, /\.workspace-address-progress::after \{[\s\S]*?animation:/);
  // And it is the one piece of motion here, so it honours reduced motion.
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.workspace-address-progress::after \{[\s\S]*?animation: none/);
});
