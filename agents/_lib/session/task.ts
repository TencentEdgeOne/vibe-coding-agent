import type { AgentContext } from '../runtime/context.ts';
import { TURN_BUDGET_MS } from '../lazy/budgets.ts';
import { runChatPipeline } from '../turn/chat.ts';
import { runDeployPipeline } from '../turn/deploy.ts';
import {
  getChatTask,
  patchConversationRecord,
  saveChatTask,
} from './store.ts';
import { interruptLiveQuery } from './live.ts';
import type { ChatTask, ChatTaskKind, ChatTaskStatus, StreamSend } from '../types.ts';
import { createSSEResponse, sseEvent } from '../runtime/sse.ts';
import { resolveConversationId } from '../runtime/request.ts';
import { resolveGatewayUserTurn } from '../../../shared/gateway-secret.ts';
import type { ChatStreamEvent } from '../../../shared/protocol.ts';
import { TURN_LIMIT_REPLY, replyLocaleFor } from '../../../shared/user-facing-reply.ts';
import { instanceId } from '../runtime/instance.ts';
import { unbindLiveWorkspace } from './live-workspace.ts';
import {
  FENCE_WATCH_MS,
  FencedError,
  PROGRESS_EVERY_WATCHES,
  TurnRunningElsewhereError,
  confirmEpoch,
  enterConversation,
  onOwnershipLost,
} from './ownership.ts';

type SequencedEvent = {
  sequence: number;
  event: ChatStreamEvent;
};

type TaskListener = (event: SequencedEvent) => void;

type LiveChatTask = {
  conversationId: string;
  task: ChatTask;
  events: SequencedEvent[];
  nextSequence: number;
  listeners: Set<TaskListener>;
  abortController: AbortController;
  runPromise?: Promise<void>;
  gatewayApiKey?: string;
  gatewaySkip?: boolean;
  /** Wound down by the turn budget rather than by the user. */
  limitReached?: boolean;
};

const liveTasks = new Map<string, LiveChatTask>();

/**
 * `idle`: no turn of this conversation runs in this process. `stopped`: the
 * turn ended and its outcome is persisted. `stopping`: it was told to stop and
 * is still saving its work.
 */
export type StopOutcome = 'stopped' | 'stopping' | 'idle';

function abortLiveTask(liveTask: LiveChatTask) {
  if (liveTask.abortController.signal.aborted) return;
  liveTask.abortController.abort();
  void interruptLiveQuery(liveTask.conversationId);
}

function findRunningLiveTask(conversationId: string) {
  for (const liveTask of liveTasks.values()) {
    if (liveTask.conversationId === conversationId && liveTask.runPromise && isChatTaskActive(liveTask.task)) {
      return liveTask;
    }
  }
  return undefined;
}

/**
 * Stop the turn this process runs for the conversation. The turn's status only
 * changes when the turn itself finishes saving, so a new prompt cannot start
 * against a sandbox the stopped turn is still writing to.
 */
export async function stopLiveChatTask(
  conversationId: string,
  options: { waitMs?: number } = {},
): Promise<StopOutcome> {
  const liveTask = findRunningLiveTask(conversationId.trim());
  if (!liveTask?.runPromise) return 'idle';
  abortLiveTask(liveTask);
  const waitMs = options.waitMs ?? 0;
  if (waitMs <= 0) return 'stopping';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    liveTask.runPromise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), waitMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return finished ? 'stopped' : 'stopping';
}

onOwnershipLost((conversationId) => {
  const liveTask = findRunningLiveTask(conversationId);
  if (liveTask) abortLiveTask(liveTask);
});

/**
 * The record says a turn is running, and this process runs none.
 *
 * `elsewhere`: another instance owns it and it is still making progress, as
 * after a redeploy; it is left alone. `settled`: its owner is gone, so the
 * conversation is claimed here and the turn recorded as stopped or failed.
 */
