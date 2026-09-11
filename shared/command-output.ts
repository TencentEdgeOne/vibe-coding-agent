/**
 * Shape command logs for the activity pane.
 *
 * Installers and compilers dump thousands of progress lines; the useful signal
 * is almost always at the end. Keep a sliding window of the tail, collapse
 * npm's HTTP chatter, and never append a "truncated" marker.
 */

const DEFAULT_CHAR_LIMIT = 2_000;
const DEFAULT_LINE_LIMIT = 60;
const ANSI_RE = /\x1b\[[0-9;?]*[~A-Za-z]/g;
const FETCH_RE = /^\s*npm http (?:fetch|cache)\s+(?:GET|PUT|HEAD|POST|DELETE|PATCH|https?:)/;
const COMMAND_LOG_RE = /\bnpm (?:http (?:fetch|cache)|info|warn|error|notice) /;
const TRUNCATION_MARK_RE = /\n?\.\.\. truncated\s*$/i;

export function looksLikeCommandLog(value: string) {
  return COMMAND_LOG_RE.test(value);
}

export function formatCommandOutput(
  value: string,
  limits: { charLimit?: number; lineLimit?: number } = {},
) {
  const charLimit = limits.charLimit ?? DEFAULT_CHAR_LIMIT;
  const lineLimit = limits.lineLimit ?? DEFAULT_LINE_LIMIT;
  const normalized = value
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(TRUNCATION_MARK_RE, '');
  const compacted = compactNpmHttpLines(normalized)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!compacted) return '';

  const lines = compacted.split('\n');
  const tailed = lines.length > lineLimit ? lines.slice(-lineLimit).join('\n') : compacted;
  if (tailed.length <= charLimit) return tailed;

  const cut = tailed.slice(-charLimit);
  const firstNl = cut.indexOf('\n');
  return firstNl >= 0 ? cut.slice(firstNl + 1) : cut;
}

function compactNpmHttpLines(value: string) {
  const compacted: string[] = [];
  let fetchCount = 0;

  const flushFetch = () => {
    if (fetchCount <= 0) return;
    compacted.push(fetchCount === 1 ? 'npm http fetch' : `npm http fetch ×${fetchCount}`);
    fetchCount = 0;
  };

  for (const line of value.split('\n')) {
    if (FETCH_RE.test(line)) {
      fetchCount += 1;
      continue;
    }
    flushFetch();
    compacted.push(line);
  }
  flushFetch();
  return compacted.join('\n');
}
