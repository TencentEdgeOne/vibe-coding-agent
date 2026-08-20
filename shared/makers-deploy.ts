/**
 * Runtime-agnostic helpers for Makers CLI --json deploy output and URL detection.
 * Keep this free of sandbox / React imports so tests and the frontend can share it.
 */

export const DEFAULT_MAKERS_DEPLOY_PROJECT_NAME = 'vibe-coding-playground';

export type MakersDeploySuccess = {
  status: 'success';
  url: string;
  type?: string;
  projectId?: string;
  deploymentId?: string;
  consoleUrl?: string;
};

export type MakersDeployFailure = {
  status: 'error';
  error: string;
};

export type MakersDeployJson = MakersDeploySuccess | MakersDeployFailure;

export function parseMakersDeployJson(stdout: string, stderr = ''): MakersDeployJson {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.status === 'success' && typeof parsed.url === 'string' && parsed.url.trim()) {
        return {
          status: 'success',
          url: parsed.url.trim(),
          ...(typeof parsed.type === 'string' ? { type: parsed.type } : {}),
          ...(typeof parsed.projectId === 'string' ? { projectId: parsed.projectId } : {}),
          ...(typeof parsed.deploymentId === 'string' ? { deploymentId: parsed.deploymentId } : {}),
          ...(typeof parsed.consoleUrl === 'string' ? { consoleUrl: parsed.consoleUrl } : {}),
        };
      }
      if (parsed.status === 'error') {
        const error = typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : 'Deploy failed.';
        return { status: 'error', error };
      }
    } catch {
      // Keep scanning earlier lines; CLI may print non-JSON before the result.
    }
  }

  const textMatch = combined.match(/EDGEONE_DEPLOY_URL=(\S+)/);
  if (textMatch?.[1]) {
    return { status: 'success', url: textMatch[1] };
  }

  const quota = combined.match(/Makers project exceeds \d+ limit/i);
  if (quota) {
    return { status: 'error', error: quota[0] };
  }

  return {
    status: 'error',
    error: 'Deploy did not return a parseable --json result.',
  };
}

export function formatMakersDeployFailure(stdout: string, stderr = '', fallback = ''): string {
  const parsed = parseMakersDeployJson(stdout, stderr);
  const combined = [stderr, stdout, fallback].filter(Boolean).join('\n').trim();
  let error = parsed.status === 'error' ? parsed.error : '';
  if (!error || error === 'Deploy did not return a parseable --json result.') {
    error = combined.slice(-1500) || fallback || 'Deploy failed.';
  }
  if (/exceeds \d+ limit/i.test(error) || /exceeds \d+ limit/i.test(combined)) {
    return [
      error.includes('exceeds') ? error : 'Makers project exceeds the account limit.',
      'Do not delete other Makers projects, do not call Pages APIs, and do not run the edgeone CLI.',
      'Tell the user the mock-deploy account is out of project quota and they need to free a slot or reuse an existing project name.',
    ].join(' ');
  }
  return error;
}

export function isMakersDeployUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/preview/' || parsed.pathname.startsWith('/preview/')) {
      return false;
    }
    return /(?:^|\.)edgeone\.(?:cool|ai|link)$/i.test(parsed.hostname)
      || /(?:^|\.)pages\.edgeone\./i.test(parsed.hostname)
      || /(?:^|\.)edgeone\.page$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function redactSecret(text: string, secret: string) {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const MAKERS_PREVIEW_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function buildEdgeoneCliPrewarmScript() {
  return [
    'set +e',
    'if command -v edgeone >/dev/null 2>&1; then exit 0; fi',
    'if [ -f /tmp/edgeone-cli-install.pid ] && kill -0 "$(cat /tmp/edgeone-cli-install.pid)" 2>/dev/null; then exit 0; fi',
    'rm -f /tmp/edgeone-cli-install.status /tmp/edgeone-cli-install.log',
    'nohup sh -c \'npm install -g edgeone@latest --no-audit --no-fund --prefer-offline > /tmp/edgeone-cli-install.log 2>&1; status=$?; echo "$status" > /tmp/edgeone-cli-install.status.tmp; mv /tmp/edgeone-cli-install.status.tmp /tmp/edgeone-cli-install.status\' >/dev/null 2>&1 &',
    'echo "$!" > /tmp/edgeone-cli-install.pid',
    'exit 0',
  ].join('\n');
}

export function buildEdgeoneCliEnsureScript() {
  return [
    'set +e',
    'export PAGES_SOURCE=skills',
    'if command -v edgeone >/dev/null 2>&1; then',
    '  edgeone -v',
    '  echo EXIT:0',
    '  exit 0',
    'fi',
    'if [ -f /tmp/edgeone-cli-install.pid ] && kill -0 "$(cat /tmp/edgeone-cli-install.pid)" 2>/dev/null; then',
    '  for i in $(seq 1 420); do',
    '    command -v edgeone >/dev/null 2>&1 && break',
    '    [ -f /tmp/edgeone-cli-install.status ] && break',
    '    sleep 1',
    '  done',
    'fi',
    'if command -v edgeone >/dev/null 2>&1; then',
    '  edgeone -v',
    '  echo EXIT:0',
    '  exit 0',
    'fi',
    'prefix=$(npm prefix -g 2>/dev/null || echo /usr)',
    'rm -rf "$prefix/lib/node_modules/edgeone" "$prefix/lib/node_modules/.edgeone-"* 2>/dev/null',
    'npm install -g edgeone@latest --no-audit --no-fund --prefer-offline',
    'status=$?',
    'command -v edgeone >/dev/null 2>&1 && edgeone -v',
    'echo EXIT:$status',
    'exit 0',
  ].join('\n');
}

export function buildMakersPreviewVerifyScript(quotedUrl: string) {
  return [
    'set +e',
    'rm -f /tmp/makers-cookies.txt /tmp/makers-preview-body',
    `code=$(curl -sS -L --max-time 30 -A ${shellQuote(MAKERS_PREVIEW_USER_AGENT)} -c /tmp/makers-cookies.txt -b /tmp/makers-cookies.txt -o /tmp/makers-preview-body -w '%{http_code}' ${quotedUrl})`,
    'status=$?',
    'if [ "$status" -ne 0 ]; then',
    '  echo "CURL_ERROR"',
    '  echo EXIT:1',
    '  exit 0',
    'fi',
    'bytes=$(wc -c < /tmp/makers-preview-body | tr -d " ")',
    'echo "HTTP:$code BYTES:$bytes"',
    'if [ "$code" -lt 200 ] || [ "$code" -ge 400 ]; then',
    '  echo EXIT:2',
    '  exit 0',
    'fi',
    'if [ "${bytes:-0}" -lt 1 ]; then',
    '  echo EXIT:3',
    '  exit 0',
    'fi',
    'echo EXIT:0',
    'exit 0',
  ].join('\n');
}
