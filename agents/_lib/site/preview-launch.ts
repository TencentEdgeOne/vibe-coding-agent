import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import {
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../constants.ts';
import type { ProjectState } from '../types.ts';
import { shellQuote } from '../utils/shell.ts';

export const SITE_PREVIEW_LOG = '/tmp/dev.log';

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type SitePreviewLaunch = {
  framework: 'vite' | 'dev' | 'static';
  command: string;
  readyPath: string;
};

async function readText(context: AgentContext, path: string) {
  const files = requireSandbox(context).files;
  if (!(await files.exists(path))) return '';
  const raw = await files.read(path);
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return '';
}

export async function readPackageJson(context: AgentContext, state: ProjectState): Promise<PackageJson | null> {
  const text = await readText(context, `${state.appDir}/package.json`);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as PackageJson;
  } catch {
    return null;
  }
}

export async function readBuildScript(context: AgentContext, state: ProjectState) {
  const scripts = (await readPackageJson(context, state))?.scripts;
  const build = scripts?.build;
  return typeof build === 'string' && build.trim() ? build.trim() : null;
}

async function previewAllowedHost(context: AgentContext) {
  try {
    const host = await Promise.resolve(requireSandbox(context).getHost?.(PREVIEW_PUBLIC_PORT));
    if (typeof host !== 'string' || !host.trim()) return '';
    const withProtocol = /^https?:\/\//i.test(host) ? host : `https://${host}`;
    return new URL(withProtocol).hostname;
  } catch {
    return '';
  }
}