export async function settleUnrunTask(
  context: AgentContext,
  conversationId: string,
  intent: 'read' | 'stop',
): Promise<'settled' | 'elsewhere' | 'none'> {
  const existing = await getChatTask(context, conversationId);
  if (!isChatTaskActive(existing) || findRunningLiveTask(conversationId)) return 'none';
  const entry = await enterConversation(context, conversationId, intent);
  if (entry.role === 'observer') return 'elsewhere';
  if (entry.tookOver) return 'settled';
  // This process owns the conversation and no longer runs the turn, which is
  // what a restart mid-turn leaves behind.
  console.warn('[chat-task] orphaned task has no live runner on this instance', {
    instance: instanceId(),
    conversationId,
    taskId: existing.id,
    status: existing.status,
  });
  await saveChatTask(context, conversationId, {
    ...existing,
    status: intent === 'stop' ? 'stopped' : 'failed',
    finishedAt: Date.now(),
    ...(intent === 'stop' ? {} : { error: 'The previous generation stopped before it finished.' }),
  });
  return 'settled';
}

const conversationLocks = new Map<string, Promise<void>>();

/**
 * One turn start at a time per conversation. Session affinity sends every
 * request of a conversation to this process, so an in-process lock is enough.
 */
async function withConversationLock<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
  const previous = conversationLocks.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  conversationLocks.set(conversationId, tail);
  try {
    await previous;
    return await run();
  } finally {
    release();
    if (conversationLocks.get(conversationId) === tail) conversationLocks.delete(conversationId);
  }
}

function taskKey(conversationId: string, taskId: string) {
  return `${conversationId}:${taskId}`;
}

function createTaskId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getConversationId(context: AgentContext): string {
  return resolveConversationId(context).conversationId.trim();
}

function isTerminalEvent(event: ChatStreamEvent) {
  return event.type === 'result' || event.type === 'error';
}

function statusFromResult(event: ChatStreamEvent): ChatTaskStatus {
  const data = event.type === 'result' && event.data ? event.data : {};
  if (data.stopped === true) return 'stopped';
  return data.ok === false ? 'failed' : 'completed';
}

function getOrCreateLiveTask(conversationId: string, task: ChatTask): LiveChatTask {
  const key = taskKey(conversationId, task.id);
  const existing = liveTasks.get(key);
  if (existing) return existing;

  const liveTask: LiveChatTask = {
    conversationId,
    task,
    events: [],
    nextSequence: 0,
    listeners: new Set(),
    abortController: new AbortController(),
  };
  liveTasks.set(key, liveTask);
  return liveTask;
}

function publish(liveTask: LiveChatTask, event: ChatStreamEvent) {
  const record = {
    sequence: ++liveTask.nextSequence,
    event,
  };
  liveTask.events.push(record);
  if (liveTask.events.length > 2_000) {
    liveTask.events.splice(0, liveTask.events.length - 2_000);
  }
  for (const listener of liveTask.listeners) listener(record);
}

export function isChatTaskActive(
  task: ChatTask | null | undefined,
): task is ChatTask & { status: 'queued' | 'running' } {
  return task?.status === 'queued' || task?.status === 'running';
}

export function hasLiveChatTask(conversationId: string, taskId: string) {
  const live = liveTasks.get(taskKey(conversationId, taskId));
  return Boolean(live?.runPromise);
}

type ChatTaskOptions = {
  turnId?: string;
  kind?: ChatTaskKind;
  model?: string;
  language?: string;
  apiKey?: string;
  gatewaySkip?: boolean;
};

