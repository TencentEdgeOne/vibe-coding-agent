import type { ProjectState, ScaffoldLog } from '../types.ts';
import { requireSandbox, type SandboxCapable } from '../runtime/context.ts';
import { runSandboxCommand } from './commands.ts';
import { shellQuote } from '../utils/shell.ts';

// Models used to pass `${appDir}/file` into the project write tool, which joined
// appDir again and created appDir/appDir/... . Lift that nested tree back to
// the real project root when we detect the classic nesting marker.
export async function repairNestedAppDirLayout(
  context: SandboxCapable,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
): Promise<boolean> {
  const nestedRel = state.appDir;
  // Probe before running the repair, even though the script's first line is the
  // same test. The probe is not what this costs — running the script is, on
  // every turn, for a legacy bug that almost no project has. Skipping the probe
  // to save a round trip put a command that had barely ever run in production
  // in front of the first tool of every conversation.
  try {
    if (!(await requireSandbox(context).files.exists(`${state.appDir}/${nestedRel}`))) {
      return false;
    }
  } catch {
    return false;
  }

  let result;
  try {
    result = await runSandboxCommand(
      context,
      [
        'set -e',
        `NESTED=${shellQuote(nestedRel)}`,
        'if [ ! -d "$NESTED" ]; then exit 0; fi',
        // Classic bug shape: real project under appDir/appDir, root missing package.json.
        'if [ ! -f "$NESTED/package.json" ] && [ ! -f "$NESTED/index.html" ]; then exit 0; fi',
        'if [ -f ./package.json ]; then exit 0; fi',
        'for item in "$NESTED"/*; do',
        '  [ -e "$item" ] || continue',
        '  name=$(basename "$item")',
        '  [ "$name" = "projects" ] && continue',
        '  rm -rf "./$name"',
        '  mv "$item" "./$name"',
        'done',
        'rm -rf ./projects',
        'echo REPAIRED',
      ].join('\n'),
      {
        cwd: state.appDir,
        timeout: 60,
      },
    );
  } catch {
    // The sandbox raises on a failed command instead of returning its exit
    // code, so the check below never sees one and this is the only place a
    // failure can be absorbed. Absorbing it is the point: repairing a layout
    // almost no project has must not cost a turn to every project that does
    // not, and the scaffold that follows reports anything genuinely wrong.
    return false;
  }

  if (result.exitCode !== 0) {
    return false;
  }

  const repaired = result.stdout.includes('REPAIRED');
  if (repaired) {
    onLog?.({
      stream: 'status',
      content: 'Fixed nested project paths and restored files to the workspace root.',
    });
  }
  return repaired;
}
