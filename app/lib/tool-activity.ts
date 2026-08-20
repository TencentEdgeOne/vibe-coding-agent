export type ToolAction =
  | 'Environment Preparing'
  | 'Glob'
  | 'Read file'
  | 'Write file'
  | 'Edit file'
  | 'Create folder'
  | 'Delete file'
  | 'Create preview'
  | 'Load skill'
  | 'Run command';

export type ToolPresentation = {
  action: ToolAction;
  target?: string;
};

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
  if (name.includes('publish preview') || name.includes('preview link') || name.includes('deploy to makers')) {
    return { action: 'Create preview' };
  }
  if (name === 'commands' || name.includes('command')) {
    return { action: 'Run command', target };
  }
  return { action: 'Run command', target: target || shortToolName(activity.name) };
}
