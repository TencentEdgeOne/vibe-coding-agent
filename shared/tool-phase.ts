/** Runtime-agnostic heuristics for classifying sandbox commands and MCP tools. */

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

function looksLikeEdgeoneCli(command: string) {
  // Match the `edgeone` binary, not npm scopes like `@edgeone/pages-blob`.
  return /(?:^|[\s;&|`(/])edgeone(?:\s|$)/i.test(command)
    || /\bnpx\s+edgeone\b/i.test(command);
}

export function forbiddenSandboxCommandReason(command: string): string | null {
  const text = command.trim();
  if (!text) return null;
  if (looksLikeEdgeoneCli(text)) {
    return 'Do not run the edgeone CLI or pass tokens. Call publish_preview. If that tool failed, read its error and tell the user — do not debug the CLI.';
  }
  if (/https?:\/\/ai-gateway\.edgeone\.(?:link|ai)/i.test(text)) {
    return 'Do not probe the AI Gateway or enumerate models. Use context.env.AI_GATEWAY_MODEL with the documented @makers/hy3-preview fallback, then verify through the generated project endpoint once.';
  }
  if (/(?:^|[\s"'`/])[.]edgeone(?:\/|$)/i.test(text)) {
    return 'Do not inspect or modify generated .edgeone runtime artifacts. Fix project source files only, then call publish_preview.';
  }
  if (
    /pages-api\.(?:edgeone\.ai|cloud\.tencent\.com)/i.test(text)
    || /\b(?:Describe|Create|Delete|Modify)PagesProject/i.test(text)
  ) {
    return 'Do not call Makers/Pages APIs or delete other projects. If preview or deploy failed with a quota or environment error, tell the user.';
  }
  if (/[.]curlrc\b/.test(text)) {
    return 'Do not change curl defaults. Call publish_preview.';
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
  if (!trimmed || hasExitCodeEcho(trimmed) || !isVerificationCommand(trimmed)) {
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
