import {
  FILE_TREE_IGNORED_DIRECTORIES,
  FILE_TREE_IGNORED_FILENAMES,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
  PREVIEW_BINARY_EXTENSIONS,
  PREVIEW_MAX_BYTES,
} from './_constants';
import type { BuildResult, BuildStatus, FileTreeItem, ProjectState, ScaffoldLog } from './_types';
import { debugLog } from './utils/_debug';
import { readFileExtension, safeSegment } from './utils/_paths';
import { detectFatalToolError } from './utils/_text';

export function createProjectState(conversationId: string): ProjectState {
  const sessionDir = `projects/${safeSegment(conversationId)}`;
  return {
    created: false,
    sessionDir,
    appDir: `${sessionDir}/app`,
  };
}

type SandboxCommandOptions = {
  cwd?: string;
  timeout?: number;
  [key: string]: unknown;
};

type SandboxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  [key: string]: unknown;
};

export async function runSandboxCommand(
  context: any,
  command: string,
  options: SandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  try {
    const result = await context.sandbox.commands.run(command, options) as SandboxCommandResult;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.exitCode !== 0 && !stdout.trim() && !stderr.trim()) {
      return {
        ...result,
        stdout,
        stderr: formatSandboxCommandExit(command, options, result.exitCode),
      };
    }
    return {
      ...result,
      stdout,
      stderr,
    };
  } catch (error) {
    throw new Error(formatSandboxCommandError(error, command, options));
  }
}

function formatSandboxCommandExit(
  command: string,
  options: SandboxCommandOptions,
  exitCode: number,
) {
  return [
    `Sandbox command exited with code ${exitCode} while running: ${command}`,
    options.cwd ? `cwd: ${options.cwd}` : '',
    typeof options.timeout === 'number' ? `timeout: ${options.timeout}s` : '',
  ].filter(Boolean).join('\n');
}

function formatSandboxCommandError(
  error: unknown,
  command: string,
  options: SandboxCommandOptions,
) {
  const parts = [`Sandbox command failed while running: ${command}`];
  if (options.cwd) {
    parts.push(`cwd: ${options.cwd}`);
  }
  if (typeof options.timeout === 'number') {
    parts.push(`timeout: ${options.timeout}s`);
  }

  const errorRecord = error && typeof error === 'object'
    ? error as { message?: unknown; stdout?: unknown; stderr?: unknown }
    : {};
  const message = error instanceof Error ? error.message : String(error || '');
  if (message) {
    parts.push(`error: ${message}`);
  }

  const stderr = typeof errorRecord.stderr === 'string' ? errorRecord.stderr.trim() : '';
  const stdout = typeof errorRecord.stdout === 'string' ? errorRecord.stdout.trim() : '';
  if (stderr) {
    parts.push(`stderr: ${truncateCommandOutput(stderr)}`);
  }
  if (stdout) {
    parts.push(`stdout: ${truncateCommandOutput(stdout)}`);
  }

  return parts.join('\n');
}

