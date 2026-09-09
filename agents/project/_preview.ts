import {
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../_constants';
import type { ProjectState } from '../_types';
import { debugLog } from '../utils/_debug';
import {
  normalizePublicUrl,
  previewTargetsMatch as previewTargetsMatchCore,
  resolvePreviewAllowedHost as resolvePreviewAllowedHostCore,
  resolvePreviewUrl,
  rewritePreviewAccessToken as rewritePreviewAccessTokenCore,
} from '../core/_preview-url.ts';
import { createProjectFiles } from '../core/_project-files.ts';
import { createMakersWorkspacePort } from '../core/adapters/_makers.ts';
import { runSandboxCommand } from './_commands';

const projectFilesFor = (context: any, state: ProjectState) =>
  createProjectFiles(createMakersWorkspacePort(context), state.appDir);

const PREVIEW_READY_ATTEMPTS = 75;
const PREVIEW_READY_TIMEOUT_S = 90;

export async function resolvePublicLinks(context: any) {
  const workspace = createMakersWorkspacePort(context);
  const previewHost = await workspace.getHost?.(PREVIEW_PUBLIC_PORT);
  const accessToken = workspace.accessToken;
  const browserLiveUrl = workspace.browserLiveUrl;
  debugLog(context, '[preview-link]', {
    internalPort: PREVIEW_SERVER_PORT,
    publicPort: PREVIEW_PUBLIC_PORT,
    proxyPath: PREVIEW_PATH_PREFIX,
    hasPreviewHost: Boolean(normalizePublicUrl(previewHost) || normalizePublicUrl(browserLiveUrl)),
    hasEnvdAccessToken: Boolean(accessToken),
    hasBrowserLiveUrl: Boolean(normalizePublicUrl(browserLiveUrl)),
  });

  return {
    previewUrl: resolvePreviewUrl({
      previewHost,
      accessToken,
      browserLiveUrl,
      pathPrefix: PREVIEW_PATH_PREFIX,
    }),
  };
}

export const previewTargetsMatch = previewTargetsMatchCore;

/** Rotate envdAccessToken on an already-published preview URL (same host/path). */
export const rewritePreviewAccessToken = rewritePreviewAccessTokenCore;

// Async because WorkspacePort.getHost may return a promise. Resolving it in a
// sync path would hand a Promise to URL parsing, which degrades silently to an
// empty allowed host and breaks Vite preview rather than failing loudly.
async function resolvePreviewAllowedHost(context: any) {
  try {
    return resolvePreviewAllowedHostCore(
      await createMakersWorkspacePort(context).getHost?.(PREVIEW_PUBLIC_PORT),
    );
  } catch {
    return '';
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function buildViteAllowedHostEnvPrefix(context: any) {
  const allowedHost = await resolvePreviewAllowedHost(context);
  return allowedHost
    ? `env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${shellQuote(allowedHost)} `
    : '';
}

async function buildFrontendPreviewEnvPrefix(context: any) {
  const allowedHost = await resolvePreviewAllowedHost(context);
  return [
    `EDGEONE_PREVIEW_BASE_PATH=${shellQuote(PREVIEW_PATH_PREFIX.replace(/\/$/, ''))}`,
    // Tells the injected preview script to post its URL back to the parent
    // window so the address bar can mirror the current route instead of the
    // raw sandbox host.
    'EDGEONE_PREVIEW_TRACK_PATH=1',
    allowedHost ? `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${shellQuote(allowedHost)}` : '',
  ].filter(Boolean).join(' ');
}

async function findViteConfigFilename(context: any, state: ProjectState) {
  return projectFilesFor(context, state).findFirst([
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.cts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.cjs',
  ]);
}

async function prepareVitePreviewConfig(context: any, state: ProjectState, deps: Record<string, string>) {
  if ((deps.react || deps['react-dom']) && !deps['@vitejs/plugin-react']) {
    throw new Error(
      'Vite React preview requires @vitejs/plugin-react so React Fast Refresh works under /preview/. Add it to devDependencies and configure plugins: [react()].',
    );
  }

  const userConfigFilename = await findViteConfigFilename(context, state);
  const userConfigSpecifier = userConfigFilename ? `../${userConfigFilename}` : '';
  const files = projectFilesFor(context, state);
  await files.makeDir('.vite');
  await files.write('.vite/edgeone-preview.config.mjs', [
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
  ].join('\n'));
  return '.vite/edgeone-preview.config.mjs';
}

async function assertNextPreviewConfig(context: any, state: ProjectState) {
  const candidates = [
    'next.config.js',
    'next.config.mjs',
    'next.config.cjs',
    'next.config.mts',
  ];
  const files = projectFilesFor(context, state);
  for (const filename of candidates) {
    if (!(await files.exists(filename))) {
      continue;
    }
    const result = await runSandboxCommand(
      context,
      `node -e ${shellQuote(`const fs=require('fs'); const s=fs.readFileSync(${JSON.stringify(filename)}, 'utf8'); process.exit(/basePath\\s*:/.test(s) && /EDGEONE_PREVIEW_BASE_PATH/.test(s) ? 0 : 2);`)}`,
      {
        cwd: state.appDir,
        timeout: 10,
      },
    );
    if (result.exitCode === 0) {
      return;
    }
    if (result.exitCode !== 2) {
      throw new Error(result.stderr || result.stdout || `Failed to inspect ${filename}.`);
    }
    throw new Error(
      `${filename} must support sandbox preview with basePath: process.env.EDGEONE_PREVIEW_BASE_PATH || ''.`,
    );
  }

  throw new Error(
    "Next.js preview requires next.config.js or next.config.mjs with basePath: process.env.EDGEONE_PREVIEW_BASE_PATH || ''.",
  );
}

type PreviewStartCommand = {
  command: string;
  framework: string;
  readyPath: string;
};

export async function startPreviewServer(context: any, state: ProjectState) {
  const port = PREVIEW_SERVER_PORT;
  const release = await runSandboxCommand(
    context,
    [
      'killed=0',
      'if command -v fuser >/dev/null 2>&1; then',
      `  if fuser ${port}/tcp >/dev/null 2>&1; then`,
      `    fuser -k ${port}/tcp >/dev/null 2>&1 || true`,
      '    killed=1',
      '  fi',
      'elif command -v lsof >/dev/null 2>&1; then',
      `  pids=$(lsof -ti tcp:${port} 2>/dev/null || true)`,
      '  if [ -n "$pids" ]; then',
      '    echo "$pids" | xargs -r kill -9 >/dev/null 2>&1 || true',
      '    killed=1',
      '  fi',
      'fi',
      'if [ "$killed" = 1 ]; then sleep 1; fi',
    ].join('\n'),
    { timeout: 10 },
  );

  if (release.exitCode !== 0) {
    throw new Error(release.stderr || release.stdout || `Failed to free port ${port}.`);
  }

  const start = await detectPreviewStartCommand(context, state);
  const startResult = await runSandboxCommand(
    context,
    `: > /tmp/dev.log; ${start.command}`,
    {
      cwd: state.appDir,
      timeout: 10,
    },
  );

  if (startResult.exitCode !== 0) {
    throw new Error(startResult.stderr || startResult.stdout || `Failed to start preview server on port ${port}.`);
  }

  await waitForPreviewReady(context, port, start.readyPath);

  return {
    port,
    publicPort: PREVIEW_PUBLIC_PORT,
    proxyPath: PREVIEW_PATH_PREFIX,
    framework: start.framework,
    command: start.command,
    readyPath: start.readyPath,
    ready: true,
  };
}

async function waitForPreviewReady(context: any, port: number, readyPath: string) {
  const url = `http://127.0.0.1:${port}${readyPath}`;
  // Always exit 0. A non-zero status is SANDBOX_UNKNOWN_ERROR and drops /tmp/dev.log.
  const probe = await runSandboxCommand(
    context,
    [
      `for i in $(seq 1 ${PREVIEW_READY_ATTEMPTS}); do`,
      `  if curl -fsS ${shellQuote(url)} >/dev/null; then echo __PREVIEW_READY__; exit 0; fi;`,
      '  sleep 1;',
      'done;',
      'echo __PREVIEW_NOT_READY__;',
      "echo '--- /tmp/dev.log ---';",
      'tail -n 160 /tmp/dev.log || true;',
      "echo '--- listeners ---';",
      `(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null || true) | grep ${port} || true;`,
      'exit 0',
    ].join('\n'),
    { timeout: PREVIEW_READY_TIMEOUT_S },
  );

  if (probe.stdout.includes('__PREVIEW_READY__')) {
    return;
  }

  const detail = [probe.stdout, probe.stderr].filter(Boolean).join('\n').trim();
  throw new Error(
    detail
      ? `Preview server did not become ready on ${url}.\n${detail}`
      : `Preview server did not become ready on ${url}.`,
  );
}

export async function isPreviewServerReady(context: any, readyPath = PREVIEW_PATH_PREFIX) {
  try {
    const result = await runSandboxCommand(
      context,
      `curl -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}${readyPath}`)} >/dev/null`,
      { timeout: 10 },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function detectPreviewStartCommand(
  context: any,
  state: ProjectState,
): Promise<PreviewStartCommand> {
  const port = PREVIEW_SERVER_PORT;
  const packageExists = await projectFilesFor(context, state).hasPackageJson();
  if (packageExists) {
    const metadata = await readPackageMetadata(context, state);
    const scripts = metadata.scripts || {};
    const deps = metadata.deps || {};
    const scriptText = Object.values(scripts).join(' ');
    const frontendPreviewEnv = await buildFrontendPreviewEnvPrefix(context);
    const viteAllowedHostEnv = await buildViteAllowedHostEnvPrefix(context);

    if (deps.next || /\bnext\b/.test(scriptText)) {
      await assertNextPreviewConfig(context, state);
      return {
        framework: 'next',
        command: `nohup env ${frontendPreviewEnv} npm run dev -- --hostname 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
        readyPath: PREVIEW_PATH_PREFIX,
      };
    }

    if (deps.vite || /\bvite\b/.test(scriptText)) {
      const vitePreviewConfig = await prepareVitePreviewConfig(context, state, deps);
      return {
        framework: 'vite',
        command: `nohup env ${frontendPreviewEnv} npm run dev -- --host 0.0.0.0 --port ${port} --config ${shellQuote(vitePreviewConfig)} > /tmp/dev.log 2>&1 &`,
        readyPath: PREVIEW_PATH_PREFIX,
      };
    }

    if (
      deps.astro
      || deps.nuxt
      || deps['@sveltejs/kit']
      || /\b(astro|nuxt|svelte-kit)\b/.test(scriptText)
    ) {
      return {
        framework: 'frontend-dev-server',
        command: `nohup ${viteAllowedHostEnv}npm run dev -- --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
        readyPath: PREVIEW_PATH_PREFIX,
      };
    }

    if (scripts.dev) {
      return {
        framework: 'node-dev-server',
        command: `nohup env HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=${port} npm run dev -- --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
        readyPath: PREVIEW_PATH_PREFIX,
      };
    }

    if (scripts.start) {
      return {
        framework: 'node-start-server',
        command: `nohup env HOST=0.0.0.0 HOSTNAME=0.0.0.0 PORT=${port} npm start > /tmp/dev.log 2>&1 &`,
        readyPath: PREVIEW_PATH_PREFIX,
      };
    }
  }

  const pythonCommand = await detectPythonPreviewCommand(context, state);
  if (pythonCommand) {
    return pythonCommand;
  }

  return {
    framework: 'static-http',
    // Symlink so python http.server can serve the app under /preview/. Hidden
    // from the Files panel / source archive (see FILE_TREE_IGNORED_* / ARCHIVE_*).
    command: `ln -sfn . preview; nohup python3 -m http.server ${port} --bind 0.0.0.0 > /tmp/dev.log 2>&1 &`,
    readyPath: PREVIEW_PATH_PREFIX,
  };
}