async function createChatTask(
  context: AgentContext,
  message: string,
  options: ChatTaskOptions = {},
) {
  const conversationId = getConversationId(context);
  if (!conversationId) {
    return {
      ok: false as const,
      status: 400,
      error: 'Missing conversationId. The project workspace cannot be prepared.',
    };
  }

  return withConversationLock(conversationId, async () => {
    // A turn start owns the conversation: it claims it unless a turn elsewhere
    // is still making progress, and a claim settles the turn a gone owner left.
    try {
      await enterConversation(context, conversationId, 'write');
    } catch (error) {
      if (!(error instanceof TurnRunningElsewhereError)) throw error;
      return { ok: false as const, status: 409, code: error.code, error: error.message };
    }

    const taskId = options.turnId || createTaskId();
    const existing = await getChatTask(context, conversationId);
    if (existing && existing.id === taskId && existing.message === message) {
      return { ok: true as const, conversationId, task: existing };
    }
    if (findRunningLiveTask(conversationId)) {
      return {
        ok: false as const,
        status: 409,
        error: 'Another generation is already running for this conversation.',
      };
    }

    const requestedModel = (options.model || '').trim();
    const language = (options.language || '').trim();
    const task: ChatTask = {
      id: taskId,
      message,
      ...(options.kind === 'deploy' ? { kind: 'deploy' as const } : { kind: 'prompt' as const }),
      ...(requestedModel ? { model: requestedModel } : {}),
      preparePhase: 'accepted',
      status: 'queued',
      createdAt: Date.now(),
    };
    // One write for all three fields the request carries. Saving the task,
    // model, and language separately cost two extra Blob round trips before
    // the stream could start.
    await patchConversationRecord(context, conversationId, {
      chatTask: task,
      ...(requestedModel ? { modelPreference: requestedModel } : {}),
      ...(language === 'zh' || language === 'en' ? { languagePreference: language } : {}),
    });
    return { ok: true as const, conversationId, task };
  });
}

function withTaskAbortSignal(context: AgentContext, signal: AbortSignal) {
  const request = context?.request && typeof context.request === 'object'
    ? { ...context.request, signal }
    : { signal };
  return { ...context, request };
}

function withTurnLimitReply(event: ChatStreamEvent, message: string): ChatStreamEvent {
  if (event.type !== 'result') return event;
  return {
    type: 'result',
    data: {
      ...event.data,
      ok: false,
      stopped: true,
      reply: TURN_LIMIT_REPLY[replyLocaleFor(message)],
    },
  };
}

