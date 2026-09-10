/**
 * The agent-loop seam.
 *
 * Everything above this port speaks domain events; everything below it speaks
 * one vendor's SDK. That is the whole contract, and it is the reason a driver
 * can be replaced without the pipelines, the presenters, or the frontend
 * noticing.
 *
 * The rule that keeps it true is mechanical rather than aspirational: no file
 * outside `core/drivers/` may import a vendor agent SDK (asserted in
 * tests/architecture.test.ts). An abstraction nobody is forced through decays
 * into decoration, which is exactly what happened to the first attempt here.
 */

import type { CancellationPort } from '../_ports.ts';
import type { DomainEvent } from '../_events.ts';

export type AgentSessionBinding = {
  /** Continue an existing transcript. */
  resume?: string;
  /** Open a new transcript under this id. */
  sessionId?: string;
  /**
   * Vendor transcript mirror, when the host provides one. Opaque here because
   * its shape is the driver's business.
   */
  store?: unknown;
};

export type AgentTurnInput = {
  /** Correlates every event of this turn. */
  runId: string;
  /** The cacheable half of the prompt. Must be stable across turns. */
  systemPrompt: string;
  /** The per-turn half: this request, its language, its context. */
  prompt: string;
  model: string;
  /** In-process MCP servers this turn may call. */
  servers: { name: string; tools: unknown[] }[];
  /** Names the model is permitted to call. */
  allowedTools: string[];
  session?: AgentSessionBinding;
  /** Extra process environment, for drivers that spawn a subprocess. */
  env?: Record<string, string>;
  cwd?: string;
  debug?: boolean;
  /** Absolute path to a vendor CLI, when the host pins one. */
  executablePath?: string;
  onStderr?: (data: string) => void;
  cancellation?: CancellationPort;
};

export type AgentTurnOutcome = 'completed' | 'failed' | 'stopped';

export type AgentTurnResult = {
  outcome: AgentTurnOutcome;
  /** Model prose concluding the turn, when it produced any. */
  summary: string;
  /**
   * Host-facing failure text. Distinct from `DomainEvent`'s `FailureReason`
   * codes: this carries a vendor message a human needs to read, which a code
   * cannot express.
   */
  error?: string;
  /** The run hit an unrecoverable host failure; do not retry into it. */
  fatal?: boolean;
};

export type AgentTurnRun = {
  events: AsyncIterable<DomainEvent>;
  /** Meaningful only once `events` is exhausted. */
  result(): AgentTurnResult;
};

export type AgentDriverPort = {
  /** Matches the `agents.framework` this deployment is configured for. */
  readonly framework: string;
  runTurn(input: AgentTurnInput): AgentTurnRun;
};
