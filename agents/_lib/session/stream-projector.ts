import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProgressEvent } from '../types.ts';
import type { SystemInfoType } from '../../../shared/protocol.ts';
import {
  resolveNarrationEmit,
  sanitizeNarrationText,
  sanitizeThinkingContent,
  summarizeToolInput,
  summarizeToolOutput,
  toolPaintsOwnProgress,
  type NarrationEmitState,
} from '../../../shared/timeline.ts';
import {
  isInstallCommand,
  isMakersDeployCommand,
  isPreviewCommand,
  shortenToolName,
} from '../makers/tool-phase.ts';

export function extractSandboxCommand(input: unknown) {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return command.trim();
}

export function extractVisibleNarrationDelta(event: SDKMessage) {
  if (event.type !== 'stream_event') return '';
  const streamEvent = (event as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
  if (streamEvent?.type !== 'content_block_delta') return '';
  const delta = streamEvent.delta;
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
    return sanitizeNarrationText(delta.text);
  }
  return '';
}

export function extractVisibleThinkingDelta(event: SDKMessage) {
  if (event.type !== 'stream_event') return '';
  const streamEvent = (event as {
    event?: { type?: string; delta?: { type?: string; thinking?: string; text?: string } };
  }).event;
  if (streamEvent?.type !== 'content_block_delta') return '';
  const delta = streamEvent.delta;
  if (delta?.type !== 'thinking_delta' && delta?.type !== 'thinking') return '';
  const text = typeof delta.thinking === 'string' ? delta.thinking : delta.text;
  return typeof text === 'string' ? sanitizeThinkingContent(text) : '';
}

export function isThinkingContentBlock(block: unknown): boolean {
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  return record.type === 'thinking' || record.type === 'redacted_thinking';
}

export function extractVisibleThinkingBlock(block: unknown) {
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  if (record.type === 'redacted_thinking') return '(redacted)';
  if (record.type !== 'thinking') return '';
  if (typeof record.thinking === 'string') return sanitizeThinkingContent(record.thinking);
  if (typeof record.text === 'string') return sanitizeThinkingContent(record.text);
  return '';
}

