/** Shared heuristics for classifying sandbox commands and MCP tool names. */

export function shortenToolName(name: string) {
  // mcp__edgeone-sandbox__files -> files
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

export function isInstallText(text: string) {
  const normalized = text.toLowerCase();
  return (
    /\bnpm\s+(install|i)\b/.test(normalized)
    || /\binstalling\b/.test(normalized)
    || /\badded\s+\d+\s+packages?\b/.test(normalized)
    || /\bpip3?\s+install\b/.test(normalized)
  );
}
