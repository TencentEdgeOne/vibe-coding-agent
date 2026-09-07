/**
 * Claude Agent SDK transcript helpers. Runtime-agnostic so tests and the
 * browser can share the filename / JSONL shape without importing the SDK.
 */

export function sessionEntriesToJsonl(entries: unknown[]): string {
  if (entries.length === 0) {
    return '';
  }
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

export function claudeSessionExportFilename(sessionId?: string | null, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const shortId = sessionId?.trim().slice(0, 8) || 'session';
  return `claude-session-${shortId}-${stamp}.jsonl`;
}
