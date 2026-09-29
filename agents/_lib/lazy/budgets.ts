/**
 * One home for the budgets. The preview budget has to leave room for the
 * install and the dev server boot that happen inside it.
 */
export const READINESS_BUDGET_MS = {
  /** A `find` against a sandbox that is up. Not a restore. */
  probe: 15_000,
  /** Pulling the Blob archive down and unpacking it. */
  restore: 45_000,
  /** npm install on a cold workspace. */
  dependencies: 300_000,
  /** Install plus dev server boot plus the route gates, worst case. */
  preview: 540_000,
  /** Everything a cold resume does before the panel has files and a preview. */
  workspace: 600_000,
} as const;

export const SANDBOX_EXTENSION_SECONDS = 1800;

/**
 * `agents.timeout` in edgeone.json. The platform ends a request at this age,
 * and a turn is only guaranteed CPU while its `/prompt` request is in flight.
 * Kept equal to the config by a test, not read from it at runtime.
 */
export const AGENT_RUN_TIMEOUT_SECONDS = 1800;

/** Left for the final snapshot, transcript upload, and status write. */
const TURN_FINALIZE_RESERVE_SECONDS = 180;

/**
 * Longest an observer stream (`/session` attach, `/transcript`) stays open. The
 * platform does not tell a handler its reader left, so a closed tab's stream
 * holds a request slot until the server ends it.
 */
export const OBSERVER_STREAM_MAX_MS = 60_000;

/** A turn that runs this long is wound down so it ends inside its request. */
export const TURN_BUDGET_MS = (AGENT_RUN_TIMEOUT_SECONDS - TURN_FINALIZE_RESERVE_SECONDS) * 1000;
