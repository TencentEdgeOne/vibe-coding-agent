import {
  query,
  type HookInput,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { rm } from 'node:fs/promises';
import { OWNER_CHECK_CACHE_MS, confirmEpoch, onOwnershipLost } from './ownership.ts';
import {
  DEFAULT_PATH,
  GATEWAY_CONVERSATION_ID_HEADER_NAME,
  GATEWAY_QUOTA_BYPASS_HEADER,
  GATEWAY_QUOTA_PROMPT_HEADER,
  SANDBOX_MCP_SERVER_NAME,
} from '../constants.ts';
import {
  describeModelRun,
  resolveConfiguredModel,
} from '../models.ts';
import type { AgentContext } from '../runtime/context.ts';
import {
  assembleAgentTools,
  emptyCodingResult,
  type LiveSessionHandle,
  type LiveTurnCallbacks,
} from '../tools/assemble.ts';
import type {
  AgentProgressEvent,
  CodingAgentResult,
  ProjectState,
} from '../types.ts';
import { detectFatalToolError, truncateForStream } from '../utils/text.ts';
import { sanitizeAssistantText, summarizeToolOutput, toolPaintsOwnProgress } from '../../../shared/timeline.ts';
import { parseEchoedExitCode } from '../makers/tool-phase.ts';
import { buildPrompt } from '../prompt.ts';
import { projectWriteHooks } from '../tools/project-write-hooks.ts';
import { getConversationRecord, patchConversationRecord } from './store.ts';
import { downloadTranscript, resolveClaudeTranscriptPath, uploadTranscript } from './transcript.ts';
import { PromptQueue } from './prompt-queue.ts';
import {
  createProgressEmitter,
  describeSdkMessage,
  extractVisibleNarrationDelta,
  extractVisibleTextBlock,
  extractVisibleThinkingBlock,
  extractVisibleThinkingDelta,
  formatResultUsage,
  isThinkingContentBlock,
  isToolUseContentBlock,
  parseToolInputJson,
  type StreamingToolUseBlock,
} from './stream-projector.ts';

type TurnWaiter = {
  callbacks: LiveTurnCallbacks;
  onProgress?: (event: AgentProgressEvent) => void;
  resolve: (result: CodingAgentResult) => void;
};

type LiveQuerySession = LiveSessionHandle & {
  queue: PromptQueue;
  query: Query;
  sessionId?: string;
  transcriptPath?: string;
  model: string;
  turn?: TurnWaiter;
  state: ProjectState;
  pump: Promise<void>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** The local JSONL as it stands is in Blob, so the local copy may go. */
  transcriptSaved?: boolean;
};

/** Close a process that finished a turn and never received another, so an abandoned conversation does not leak one. */
export const LIVE_QUERY_IDLE_MS = 5 * 60 * 1000;

/**
 * An instance hosts several conversations in 2 GB, and each warm CLI holds a
 * few hundred MB. Past this many, idle ones are closed after a minute instead.
 */
const WARM_QUERIES_PER_INSTANCE = 3;
const CROWDED_IDLE_MS = 60 * 1000;

const liveQueries = new Map<string, LiveQuerySession>();

export type StartLiveQueryOptions = {
  context: AgentContext;
  conversationId: string;
  state: ProjectState;
  abortSignal?: AbortSignal;
  model?: string;
};

export type RunCodingAgentOptions = StartLiveQueryOptions & {
  userMessage: string;
  onProgress?: (event: AgentProgressEvent) => void;
  onProjectFilesChanged?: LiveTurnCallbacks['onProjectFilesChanged'];
  onPreviewReady?: LiveTurnCallbacks['onPreviewReady'];
  onDeploymentStatus?: LiveTurnCallbacks['onDeploymentStatus'];
  send?: LiveTurnCallbacks['send'];
};

function pickEnvValue(context: AgentContext, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function buildAnthropicCustomHeaders(customHeaders: string, conversationId: string) {
  const safeConversationId = sanitizeHeaderValue(conversationId);
  return [
    customHeaders,
    GATEWAY_QUOTA_BYPASS_HEADER,
    GATEWAY_QUOTA_PROMPT_HEADER,
    safeConversationId
      ? `${GATEWAY_CONVERSATION_ID_HEADER_NAME}: ${safeConversationId}`
      : '',
  ].filter(Boolean).join('\n');
}

function userMessage(content: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

function flagsFrom(session: LiveQuerySession): Pick<
  CodingAgentResult,
  'projectTouched' | 'filesWritten' | 'previewTouched' | 'deploymentTouched' | 'wasCreated'
> {
  return {
    projectTouched: session.flags.projectTouched,
    filesWritten: session.flags.filesWritten,
    previewTouched: session.flags.previewTouched,
    deploymentTouched: session.flags.deploymentTouched,
    wasCreated: false,
  };
}

function clearIdleTimer(session: LiveQuerySession) {
  if (!session.idleTimer) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = undefined;
}

function scheduleIdleClose(session: LiveQuerySession) {
  clearIdleTimer(session);
  const idleMs = liveQueries.size > WARM_QUERIES_PER_INSTANCE ? CROWDED_IDLE_MS : LIVE_QUERY_IDLE_MS;
  session.idleTimer = setTimeout(() => {
    if (session.turn) return;
    void disposeLiveQuery(session.conversationId);
  }, idleMs);
  session.idleTimer.unref?.();
}

function closeLiveQuery(session: LiveQuerySession) {
  clearIdleTimer(session);
  if (liveQueries.get(session.conversationId) === session) liveQueries.delete(session.conversationId);
  try {
    session.query.close();
  } catch (error) {
    console.warn('[agent] failed to close the SDK query', error);
  }
  session.queue.close();
}

function disposeLiveQuery(conversationId: string) {
  const session = liveQueries.get(conversationId);
  if (!session || session.turn) return false;
  closeLiveQuery(session);
  // The instance has 512 MB of disk for every conversation it hosts. A copy
  // already in Blob is downloaded again if this process resumes the session.
  if (session.transcriptSaved && session.transcriptPath) {
    void rm(session.transcriptPath, { force: true }).catch(() => undefined);
  }
  return true;
}

// A newer owner may have run turns this process never saw. The in-memory CLI
// session is behind them, so it is dropped and the next turn here resumes from
// the transcript in Blob.
onOwnershipLost((conversationId) => {
  const session = liveQueries.get(conversationId);
  if (session) closeLiveQuery(session);
});

const FENCED_REASON = 'This conversation was taken over by a newer session. Stop now; do not retry.';

/** Before every tool call: a replaced owner stops instead of touching the sandbox. */
function fenceHook(session: LiveQuerySession) {
  return {
    hooks: [async (input: HookInput): Promise<SyncHookJSONOutput> => {
      if (input.hook_event_name !== 'PreToolUse') return {};
      if (await confirmEpoch(session.context, session.conversationId, { cacheMs: OWNER_CHECK_CACHE_MS })) {
        return {};
      }
      return {
        continue: false,
        stopReason: FENCED_REASON,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: FENCED_REASON,
        },
      };
    }],
  };
}

async function persistTranscript(session: LiveQuerySession) {
  if (!session.sessionId || !session.transcriptPath) return;
  session.transcriptSaved = false;
  await uploadTranscript({
    context: session.context,
    conversationId: session.conversationId,
    sessionId: session.sessionId,
    sourcePath: session.transcriptPath,
  });
  session.transcriptSaved = true;
}


async function pumpSession(session: LiveQuerySession) {
  const pendingToolUseBlocks = new Map<number, StreamingToolUseBlock>();
  const progress = createProgressEmitter({
    appDir: session.getState().appDir,
    onProgress: (event) => session.turn?.onProgress?.(event),
  });
  let fatalError: string | null = null;

  const finishTurn = async (result: CodingAgentResult) => {
    await persistTranscript(session).catch((error) => {
      console.warn('[transcript] upload failed', error);
    });
    const waiter = session.turn;
    session.turn = undefined;
    waiter?.resolve(result);
    // The process stays up for the next prompt. Close it if nobody sends one.
    scheduleIdleClose(session);
  };

  try {
    for await (const event of session.query as AsyncIterable<SDKMessage>) {
      const systemEvent = event as SDKMessage & { subtype?: string; session_id?: string };
      if (event.type === 'system' && systemEvent.subtype === 'compact_boundary') {
        await persistTranscript(session).catch((error) => {
          console.warn('[transcript] compaction upload failed', error);
        });
      }
      if (typeof systemEvent.session_id === 'string' && systemEvent.session_id) {
        session.sessionId = systemEvent.session_id;
        if (!session.transcriptPath) {
          session.transcriptPath = resolveClaudeTranscriptPath(systemEvent.session_id);
        }
      }

      if (!session.turn) continue;

      if (event.type === 'stream_event') {
        progress.emitNarration(
          extractVisibleNarrationDelta(event),
          typeof event.uuid === 'string' ? event.uuid : '',
          false,
        );
        progress.emitThinking(
          extractVisibleThinkingDelta(event),
          typeof event.uuid === 'string' ? event.uuid : '',
          false,
        );
        const streamEvent = (event as { event?: Record<string, any> }).event;
        if (streamEvent?.type === 'content_block_start') {
          const contentBlock = streamEvent.content_block;
          if (contentBlock?.type === 'text') {
            progress.beginTextBlock();
          }
          if (isThinkingContentBlock(contentBlock)) {
            progress.beginThinkingBlock();
            if (contentBlock?.type === 'redacted_thinking') {
              progress.emitThinking('(redacted)', typeof event.uuid === 'string' ? event.uuid : '', true);
            }
          }
          if (isToolUseContentBlock(contentBlock) && typeof streamEvent.index === 'number') {
            pendingToolUseBlocks.set(streamEvent.index, {
              id: typeof contentBlock.id === 'string' ? contentBlock.id : '',
              name: typeof contentBlock.name === 'string' ? contentBlock.name : '',
              inputJson: '',
              input: contentBlock.input,
            });
            progress.emitToolUseProgress({
              id: contentBlock.id,
              name: contentBlock.name,
              input: contentBlock.input,
            });
          }
        } else if (streamEvent?.type === 'content_block_delta') {
          const delta = streamEvent.delta;
          const pendingToolUse = typeof streamEvent.index === 'number'
            ? pendingToolUseBlocks.get(streamEvent.index)
            : undefined;
          if (pendingToolUse && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const previousLength = pendingToolUse.inputJson.length;
            pendingToolUse.inputJson += delta.partial_json;
            const parsed = parseToolInputJson(pendingToolUse.inputJson, pendingToolUse.input);
            const crossedChunk = Math.floor(previousLength / 120) !== Math.floor(pendingToolUse.inputJson.length / 120);
            if (crossedChunk || parsed !== pendingToolUse.input) {
              progress.emitToolUseProgress({
                id: pendingToolUse.id,
                name: pendingToolUse.name,
                input: parsed,
                inputJson: pendingToolUse.inputJson,
              });
            }
          }
        } else if (streamEvent?.type === 'content_block_stop') {
          const pendingToolUse = typeof streamEvent.index === 'number'
            ? pendingToolUseBlocks.get(streamEvent.index)
            : undefined;
          if (pendingToolUse) {
            pendingToolUseBlocks.delete(streamEvent.index);
            progress.emitToolUseProgress({
              id: pendingToolUse.id,
              name: pendingToolUse.name,
              input: parseToolInputJson(pendingToolUse.inputJson, pendingToolUse.input),
              inputJson: pendingToolUse.inputJson,
            });
          }
        }
        continue;
      }

      if (event.type === 'assistant') {
        const blocks = (event as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            progress.emitNarration(
              extractVisibleTextBlock(block),
              typeof event.uuid === 'string' ? event.uuid : '',
              true,
            );
            progress.emitThinking(
              extractVisibleThinkingBlock(block),
              typeof event.uuid === 'string' ? event.uuid : '',
              true,
            );
            if (isToolUseContentBlock(block)) {
              progress.emitToolUseProgress({ id: block.id, name: block.name, input: block.input });
            }
          }
        }
        continue;
      }

      if (event.type === 'user') {
        const blocks = (event as { message?: { content?: unknown } }).message?.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
            if (record.type !== 'tool_result') continue;
            const text = Array.isArray(record.content)
              ? record.content.map((item: any) => (typeof item?.text === 'string' ? item.text : '')).join(' ')
              : (typeof record.content === 'string' ? record.content : '');
            const toolUseId = typeof record.tool_use_id === 'string' ? record.tool_use_id : '';
            const toolContext = progress.toolContextById.get(toolUseId);
            const toolName = toolContext?.name || '<unknown>';
            const echoedExit = parseEchoedExitCode(text);
            const commandFailed = typeof echoedExit === 'number' && echoedExit !== 0;
            const toolFailed = record.is_error === true || commandFailed;
            const outputSummary = summarizeToolOutput(text, session.getState().appDir, toolName);
            // A preview that came up keeps the log it painted while starting.
            // Replacing that with the tool result would put the model's note,
            // and a URL that carries an access token, on the row instead.
            const keepPaintedLog = outputSummary === ''
              && !toolFailed
              && toolPaintsOwnProgress(toolName);
            session.turn?.onProgress?.({
              type: 'tool_result',
              data: {
                id: toolUseId,
                toolName,
                ...(toolContext?.command ? { command: toolContext.command } : {}),
                ok: !toolFailed,
                ...(keepPaintedLog ? {} : {
                  preview: truncateForStream(text, 8_000),
                  outputSummary,
                }),
                status: toolFailed ? 'failed' : 'completed',
                endedAt: Date.now(),
              },
            });
            if (record.is_error === true && !fatalError) {
              const fatal = detectFatalToolError(text);
              if (fatal) {
                fatalError = `${fatal} (tool=${toolName})`;
                console.warn('[fatal] aborting agent loop:', fatalError);
              }
            }
          }
        }
        if (fatalError) {
          await finishTurn(emptyCodingResult({
            error: fatalError,
            fatal: true,
            ...flagsFrom(session),
          }));
          fatalError = null;
        }
        continue;
      }

      if (event.type === 'tool_progress') {
        const progressEvent = event as SDKMessage & {
          tool_use_id?: string;
          tool_name?: string;
          elapsed_time_seconds?: number;
        };
        const toolUseId = typeof progressEvent.tool_use_id === 'string' ? progressEvent.tool_use_id : '';
        const toolContext = progress.toolContextById.get(toolUseId);
        const toolName = progressEvent.tool_name || toolContext?.name || '';
        if (toolPaintsOwnProgress(toolName)) continue;
        const elapsed = typeof progressEvent.elapsed_time_seconds === 'number'
          ? Math.max(0, Math.round(progressEvent.elapsed_time_seconds))
          : 0;
        progress.emitToolUseProgress({
          id: toolUseId,
          name: toolName || '<unknown>',
          outputSummary: elapsed ? `${elapsed}s` : 'running',
        });
        continue;
      }

      if (event.type === 'result') {
        const resultMessage = event as SDKResultMessage;
        progress.emitInfo({
          infoType: 'usage',
          title: 'Usage',
          content: formatResultUsage(resultMessage),
        });
        const modelRun = describeModelRun(session.model, resultMessage.modelUsage);
        if (modelRun.mismatch) {
          console.warn('[model]', `${modelRun.line} — the gateway served a model this turn did not request`);
        } else {
          console.info('[model]', modelRun.line);
        }
        if (resultMessage.subtype !== 'success') {
          await finishTurn(emptyCodingResult({
            error: Array.isArray(resultMessage.errors) && resultMessage.errors.length > 0
              ? resultMessage.errors[0]
              : 'Model execution failed.',
            ...flagsFrom(session),
          }));
        } else {
          await finishTurn({
            success: true,
            output: sanitizeAssistantText((resultMessage.result || '').trim()),
            error: null,
            ...flagsFrom(session),
          });
        }
        pendingToolUseBlocks.clear();
        progress.resetTurn();
        fatalError = null;
        continue;
      }

      const info = describeSdkMessage(event);
      if (info) progress.emitInfo(info);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fatal = detectFatalToolError(message);
    if (session.turn) {
      await finishTurn(emptyCodingResult({
        error: fatal || message || 'Execution failed.',
        ...(fatal ? { fatal: true } : {}),
        ...flagsFrom(session),
      }));
    }
  } finally {
    if (session.turn) {
      await finishTurn(emptyCodingResult({
        error: 'The model stream ended without returning a result.',
        ...flagsFrom(session),
      }));
    }
    // Only this session's entry: a replacement may already be registered.
    closeLiveQuery(session);
  }
}

