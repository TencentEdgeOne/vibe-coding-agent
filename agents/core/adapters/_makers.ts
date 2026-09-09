/**
 * Makers host adapter: EdgeOne `context` in, core ports out.
 *
 * This is the translation layer that lets `context` stop leaking into the
 * engine. Today `context: any` appears ~100 times across agents/, and 39
 * exported functions take it as their first parameter, which is exactly why
 * there is no runtime the CLI could borrow. Once the core takes ports, this
 * file is the only place that knows what an EdgeOne context looks like.
 *
 * Every method below maps to a call the current pipelines already make, so this
 * is a rename of existing behavior rather than new capability.
 */

import type {
  AgentPorts,
  CancellationPort,
  CommandResult,
  ConfigPort,
  ConversationStorePort,
  LoggerPort,
  ToolProviderPort,
  WorkspacePort,
} from '../_ports.ts';

function readEnv(context: any, key: string): string {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function createMakersConfigPort(context: any): ConfigPort {
  return { get: (key) => readEnv(context, key) };
}

export function createMakersStorePort(context: any): ConversationStorePort {
  const store = context?.store;
  if (!store) throw new Error('Makers context is missing `store`.');
  // Methods are looked up per call, not captured at construction. Some runtimes
  // (and callers such as session binding) expose a partial store and rely on
  // `typeof store.x === 'function'` checks, so binding eagerly would both break
  // late-added methods and turn a tolerated absence into a TypeError.
  const port: ConversationStorePort = {
    getConversation: (args) => store.getConversation?.(args) ?? null,
    updateConversation: (args) => store.updateConversation?.(args),
    getMessages: (args) => store.getMessages?.(args) ?? [],
    appendMessage: (args) => store.appendMessage?.(args),
  };
  // Callers treat an absent session store as "no session resume", so this stays
  // undefined rather than becoming a function that returns nothing.
  if (typeof store.claudeSessionStore === 'function') {
    port.claudeSessionStore = () => store.claudeSessionStore();
  }
  return port;
}

/**
 * Same port, but `undefined` when the runtime has no store instead of throwing.
 *
 * Session binding is best-effort: a context without a store means session
 * resume is simply unavailable, which several call sites already treated as a
 * silent no-op rather than a failure.
 */
export function tryCreateMakersStorePort(context: any): ConversationStorePort | undefined {
  return context?.store ? createMakersStorePort(context) : undefined;
}

export function createMakersWorkspacePort(context: any): WorkspacePort {
  const sandbox = context?.sandbox;
  if (!sandbox) throw new Error('Makers context is missing `sandbox`.');

  /**
   * Everything below is resolved per call rather than at construction.
   *
   * EdgeOne sandboxes initialize lazily: `files`, `browser`, and
   * `envdAccessToken` are getters that throw "Sandbox is not initialized" until
   * an async sandbox method has run. Because the port is now built in front of
   * every sandbox call — including the first one of a turn — reading any of
   * them eagerly fails the whole run before it starts.
   */
  const readLazily = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      // Not initialized yet. Callers treat absence as "not available".
      return undefined;
    }
  };

  return {
    files: {
      exists: (path) => sandbox.files.exists(path),
      read: (path) => sandbox.files.read(path),
      write: (path, content) => sandbox.files.write(path, content),
      makeDir: (path) => sandbox.files.makeDir(path),
      // Optional upstream: agents/project/_state.ts checks
      // `typeof files.remove === 'function'` and falls back to `rm -rf`. The
      // capability probe has to stay lazy, because reaching `sandbox.files` on a
      // cold sandbox throws — but it must still report absence honestly, or the
      // fallback becomes unreachable on hosts without it.
      get remove() {
        const remove = readLazily(() => sandbox.files?.remove);
        return typeof remove === 'function'
          ? (path: string) => sandbox.files.remove(path)
          : undefined;
      },
    },
    commands: {
      async run(command, options) {
        const result = await sandbox.commands.run(command, options ?? {});
        return {
          exitCode: typeof result?.exitCode === 'number' ? result.exitCode : 0,
          stdout: typeof result?.stdout === 'string' ? result.stdout : '',
          stderr: typeof result?.stderr === 'string' ? result.stderr : '',
        } satisfies CommandResult;
      },
    },
    persist: (args) => sandbox.persist(args),
    restore: (args) => sandbox.restore(args),
    getHost: (port) => sandbox.getHost?.(port),
    getInfo: () => sandbox.getInfo?.(),
    // Same reasoning as `remove`: agents/pipelines/_helpers.ts treats a missing
    // extendTimeout as a silent no-op, so claiming to have it would make that
    // path log a lease extension that never happened.
    get extendTimeout() {
      const extend = readLazily(() => sandbox.extendTimeout);
      return typeof extend === 'function'
        ? (seconds: number) => sandbox.extendTimeout(seconds)
        : undefined;
    },
    get browserLiveUrl() {
      const liveUrl = readLazily(() => sandbox.browser?.liveUrl);
      return typeof liveUrl === 'string' ? liveUrl : undefined;
    },
    get accessToken() {
      const token = readLazily(() => sandbox.envdAccessToken);
      return typeof token === 'string' ? token : undefined;
    },
  };
}

