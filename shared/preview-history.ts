/**
 * Address-bar history for the preview pane, kept entirely in the parent.
 *
 * The preview runs in a cross-origin iframe, so its real history stack is not
 * readable and `history.back()` cannot be relied on to produce an observable
 * result. This module is the two stacks instead: `back` holds the routes the
 * pane came through, `forward` the ones it backed out of. Selecting a route and
 * following an in-app link are both a plain visit; Back and Forward move one
 * entry between the stacks.
 *
 * Keep it runtime-agnostic and side-effect free — the hook and the tests both
 * call it directly.
 */

import { previewTrackedPathFromDisplayPath } from './preview-display-path.ts';

export type PreviewHistoryState = {
  /** The route currently shown, in tracker form (`/preview/about?x=1`). */
  current: string;
  /** Oldest first; the last entry is where Back goes. */
  back: string[];
  /** Next entry first; the first entry is where Forward goes. */
  forward: string[];
};

/** Back and forward stay useful without growing a conversation-long list. */
export const PREVIEW_HISTORY_LIMIT = 100;

export const EMPTY_PREVIEW_HISTORY: PreviewHistoryState = {
  current: '',
  back: [],
  forward: [],
};

export function previewHistoryReset(path = ''): PreviewHistoryState {
  return path ? { current: path, back: [], forward: [] } : { ...EMPTY_PREVIEW_HISTORY };
}

function capBack(back: string[]) {
  return back.length > PREVIEW_HISTORY_LIMIT
    ? back.slice(back.length - PREVIEW_HISTORY_LIMIT)
    : back;
}

/**
 * A route the pane arrived at — a menu selection, an in-app link, a redirect.
 * Visiting a new route is where Forward is discarded, which is what a browser
 * does too.
 */
export function previewHistoryVisit(
  history: PreviewHistoryState,
  path: string,
): PreviewHistoryState {
  if (!path || path === history.current) return history;
  const back = history.current ? capBack([...history.back, history.current]) : history.back;
  return { current: path, back, forward: [] };
}

export function previewHistoryBack(history: PreviewHistoryState) {
  if (history.back.length === 0) return null;
  const target = history.back[history.back.length - 1];
  return {
    target,
    state: {
      current: target,
      back: history.back.slice(0, -1),
      forward: history.current
        ? [history.current, ...history.forward]
        : history.forward,
    } satisfies PreviewHistoryState,
  };
}

export function previewHistoryForward(history: PreviewHistoryState) {
  if (history.forward.length === 0) return null;
  const [target, ...rest] = history.forward;
  return {
    target,
    state: {
      current: target,
      back: history.current ? capBack([...history.back, history.current]) : history.back,
      forward: rest,
    } satisfies PreviewHistoryState,
  };
}

/**
 * The whole navigation state, not just the stacks.
 *
 * A route change is a document load in a frame this side cannot observe, so a
 * request stays open until a report from the frame's tracker answers it. That
 * wait is the third piece of state, and it belongs here rather than in the hook:
 * which reports answer a request and which are stale is a rule about the
 * navigation, and it is the rule a repeated selection used to get wrong.
 */
export type PreviewNavigationState = {
  history: PreviewHistoryState;
  /**
   * The route a request left from and where it is headed, while one is in
   * flight. `null` means nothing is being waited on.
   */
  pending: { from: string; target: string } | null;
};

export function previewNavigationInit(path = ''): PreviewNavigationState {
  return { history: previewHistoryReset(path), pending: null };
}

export function previewNavigationIsBusy(state: PreviewNavigationState) {
  return state.pending !== null;
}

/**
 * Where the frame should be sent for this transition, or `null` when the
 * transition moves nowhere.
 */
export function previewNavigationTarget(state: PreviewNavigationState) {
  const pending = state.pending;
  return pending ? previewTrackedPathFromDisplayPath(pending.target) : null;
}

function begin(
  history: PreviewHistoryState,
  from: string,
  target: string,
): PreviewNavigationState {
  return { history, pending: { from, target } };
}

/**
 * A route chosen from the list.
 *
 * Choosing the route already showing is not a move: it would open a wait whose
 * answer — a report naming the route the request "left" — is indistinguishable
 * from a stale one, so nothing could ever close it. The list already marks the
 * current entry, and reloading the frame is what Refresh is for.
 */
export function previewNavigationSelect(
  state: PreviewNavigationState,
  path: string,
): PreviewNavigationState {
  // Returned untouched rather than clearing any pending request: re-choosing
  // the entry that is already showing is a no-op, and a request that is
  // genuinely in flight still needs its report.
  if (!path || path === state.history.current) return state;
  const from = state.history.current;
  return begin(previewHistoryVisit(state.history, path), from, path);
}

export function previewNavigationBack(state: PreviewNavigationState) {
  const step = previewHistoryBack(state.history);
  if (!step) return state;
  return begin(step.state, state.history.current, step.target);
}

export function previewNavigationForward(state: PreviewNavigationState) {
  const step = previewHistoryForward(state.history);
  if (!step) return state;
  return begin(step.state, state.history.current, step.target);
}

/**
 * A report from the tracker, already normalised to display form.
 *
 * A report naming the route the request left is one that was in flight when the
 * click happened: applying it would push the route just left back onto the
 * stack, so it is dropped whole. Any other report is the answer — the target
 * asked for, or wherever a redirect landed — and closes the wait.
 */
export function previewNavigationReport(
  state: PreviewNavigationState,
  displayPath: string,
): PreviewNavigationState {
  const pending = state.pending;
  if (pending) {
    if (displayPath === pending.from) return state;
  }
  return {
    history: previewHistoryVisit(state.history, displayPath),
    pending: null,
  };
}