const VITE_CONFIG_NAMES = [
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

async function findViteConfigFilename(context: AgentContext, state: ProjectState) {
  const files = requireSandbox(context).files;
  for (const name of VITE_CONFIG_NAMES) {
    if (await files.exists(`${state.appDir}/${name}`)) return name;
  }
  return '';
}

function vitePreviewConfigSource(userConfigSpecifier: string) {
  return [
    "import { defineConfig, loadConfigFromFile, mergeConfig } from 'vite';",
    '',
    "const reactDeps = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'];",
    "const mode = process.env.NODE_ENV || 'development';",
    "const configEnv = { command: 'serve', mode, isSsrBuild: false, isPreview: false };",
    `const userConfigSpecifier = ${JSON.stringify(userConfigSpecifier)};`,
    'let loaded = null;',
    'try {',
    '  loaded = userConfigSpecifier',
    '    ? await loadConfigFromFile(configEnv, new URL(userConfigSpecifier, import.meta.url).pathname)',
    '    : null;',
    '} catch (error) {',
    "  console.warn('[edgeone-preview] failed to load user Vite config:', error);",
    '}',
    'const userConfig = loaded?.config || {};',
    'const userServer = userConfig.server || {};',
    'const userHmr = userServer.hmr && typeof userServer.hmr === \'object\' ? userServer.hmr : {};',
    'const { path: _hmrPath, ...hmrWithoutPath } = userHmr;',
    'const sanitizedUserConfig = {',
    '  ...userConfig,',
    '  server: {',
    '    ...userServer,',
    '    hmr: hmrWithoutPath,',
    '  },',
    '};',
    'const existingOptimizeInclude = userConfig.optimizeDeps?.include;',
    'const optimizeInclude = Array.from(new Set([',
    '  ...(Array.isArray(existingOptimizeInclude) ? existingOptimizeInclude : []),',
    '  ...reactDeps,',
    ']));',
    'const edgeoneConfig = {',
    `  base: ${JSON.stringify(PREVIEW_PATH_PREFIX)},`,
    "  root: userConfig.root || process.cwd(),",
    '  optimizeDeps: {',
    '    include: optimizeInclude,',
    '  },',
    '  legacy: {',
    '    skipWebSocketTokenCheck: true,',
    '  },',
    '  plugins: [',
    '    {',
    "      name: 'edgeone-preview-path-tracker',",
    "      apply: 'serve',",
    '      transformIndexHtml: {',
    "        order: 'post',",
    '        handler(html) {',
    "          if (process.env.EDGEONE_PREVIEW_TRACK_PATH !== '1') return html;",
    '          var script =',
    "            '<script>(function(){' +",
    "            'if(window.parent===window)return;' +",
    "            'var s=function(){window.parent.postMessage({__edgeonePreviewPath:location.pathname+location.search+location.hash},\"*\");};' +",
    "            's();' +",
    "            'var h=history.pushState;var r=history.replaceState;' +",
    "            'history.pushState=function(){var a=h.apply(this,arguments);s();return a;};' +",
    "            'history.replaceState=function(){var a=r.apply(this,arguments);s();return a;};' +",
    "            'window.addEventListener(\"popstate\",s);window.addEventListener(\"hashchange\",s);' +",
    "            '})();<\\/script>';",
    "          return html.replace('</head>', script + '</head>');",
    '        },',
    '      },',
    '    },',
    '  ],',
    '  server: {',
    "    host: '0.0.0.0',",
    `    port: Number(process.env.PORT || ${PREVIEW_SERVER_PORT}),`,
    '    strictPort: true,',
    '    allowedHosts: true,',
    '    hmr: {',
    '      ...hmrWithoutPath,',
    "      protocol: 'wss',",
    '      clientPort: 443,',
    '    },',
    '  },',
    '};',
    '',
    'export default defineConfig(mergeConfig(sanitizedUserConfig, edgeoneConfig));',
    '',
  ].join('\n');
}

async function writeVitePreviewConfig(
  context: AgentContext,
  state: ProjectState,
  deps: Record<string, string>,
) {
  if ((deps.react || deps['react-dom']) && !deps['@vitejs/plugin-react']) {
    throw new Error(
      'Vite React preview requires @vitejs/plugin-react so React Fast Refresh works under /preview/. Add it to devDependencies and configure plugins: [react()].',
    );
  }
  const userConfigFilename = await findViteConfigFilename(context, state);
  const source = vitePreviewConfigSource(userConfigFilename ? `../${userConfigFilename}` : '');
  const files = requireSandbox(context).files;
  const relative = '.vite/edgeone-preview.config.mjs';
  const existing = await readText(context, `${state.appDir}/${relative}`);
  if (existing === source) return { relative, changed: false };
  await files.makeDir(`${state.appDir}/.vite`);
  await files.write(`${state.appDir}/${relative}`, source);
  return { relative, changed: true };
}

/** Rewrite the sandbox Vite overlay when it is stale. A running server must restart to load it. */
export async function syncVitePreviewConfig(context: AgentContext, state: ProjectState) {
  const pkg = await readPackageJson(context, state);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const scripts = Object.values(pkg?.scripts || {}).join(' ');
  if (!deps.vite && !/\bvite\b/.test(scripts)) return false;
  const written = await writeVitePreviewConfig(context, state, deps);
  return written.changed;
}

function waitUntilReady(port: number, readyPath: string) {
  const url = `http://127.0.0.1:${port}${readyPath}`;
  return [
    `for i in $(seq 1 75); do`,
    `  if curl --noproxy '*' -fsS ${shellQuote(url)} >/dev/null; then echo READY; exit 0; fi`,
    '  sleep 1',
    'done',
    `echo 'preview did not become ready' >&2`,
    `tail -n 40 ${shellQuote(SITE_PREVIEW_LOG)} >&2 || true`,
    'exit 1',
  ].join('\n');
}

function freePort(port: number) {
  return [
    'if command -v fuser >/dev/null 2>&1; then',
    `  fuser -k ${port}/tcp >/dev/null 2>&1 || true`,
    'elif command -v lsof >/dev/null 2>&1; then',
    `  lsof -ti tcp:${port} | xargs kill -TERM >/dev/null 2>&1 || true`,
    'fi',
    'sleep 1',
  ].join('\n');
}

/**
 * Start the site's own dev server on the preview port, under /preview/.
 * A package with Vite uses Vite. Anything else with a dev script uses that.
 * A directory with no dev script is served as static files.
 */
export async function buildSitePreviewLaunch(
  context: AgentContext,
  state: ProjectState,
): Promise<SitePreviewLaunch> {
  const port = PREVIEW_SERVER_PORT;
  const readyPath = PREVIEW_PATH_PREFIX;
  const pkg = await readPackageJson(context, state);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const scripts = pkg?.scripts || {};
  const allowedHost = await previewAllowedHost(context);
  const env = [
    `EDGEONE_PREVIEW_BASE_PATH=${shellQuote(PREVIEW_PATH_PREFIX.replace(/\/$/, ''))}`,
    'EDGEONE_PREVIEW_TRACK_PATH=1',
    allowedHost ? `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${shellQuote(allowedHost)}` : '',
  ].filter(Boolean).join(' ');

  let framework: SitePreviewLaunch['framework'] = 'static';
  let start = `ln -sfn . preview; nohup python3 -m http.server ${port} --bind 0.0.0.0 > ${SITE_PREVIEW_LOG} 2>&1 &`;

  if (deps.vite || /\bvite\b/.test(Object.values(scripts).join(' '))) {
    const config = (await writeVitePreviewConfig(context, state, deps)).relative;
    framework = 'vite';
    start = `nohup env ${env} npm run dev -- --host 0.0.0.0 --port ${port} --config ${shellQuote(config)} > ${SITE_PREVIEW_LOG} 2>&1 &`;
  } else if (scripts.dev) {
    framework = 'dev';
    start = `nohup env ${env} HOST=0.0.0.0 PORT=${port} npm run dev -- --host 0.0.0.0 --port ${port} > ${SITE_PREVIEW_LOG} 2>&1 &`;
  }

  return {
    framework,
    readyPath,
    command: [freePort(port), start, waitUntilReady(port, readyPath)].join('\n'),
  };
}
