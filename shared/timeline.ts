/**
 * Conversation timeline: sanitizing, tool presentation, live-event folding.
 * One module for the agent runtime and the browser so resume and live SSE
 * cannot disagree about a turn.
 */

import type {
  ActivityStatus,
  AssistantActivity,
  ChatStreamEvent,
  PersistedActivityTurn,
} from './protocol.ts';
import { WEB_SEARCH_TOOL_NAME } from './web-search.ts';

export function sanitizeAssistantText(input: string): string {
  if (!input) return '';
  let text = input;
  text = stripControls(text);
  text = stripThinkBlocks(text);
  text = stripJsonBlocksMatching(text, /\{\s*"type"\s*:\s*"(?:tool_use|tool_result)"/);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function sanitizeNarrationText(input: string) {
  if (!input) return '';
  return stripControls(input)
    .replace(/<think\b[^>]*>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

export function sanitizeThinkingContent(value: string) {
  return sanitizeNarrationText(value)
    .replace(/<t(?:h(?:i(?:n(?:k(?:\b[^>]*)?)?)?)?)?$/i, '');
}

function stripControls(text: string) {
  return text
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/\[20[01]~/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/i, '');
}

function stripJsonBlocksMatching(text: string, startPattern: RegExp): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const match = rest.match(startPattern);
    if (!match || match.index === undefined) {
      out += rest;
      break;
    }
    out += rest.slice(0, match.index);
    const start = index + match.index;
    const end = findJsonObjectEnd(text, start);
    if (end < 0) break;
    index = end + 1;
  }
  return out;
}

function findJsonObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return index;
  }
  return -1;
}

const MIN_RESEND_PREFIX = 8;

export type NarrationEmitState = {
  currentTextBlock: string;
  emittedNarration: string;
};

export function resolveNarrationEmit(
  state: NarrationEmitState,
  rawText: string,
  complete = false,
): { state: NarrationEmitState; text: string | null } {
  const text = sanitizeNarrationText(rawText);
  if (!text) return { state, text: null };

  if (complete) {
    const trimmed = text.trim();
    if (!trimmed) return { state, text: null };
    const streamed = state.currentTextBlock;
    const streamedTrimmed = streamed.trimEnd();
    if (streamed.includes(trimmed) || streamedTrimmed === trimmed) {
      return { state, text: null };
    }
    let nextChunk = trimmed;
    if (streamed && trimmed.startsWith(streamed)) {
      nextChunk = trimmed.slice(streamed.length);
    } else if (streamedTrimmed && trimmed.startsWith(streamedTrimmed)) {
      nextChunk = trimmed.slice(streamedTrimmed.length);
    } else if (streamed) {
      return { state, text: null };
    } else {
      if (state.emittedNarration.trimEnd().endsWith(trimmed)) {
        return { state, text: null };
      }
      nextChunk = trimmed;
    }
    nextChunk = sanitizeNarrationText(nextChunk);
    if (!nextChunk.trim()) return { state, text: null };
    return {
      state: {
        currentTextBlock: sanitizeNarrationText(`${streamed}${nextChunk}`),
        emittedNarration: sanitizeNarrationText(`${state.emittedNarration}${nextChunk}`),
      },
      text: nextChunk,
    };
  }

  if (state.currentTextBlock.length >= MIN_RESEND_PREFIX && text.startsWith(state.currentTextBlock)) {
    const remainder = text.slice(state.currentTextBlock.length);
    if (!remainder) return { state, text: null };
    return {
      state: {
        currentTextBlock: sanitizeNarrationText(`${state.currentTextBlock}${remainder}`),
        emittedNarration: sanitizeNarrationText(`${state.emittedNarration}${remainder}`),
      },
      text: remainder,
    };
  }

  return {
    state: {
      currentTextBlock: sanitizeNarrationText(`${state.currentTextBlock}${text}`),
      emittedNarration: sanitizeNarrationText(`${state.emittedNarration}${text}`),
    },
    text,
  };
}

const SUMMARY_LIMIT = 8_000;
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;

