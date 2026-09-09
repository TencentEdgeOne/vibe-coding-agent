/**
 * The core entry point.
 *
 * Everything here is host-agnostic: ports in, domain events out. There is no
 * Response, no SSE framing, no `context`. That is the whole point of the PoC —
 * today `runChatPipeline(context)` both runs the agent and writes an HTTP
 * stream, so a CLI cannot reuse it. `runTurn` splits those jobs apart.
 */

import type { DomainEvent } from './_events.ts';
import type { AgentPorts } from './_ports.ts';

export type TurnRequest = {
  conversationId: string;
  message: string;
  /** Stable id for the turn, so a reconnecting host can dedupe. */
  runId?: string;
  /** Discard the existing workspace before running. */
  resetWorkspace?: boolean;
  /** Empty or absent runs the deployment default. */
  model?: string;
};

/**
 * Run one agent turn.
 *
 * The return type is the contract that makes multiple frontends possible:
 *
 *   // Makers HTTP host
 *   for await (const event of runTurn(ports, req)) send(toSseEvent(event));
 *
 *   // CLI host
 *   for await (const event of runTurn(ports, req)) printLine(event);
 *
 *   // SDK host
 *   export { runTurn };
 */
export type TurnRunner = (
  ports: AgentPorts,
  request: TurnRequest,
) => AsyncIterable<DomainEvent>;

/** A restored conversation, as facts. Hosts decide what to render and when. */
export type ConversationSnapshot = {
  conversationId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  hasWorkspace: boolean;
  /** Present only when a preview server is currently serving. */
  preview?: { url: string; serverGeneration: number };
  model?: string;
  /** A turn still running from a previous connection, if any. */
  activeRunId?: string;
};

/**
 * Read a conversation's current state.
 *
 * Deliberately not staged. `ResumeData.stage` ('history' | 'workspace' |
 * 'preview') encodes the web client's progressive paint, which forces the
 * server to know about UI batching. A host that wants three paints calls the
 * cheap parts first and composes them itself; a CLI just awaits the whole thing.
 */
export type SnapshotReader = (
  ports: AgentPorts,
  conversationId: string,
) => Promise<ConversationSnapshot>;

/** Cancel an in-flight turn. Cooperative, via CancellationPort. */
export type TurnCanceller = (
  ports: AgentPorts,
  conversationId: string,
  options?: { discardWorkspace?: boolean },
) => Promise<void>;

export type AgentCore = {
  runTurn: TurnRunner;
  readSnapshot: SnapshotReader;
  cancelTurn: TurnCanceller;
};