async function executeLiveTask(context: AgentContext, liveTask: LiveChatTask) {
  const runningTask: ChatTask = {
    ...liveTask.task,
    status: 'running',
    startedAt: liveTask.task.startedAt || Date.now(),
    progressAt: Date.now(),
    error: undefined,
  };
  liveTask.task = runningTask;
  let finalEvent: ChatStreamEvent | undefined;
  let error: string | undefined;
  // A terminal event ends every subscriber's stream, including the `/prompt`
  // request this turn runs inside. Once that request is gone the instance has
  // no CPU guarantee, so the outcome is persisted before the event goes out.
  const held: ChatStreamEvent[] = [];
  const send: StreamSend = (event) => {
    if (isTerminalEvent(event)) {
      held.push(event);
      finalEvent = event;
      return;
    }
    publish(liveTask, event);
  };
  const taskContext = withTaskAbortSignal(context, liveTask.abortController.signal);
  const budget = setTimeout(() => {
    liveTask.limitReached = true;
    abortLiveTask(liveTask);
  }, TURN_BUDGET_MS);
  budget.unref?.();

  // Each watch asks whether a newer owner took the conversation (losing it
  // aborts this turn) and, every few watches, records progress so a request
  // landing elsewhere can tell this turn is alive. Watches run one after
  // another and stop before the final status is written, so a slow progress
  // write can never land on top of it.
  let watches = 0;
  let finished = false;
  let watching: Promise<void> = Promise.resolve();
  const watch = setInterval(() => {
    watches += 1;
    const recordProgress = watches % PROGRESS_EVERY_WATCHES === 0;
    watching = watching.then(async () => {
      if (finished || !(await confirmEpoch(taskContext, liveTask.conversationId))) return;
      if (!recordProgress || finished) return;
      liveTask.task = { ...liveTask.task, progressAt: Date.now() };
      await saveChatTask(taskContext, liveTask.conversationId, liveTask.task);
    }).catch((watchError) => {
      console.warn('[chat-task] watch failed', watchError);
    });
  }, FENCE_WATCH_MS);
  watch.unref?.();

  try {
    await saveChatTask(taskContext, liveTask.conversationId, runningTask);
    const gateway = {
      ...(liveTask.gatewayApiKey ? { apiKey: liveTask.gatewayApiKey } : {}),
      ...(liveTask.gatewaySkip ? { gatewaySkip: true } : {}),
    };
    liveTask.gatewayApiKey = undefined;
    liveTask.gatewaySkip = undefined;
    const input = {
      kind: liveTask.task.kind === 'deploy' ? 'deploy' as const : 'prompt' as const,
      message: liveTask.task.message,
      turnId: liveTask.task.id,
      model: liveTask.task.model,
    };
    if (context.runTurn) {
      await context.runTurn(taskContext, input, send);
    } else if (input.kind === 'deploy') {
      await runDeployPipeline(taskContext, input.message, send, { turnId: input.turnId, ...gateway });
    } else {
      await runChatPipeline(taskContext, input.message, send, {
        turnId: input.turnId,
        model: input.model,
        ...gateway,
      });
    }
  } catch (runError) {
    error = runError instanceof Error ? runError.message : 'Request processing failed.';
    if (!finalEvent) {
      finalEvent = { type: 'error', error };
      held.push(finalEvent);
    }
  } finally {
    clearTimeout(budget);
    clearInterval(watch);
    finished = true;
    unbindLiveWorkspace(liveTask.conversationId);
  }
  await watching;

  const current = liveTask.task;
  const aborted = liveTask.abortController.signal.aborted;
  const nextStatus: ChatTaskStatus = finalEvent?.type === 'result'
    ? (liveTask.limitReached ? 'stopped' : statusFromResult(finalEvent))
    : error
      ? 'failed'
      : aborted ? 'stopped' : 'completed';
  const nextTask: ChatTask = {
    ...current,
    status: nextStatus,
    finishedAt: Date.now(),
    ...(error ? { error } : {}),
  };
  try {
    await saveChatTask(taskContext, liveTask.conversationId, nextTask);
  } catch (persistError) {
    if (persistError instanceof FencedError) {
      console.warn('[chat-task] a newer owner took the conversation; this turn\'s outcome is not saved', {
        instance: instanceId(),
        conversationId: liveTask.conversationId,
        taskId: nextTask.id,
        epoch: taskContext.epoch,
      });
    } else {
      console.error('[chat-task] failed to persist final task state', persistError);
    }
  }
  // The status flips only now: a subscriber that attaches while the outcome is
  // being saved still waits for the terminal event instead of leaving early.
  liveTask.task = nextTask;
  if (held.length === 0) {
    held.push({
      type: 'result',
      data: {
        ok: nextStatus === 'completed',
        conversation_id: liveTask.conversationId,
        ...(nextStatus === 'stopped' ? { stopped: true } : {}),
      },
    });
  }
  for (const event of held) {
    publish(liveTask, liveTask.limitReached ? withTurnLimitReply(event, current.message) : event);
  }

  const key = taskKey(liveTask.conversationId, liveTask.task.id);
  const cleanup = setTimeout(() => {
    if (liveTask.listeners.size === 0 && !isChatTaskActive(liveTask.task) && liveTasks.get(key) === liveTask) {
      liveTasks.delete(key);
    }
  }, 5 * 60 * 1_000);
  cleanup.unref?.();
}

