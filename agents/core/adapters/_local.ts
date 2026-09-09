/**
 * Local host adapter: the same ports backed by plain Node and an in-memory store.
 *
 * This file is the PoC's actual proof. It implements every capability the core
 * needs using nothing but `node:fs` and `node:child_process` — no EdgeOne, no
 * HTTP, no React. If the core can run against this, then a CLI and an SDK are
 * just two more callers of `runTurn`, which is the deepseek-harness property
 * the template is missing today.
 *
 * It doubles as the test seam: pipelines currently need a fake `context`, and
 * anything touching SSE needs a live Response. Against these ports a turn can
 * be asserted as a plain list of domain events.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  AgentPorts,
  CancellationPort,
  ConfigPort,
  ConversationRecord,
  ConversationStorePort,
  LoggerPort,
  StoredMessage,
  ToolProviderPort,
  WorkspacePort,
} from '../_ports.ts';

const execFileAsync = promisify(execFile);

/** Conversation store backed by a Map. Good enough for a CLI session or a test. */
export function createMemoryStorePort(): ConversationStorePort & {
  dump(): Map<string, { record: ConversationRecord; messages: StoredMessage[] }>;
} {
  const conversations = new Map<string, { record: ConversationRecord; messages: StoredMessage[] }>();

  const ensure = (conversationId: string) => {
    const existing = conversations.get(conversationId);
    if (existing) return existing;
    const created = { record: { metadata: {} }, messages: [] as StoredMessage[] };
    conversations.set(conversationId, created);
    return created;
  };

  return {
    async getConversation({ conversationId }) {
      return conversations.get(conversationId)?.record ?? null;
    },
    async updateConversation({ conversationId, metadata }) {
      const entry = ensure(conversationId);
      // Shallow merge, matching Makers semantics.
      entry.record.metadata = { ...(entry.record.metadata ?? {}), ...metadata };
      return entry.record;
    },
    async getMessages({ conversationId, limit, order }) {
      const messages = [...(conversations.get(conversationId)?.messages ?? [])];
      if (order === 'desc') messages.reverse();
      return typeof limit === 'number' ? messages.slice(0, limit) : messages;
    },
    async appendMessage({ conversationId, role, content }) {
      const entry = ensure(conversationId);
      entry.messages.push({ role, content });
      return entry.messages.at(-1);
    },
    dump: () => conversations,
  };
}

/** Workspace rooted at a real directory on disk. */
export function createLocalWorkspacePort(rootDir: string): WorkspacePort {
  const resolve = (target: string) => {
    const absolute = path.resolve(rootDir, target);
    const relative = path.relative(rootDir, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Refusing to touch a path outside the workspace: ${target}`);
    }
    return absolute;
  };

  return {
    files: {
      async exists(target) {
        try {
          await stat(resolve(target));
          return true;
        } catch {
          return false;
        }
      },
      // These stay `async` so a rejected path guard surfaces as a rejection
      // rather than a synchronous throw; the port contract is promise-based and
      // callers are entitled to use `.catch()`.
      async read(target) {
        return readFile(resolve(target), 'utf8');
      },
      async write(target, content) {
        const absolute = resolve(target);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, content as any);
      },
      async makeDir(target) {
        await mkdir(resolve(target), { recursive: true });
      },
      async remove(target) {
        await rm(resolve(target), { recursive: true, force: true });
      },
    },
    commands: {
      async run(command, options) {
        const cwd = options?.cwd ? resolve(options.cwd) : rootDir;
        try {
          const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
            cwd,
            timeout: options?.timeout ? options.timeout * 1_000 : undefined,
            env: options?.env ? { ...process.env, ...options.env } : undefined,
            maxBuffer: 32 * 1024 * 1024,
          });
          if (stdout) options?.onStdout?.(stdout);
          if (stderr) options?.onStderr?.(stderr);
          return { exitCode: 0, stdout, stderr };
        } catch (error: any) {
          const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
          const stderr = typeof error?.stderr === 'string' ? error.stderr : String(error?.message ?? '');
          if (stdout) options?.onStdout?.(stdout);
          if (stderr) options?.onStderr?.(stderr);
          return {
            exitCode: typeof error?.code === 'number' ? error.code : 1,
            stdout,
            stderr,
          };
        }
      },
    },
    // A local run keeps the project on disk, so snapshotting is a no-op rather
    // than a missing feature.
    async persist() {},
    async restore() {},
    getHost: (port) => `http://localhost:${port}`,
  };
}

export function createRecordConfigPort(values: Record<string, string> = {}): ConfigPort {
  return { get: (key) => (values[key] ?? '').trim() };
}

/** Config from `process.env`, for a CLI host. */
export function createProcessConfigPort(): ConfigPort {
  return {
    get: (key) => {
      const value = process.env[key];
      return typeof value === 'string' ? value.trim() : '';
    },
  };
}

export function createManualCancellationPort(): CancellationPort & { abort(): void } {
  const listeners = new Set<() => void>();
  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    onAbort(listener) {
      if (aborted) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}

/**
 * A host with no sandbox tool surface. The agent still has the core's own
 * project tools, which is exactly the CLI case: it edits a local checkout and
 * has no remote sandbox to expose.
 */
export function createEmptyToolProviderPort(): ToolProviderPort {
  return { provide: () => ({ tools: [], allowedTools: [] }) };
}

/** Collects diagnostics instead of printing, so tests can assert on them. */
export function createCollectingLoggerPort(): LoggerPort & {
  entries: { level: 'debug' | 'warn'; message: string; fields?: Record<string, unknown> }[];
} {
  const entries: { level: 'debug' | 'warn'; message: string; fields?: Record<string, unknown> }[] = [];
  return {
    entries,
    debug(message, fields) {
      entries.push({ level: 'debug', message, fields });
    },
    warn(message, fields) {
      entries.push({ level: 'warn', message, fields });
    },
  };
}

/** Assemble a complete local port set, e.g. for a CLI host or a test. */
export function createLocalPorts(options: {
  rootDir: string;
  config?: Record<string, string>;
  useProcessEnv?: boolean;
}): AgentPorts {
  return {
    store: createMemoryStorePort(),
    workspace: createLocalWorkspacePort(options.rootDir),
    config: options.useProcessEnv
      ? createProcessConfigPort()
      : createRecordConfigPort(options.config),
    cancellation: createManualCancellationPort(),
    tools: createEmptyToolProviderPort(),
    logger: createCollectingLoggerPort(),
  };
}