export type SystemInfoPayload = {
  infoType: SystemInfoType;
  title: string;
  content: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function compactJson(value: unknown, limit = 1_500) {
  const omit = new Set(['uuid', 'session_id', 'message', 'event']);
  try {
    const json = JSON.stringify(value, (key, nested) => (omit.has(key) ? undefined : nested));
    if (!json) return '';
    return json.length > limit ? `${json.slice(0, limit)}\n... truncated` : json;
  } catch {
    return '';
  }
}

export function formatResultUsage(result: SDKResultMessage) {
  const lines = [
    `subtype=${result.subtype} turns=${result.num_turns}`
      + ` duration=${(result.duration_ms / 1000).toFixed(1)}s`
      + ` cost=$${Number(result.total_cost_usd || 0).toFixed(4)}`,
  ];
  const usage = result.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
  if (usage) {
    lines.push(
      `input=${usage.input_tokens ?? 0} output=${usage.output_tokens ?? 0}`
        + ` cacheRead=${usage.cache_read_input_tokens ?? 0}`
        + ` cacheWrite=${usage.cache_creation_input_tokens ?? 0}`,
    );
  }
  const models = Object.entries(result.modelUsage || {});
  for (const [id, modelUsage] of models) {
    lines.push(
      `${id} in=${modelUsage.inputTokens} out=${modelUsage.outputTokens} cost=$${Number(modelUsage.costUSD || 0).toFixed(4)}`,
    );
  }
  if ('errors' in result && Array.isArray(result.errors) && result.errors.length > 0) {
    lines.push(result.errors.join('\n'));
  }
  if (result.permission_denials?.length) {
    lines.push(`denied=${result.permission_denials.map((item) => item.tool_name).join(', ')}`);
  }
  return lines.join('\n');
}

function isTokenMeterEvent(event: SDKMessage) {
  const type = String(event.type);
  if (type === 'system') {
    const subtype = typeof (event as { subtype?: unknown }).subtype === 'string'
      ? (event as { subtype: string }).subtype
      : '';
    return /thinking[_-]?tokens|(^|_)tokens$/i.test(subtype);
  }
  return /thinking[_-]?tokens/i.test(type);
}

export function describeSdkMessage(event: SDKMessage): SystemInfoPayload | null {
  if (
    event.type === 'stream_event'
    || event.type === 'assistant'
    || event.type === 'user'
    || event.type === 'result'
    || event.type === 'tool_progress'
    || isTokenMeterEvent(event)
  ) {
    return null;
  }

  if (event.type === 'system') {
    const record = event as SDKMessage & { subtype?: string };
    const subtype = typeof record.subtype === 'string' ? record.subtype : '';
    if (subtype === 'init') {
      const init = event as SDKMessage & {
        model?: string;
        tools?: string[];
        mcp_servers?: { name?: string; status?: string }[];
        skills?: string[];
      };
      const tools = Array.isArray(init.tools) ? init.tools : [];
      const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
      const skills = Array.isArray(init.skills) ? init.skills : [];
      return {
        infoType: 'system',
        title: 'Session',
        content: [
          `model=${init.model || ''}`,
          `tools=${tools.length}${tools.length ? ` ${tools.slice(0, 12).join(', ')}` : ''}`,
          servers.length ? `mcp=${servers.map((server) => `${server.name}:${server.status}`).join(', ')}` : '',
          skills.length ? `skills=${skills.slice(0, 12).join(', ')}` : '',
        ].filter(Boolean).join('\n'),
      };
    }
    if (subtype === 'compact_boundary') {
      const compact = asRecord((event as { compact_metadata?: unknown }).compact_metadata);
      return {
        infoType: 'compact',
        title: 'Compact',
        content: [
          `trigger=${compact.trigger || ''}`,
          compact.pre_tokens != null ? `pre_tokens=${compact.pre_tokens}` : '',
          compact.post_tokens != null ? `post_tokens=${compact.post_tokens}` : '',
          compact.duration_ms != null ? `duration_ms=${compact.duration_ms}` : '',
        ].filter(Boolean).join('\n'),
      };
    }
    if (subtype === 'status') {
      const status = event as SDKMessage & { status?: string | null; compact_result?: string; compact_error?: string };
      return {
        infoType: 'status',
        title: 'Status',
        content: [status.status, status.compact_result, status.compact_error].filter(Boolean).join('\n'),
      };
    }
    if (subtype === 'notification') {
      const note = event as SDKMessage & { text?: string; key?: string };
      return {
        infoType: 'system',
        title: note.key || 'Notification',
        content: note.text || '',
      };
    }
    if (subtype === 'permission_denied') {
      const denied = event as SDKMessage & { tool_name?: string; message?: string; decision_reason?: string };
      return {
        infoType: 'system',
        title: `Denied ${denied.tool_name || 'tool'}`,
        content: [denied.message, denied.decision_reason].filter(Boolean).join('\n'),
      };
    }
    if (subtype === 'api_retry') {
      const retry = event as SDKMessage & { attempt?: number; max_retries?: number; retry_delay_ms?: number; error?: string };
      return {
        infoType: 'status',
        title: 'API retry',
        content: `attempt ${retry.attempt}/${retry.max_retries} delay=${retry.retry_delay_ms}ms ${retry.error || ''}`.trim(),
      };
    }
    if (subtype === 'local_command_output') {
      const output = event as SDKMessage & { content?: string };
      return {
        infoType: 'system',
        title: 'Command output',
        content: typeof output.content === 'string' ? output.content.slice(0, 4_000) : '',
      };
    }
    if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_updated' || subtype === 'task_notification') {
      const task = event as SDKMessage & { description?: string; summary?: string; task_id?: string; last_tool_name?: string };
      return {
        infoType: 'status',
        title: subtype.replace('task_', 'Task '),
        content: [task.description, task.summary, task.last_tool_name, task.task_id].filter(Boolean).join('\n'),
      };
    }
    if (subtype === 'files_persisted') {
      const persisted = event as SDKMessage & { files?: { filename?: string }[]; failed?: { filename?: string; error?: string }[] };
      const names = (persisted.files || []).map((file) => file.filename).filter(Boolean);
      const failed = (persisted.failed || []).map((file) => `${file.filename}: ${file.error}`).filter(Boolean);
      return {
        infoType: 'system',
        title: 'Files persisted',
        content: [...names, ...failed].join('\n'),
      };
    }
    return null;
  }

  if (event.type === 'tool_use_summary') {
    const summary = event as SDKMessage & { summary?: string };
    return { infoType: 'system', title: 'Tool summary', content: summary.summary || '' };
  }
  if (event.type === 'rate_limit_event') {
    return { infoType: 'status', title: 'Rate limit', content: compactJson(event) };
  }
  if (event.type === 'prompt_suggestion') {
    const suggestion = event as SDKMessage & { suggestion?: string };
    return { infoType: 'system', title: 'Prompt suggestion', content: suggestion.suggestion || '' };
  }

  return null;
}

export type StreamingToolUseBlock = {
  id: string;
  name: string;
  inputJson: string;
  input?: unknown;
};

export function isToolUseContentBlock(block: unknown): block is {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
} {
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  return record.type === 'tool_use' || record.type === 'mcp_tool_use';
}

export function extractVisibleTextBlock(block: unknown) {
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  if (record.type !== 'text' || typeof record.text !== 'string') return '';
  return sanitizeNarrationText(record.text);
}

export function parseToolInputJson(rawJson: string, fallback: unknown) {
  if (!rawJson.trim()) return fallback ?? {};
  try {
    return JSON.parse(rawJson);
  } catch {
    return fallback ?? {};
  }
}

type ToolProgressPhase = 'scaffold' | 'code' | 'install' | 'preview' | 'link';

