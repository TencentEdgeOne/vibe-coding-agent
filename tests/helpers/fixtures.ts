import { readFile } from 'node:fs/promises';
import type { ProjectState } from '../../agents/_lib/types.ts';

/**
 * A scaffolded project, as the pipelines see one. Lives here because four test
 * files had grown their own copy of the same three fields, and a change to
 * ProjectState had to be made in all of them or in none.
 *
 * `sessionDir` is a parameter because the deploy tests derive a project name
 * from it; everything else is overridable for the cases that need a preview or
 * a deployment attached.
 */
export function projectState(
  sessionDir = 'projects/demo',
  overrides: Partial<ProjectState> = {},
): ProjectState {
  return {
    created: true,
    sessionDir,
    appDir: `${sessionDir}/app`,
    ...overrides,
  };
}

export const COMMANDS_WRAP_FILES = [
  'agents/_lib/tools/commands-wrap.ts',
  'agents/_lib/tools/makers-command.ts',
  'agents/_lib/tools/preview-command-result.ts',
  'agents/_lib/tools/deploy-command-result.ts',
  'agents/_lib/tools/command-preprocess.ts',
  'agents/_lib/tools/command-text.ts',
  'agents/_lib/tools/makers-lifecycle.ts',
] as const;

export async function readCommandsWrapSource() {
  return (await Promise.all(COMMANDS_WRAP_FILES.map((file) => readFile(file, 'utf8')))).join('\n');
}
