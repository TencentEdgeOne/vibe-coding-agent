import type { BuildResult, BuildStatus, ProjectState, ScaffoldLog } from '../_types';
import { buildEdgeoneCliPrewarmScript } from '../../shared/makers-deploy';
import { debugLog } from '../utils/_debug';
import { detectFatalToolError } from '../utils/_text';
import { runCommandCapturingExit, runSandboxCommand } from './_commands';

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Models used to pass `${appDir}/file` into write_project_file, which joined
// appDir again and created appDir/appDir/... . Lift that nested tree back to
// the real project root when we detect the classic nesting marker.
export async function repairNestedAppDirLayout(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
): Promise<boolean> {
  const nestedRel = state.appDir;
  const nestedAbs = `${state.appDir}/${nestedRel}`;
  try {
    if (!(await context.sandbox.files.exists(nestedAbs))) {
      return false;
    }
  } catch {
    return false;
  }

  const result = await runSandboxCommand(
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

  if (result.exitCode !== 0) {
    debugLog(context, '[nested-appdir-repair]', {
      ok: false,
      stderr: result.stderr,
      stdout: result.stdout,
    });
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

export async function ensureProjectScaffold(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
) {
  const sandbox = context.sandbox;
  onLog?.({ stream: 'status', content: `Preparing the project workspace ${state.appDir}` });
  
  await sandbox.files.makeDir(state.sessionDir);
  await sandbox.files.makeDir(state.appDir);

  // CLI installation dominates first preview latency in a fresh sandbox. Start
  // it in the background while the model writes project files; publish_preview
  // will join this same install instead of launching a duplicate.
  await prewarmEdgeoneCli(context);

  await repairNestedAppDirLayout(context, state, onLog);

  const existing = await runSandboxCommand(
    context,
    [
      'find . -mindepth 1 -maxdepth 2',
      "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' \\) -prune",
      '-o -print',
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 60,
    },
  );
  if (existing.exitCode !== 0) {
    throw new Error(existing.stderr || existing.stdout || 'Workspace inspection failed.');
  }
  debugLog(context, '[sandbox-info]', { available: Boolean(context.sandbox.getInfo()) });

  // One conversation_id maps to one long-lived project. Reuse existing business
  // files without overwriting them.
  if (existing.stdout.trim()) {
    onLog?.({ stream: 'status', content: 'Existing project workspace detected; skipping initialization.' });
    return false;
  }

  onLog?.({ stream: 'status', content: 'Prepared an empty project workspace. Waiting for the agent to generate project files.' });
  
  return true;
}

export async function prewarmEdgeoneCli(context: any) {
  await runSandboxCommand(context, buildEdgeoneCliPrewarmScript(), {
    timeout: 10,
  });
}

export async function runVerification(context: any, state: ProjectState): Promise<BuildResult> {
  try {
    const packageExists = await context.sandbox.files.exists(`${state.appDir}/package.json`);
    if (packageExists) {
      const hasBuildScript = await runSandboxCommand(
        context,
        'node -e "try { const p=require(\'./package.json\'); process.stdout.write((p.scripts && p.scripts.build) ? \'yes\' : \'no\'); } catch (e) { process.stdout.write(\'error\'); }"',
        {
          cwd: state.appDir,
          timeout: 30,
        },
      );

      if (hasBuildScript.exitCode !== 0) {
        return {
          status: 'failed',
          stdout: hasBuildScript.stdout,
          stderr: hasBuildScript.stderr || 'Failed to read package.json; unable to determine whether a build script exists.',
        };
      }

      const buildFlag = hasBuildScript.stdout.trim();
      if (buildFlag === 'error') {
        return {
          status: 'failed',
          stdout: hasBuildScript.stdout,
          stderr: 'Failed to parse package.json; unable to determine whether a build script exists.',
        };
      }

      if (buildFlag === 'yes') {
        const result = await runCommandCapturingExit(context, 'npm run build', {
          cwd: state.appDir,
          timeout: 600,
        });

        return {
          status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }

      if (buildFlag !== 'no') {
        return {
          status: 'failed',
          stdout: hasBuildScript.stdout,
          stderr: hasBuildScript.stderr || 'Failed to parse package.json; unable to determine whether a build script exists.',
        };
      }
    }

    const pythonFiles = await runSandboxCommand(
      context,
      [
        'find .',
        "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' -o -path './.venv' -o -path './venv' \\) -prune",
        "-o -name '*.py' -print -quit",
      ].join(' '),
      {
        cwd: state.appDir,
        timeout: 30,
      },
    );

    if (pythonFiles.exitCode !== 0) {
      return {
        status: 'failed',
        stdout: pythonFiles.stdout,
        stderr: pythonFiles.stderr || 'Python file inspection failed.',
      };
    }

    if (pythonFiles.stdout.trim()) {
      const result = await runCommandCapturingExit(context, 'python -m compileall .', {
        cwd: state.appDir,
        timeout: 300,
      });

      return {
        status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    return {
      status: 'skipped',
      stdout: 'No package build script or Python source files found; verification skipped.',
    };
  } catch (error) {
    const commandError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const stdout = typeof commandError.stdout === 'string' ? commandError.stdout : '';
    const stderr = typeof commandError.stderr === 'string' ? commandError.stderr : '';
    const message = error instanceof Error ? error.message : String(error);
    const fatal = detectFatalToolError([stdout, stderr, message].filter(Boolean).join('\n'));
    return {
      status: 'failed',
      stdout,
      stderr: fatal || stderr || message || 'Verification failed.',
      ...(fatal ? { fatal: true } : {}),
    };
  }
}