async function startLiveQuery(options: StartLiveQueryOptions): Promise<LiveQuerySession | CodingAgentResult> {
  const { context, conversationId } = options;
  const apiKey = pickEnvValue(context, 'AI_GATEWAY_API_KEY')
    || pickEnvValue(context, 'ANTHROPIC_API_KEY')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const authToken = pickEnvValue(context, 'ANTHROPIC_AUTH_TOKEN')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const model = (options.model || '').trim() || resolveConfiguredModel(context);
  const baseURL = pickEnvValue(context, 'AI_GATEWAY_BASE_URL')
    || pickEnvValue(context, 'ANTHROPIC_BASE_URL')
    || pickEnvValue(context, 'DEEPSEEK_BASE_URL')
    || '';
  const customHeaders = pickEnvValue(context, 'ANTHROPIC_CUSTOM_HEADERS');
  const executablePath = pickEnvValue(context, 'CLAUDE_CODE_EXECUTABLE_PATH');

  if (!apiKey && !authToken) {
    return emptyCodingResult({
      error: 'Missing AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY. The agent cannot call the model.',
    });
  }
  if (!baseURL) {
    return emptyCodingResult({
      error: 'Missing AI_GATEWAY_BASE_URL / ANTHROPIC_BASE_URL / DEEPSEEK_BASE_URL. The agent cannot call the model.',
    });
  }

  const session = {
    conversationId,
    context,
    state: options.state,
    getState: () => session.state,
    getCallbacks: () => session.turn?.callbacks || {},
    flags: {
      projectTouched: false,
      filesWritten: false,
      previewTouched: false,
      deploymentTouched: false,
    },
    queue: new PromptQueue(),
    query: null as unknown as Query,
    model,
    pump: Promise.resolve(),
  } as LiveQuerySession;

  const assembled = assembleAgentTools(session);
  const sdkEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_CUSTOM_HEADERS: buildAnthropicCustomHeaders(customHeaders, conversationId),
    PATH: pickEnvValue(context, 'PATH') || DEFAULT_PATH,
    HOME: pickEnvValue(context, 'HOME') || '/tmp',
    CLAUDE_CONFIG_DIR: pickEnvValue(context, 'CLAUDE_CONFIG_DIR') || '/tmp/.claude',
  };
  if (apiKey) sdkEnv.ANTHROPIC_API_KEY = apiKey;
  if (authToken) sdkEnv.ANTHROPIC_AUTH_TOKEN = authToken;
  if (!sdkEnv.ANTHROPIC_API_KEY && authToken) sdkEnv.ANTHROPIC_API_KEY = authToken;

  const record = await getConversationRecord(context, conversationId);
  if (record.claudeSessionId && record.transcriptPath) {
    const restored = await downloadTranscript({
      context,
      conversationId,
      sessionId: record.claudeSessionId,
      destPath: record.transcriptPath,
    });
    if (restored) {
      session.sessionId = record.claudeSessionId;
      session.transcriptPath = record.transcriptPath;
    }
  }

  const writeHooks = projectWriteHooks({
    get context() {
      return session.context;
    },
    get state() {
      return session.getState();
    },
    get conversationId() {
      return session.conversationId;
    },
    get send() {
      return session.getCallbacks().send;
    },
    onWritten: async (file) => {
      session.flags.projectTouched = true;
      session.flags.filesWritten = true;
      await session.getCallbacks().onProjectFilesChanged?.(file);
    },
  });

  const sdkOptions: Parameters<typeof query>[0]['options'] = {
    model,
    permissionMode: 'dontAsk',
    maxTurns: 100,
    includePartialMessages: true,
    persistSession: true,
    mcpServers: {
      [assembled.mcpServerName]: assembled.sandboxMcpServer,
    },
    allowedTools: assembled.mcpAllowedTools,
    strictMcpConfig: true,
    // Called once per SDK process. Both arguments are fixed for the life of the
    // conversation — the project directory and the MCP server name — so a
    // rebuilt prompt is byte-identical to the one the previous process wrote.
    // Everything else that used to be interpolated here varied: the selected
    // model (setLiveQueryModel changes it without rebuilding this text), the
    // publish area and project name (the command wrapper injects both), whether
    // the workspace was empty (the model reads that from a file listing), the
    // reply language, and whether a search tool was configured.
    systemPrompt: buildPrompt(
      session.getState(),
      SANDBOX_MCP_SERVER_NAME,
    ),
    env: sdkEnv,
    cwd: process.cwd(),
    settingSources: ['project'],
    stderr: (data: string) => {
      console.warn('[claude-code]', data.trimEnd());
    },
    hooks: {
      SessionStart: [{
        hooks: [async (input) => {
          if (input.hook_event_name === 'SessionStart') {
            session.sessionId = input.session_id;
            session.transcriptPath = resolveClaudeTranscriptPath(input.session_id, {
              explicitPath: input.transcript_path,
            });
            // Remember the path now. Upload still waits for the turn to end;
            // the Session tab reads this local file while the agent is running.
            await patchConversationRecord(session.context, session.conversationId, {
              claudeSessionId: input.session_id,
              transcriptPath: session.transcriptPath,
            }).catch((error) => {
              console.warn('[transcript] session path persist failed', error);
            });
          }
          return {};
        }],
      }],
      PostCompact: [{
        hooks: [async () => {
          await persistTranscript(session).catch((error) => {
            console.warn('[transcript] post-compact upload failed', error);
          });
          return {};
        }],
      }],
      ...writeHooks,
      PreToolUse: [fenceHook(session), ...writeHooks.PreToolUse],
    },
    ...(session.sessionId ? { resume: session.sessionId } : {}),
  };
  if (executablePath) sdkOptions.pathToClaudeCodeExecutable = executablePath;

  session.query = query({
    prompt: session.queue,
    options: sdkOptions,
  });
  session.pump = pumpSession(session);
  liveQueries.set(conversationId, session);
  return session;
}