/** Same port, but `undefined` instead of throwing when there is no sandbox. */
export function tryCreateMakersWorkspacePort(context: any): WorkspacePort | undefined {
  return context?.sandbox ? createMakersWorkspacePort(context) : undefined;
}

/** Bridges an HTTP abort signal onto the port the core understands. */
export function createSignalCancellationPort(signal?: AbortSignal): CancellationPort | undefined {
  if (!signal) return undefined;
  return {
    get aborted() {
      return signal.aborted;
    },
    onAbort(listener) {
      signal.addEventListener('abort', listener, { once: true });
      return () => signal.removeEventListener('abort', listener);
    },
  };
}

/**
 * Wraps `context.tools.toClaudeMcpServer`, the runtime's sandbox tool surface.
 * The loud failure is kept from the original call site: a runtime without this
 * API cannot run the agent at all, so degrading quietly would only surface later
 * as a confusing model error.
 */
export function createMakersToolProviderPort(context: any): ToolProviderPort {
  return {
    provide(serverName) {
      if (typeof context?.tools?.toClaudeMcpServer !== 'function') {
        throw new Error(
          'The current Pages Agent Runtime is missing context.tools.toClaudeMcpServer. Please upgrade to a runtime that supports the new pages-agent-toolkit Tools API.',
        );
      }
      const mcp = context.tools.toClaudeMcpServer(serverName, { alwaysLoad: true });
      return {
        tools: Array.isArray(mcp?.tools) ? mcp.tools : [],
        allowedTools: Array.isArray(mcp?.allowedTools) ? mcp.allowedTools : [],
      };
    },
  };
}

export function createMakersLoggerPort(context: any): LoggerPort {
  // Same flag the rest of the runtime honors, including the 'true' spelling.
  const raw = context?.env?.WEB_DEV_AGENT_DEBUG;
  const enabled = raw === 'true' || raw === '1';
  return {
    debug(message, fields) {
      if (!enabled) return;
      if (fields === undefined) {
        console.warn(message);
        return;
      }
      console.warn(message, fields);
    },
    warn(message, fields) {
      if (fields === undefined) {
        console.warn(message);
        return;
      }
      console.warn(message, fields);
    },
  };
}

export function createMakersPorts(context: any, signal?: AbortSignal): AgentPorts {
  return {
    store: createMakersStorePort(context),
    workspace: createMakersWorkspacePort(context),
    config: createMakersConfigPort(context),
    cancellation: createSignalCancellationPort(signal),
    tools: createMakersToolProviderPort(context),
    logger: createMakersLoggerPort(context),
  };
}
