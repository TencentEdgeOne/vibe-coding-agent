/**
 * Domain events emitted by the agent core.
 *
 * These describe what happened in the run, never how a client should draw it.
 * Contrast with shared/protocol.ts, whose ChatStreamEvent / ResumeData carry
 * presentation decisions the browser happens to need today:
 *
 *   - `ResumeData.stage: 'history' | 'workspace' | 'preview'` is a paint order.
 *   - `ResumeData.needsWorkspace` tells the client which request to send next.
 *   - `LinkInfo.restarted` exists to invalidate an already-loaded iframe.
 *   - `phaseHint` / `inputSummary` / `outputSummary` are prerendered UI strings.
 *
 * A CLI or SDK consumer cannot act on any of those. So the core emits facts and
 * leaves batching, reloading, and wording to each host:
 *
 *   - Web maps `preview.ready` to an iframe src, and decides on its own whether
 *     a new `serverGeneration` means it must reload.
 *   - CLI prints `tool.invoked` as a log line and ignores preview entirely.
 *   - SDK just yields the events.
 */

export type TurnOutcome = 'completed' | 'failed' | 'stopped';

export type VerificationStatus = 'success' | 'failed' | 'skipped';

/** Machine-readable tool classification. Hosts choose the label and icon. */
export type ToolKind =
  | 'file.write'
  | 'file.read'
  | 'file.remove'
  | 'dir.create'
  | 'command.run'
  | 'dependency.install'
  | 'preview.publish'
  | 'scaffold'
  | 'other';

export type DomainEvent =
  /** A turn began. `runId` is stable across reconnects. */
  | { type: 'turn.started'; runId: string; conversationId: string; at: number }
  /** Assistant prose, already sanitized, streamed as it arrives. */
  | { type: 'assistant.text'; runId: string; blockId: string; text: string; at: number }
  /** The model asked for a tool. `raw` keeps the unsummarized input for hosts that want it. */
  | {
      type: 'tool.invoked';
      runId: string;
      toolUseId: string;
      name: string;
      kind: ToolKind;
      command?: string;
      raw?: unknown;
      at: number;
    }
  | {
      type: 'tool.settled';
      runId: string;
      toolUseId: string;
      ok: boolean;
      exitCode?: number;
      /** Untruncated tool output. Hosts truncate for their own display. */
      output?: string;
      at: number;
    }
  /** Workspace contents changed. Paths are workspace-relative. */
  | { type: 'workspace.changed'; runId?: string; paths: string[]; at: number }
  /**
   * A preview server is serving the project. `serverGeneration` increments on
   * every (re)boot, which is the fact behind the old `restarted` flag: a client
   * that cached generation N can tell it must re-fetch, and one that never
   * rendered a preview can ignore it.
   */
  | {
      type: 'preview.ready';
      runId?: string;
      url: string;
      serverGeneration: number;
      at: number;
    }
  | { type: 'preview.failed'; runId?: string; reason: FailureReason; at: number }
  | {
      type: 'verification.finished';
      runId: string;
      status: VerificationStatus;
      stdout?: string;
      stderr?: string;
      at: number;
    }
  /**
   * The turn ended. `summary` is model prose when the model produced any.
   * When it did not, the core sets `reason` instead of inventing a sentence, so
   * localized copy stays in the host. This replaces
   * buildRequirementConclusionFallback, which hardcoded Chinese and English
   * strings (including "右侧预览面板") inside the runtime.
   */
  | {
      type: 'turn.finished';
      runId: string;
      outcome: TurnOutcome;
      summary?: string;
      reason?: FailureReason;
      at: number;
    };

/** Codes, not sentences. Every host renders these in its own voice and locale. */
export type FailureReason =
  | 'model_returned_no_output'
  | 'model_error'
  | 'tool_fatal_error'
  | 'verification_failed'
  | 'preview_boot_failed'
  | 'workspace_unavailable'
  | 'cancelled'
  | 'timeout';

export type DomainEventOf<T extends DomainEvent['type']> = Extract<DomainEvent, { type: T }>;