export function getLiveQuery(conversationId: string) {
  return liveQueries.get(conversationId) || null;
}

export async function interruptLiveQuery(conversationId: string) {
  const live = liveQueries.get(conversationId);
  if (!live) return false;
  try {
    await live.query.interrupt();
    return true;
  } catch (error) {
    console.warn('[agent] interrupt failed', error);
    return false;
  }
}

export async function setLiveQueryModel(conversationId: string, model: string) {
  const live = liveQueries.get(conversationId);
  if (!live) return false;
  live.model = model;
  try {
    await live.query.setModel(model);
    return true;
  } catch (error) {
    console.warn('[agent] setModel failed', error);
    return false;
  }
}

/**
 * Reuse the live CLI for this conversation, or start one.
 * Starting restores the transcript and passes `resume` when a previous
 * session id is stored. Nothing here runs until a prompt asks.
 */
export async function acquireAgentSession(
  options: StartLiveQueryOptions,
): Promise<LiveQuerySession | CodingAgentResult> {
  if (options.abortSignal?.aborted) {
    return emptyCodingResult({ stopped: true });
  }

  const model = (options.model || '').trim() || resolveConfiguredModel(options.context);
  let session = liveQueries.get(options.conversationId);
  if (!session) {
    const started = await startLiveQuery(options);
    if (!('queue' in started)) return started;
    session = started;
  } else {
    session.context = options.context;
    session.state = options.state;
    if (model !== session.model) {
      await setLiveQueryModel(options.conversationId, model);
    }
  }
  clearIdleTimer(session);
  return session;
}