async function readPackageMetadata(
  context: any,
  state: ProjectState,
): Promise<{
  scripts?: Record<string, string>;
  deps?: Record<string, string>;
}> {
  const result = await runSandboxCommand(
    context,
    [
      'node -e "',
      'const fs=require(\'fs\');',
      'const p=JSON.parse(fs.readFileSync(\'package.json\',\'utf8\'));',
      'process.stdout.write(JSON.stringify({scripts:p.scripts||{},deps:{...(p.dependencies||{}),...(p.devDependencies||{})}}));',
      '"',
    ].join(''),
    {
      cwd: state.appDir,
      timeout: 10,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to parse package.json for preview startup.');
  }

  try {
    return JSON.parse(result.stdout || '{}');
  } catch {
    throw new Error('Failed to parse package.json metadata for preview startup.');
  }
}

async function detectPythonPreviewCommand(
  context: any,
  state: ProjectState,
): Promise<PreviewStartCommand | null> {
  const port = PREVIEW_SERVER_PORT;
  const result = await runSandboxCommand(
    context,
    [
      'if [ -f main.py ] && grep -q "FastAPI(" main.py 2>/dev/null; then echo fastapi:main; exit 0; fi;',
      'if [ -f app.py ] && grep -q "FastAPI(" app.py 2>/dev/null; then echo fastapi:app; exit 0; fi;',
      'if [ -f app.py ] && grep -q "Flask(" app.py 2>/dev/null; then echo flask:app; exit 0; fi;',
      'if [ -f main.py ] && grep -q "Flask(" main.py 2>/dev/null; then echo flask:main; exit 0; fi;',
      'find . -maxdepth 2 -type f -name "*.py" -print -quit',
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 10,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to inspect Python project for preview startup.');
  }

  const marker = String(result.stdout || '').trim();
  if (marker === 'fastapi:main') {
    return {
      framework: 'fastapi',
      command: `nohup python3 -m uvicorn main:app --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
      readyPath: PREVIEW_PATH_PREFIX,
    };
  }
  if (marker === 'fastapi:app') {
    return {
      framework: 'fastapi',
      command: `nohup python3 -m uvicorn app:app --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
      readyPath: PREVIEW_PATH_PREFIX,
    };
  }
  if (marker === 'flask:app') {
    return {
      framework: 'flask',
      command: `nohup python3 -m flask --app app run --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
      readyPath: PREVIEW_PATH_PREFIX,
    };
  }
  if (marker === 'flask:main') {
    return {
      framework: 'flask',
      command: `nohup python3 -m flask --app main run --host 0.0.0.0 --port ${port} > /tmp/dev.log 2>&1 &`,
      readyPath: PREVIEW_PATH_PREFIX,
    };
  }
  return null;
}