function truncateCommandOutput(value: string) {
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

export async function resetProjectWorkspace(
  context: any,
  state: ProjectState,
) {
  assertResettableProjectPath(state);

  const sandbox = context.sandbox;

  await sandbox.files.makeDir(state.sessionDir);

  const appDirExists = await sandbox.files.exists(state.appDir);
  if (appDirExists) {
    if (typeof sandbox.files.remove === 'function') {
      await sandbox.files.remove(state.appDir);
    } else {
      const result = await runSandboxCommand(context, 'rm -rf app', {
        cwd: state.sessionDir,
        timeout: 60,
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || 'Failed to initialize the project workspace.');
      }
    }
  }

  await sandbox.files.makeDir(state.appDir);
  state.created = false;
  state.previewUrl = undefined;
  state.sandboxDebugUrl = undefined;
  return appDirExists;
}

function assertResettableProjectPath(state: ProjectState) {
  if (state.appDir !== `${state.sessionDir}/app`) {
    throw new Error(`Refusing to operate on an unexpected project path: ${state.appDir}`);
  }
  if (!/^projects\/[a-zA-Z0-9_-]+$/.test(state.sessionDir)) {
    throw new Error(`Refusing to operate on an unexpected session path: ${state.sessionDir}`);
  }
  if (!/^projects\/[a-zA-Z0-9_-]+\/app$/.test(state.appDir)) {
    throw new Error(`Refusing to operate on an unexpected project path: ${state.appDir}`);
  }
}

export async function ensureProjectScaffold(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
) {
  const sandbox = context.sandbox;
  onLog?.({ stream: 'status', content: `Preparing the project workspace ${state.appDir}` });
  
  await sandbox.files.makeDir(state.sessionDir);
  await sandbox.files.makeDir(state.appDir);

  const existing = await runSandboxCommand(
    context,
    [
      'find . -mindepth 1 -maxdepth 2',
      "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' \\) -prune",
      '-o -print',
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 60,
    },
  );
  if (existing.exitCode !== 0) {
    throw new Error(existing.stderr || existing.stdout || 'Workspace inspection failed.');
  }
  debugLog(context, '[sandbox-info]', { available: Boolean(context.sandbox.getInfo()) });

  // One conversation_id maps to one long-lived project. Reuse existing business
  // files without overwriting them.
  if (existing.stdout.trim()) {
    onLog?.({ stream: 'status', content: 'Existing project workspace detected; skipping initialization.' });
    return false;
  }

  onLog?.({ stream: 'status', content: 'Prepared an empty project workspace. Waiting for the agent to generate project files.' });
  
  return true;
}

export async function runVerification(context: any, state: ProjectState): Promise<BuildResult> {
  try {
    const packageExists = await context.sandbox.files.exists(`${state.appDir}/package.json`);
    if (packageExists) {
      const hasBuildScript = await runSandboxCommand(
        context,
        'node -e "const p=require(\'./package.json\'); process.exit(p.scripts && p.scripts.build ? 0 : 2)"',
        {
          cwd: state.appDir,
          timeout: 30,
        },
      );

      if (hasBuildScript.exitCode === 0) {
        const result = await runSandboxCommand(context, 'npm run build', {
          cwd: state.appDir,
          timeout: 600,
        });

        return {
          status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }

      if (hasBuildScript.exitCode !== 2) {
        return {
          status: 'failed',
          stdout: hasBuildScript.stdout,
          stderr: hasBuildScript.stderr || 'Failed to parse package.json; unable to determine whether a build script exists.',
        };
      }
    }

    const pythonFiles = await runSandboxCommand(
      context,
      [
        'find .',
        "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' -o -path './.venv' -o -path './venv' \\) -prune",
        "-o -name '*.py' -print -quit",
      ].join(' '),
      {
        cwd: state.appDir,
        timeout: 30,
      },
    );

    if (pythonFiles.exitCode !== 0) {
      return {
        status: 'failed',
        stdout: pythonFiles.stdout,
        stderr: pythonFiles.stderr || 'Python file inspection failed.',
      };
    }

    if (pythonFiles.stdout.trim()) {
      const result = await runSandboxCommand(context, 'python -m compileall .', {
        cwd: state.appDir,
        timeout: 300,
      });

      return {
        status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    return {
      status: 'skipped',
      stdout: 'No package build script or Python source files found; verification skipped.',
    };
  } catch (error) {
    const commandError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const stdout = typeof commandError.stdout === 'string' ? commandError.stdout : '';
    const stderr = typeof commandError.stderr === 'string' ? commandError.stderr : '';
    const message = error instanceof Error ? error.message : String(error);
    const fatal = detectFatalToolError([stdout, stderr, message].filter(Boolean).join('\n'));
    return {
      status: 'failed',
      stdout,
      stderr: fatal || stderr || message || 'Verification failed.',
      ...(fatal ? { fatal: true } : {}),
    };
  }
}

export async function getFileTree(context: any, state: ProjectState): Promise<FileTreeItem[]> {
  const ignoredDirectoryPruneExpression = FILE_TREE_IGNORED_DIRECTORIES
    .map((dir) => `-path './${dir}'`)
    .join(' -o ');
  const result = await runSandboxCommand(
    context,
    [
      'find .',
      `\\( ${ignoredDirectoryPruneExpression} \\) -prune`,
      "-o -maxdepth 4 -print",
      "| while IFS= read -r path; do",
      "[ \"$path\" = \".\" ] && continue;",
      "if [ -d \"$path\" ]; then",
      "printf 'directory\\t%s\\n' \"$path\";",
      "else",
      "printf 'file\\t%s\\n' \"$path\";",
      "fi;",
      "done",
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 30,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to read the file list.');
  }

  return result.stdout
    .split('\n')
    .map((line: string) => line.trim())
    .map((line: string) => {
      const separatorIndex = line.indexOf('\t');
      const type = separatorIndex >= 0 ? line.slice(0, separatorIndex) : '';
      const rawPath = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
      return {
        rawPath,
        type,
      };
    })
    .filter((item: { rawPath: string; type: string }) => (
      item.rawPath
      && (item.type === 'file' || item.type === 'directory')
    ))
    .filter((item: { rawPath: string; type: string }) => {
      const name = item.rawPath.replace(/^\.\//, '').split('/').pop() || '';
      return !FILE_TREE_IGNORED_FILENAMES.has(name);
    })
    .slice(0, 220)
    .map((item: { rawPath: string; type: string }) => {
      const path = item.rawPath.replace(/^\.\//, '');
      const name = path.split('/').pop() || path;
      return {
        path,
        name,
        type: item.type as 'file' | 'directory',
        depth: path.split('/').length - 1,
      };
    });
}

export async function resolvePublicLinks(context: any) {
  const previewHost = context.sandbox.getHost(PREVIEW_PUBLIC_PORT);
  const accessToken = context.sandbox.envdAccessToken;
  const previewBaseUrl = normalizePublicUrl(previewHost);
  const sandboxDebugUrl = normalizePublicUrl(context.sandbox.browser?.liveUrl);
  debugLog(context, '[preview-link]', {
    internalPort: PREVIEW_SERVER_PORT,
    publicPort: PREVIEW_PUBLIC_PORT,
    proxyPath: PREVIEW_PATH_PREFIX,
    hasPreviewHost: Boolean(previewBaseUrl),
    hasEnvdAccessToken: Boolean(accessToken),
    hasSandboxDebugUrl: Boolean(sandboxDebugUrl),
  });

  const previewUrl = (previewBaseUrl && accessToken)
    ? buildPublicPreviewUrl(previewBaseUrl, accessToken)
    : undefined;

  return {
    previewUrl,
    sandboxDebugUrl,
  };
}

function normalizePublicUrl(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function buildPublicPreviewUrl(baseUrl: string, token: string) {
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = PREVIEW_PATH_PREFIX;
    parsed.search = '';
    parsed.hash = '';
    return appendAccessToken(parsed.toString(), token);
  } catch {
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    return appendAccessToken(`${trimmedBase}${PREVIEW_PATH_PREFIX}`, token);
  }
}

function appendAccessToken(url: string, token: string) {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', token);
    }
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}access_token=${encodeURIComponent(token)}`;
  }
}

function resolvePreviewAllowedHost(context: any) {
  try {
    const previewHost = context.sandbox.getHost(PREVIEW_PUBLIC_PORT);
    const previewUrl = normalizePublicUrl(previewHost);
    if (!previewUrl) {
      return '';
    }
    return new URL(previewUrl).hostname;
  } catch {
    return '';
  }
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildViteAllowedHostEnvPrefix(context: any) {
  const allowedHost = resolvePreviewAllowedHost(context);
  return allowedHost
    ? `env __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${shellQuote(allowedHost)} `
    : '';
}

function buildFrontendPreviewEnvPrefix(context: any) {
  const allowedHost = resolvePreviewAllowedHost(context);
  return [
    `EDGEONE_PREVIEW_BASE_PATH=${shellQuote(PREVIEW_PATH_PREFIX.replace(/\/$/, ''))}`,
    allowedHost ? `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${shellQuote(allowedHost)}` : '',
  ].filter(Boolean).join(' ');
}

async function findViteConfigFilename(context: any, state: ProjectState) {
  const candidates = [
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.cts',
    'vite.config.js',
    'vite.config.mjs',
    'vite.config.cjs',
  ];
  for (const filename of candidates) {
    if (await context.sandbox.files.exists(`${state.appDir}/${filename}`)) {
      return filename;
    }
  }
  return '';
}

async function prepareVitePreviewConfig(context: any, state: ProjectState, deps: Record<string, string>) {
  if ((deps.react || deps['react-dom']) && !deps['@vitejs/plugin-react']) {
    throw new Error(
      'Vite React preview requires @vitejs/plugin-react so React Fast Refresh works under /preview/. Add it to devDependencies and configure plugins: [react()].',
    );
  }

  const userConfigFilename = await findViteConfigFilename(context, state);
  const userConfigSpecifier = userConfigFilename ? `../${userConfigFilename}` : '';
  const previewConfigPath = `${state.appDir}/.vite/edgeone-preview.config.mjs`;
  await context.sandbox.files.makeDir(`${state.appDir}/.vite`);
  await context.sandbox.files.write(previewConfigPath, [
    "import { defineConfig, loadConfigFromFile, mergeConfig } from 'vite';",
    '',
    "const reactDeps = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'];",
    "const mode = process.env.NODE_ENV || 'development';",
    "const configEnv = { command: 'serve', mode, isSsrBuild: false, isPreview: false };",
    `const userConfigSpecifier = ${JSON.stringify(userConfigSpecifier)};`,
    'const loaded = userConfigSpecifier',
    '  ? await loadConfigFromFile(configEnv, new URL(userConfigSpecifier, import.meta.url).pathname)',
    '  : null;',
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
  for (const filename of candidates) {
    if (!(await context.sandbox.files.exists(`${state.appDir}/${filename}`))) {
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
      'if command -v fuser >/dev/null 2>&1; then',
      `fuser -k ${port}/tcp 2>/dev/null || true;`,
      'elif command -v lsof >/dev/null 2>&1; then',
      `lsof -ti tcp:${port} | xargs -r kill -9 2>/dev/null || true;`,
      'fi;',
      'sleep 1',
    ].join(' '),
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

  const ready = await runSandboxCommand(
    context,
    [
      `for i in $(seq 1 30); do curl -fsS ${shellQuote(`http://127.0.0.1:${port}${start.readyPath}`)} >/dev/null && exit 0; sleep 1; done;`,
      `echo "Preview server did not become ready on port ${port}${start.readyPath}" >&2;`,
      'tail -n 120 /tmp/dev.log >&2 || true;',
      'exit 1',
    ].join(' '),
    { timeout: 35 },
  );

  if (ready.exitCode !== 0) {
    throw new Error(ready.stderr || ready.stdout || `Preview server did not become ready on port ${port}.`);
  }

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

export async function assertPreviewServerReady(context: any, readyPath = PREVIEW_PATH_PREFIX) {
  const result = await runSandboxCommand(
    context,
    `curl -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}${readyPath}`)} >/dev/null`,
    { timeout: 10 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Preview server is not ready on port ${PREVIEW_SERVER_PORT}${readyPath}.`);
  }
}

async function detectPreviewStartCommand(
  context: any,
  state: ProjectState,
): Promise<PreviewStartCommand> {
  const port = PREVIEW_SERVER_PORT;
  const packageExists = await context.sandbox.files.exists(`${state.appDir}/package.json`);
  if (packageExists) {
    const metadata = await readPackageMetadata(context, state);
    const scripts = metadata.scripts || {};
    const deps = metadata.deps || {};
    const scriptText = Object.values(scripts).join(' ');
    const frontendPreviewEnv = buildFrontendPreviewEnvPrefix(context);
    const viteAllowedHostEnv = buildViteAllowedHostEnvPrefix(context);

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
        command: `nohup npm run dev -- --host 0.0.0.0 --port ${port} --config ${shellQuote(vitePreviewConfig)} > /tmp/dev.log 2>&1 &`,
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

export async function readFileFromSandbox(
  context: any,
  state: ProjectState,
  relPath: string,
): Promise<{
  ok: boolean;
  content?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
}> {
  const ext = readFileExtension(relPath);
  if (ext && PREVIEW_BINARY_EXTENSIONS.has(ext)) {
    return { ok: false, error: `Binary files cannot be previewed (${ext}).` };
  }

  // Read through commands.run with head -c so the size can be limited without
  // relying on the uncertain sandbox.files.read signature. Quote the path and
  // escape embedded single quotes to avoid shell injection.
  const safePath = relPath.replace(/'/g, "'\\''");
  const cmd = `if [ ! -f '${safePath}' ]; then echo "__NOTFOUND__" 1>&2; exit 2; fi; wc -c < '${safePath}' | tr -d ' '; echo "__SEP__"; head -c ${PREVIEW_MAX_BYTES + 1} '${safePath}'`;
  let result;
  try {
    result = await runSandboxCommand(context, cmd, {
      cwd: state.appDir,
      timeout: 15,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Read failed.' };
  }

  if (result.exitCode !== 0) {
    const stderr = String(result.stderr || '').trim();
    if (stderr.includes('__NOTFOUND__')) {
      return { ok: false, error: 'File does not exist.' };
    }
    return { ok: false, error: stderr || 'Read failed.' };
  }

  const stdout = String(result.stdout || '');
  const sepIdx = stdout.indexOf('__SEP__\n');
  if (sepIdx === -1) {
    return { ok: false, error: 'Unexpected read format.' };
  }
  const sizeStr = stdout.slice(0, sepIdx).trim();
  const size = Number(sizeStr) || 0;
  let content = stdout.slice(sepIdx + '__SEP__\n'.length);
  let truncated = false;
  if (content.length > PREVIEW_MAX_BYTES) {
    content = content.slice(0, PREVIEW_MAX_BYTES);
    truncated = true;
  } else if (size > PREVIEW_MAX_BYTES) {
    truncated = true;
  }
  // Binary fallback: treat the file as binary if the first 4KB contains many
  // non-printable control characters.
  const sample = content.slice(0, 4096);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) nonPrintable += 1;
  }
  if (sample.length > 0 && nonPrintable / sample.length > 0.1) {
    return { ok: false, error: 'The file appears to be binary, so preview was refused.' };
  }

  return { ok: true, content, size, truncated };
}