export async function runCodingAgent(options: RunCodingAgentOptions): Promise<CodingAgentResult> {
  const acquired = await acquireAgentSession(options);
  if (!('queue' in acquired)) return acquired;
  const session = acquired;

  session.flags.projectTouched = false;
  session.flags.filesWritten = false;
  session.flags.previewTouched = false;
  session.flags.deploymentTouched = false;
  // This turn appends to the local JSONL; only its own upload makes it safe to drop.
  session.transcriptSaved = false;

  const abort = () => {
    void interruptLiveQuery(options.conversationId);
  };
  options.abortSignal?.addEventListener('abort', abort, { once: true });

  try {
    const result = await new Promise<CodingAgentResult>((resolve) => {
      session!.turn = {
        callbacks: {
          onProjectFilesChanged: options.onProjectFilesChanged,
          onPreviewReady: options.onPreviewReady,
          onDeploymentStatus: options.onDeploymentStatus,
          send: options.send,
          abortSignal: options.abortSignal,
        },
        onProgress: options.onProgress,
        resolve,
      };
      session!.queue.push(userMessage(options.userMessage));
    });
    if (options.abortSignal?.aborted) {
      return { ...result, success: false, stopped: true, error: null };
    }
    return result;
  } finally {
    options.abortSignal?.removeEventListener('abort', abort);
  }
}
