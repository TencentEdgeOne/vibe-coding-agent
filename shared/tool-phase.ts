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
    || /\bpython\s+-m\s+http\.server\b/.test(normalized)
    || /\b(3000|8080)\b/.test(normalized) && /\b(dev|serve|server|preview|proxy)\b/.test(normalized)
  );
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
