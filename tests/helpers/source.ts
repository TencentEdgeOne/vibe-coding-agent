import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_EXT = /\.[cm]?[jt]sx?$/;

async function collectFiles(target: string): Promise<string[]> {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (info.isFile()) {
    return SOURCE_EXT.test(target) ? [target] : [];
  }
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const next = path.join(target, entry.name);
    if (entry.isDirectory()) return collectFiles(next);
    return SOURCE_EXT.test(entry.name) ? Promise.resolve([next]) : Promise.resolve([]);
  }));
  return nested.flat();
}

export async function surface(
  ...targets: Array<string | readonly string[]>
): Promise<string> {
  const files = [...new Set((await Promise.all(targets.flat().map(collectFiles))).flat())]
    .sort((left, right) => left.localeCompare(right));
  const contents = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  return contents.join('\n');
}

export const WORKSPACE = 'app/features/workspace';
export const CONVERSATION = [
  'app/components/agent-conversation.tsx',
  'app/features/workspace/components/conversation',
] as const;
export const FILES_PANEL = [
  'app/components/files-panel.tsx',
  'app/features/workspace/components/files',
] as const;
export const SESSION_PANEL = [
  'app/components/session-panel.tsx',
  'app/features/workspace/components/session-panel.tsx',
] as const;
export const MODEL_PICKER = [
  'app/components/model-picker.tsx',
  'app/features/workspace/components/model-picker.tsx',
] as const;
export const LIVE_TURN = [
  'app/features/workspace/hooks/use-live-turn.ts',
  'app/features/workspace/hooks/live',
] as const;
export const NEW_PROJECT = [
  'app/features/workspace/workspace-screen.tsx',
  'app/features/workspace/hooks/use-new-project.ts',
  'app/features/workspace/components/new-project-dialog.tsx',
] as const;
export const I18N = [
  'app/i18n.ts',
  'app/i18n',
] as const;
export const PREVIEW_SURFACE = [
  'app/features/workspace/hooks/use-preview-surface.ts',
  'app/features/workspace/hooks/use-preview-refresh.ts',
  'app/features/workspace/hooks/use-preview-navigation.ts',
  'app/features/workspace/hooks/preview-identity.ts',
] as const;