export function inferToolProgress(name: string, input: unknown): {
  phaseHint?: ToolProgressPhase;
  fileCount?: number;
} {
  const toolName = shortenToolName(name);
  if (toolName === 'files_write' || toolName === 'write_files' || toolName === 'write_project_file') {
    return { phaseHint: 'code', fileCount: 1 };
  }
  if (toolName === 'files_make_dir' || toolName === 'files_remove') {
    return { phaseHint: 'code' };
  }
  if (toolName === 'commands') {
    const cmd = extractSandboxCommand(input);
    if (isInstallCommand(cmd)) return { phaseHint: 'install' };
    if (isPreviewCommand(cmd) || isMakersDeployCommand(cmd)) return { phaseHint: 'preview' };
  }
  return {};
}

export function createProgressEmitter(options: {
  appDir: string;
  onProgress?: (event: AgentProgressEvent) => void;
}) {
  const toolContextById = new Map<string, { name: string; command?: string }>();
  const toolStartedAtById = new Map<string, number>();
  const emittedToolUseProgress = new Map<string, string>();
  let narrationState: NarrationEmitState = { currentTextBlock: '', emittedNarration: '' };
  let thinkingState: NarrationEmitState = { currentTextBlock: '', emittedNarration: '' };

  const emitNarration = (rawText: string, uuid: string, complete = false) => {
    const resolved = resolveNarrationEmit(narrationState, rawText, complete);
    narrationState = resolved.state;
    if (!resolved.text) return;
    options.onProgress?.({
      type: 'text_segment',
      data: { uuid, text: resolved.text },
    });
  };

  const emitThinking = (rawText: string, uuid: string, complete = false) => {
    const resolved = resolveNarrationEmit(thinkingState, rawText, complete);
    thinkingState = resolved.state;
    if (!resolved.text) return;
    options.onProgress?.({
      type: 'thinking_segment',
      data: { uuid, text: resolved.text },
    });
  };

  const emitInfo = (info: SystemInfoPayload) => {
    if (!info.content.trim() && !info.title.trim()) return;
    options.onProgress?.({
      type: 'system_info',
      data: info,
    });
  };

  const emitToolUseProgress = (toolUse: {
    id?: string;
    name?: string;
    input?: unknown;
    inputJson?: string;
    outputSummary?: string;
  }) => {
    const toolName = typeof toolUse.name === 'string' ? toolUse.name : '<unknown>';
    const toolUseId = typeof toolUse.id === 'string' ? toolUse.id : '';
    const shortToolName = shortenToolName(toolName);
    const command = shortToolName === 'commands' ? extractSandboxCommand(toolUse.input) : '';
    const progress = typeof toolUse.name === 'string' ? inferToolProgress(toolName, toolUse.input) : {};
    const hasInput = toolUse.input !== undefined || Boolean(toolUse.inputJson);
    const parsedSummary = hasInput ? summarizeToolInput(toolName, toolUse.input, options.appDir) : '';
    const inputSummary = toolPaintsOwnProgress(toolName)
      ? ''
      : parsedSummary
        || (toolUse.inputJson ? summarizeToolOutput(toolUse.inputJson, options.appDir) : '');
    const outputSummary = toolUse.outputSummary || '';
    const progressSignature = JSON.stringify({
      name: toolName,
      command,
      phaseHint: progress.phaseHint || '',
      fileCount: progress.fileCount || 0,
      inputSummary,
      outputSummary,
    });
    if (toolUseId) {
      if (emittedToolUseProgress.get(toolUseId) === progressSignature) return;
      emittedToolUseProgress.set(toolUseId, progressSignature);
    }
    narrationState = { ...narrationState, currentTextBlock: '' };
    if (toolUseId && typeof toolUse.name === 'string') {
      toolContextById.set(toolUseId, { name: toolUse.name, ...(command ? { command } : {}) });
    }
    const startedAt = toolUseId ? toolStartedAtById.get(toolUseId) || Date.now() : Date.now();
    if (toolUseId) toolStartedAtById.set(toolUseId, startedAt);
    options.onProgress?.({
      type: 'tool_use',
      data: {
        id: toolUseId,
        name: toolName,
        ...(command ? { command } : {}),
        ...progress,
        inputSummary,
        ...(outputSummary ? { outputSummary } : {}),
        startedAt,
      },
    });
  };

  return {
    toolContextById,
    toolStartedAtById,
    emitNarration,
    emitThinking,
    emitInfo,
    emitToolUseProgress,
    resetNarration() {
      narrationState = { currentTextBlock: '', emittedNarration: '' };
    },
    beginTextBlock() {
      narrationState = { ...narrationState, currentTextBlock: '' };
    },
    beginThinkingBlock() {
      thinkingState = { ...thinkingState, currentTextBlock: '' };
    },
    resetTurn() {
      toolContextById.clear();
      toolStartedAtById.clear();
      emittedToolUseProgress.clear();
      narrationState = { currentTextBlock: '', emittedNarration: '' };
      thinkingState = { currentTextBlock: '', emittedNarration: '' };
    },
  };
}
