/**
 * Helpers for sandbox preview via `edgeone makers dev`.
 * The public iframe still uses nginx :9000 /preview/; a tiny proxy on :3000
 * strips that prefix and forwards to makers-dev (default :8088).
 */

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const PREVIEW_PROXY_SCRIPT_PATH = '/tmp/edgeone-preview-proxy.cjs';

export function rewritePreviewProxyPath(url: string | undefined, prefix = '/preview'): string {
  if (!url) return '/';
  if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
    const next = url.slice(prefix.length);
    if (!next || next === '/') return '/';
    return next.startsWith('/') || next.startsWith('?') ? next : `/${next}`;
  }
  return url;
}

export function buildMakersDevLaunchCommand(port: number, projectName: string) {
  return `edgeone makers dev --port ${port} --skip-env-sync --name ${shellQuote(projectName)}`;
}

export function buildPreviewProxyScript(listenPort: number, targetPort: number, prefix = '/preview') {
  return `const http = require('http');
const net = require('net');

const LISTEN_PORT = ${listenPort};
const TARGET_PORT = ${targetPort};
const PREFIX = ${JSON.stringify(prefix)};

function rewritePath(url) {
  if (!url) return '/';
  if (url === PREFIX || url.startsWith(PREFIX + '/') || url.startsWith(PREFIX + '?')) {
    const next = url.slice(PREFIX.length);
    if (!next || next === '/') return '/';
    return next.startsWith('/') || next.startsWith('?') ? next : '/' + next;
  }
  return url;
}

const server = http.createServer((req, res) => {
  const path = rewritePath(req.url);
  const headers = { ...req.headers, host: '127.0.0.1:' + TARGET_PORT };
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: TARGET_PORT,
    path,
    method: req.method,
    headers,
  }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('preview proxy error');
  });
  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  const path = rewritePath(req.url);
  const target = net.connect(TARGET_PORT, '127.0.0.1', () => {
    const headerLines = Object.entries(req.headers).map(([key, value]) => {
      const serialized = Array.isArray(value) ? value.join(', ') : value;
      return key + ': ' + serialized;
    });
    target.write([
      req.method + ' ' + path + ' HTTP/1.1',
      ...headerLines,
      '',
      '',
    ].join('\\r\\n'));
    if (head && head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0');
`;
}