function truncate(value: string, limit = SUMMARY_LIMIT) {
  const normalized = value.replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n... truncated` : normalized;
}

function redactInlineSecrets(value: string) {
  return value
    .replace(/(authorization\s*:\s*)(?:bearer\s+)?[^"'\s]+(?:\s+[^"'\s]+)?/gi, '$1[REDACTED]')
    .replace(/((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]');
}

function safeValue(value: unknown, projectDir: string, depth = 0): unknown {
  if (depth > 4) return '[nested value omitted]';
  if (typeof value === 'string') {
    const withoutProjectPath = projectDir ? value.split(projectDir).join('<project>') : value;
    return truncate(redactInlineSecrets(withoutProjectPath), 600);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, projectDir, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, child]) => [
          key,
          SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeValue(child, projectDir, depth + 1),
        ]),
    );
  }
  return String(value);
}

export function summarizeToolInput(name: string, input: unknown, projectDir = '') {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const shortName = name.replace(/^mcp__[^_]+__/, '');

  if (shortName === 'write_project_file' || shortName === 'files_write' || shortName === 'write_files') {
    if (typeof record.path !== 'string' && typeof record.content !== 'string') return '';
    const path = typeof record.path === 'string' ? record.path : '<pending path>';
    const length = typeof record.content === 'string' ? record.content.length : 0;
    return `${path} (${length.toLocaleString('en-US')} chars)`;
  }
  if (shortName === 'commands') {
    const command = typeof record.command === 'string'
      ? record.command
      : typeof record.cmd === 'string'
        ? record.cmd
        : '';
    return truncate(redactInlineSecrets(projectDir ? command.split(projectDir).join('<project>') : command));
  }
  // Neither call takes an argument a reader can use. Dumping `{}` only opens
  // the row onto an empty input.
  if (shortName === 'deploy_project' || shortName === 'start_preview') return '';

  return truncate(JSON.stringify(safeValue(record, projectDir), null, 2));
}

/**
 * Deploy and preview paint the row themselves. An elapsed-seconds ping would
 * replace a live deploy log with "12s", and a preview has nothing to report
 * until it finishes — the row already shows how long it has been running.
 */
export function toolPaintsOwnProgress(name: string) {
  const shortName = name.replace(/^mcp__[^_]+__/, '');
  return shortName === 'deploy_project' || shortName === 'start_preview';
}

/**
 * What of a platform tool result belongs in the transcript.
 *
 * The result is written for the model: a note telling it what to say, and for
 * a preview a URL that carries an access token. The row keeps the part a
 * person can act on. An empty string means the row should show nothing.
 * `undefined` means this text is not one of those results.
 */
function userFacingPlatformResult(name: string, value: string): string | undefined {
  const shortName = name.replace(/^mcp__[^_]+__/, '');
  if (shortName !== 'deploy_project' && shortName !== 'start_preview') return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (shortName === 'deploy_project') {
    if (typeof parsed.url === 'string' && parsed.url.trim()) return parsed.url.trim();
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    return '';
  }
  if (parsed.status === 'success') return '';
  if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
  return '';
}

export function summarizeToolOutput(value: string, projectDir = '', name = '') {
  const withoutProjectPath = projectDir ? value.split(projectDir).join('<project>') : value;
  const faced = userFacingPlatformResult(name, withoutProjectPath);
  return truncate(redactInlineSecrets(faced === undefined ? withoutProjectPath : faced));
}

export type ToolAction =
  | 'Environment Preparing'
  | 'Glob'
  | 'Read file'
  | 'Write file'
  | 'Edit file'
  | 'Create folder'
  | 'Delete file'
  | 'Create preview'
  | 'Deploy project'
  | 'Load skill'
  | 'Search web'
  | 'Run command';

export type ReferenceTopic =
  | 'platform'
  | 'structure'
  | 'serverApi'
  | 'edgeApi'
  | 'aiEndpoint'
  | 'storage'
  | 'middleware'
  | 'migration'
  | 'cli'
  | 'deployment'
  | 'environment'
  | 'framework';

export const REFERENCE_TOPICS: Readonly<Record<string, ReferenceTopic>> = {
  'edgeone-makers-tools': 'platform',
  'makers-recipes': 'structure',
  'makers-cloud-functions': 'serverApi',
  'makers-edge-functions': 'edgeApi',
  'makers-agents': 'aiEndpoint',
  'makers-storage': 'storage',
  'makers-middleware': 'middleware',
  'makers-migration': 'migration',
  'makers-cli': 'cli',
  'makers-deploy': 'deployment',
  'makers-env-adaption': 'environment',
  'makers-frameworks': 'framework',
};

export type ToolPresentation = {
  action: ToolAction;
  target?: string;
  topic?: ReferenceTopic;
  detailed?: boolean;
};

/** Reading a reference is bookkeeping like any other read, so the row reads as
 *  plain as one. It still keeps a row of its own: the topic is the point of the
 *  row, and a fold would hide it behind a generic label. */
const ROW_OWNING_ACTIONS = new Set<ToolAction>([
  'Load skill',
  'Create preview',
  'Deploy project',
]);

/** Whether a step is one a fold would hide, rather than a run to summarise. */
function keepsOwnRowAction(action: ToolAction): boolean {
  return ROW_OWNING_ACTIONS.has(action);
}

const MIN_REPLAY_CHUNK = 24;

export function appendNarrationChunk(
  activities: readonly AssistantActivity[],
  text: string,
): AssistantActivity[] {
  const list = [...activities];
  const last = list.at(-1);
  if (last?.kind !== 'text') {
    list.push({ kind: 'text', content: text });
    return list;
  }
  const trimmed = text.trim();
  if (trimmed.length >= MIN_REPLAY_CHUNK && last.content.includes(trimmed)) {
    return list;
  }
  list[list.length - 1] = { ...last, content: `${last.content}${text}` };
  return list;
}

export function isBoundarySystemInfo(info: { infoType?: string }) {
  return info.infoType === 'usage' || info.infoType === 'compact';
}

/** Token-count pings and other SDK dumps. They are not a step the user asked
 *  about, and they must not cut a thought into empty rows. */
export function isPlumbingSystemInfo(info: { infoType?: string; title?: string }) {
  const infoType = info.infoType || 'sdk';
  const title = (info.title || '').trim();
  if (infoType === 'sdk') return true;
  return /thinking[_-]?tokens/i.test(title) || /thinking[_-]?tokens/i.test(infoType);
}

function findOpenThinkingIndex(activities: readonly AssistantActivity[]): number {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity.kind === 'thinking' && !activity.endedAt) return index;
    if (activity.kind === 'info' && !isBoundarySystemInfo(activity)) continue;
    break;
  }
  return -1;
}

export function appendThinkingChunk(
  activities: readonly AssistantActivity[],
  text: string,
  at = Date.now(),
): AssistantActivity[] {
  const list = [...activities];
  const index = findOpenThinkingIndex(list);
  if (index < 0) {
    list.push({ kind: 'thinking', content: text, startedAt: at });
    return list;
  }
  const last = list[index];
  if (last.kind !== 'thinking') {
    list.push({ kind: 'thinking', content: text, startedAt: at });
    return list;
  }
  const trimmed = text.trim();
  if (trimmed.length >= MIN_REPLAY_CHUNK && last.content.includes(trimmed)) {
    return list;
  }
  list[index] = { ...last, content: `${last.content}${text}` };
  return list;
}

/** A thought is over once the turn does something else, or the turn itself
 *  lands. Without an end time the row cannot say how long the agent sat there. */
export function sealOpenThinking(
  activities: readonly AssistantActivity[],
  endedAt = Date.now(),
): AssistantActivity[] {
  const index = findOpenThinkingIndex(activities);
  if (index < 0) return [...activities];
  const last = activities[index];
  if (last.kind !== 'thinking' || last.endedAt) return [...activities];
  const list = [...activities];
  list[index] = { ...last, endedAt };
  return list;
}

/**
 * The clock starts when the user first sees the agent doing something:
 * thinking, a tool call, or narration. Historical text blocks did not carry a
 * timestamp, so callers that need a duration leave those without one rather
 * than substituting the user's send time.
 */
export function firstVisibleActivityStartedAt(
  activities: readonly AssistantActivity[],
) {
  for (const activity of activities) {
    if (activity.kind === 'thinking' || activity.kind === 'tool') {
      if (activity.startedAt) return activity.startedAt;
    }
  }
  return undefined;
}

function withoutUrls(text: string) {
  return text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, '');
}

export function dropTrailingSummaryEcho<T extends {
  kind: string;
  content?: string;
  infoType?: string;
}>(
  activities: readonly T[],
  finalContent: string,
): T[] {
  const list = [...activities];
  // The SDK's usage event lands between the last streamed narration and the
  // final reply. Usage and compact rows are boundaries, not narration, so look
  // through them for the text block the reply is echoing.
  let lastIndex = list.length - 1;
  while (
    lastIndex >= 0
    && list[lastIndex].kind === 'info'
    && isBoundarySystemInfo(list[lastIndex])
  ) {
    lastIndex -= 1;
  }
  const last = list[lastIndex];
  if (!last || last.kind !== 'text') return list;
  const echoes = (narration: string, summary: string) => Boolean(narration)
    && Boolean(summary)
    && summary.includes(narration);
  const content = last.content || '';
  if (
    echoes(content.replace(/\s+/g, ''), finalContent.replace(/\s+/g, ''))
    || echoes(withoutUrls(content), withoutUrls(finalContent))
  ) {
    list.splice(lastIndex, 1);
  }
  return list;
}

function shortToolName(name: string) {
  return name.replace(/^mcp__[^_]+__/, '').replaceAll('_', ' ');
}

function looksLikeJson(value: string) {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function cleanSummaryTarget(summary = '') {
  const firstLine = summary.trim().split('\n')[0] || '';
  return firstLine
    .replace(/^<project>\/?/, '')
    .replace(/\s+\([\d,.]+ chars\)$/, '')
    .trim();
}

function readStructuredTarget(summary = '') {
  const trimmed = summary.trim();
  if (!looksLikeJson(trimmed)) return '';
  try {
    const input = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of [
      'pattern',
      'glob',
      'glob_pattern',
      'query',
      'command',
      'cmd',
      'skill',
      'path',
      'file_path',
      'directory',
      'dir',
    ]) {
      if (typeof input[key] === 'string' && input[key].trim()) {
        return cleanSummaryTarget(input[key]);
      }
    }
  } catch {
    // Still arriving — a lone `{` is not a path the agent touched.
    return '';
  }
  return '';
}

function readReferenceRequest(summary = '') {
  const trimmed = summary.trim();
  if (!looksLikeJson(trimmed)) {
    return { skill: cleanSummaryTarget(trimmed), ref: '' };
  }
  try {
    const input = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      skill: typeof input.skill === 'string' ? input.skill : '',
      ref: typeof input.ref === 'string' ? input.ref.trim() : '',
    };
  } catch {
    return { skill: '', ref: '' };
  }
}

export function presentToolActivity(
  activity: { name: string; inputSummary?: string },
  previouslyReadPaths: ReadonlySet<string> = new Set(),
): ToolPresentation {
  const name = shortToolName(activity.name).toLowerCase();
  const structuredTarget = readStructuredTarget(activity.inputSummary);
  // Pretty-printed JSON starts with `{`, which is not a file. Until the object
  // parses, the row has no target rather than a brace.
  const fallback = looksLikeJson(activity.inputSummary || '')
    ? ''
    : cleanSummaryTarget(activity.inputSummary);
  const target = structuredTarget || fallback;

  if (name.includes('environment')) {
    return { action: 'Environment Preparing', target };
  }
  if (name === 'skill' || name === 'load makers skill') {
    const request = readReferenceRequest(activity.inputSummary);
    return {
      action: 'Load skill',
      topic: REFERENCE_TOPICS[request.skill] || 'platform',
      detailed: Boolean(request.ref),
    };
  }
  if (name === shortToolName(WEB_SEARCH_TOOL_NAME)) {
    return { action: 'Search web', target };
  }
  if (name.includes('glob') || name.includes('files list') || name.includes('folder search')) {
    return { action: 'Glob', target: target || '**/*' };
  }
  if (name.includes('make dir') || name.includes('mkdir')) {
    return { action: 'Create folder', target };
  }
  if (name.includes('files remove') || name.includes('files delete')) {
    return { action: 'Delete file', target };
  }
  if (name.includes('read') || name.includes('files exists')) {
    return { action: 'Read file', target };
  }
  if (name.includes('write project file') || name.includes('files write') || name.includes('write files')) {
    return { action: previouslyReadPaths.has(target) ? 'Edit file' : 'Write file', target };
  }
  if (name === 'deploy project') {
    return { action: 'Deploy project' };
  }
  if (name === 'start preview') {
    return { action: 'Create preview' };
  }
  if (name === 'commands' || name.includes('command')) {
    if (/\bedgeone\s+makers\s+deploy\b/i.test(target)) return { action: 'Deploy project' };
    if (/\bedgeone\s+makers\s+dev\b/i.test(target)) return { action: 'Create preview' };
    return { action: 'Run command', target };
  }
  return { action: 'Run command', target: target || shortToolName(activity.name) };
}

export type DeployOfferKind = 'first' | 'again';

export type DeployOfferActivity = {
  kind?: string;
  status?: string;
  name?: string;
  inputSummary?: string;
};

export type DeployOfferMessage = {
  id?: string;
  role: string;
  status?: string;
  activities?: DeployOfferActivity[];
};

export function isDeployProjectActivity(activity: DeployOfferActivity) {
  if (activity.kind !== 'tool' || !activity.name) return false;
  return presentToolActivity({
    name: activity.name,
    inputSummary: activity.inputSummary,
  }).action === 'Deploy project';
}

export function lastFinishedAssistant<T extends DeployOfferMessage>(messages: readonly T[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item.role === 'assistant' && item.status && item.status !== 'running') {
      return item;
    }
  }
  return undefined;
}

export function resolveDeployOffer(
  messages: readonly DeployOfferMessage[],
  options: {
    canDownload: boolean;
    loading: boolean;
    hasLiveDeployment?: boolean;
  },
): DeployOfferKind | null {
  if (options.loading || !options.canDownload) return null;
  const last = lastFinishedAssistant(messages);
  if (!last || last.status !== 'done') return null;
  const lastActivities = last.activities ?? [];
  const hasSuccessfulDeploy = (activities: readonly DeployOfferActivity[]) =>
    activities.some((activity) => isDeployProjectActivity(activity) && activity.status === 'completed');
  const hasFailedDeploy = lastActivities.some((activity) => (
    isDeployProjectActivity(activity)
    && (activity.status === 'failed' || activity.status === 'stopped')
  ));
  if (hasSuccessfulDeploy(lastActivities) || hasFailedDeploy) return null;
  if (lastActivities.some((activity) => isDeployProjectActivity(activity))) return null;
  const everPublished = Boolean(options.hasLiveDeployment)
    || messages.some((message) => hasSuccessfulDeploy(message.activities ?? []));
  if (lastActivities.some((activity) => activity.kind === 'tool' && !isDeployProjectActivity(activity))) {
    return everPublished ? 'again' : 'first';
  }
  const anyTools = messages.some((message) => (
    (message.activities ?? []).some((activity) => activity.kind === 'tool')
  ));
  if (!everPublished && !anyTools) return 'first';
  return null;
}

type ToolActivity = Extract<AssistantActivity, { kind: 'tool' }>;

export type AssistantTimelineTextBlock = {
  kind: 'text';
  index: number;
  content: string;
};

export type AssistantTimelineThinkingBlock = {
  kind: 'thinking';
  index: number;
  content: string;
  startedAt?: number;
  endedAt?: number;
};

export type AssistantTimelineInfoBlock = {
  kind: 'info';
  index: number;
  activity: Extract<AssistantActivity, { kind: 'info' }>;
};

export type AssistantTimelineToolBlock = {
  kind: 'tool';
  index: number;
  activity: ToolActivity;
};

export type AssistantTimelineBlock =
  | AssistantTimelineTextBlock
  | AssistantTimelineThinkingBlock
  | AssistantTimelineInfoBlock
  | AssistantTimelineToolBlock;

export function normalizeTimelineText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function buildAssistantTimeline(activities: AssistantActivity[]): AssistantTimelineBlock[] {
  const blocks: AssistantTimelineBlock[] = [];

  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    if (activity.kind === 'text') {
      if (!activity.content.trim()) continue;
      blocks.push({ kind: 'text', index, content: activity.content });
      continue;
    }
    if (activity.kind === 'thinking') {
      if (!activity.content.trim()) continue;
      blocks.push({
        kind: 'thinking',
        index,
        content: activity.content,
        startedAt: activity.startedAt,
        endedAt: activity.endedAt,
      });
      continue;
    }
    if (activity.kind === 'info') {
      if (!activity.content.trim() && !activity.title.trim()) continue;
      blocks.push({ kind: 'info', index, activity });
      continue;
    }
    blocks.push({ kind: 'tool', index, activity });
  }
  return blocks;
}

export function lastTimelineText(blocks: AssistantTimelineBlock[]) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === 'text') return block;
  }
  return undefined;
}

function mergeThinkingBlocks(
  left: AssistantTimelineThinkingBlock,
  right: AssistantTimelineThinkingBlock,
): AssistantTimelineThinkingBlock {
  const trimmed = right.content.trim();
  const content = trimmed.length >= MIN_REPLAY_CHUNK && left.content.includes(trimmed)
    ? left.content
    : `${left.content}${right.content}`;
  return {
    ...left,
    content,
    startedAt: left.startedAt ?? right.startedAt,
    endedAt: right.endedAt ?? left.endedAt,
  };
}

/** SDK status, session, and usage rows are the agent's plumbing, not a step the
 *  user asked about. Classic keeps them; the reading view does not. Thoughts
 *  that those pings split are stitched back into one row. */
export function visibleRefinedBlocks(blocks: AssistantTimelineBlock[]): AssistantTimelineBlock[] {
  const visible: AssistantTimelineBlock[] = [];
  for (const block of blocks) {
    if (
      block.kind === 'info'
      && (
        block.activity.infoType === 'status'
        || block.activity.infoType === 'usage'
        || (
          block.activity.infoType === 'system'
          && block.activity.title.trim().toLowerCase() === 'session'
        )
        || isPlumbingSystemInfo(block.activity)
      )
    ) {
      continue;
    }
    if (block.kind === 'thinking') {
      const last = visible.at(-1);
      if (last?.kind === 'thinking') {
        visible[visible.length - 1] = mergeThinkingBlocks(last, block);
        continue;
      }
    }
    visible.push(block);
  }
  return visible;
}

export type AssistantTimelineGroupBlock = {
  kind: 'group';
  index: number;
  blocks: AssistantTimelineToolBlock[];
};

export type GroupedTimelineBlock = AssistantTimelineBlock | AssistantTimelineGroupBlock;

/** Below this a group saves no room, and hiding two rows behind one reads as a
 *  step the agent is keeping from the reader. */
const MIN_GROUP_SIZE = 3;

function isFoldableTool(block: AssistantTimelineBlock): block is AssistantTimelineToolBlock {
  if (block.kind !== 'tool') return false;
  return !keepsOwnRowAction(presentToolActivity(block.activity).action);
}

/**
 * Folds runs of routine file work into one row. A deploy and a preview are what
 * the user is waiting on, and a document the agent went and read is identified
 * by its topic — folding any of them in would hide the step behind a generic
 * label, so each keeps a row of its own.
 */
export function groupTimelineBlocks(blocks: AssistantTimelineBlock[]): GroupedTimelineBlock[] {
  const grouped: GroupedTimelineBlock[] = [];
  let run: AssistantTimelineToolBlock[] = [];

  const flushRun = () => {
    if (run.length >= MIN_GROUP_SIZE) {
      grouped.push({ kind: 'group', index: run[0].index, blocks: run });
    } else {
      grouped.push(...run);
    }
    run = [];
  };

  for (const block of blocks) {
    if (isFoldableTool(block)) {
      run.push(block);
      continue;
    }
    flushRun();
    grouped.push(block);
  }
  flushRun();

  return grouped;
}

export type ToolGroupSummary = {
  status: ActivityStatus;
  action: ToolAction;
  target?: string;
  count: number;
};

/**
 * What the collapsed group row says. It speaks for whatever still needs
 * attention before it speaks for whatever merely finished, so a failure inside
 * a folded run cannot hide behind the step that came after it.
 */
export function summarizeToolGroup(blocks: readonly AssistantTimelineToolBlock[]): ToolGroupSummary {
  const activities = blocks.map((block) => block.activity);
  const byUrgency = (status: ActivityStatus) => activities.find((activity) => activity.status === status);
  const lead = byUrgency('running')
    || byUrgency('failed')
    || byUrgency('stopped')
    || activities[activities.length - 1];
  const presentation = presentToolActivity(lead);

  return {
    status: lead.status,
    action: presentation.action,
    target: presentation.target,
    count: activities.length,
  };
}

export function trailingTimelineContent(
  lastText: string | undefined,
  finalContent: string,
  status?: 'running' | 'done' | 'error' | 'stopped',
) {
  const trailing = finalContent.trim();
  if (!trailing || status === 'running') return '';
  if (status === 'error' || !lastText?.trim()) return trailing;
  const left = normalizeTimelineText(lastText);
  const right = normalizeTimelineText(trailing);
  if (left === right || left.includes(right)) return '';
  if (right.startsWith(left)) return right.slice(left.length).trimStart();
  return trailing;
}

export function applyStreamEvent(
  turn: PersistedActivityTurn,
  event: ChatStreamEvent,
): PersistedActivityTurn {
  if (event.type === 'text_segment' && event.data?.text) {
    return {
      ...turn,
      activities: appendNarrationChunk(sealOpenThinking(turn.activities), event.data.text),
    };
  }
  if (event.type === 'thinking_segment' && event.data?.text) {
    return {
      ...turn,
      activities: appendThinkingChunk(turn.activities, event.data.text),
    };
  }
  if (event.type === 'system_info' && (event.data?.content || event.data?.title)) {
    if (isPlumbingSystemInfo(event.data)) return turn;
    const next = {
      kind: 'info' as const,
      infoType: event.data.infoType || 'sdk',
      title: event.data.title || event.data.infoType || 'sdk',
      content: event.data.content || '',
    };
    return {
      ...turn,
      activities: [
        ...(isBoundarySystemInfo(next) ? sealOpenThinking(turn.activities) : turn.activities),
        next,
      ],
    };
  }
  if (event.type === 'tool_use' && event.data?.id) {
    const existing = turn.activities.find(
      (item): item is Extract<AssistantActivity, { kind: 'tool' }> =>
        item.kind === 'tool' && item.toolUseId === event.data?.id,
    );
    if (existing) {
      existing.name = event.data.name || existing.name;
      existing.command = event.data.command || existing.command;
      existing.phaseHint = event.data.phaseHint || existing.phaseHint;
      existing.fileCount = event.data.fileCount ?? existing.fileCount;
      existing.inputSummary = event.data.inputSummary || existing.inputSummary;
      existing.outputSummary = event.data.outputSummary || existing.outputSummary;
      return { ...turn, activities: [...turn.activities] };
    }
    return {
      ...turn,
      activities: [
        ...sealOpenThinking(turn.activities),
        {
          kind: 'tool',
          toolUseId: event.data.id,
          name: event.data.name || 'tool',
          status: 'running',
          command: event.data.command,
          phaseHint: event.data.phaseHint,
          fileCount: event.data.fileCount,
          inputSummary: event.data.inputSummary,
          outputSummary: event.data.outputSummary,
          startedAt: event.data.startedAt || Date.now(),
        },
      ],
    };
  }
  if (event.type === 'tool_result' && event.data?.id) {
    return {
      ...turn,
      activities: turn.activities.map((activity) => (
        activity.kind === 'tool' && activity.toolUseId === event.data?.id
          ? {
              ...activity,
              status: event.data.status || (event.data.ok ? 'completed' : 'failed'),
              command: event.data.command || activity.command,
              // An empty summary is a decision to show nothing. Falling through to
              // the raw result would put the model's note back on the row.
              outputSummary: event.data.outputSummary ?? event.data.preview ?? activity.outputSummary,
              endedAt: event.data.endedAt || Date.now(),
            }
          : activity
      )),
    };
  }
  return turn;
}