function ensureChatTaskStarted(
  context: AgentContext,
  conversationId: string,
  task: ChatTask,
  extras?: { gatewayApiKey?: string; gatewaySkip?: boolean },
) {
  const liveTask = getOrCreateLiveTask(conversationId, task);
  if (extras?.gatewayApiKey) liveTask.gatewayApiKey = extras.gatewayApiKey;
  if (extras?.gatewaySkip) liveTask.gatewaySkip = true;
  if (!liveTask.runPromise && isChatTaskActive(liveTask.task)) {
    liveTask.runPromise = executeLiveTask(context, liveTask).catch((error) => {
      console.error('[chat-task] execution failed', error);
    });
  }
  return liveTask;
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  next() {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

const ABORTED = Symbol('aborted');
const DEADLINE = Symbol('deadline');

export type AttachOptions = {
  /** Replay only events after this sequence: the last one a reopened observer saw. */
  afterSeq?: number;
  /** End with a `reconnect` event after this long if the turn is still running. */
  maxMs?: number;
};

/** The turn this process holds for the conversation, running or recently finished. */
export function findLiveChatTask(conversationId: string, turnId: string): ChatTask | null {
  return liveTasks.get(taskKey(conversationId, turnId))?.task || null;
}

export async function* iterateLiveChatTaskEvents(
  context: AgentContext,
  conversationId: string,
  task: ChatTask,
  extras?: { gatewayApiKey?: string; gatewaySkip?: boolean },
  signal?: AbortSignal,
  options: AttachOptions = {},
): AsyncGenerator<string> {
  const liveTask = ensureChatTaskStarted(context, conversationId, task, extras);
  const replayAfter = options.afterSeq ?? 0;
  if (options.afterSeq === undefined) {
    yield sseEvent({
      type: 'task_started',
      data: {
        runId: task.id,
        conversation_id: conversationId,
        status: task.status,
        preparePhase: task.preparePhase || 'accepted',
      },
    });
  }
  const queue = new AsyncEventQueue<SequencedEvent>();
  const bufferedUpTo = liveTask.nextSequence;
  let lastSeq = replayAfter;
  const listener: TaskListener = (record) => {
    if (record.sequence > bufferedUpTo) queue.push(record);
  };
  liveTask.listeners.add(listener);
  const frame = (record: SequencedEvent) => {
    lastSeq = record.sequence;
    return sseEvent({ ...record.event, seq: record.sequence });
  };
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    for (const record of liveTask.events) {
      if (record.sequence <= replayAfter || record.sequence > bufferedUpTo) continue;
      yield frame(record);
      if (isTerminalEvent(record.event)) return;
    }
    if (!isChatTaskActive(liveTask.task)) return;

    const stops: Array<Promise<typeof ABORTED | typeof DEADLINE>> = [];
    if (signal) {
      stops.push(new Promise((resolve) => {
        if (signal.aborted) resolve(ABORTED);
        else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
      }));
    }
    if (options.maxMs) {
      stops.push(new Promise((resolve) => {
        deadlineTimer = setTimeout(() => resolve(DEADLINE), options.maxMs);
      }));
    }

    while (!signal?.aborted) {
      const record = await Promise.race([queue.next(), ...stops]);
      if (record === ABORTED) return;
      if (record === DEADLINE) {
        yield sseEvent({ type: 'reconnect', data: { turnId: liveTask.task.id, afterSeq: lastSeq } });
        return;
      }
      yield frame(record);
      if (isTerminalEvent(record.event)) return;
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    liveTask.listeners.delete(listener);
  }
}

function createLiveTaskStreamResponse(
  context: AgentContext,
  conversationId: string,
  task: ChatTask,
  extras?: { gatewayApiKey?: string; gatewaySkip?: boolean },
) {
  return createSSEResponse(async function* (signal) {
    yield* iterateLiveChatTaskEvents(context, conversationId, task, extras, signal);
  }, context?.request?.signal);
}

export async function createChatTaskAndStreamResponse(
  context: AgentContext,
  message: string,
  options: ChatTaskOptions = {},
) {
  const resolved = resolveGatewayUserTurn(message, options.apiKey);
  const result = await createChatTask(context, resolved.message, {
    ...options,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
  });
  if (!result.ok) {
    return new Response(JSON.stringify(result), {
      status: result.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return createLiveTaskStreamResponse(context, result.conversationId, result.task, {
    ...(resolved.apiKey ? { gatewayApiKey: resolved.apiKey } : {}),
    ...(options.gatewaySkip ? { gatewaySkip: true } : {}),
  });
}
