/** Runtime-agnostic heuristics for classifying sandbox commands and MCP tools. */

export const MAKERS_CLI_UNAVAILABLE_ERROR_CODE = 'MAKERS_CLI_UNAVAILABLE';
export const MAKERS_CLI_UNAVAILABLE_MESSAGE =
  'The sandbox image does not include the preinstalled EdgeOne CLI.';

export function shortenToolName(name: string) {
  const match = name.match(/^mcp__[^_]+__(.+)$/);
  return match ? match[1] : name;
}

export function isInstallCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\bnpm\s+(install|i)\b/.test(normalized)
    || /\bpnpm\s+install\b/.test(normalized)
    || /\byarn\s+install\b/.test(normalized)
    || /\bbun\s+install\b/.test(normalized)
    || /\bpython3?\s+-m\s+pip\s+install\b/.test(normalized)
    || /\bpip3?\s+install\b/.test(normalized)
  );
}

export function isPreviewCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/.test(normalized)
    || /\b(next|vite|astro|nuxt)\s+dev\b/.test(normalized)
    || /\b(python\s+-m\s+http\.server|edgeone\s+makers\s+dev)\b/.test(normalized)
    || /\b(3000|8080)\b/.test(normalized) && /\b(dev|serve|server|preview|proxy)\b/.test(normalized)
  );
}

export function isMakersDevCommand(command: string) {
  return /\bedgeone\s+makers\s+dev\b/i.test(command);
}

export function isMakersDeployCommand(command: string) {
  return /\bedgeone\s+makers\s+deploy\b/i.test(command);
}

export function isEdgeoneVersionCommand(command: string) {
  const withoutExitEcho = command.trim().replace(
    /;\s*echo\s+["']?EXIT:\$\?["']?\s*$/i,
    '',
  ).trim();
  return /^edgeone\s+(?:--version|-v)$/i.test(withoutExitEcho);
}

export function buildEdgeoneVersionCheckCommand() {
  return [
    'set +e',
    'edgeone --version',
    'version_status=$?',
    'echo "EDGEONE_VERSION_EXIT:$version_status"',
    'exit 0',
  ].join('\n');
}

export function parseEdgeoneVersionExitCode(output: string) {
  const matches = [
    ...output.matchAll(
      /(?:^|[\n\r]|\\n)EDGEONE_VERSION_EXIT:(\d+)(?=\s|\\n|"|$)/g,
    ),
  ];
  if (matches.length === 0) return undefined;
  const value = Number(matches.at(-1)?.[1]);
  return Number.isInteger(value) ? value : undefined;
}

export function isEdgeoneCliUnavailable(output: string) {
  return [
    /\b(?:bash|sh|zsh)(?::[^\n\r]*)?\bedgeone:\s*(?:command\s+)?not found\b/i,
    /\b(?:bash|sh|zsh)(?::[^\n\r]*)?\bcommand not found:\s*edgeone\b/i,
    /\bnohup:\s*failed to run command\s+['"`]?edgeone['"`]?:\s*no such file or directory\b/i,
    /\bspawn\s+edgeone\s+enoent\b/i,
    /\bexec(?:vp)?\s+edgeone[^\n\r]*\benoent\b/i,
  ].some((pattern) => pattern.test(output));
}

function looksLikeEdgeoneCli(command: string) {
  // Match the `edgeone` binary, not npm scopes like `@edgeone/pages-blob`.
  return /(?:^|[\s;&|`(/])edgeone(?:\s|$)/i.test(command)
    || /\bnpx\s+edgeone\b/i.test(command);
}

export function forbiddenSandboxCommandReason(command: string): string | null {
  const text = command.trim();
  if (!text) return null;
  if (looksLikeEdgeoneCli(text)) {
    if (/\bnpx\s+edgeone\b/i.test(text)) {
      return 'Do not invoke EdgeOne through npx or install it. Use only the direct sandbox CLI lifecycle command; if the tool reports MAKERS_CLI_UNAVAILABLE, stop.';
    }
    if (/(?:^|\s)(?:-t|--token)(?:\s|=|$)/i.test(text)) {
      return 'Do not pass a token to the EdgeOne CLI. The host injects a short-lived tenant credential when one is configured.';
    }
    if (
      !isMakersDevCommand(text)
      && !isMakersDeployCommand(text)
      && !isEdgeoneVersionCommand(text)
    ) {
      return 'Only use the sandbox EdgeOne CLI for makers dev/deploy or one read-only version check. Do not inspect its installation, install it, log in, link accounts, or change remote environment variables. If the tool reports MAKERS_CLI_UNAVAILABLE, stop.';
    }
  }
  if (/https?:\/\/ai-gateway\.edgeone\.(?:link|ai)/i.test(text)) {
    return 'Do not probe the AI Gateway or enumerate models. Use context.env.AI_GATEWAY_MODEL with the documented @makers/hy3-preview fallback, then verify through the generated project endpoint once.';
  }
  if (/(?:^|[\s"'`/])[.]edgeone(?:\/|$)/i.test(text)) {
    return 'Do not inspect or modify generated .edgeone runtime artifacts. Return to the original CLI error and fix project source only when that error identifies a project issue.';
  }
  if (
    /pages-api\.(?:edgeone\.ai|cloud\.tencent\.com)/i.test(text)
    || /\b(?:Describe|Create|Delete|Modify)PagesProject/i.test(text)
  ) {
    return 'Do not call Makers/Pages APIs or delete other projects. If preview or deploy failed with a quota or environment error, tell the user.';
  }
  if (/[.]curlrc\b/.test(text)) {
    return 'Do not change curl defaults. Use the preinstalled EdgeOne CLI directly.';
  }
  return null;
}

export function isVerificationCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/.test(normalized)
    || /\b(npm|pnpm|yarn|bun)\s+run\s+(typecheck|tsc|check)\b/.test(normalized)
    || /\b(vite|next)\s+build\b/.test(normalized)
    || /\bnpx\s+tsc\b/.test(normalized)
    || /\btsc(\s|$)/.test(normalized)
    || /\bpython3?\s+-m\s+compileall\b/.test(normalized)
    || /\bpython3?\s+-m\s+py_compile\b/.test(normalized)
  );
}

function hasExitCodeEcho(cmd: string) {
  return /echo\s+["']?EXIT:\$\?/.test(cmd);
}

export function withExitCodeEcho(cmd: string) {
  const trimmed = cmd.trim();
  // Installs are echoed too: the sandbox reports a non-zero shell exit as
  // SANDBOX_UNKNOWN_ERROR and discards the output, so a failed `npm install`
  // otherwise reaches the model with the resolver error stripped off.
  if (
    !trimmed
    || hasExitCodeEcho(trimmed)
    || !(isVerificationCommand(trimmed) || isInstallCommand(trimmed))
  ) {
    return trimmed;
  }
  if (/\bnohup\b/.test(trimmed) || /&\s*$/.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}; echo EXIT:$?`;
}

export function parseEchoedExitCode(output: string): number | undefined {
  const matches = [...output.matchAll(/(?:^|[\n\r]|\\n)EXIT:(\d+)(?=\s|\\n|"|$)/g)];
  if (matches.length === 0) return undefined;
  const value = Number(matches[matches.length - 1][1]);
  return Number.isInteger(value) ? value : undefined;
}

export function stripEchoedExit(output: string) {
  return output
    .replace(/(?:\r?\n|\\n)?EXIT:\d+\s*$/, '')
    .replace(/\r?\nEXIT:\d+\s*\r?\n/g, '\n');
}
