import { requireSandbox, type AgentContext } from '../../runtime/context.ts';
import { createHash } from 'node:crypto';
import type { ProjectState } from '../../types.ts';
import { runCommandCapturingExit } from '../../project/commands.ts';
import { loadMakersFrameworkProfiles, loadMakersValidationRules } from './skill-rules.ts';
import { buildMakersCompatibilityScript } from './lint-script.ts';

const COMPAT_SCRIPT_NAME = '.makers-compat-check.cjs';

/**
 * Which script body each session already has on disk.
 *
 * The body is derived from the vendored skills, which are read once per
 * process, so it is identical for every run of a session — and the lint runs at
 * least twice a turn, once before the preview starts and once at verification.
 * Re-sending it each time was a sandbox write buying nothing.
 *
 * Keyed by session because sessions do not share a sandbox, and paired with the
 * retry below because a cache that outlives the file it describes is worse than
 * no cache at all.
 */
const uploadedCompatScripts = new Map<string, string>();

function compatScriptFingerprint(script: string) {
  return createHash('sha256').update(script).digest('hex');
}

/** A sandbox recycled under us: the file is gone, so the lint never ran. */
function compatScriptMissing(result: { stdout?: string; stderr?: string }) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return output.includes('MODULE_NOT_FOUND')
    || (output.includes('Cannot find module') && output.includes(COMPAT_SCRIPT_NAME));
}

/**
 * Run the lint so that a failure still arrives as a report.
 *
 * Exiting non-zero is how the lint says it found something, and it is also what
 * throws away everything it found: the sandbox layer turns a failed shell into
 * SANDBOX_UNKNOWN_ERROR and keeps neither stdout nor stderr, so the caller is
 * handed "exit status 2" and nothing else. That reads like a broken sandbox
 * rather than a project to fix — the run that prompted this spent one turn
 * checking the CLI version and another guessing at a file before it landed on
 * the one the lint had already named. Echoing the status keeps the shell
 * successful, which is what lets the report travel as text.
 */
export function buildMakersCompatibilityCommand() {
  return [
    'set +e',
    `node ../${COMPAT_SCRIPT_NAME}`,
    'echo EXIT:$?',
  ].join('\n');
}

export async function runMakersCompatibilityCheck(
  context: AgentContext,
  state: ProjectState,
) {
  const [rules, profiles] = await Promise.all([
    loadMakersValidationRules(),
    loadMakersFrameworkProfiles(),
  ]);
  const script = buildMakersCompatibilityScript(rules, profiles);
  const scriptPath = `${state.sessionDir}/${COMPAT_SCRIPT_NAME}`;
  const fingerprint = compatScriptFingerprint(script);
  const upload = async () => {
    await requireSandbox(context).files.write(scriptPath, script);
    uploadedCompatScripts.set(state.sessionDir, fingerprint);
  };

  if (uploadedCompatScripts.get(state.sessionDir) !== fingerprint) {
    await upload();
  }

  const run = () => runCommandCapturingExit(
    context,
    buildMakersCompatibilityCommand(),
    { cwd: state.appDir, timeout: 20 },
  );

  const result = await run();
  if (result.exitCode !== 0 && compatScriptMissing(result)) {
    // Not a project failure — the lint had nothing to run. Restore the file and
    // ask again, because reporting this as a compatibility failure would send
    // the model looking for a problem in code that was never examined.
    uploadedCompatScripts.delete(state.sessionDir);
    await upload();
    return run();
  }
  return result;
}

/**
 * Keep fast, deterministic checks that the CLI cannot explain as clearly.
 *
 * The prefix rules here are about what the project must not contain: the host
 * restores /preview/ in the browser, so root-absolute paths are correct, and
 * what breaks is a path that carries the prefix already or a framework told to
 * expect it. The exception is a subresource URL in a page nothing builds, which
 * the parser fetches before the restoring shim can exist — that one has to be
 * relative, and it is the only root-absolute path still rejected here.
 *
 * The adapter check is the exception in shape — it is about what the project
 * must contain. It earns that because it is the only failure here that no other
 * gate sees: preview and build both pass without the adapter, and the
 * deployment is broken anyway.
 */
export async function assertMakersProjectCompatible(
  context: AgentContext,
  state: ProjectState,
) {
  const result = await runMakersCompatibilityCheck(context, state);
  if (result.exitCode !== 0) {
    throw new Error(
      `Makers compatibility check failed:\n${result.stderr || result.stdout}\nThis is the project lint, not the EdgeOne CLI: do not check the CLI version or inspect the environment. Fix only the reported project files, then rerun the same EdgeOne CLI command.`,
    );
  }
}
