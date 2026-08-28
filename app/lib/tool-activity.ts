import type { AssistantActivity } from '../../shared/protocol';

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
  | 'Run command';

export type ToolPresentation = {
  action: ToolAction;
  target?: string;
};

/**
 * Actions that only exist because the project runs on Makers. They are the one
 * tier of the activity stream that carries the platform accent, so plain file
 * work stays visually quiet.
 */
const PLATFORM_ACTIONS = new Set<ToolAction>([
  'Load skill',
  'Create preview',
  'Deploy project',
]);

export function toolActionTier(action: ToolAction): 'platform' | 'file' {
  return PLATFORM_ACTIONS.has(action) ? 'platform' : 'file';
}

/**
 * Shortest chunk that may be skipped as an already-rendered replay. Narration
 * streams in token-sized pieces, so "the text already ends with this chunk" is
 * the normal case for a repeated character and says nothing about a replay.
 * Skipping one silently corrupts what it belonged to: a URL that loses a
 * character is still shaped like a URL, and the reader has no way to tell.
 */
const MIN_REPLAY_CHUNK = 24;

/**
 * Append a streamed narration chunk to an assistant message's activities.
 *
 * A resumed turn replays what the browser already rendered, so a chunk big
 * enough to be unmistakable is dropped when it is already present.
 */
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

function withoutUrls(text: string) {
  return text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, '');
}

/**
 * The model's closing narration and the turn summary are the same sentence
 * emitted twice: once as streamed progress, once as the answer. Only the
 * summary is compacted and carries the live deployment URL, so the trailing
 * narration is the copy to drop.
 *
 * Neither whitespace nor links can be compared literally. Streamed chunks and
 * the final text break lines differently, and the summary moves the deployment
 * URL onto a line of its own, so the prose is what has to match.
 */
export function dropTrailingSummaryEcho<T extends { kind: string; content?: string }>(
  activities: readonly T[],
  finalContent: string,
): T[] {
  const list = [...activities];
  const last = list.at(-1);
  if (!last || last.kind !== 'text') {
    return list;
  }

  const echoes = (narration: string, summary: string) => Boolean(narration)
    && Boolean(summary)
    && (summary.includes(narration) || narration.includes(summary));
  const content = last.content || '';
  if (
    echoes(content.replace(/\s+/g, ''), finalContent.replace(/\s+/g, ''))
    || echoes(withoutUrls(content), withoutUrls(finalContent))
  ) {
    list.pop();
  }
  return list;
}

function shortToolName(name: string) {
  return name.replace(/^mcp__[^_]+__/, '').replaceAll('_', ' ');
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
  if (!trimmed.startsWith('{')) return '';
  try {
    const input = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'pattern', 'glob', 'query', 'command', 'cmd', 'skill']) {
      if (typeof input[key] === 'string') return cleanSummaryTarget(input[key]);
    }
  } catch {
    return '';
  }
  return '';
}

export function presentToolActivity(
  activity: { name: string; inputSummary?: string },
  previouslyReadPaths: ReadonlySet<string> = new Set(),
): ToolPresentation {
  const name = shortToolName(activity.name).toLowerCase();
  const structuredTarget = readStructuredTarget(activity.inputSummary);
  const target = structuredTarget || cleanSummaryTarget(activity.inputSummary);

  if (name.includes('ensure project scaffold') || name.includes('environment')) {
    return { action: 'Environment Preparing' };
  }
  if (name === 'skill' || name === 'load makers skill') {
    return { action: 'Load skill', target };
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
  if (name === 'commands' || name.includes('command')) {
    if (/\bedgeone\s+makers\s+deploy\b/i.test(target)) {
      return { action: 'Deploy project' };
    }
    if (/\bedgeone\s+makers\s+dev\b/i.test(target)) {
      return { action: 'Create preview' };
    }
    return { action: 'Run command', target };
  }
  return { action: 'Run command', target: target || shortToolName(activity.name) };
}
