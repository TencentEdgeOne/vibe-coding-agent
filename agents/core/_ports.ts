/**
 * Capability ports for the agent core.
 *
 * The core depends on these interfaces alone. It must never receive an EdgeOne
 * `context`, a Request, or a Response. Every host (Makers HTTP, CLI, SDK) builds
 * these ports its own way and gets the same engine.
 *
 * The shapes below are deliberately narrow: they cover exactly what today's
 * pipelines call on `context.store` / `context.sandbox` / `context.env` and
 * nothing more, so an adapter can be written without guessing.
 */

/** Conversation-scoped persistence. Mirrors the Makers store surface in use. */
export type ConversationRecord = {
  metadata?: Record<string, unknown>;
};

export type StoredMessage = {
  role: string;
  content: unknown;
};

export type ConversationStorePort = {
  getConversation(args: { conversationId: string }): Promise<ConversationRecord | null>;
  /** Shallow-merges `metadata`. May reject with code `MemoryNotFoundError`. */
  updateConversation(args: {
    conversationId: string;
    metadata: Record<string, unknown>;
  }): Promise<unknown>;
  getMessages(args: {
    conversationId: string;
    limit?: number;
    order?: 'asc' | 'desc';
  }): Promise<StoredMessage[] | { items?: StoredMessage[] }>;
  appendMessage(args: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
  }): Promise<unknown>;
  /**
   * Claude Agent SDK session storage, when the host provides it.
   *
   * Optional because it is the one store capability tied to a specific agent
   * SDK rather than to conversations in general: a host that runs a different
   * model, or replays a transcript, simply omits it and session resume is off.
   */
  claudeSessionStore?(): unknown;
};

/** Filesystem and process access inside the project workspace. */
export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * What a host may hand back from a file read.
 *
 * Deliberately wide: runtimes differ, and callers already defend against a
 * wrapped `{ content }` body or an ArrayBuffer. Narrowing this would only push
 * the cast to every call site.
 */
export type FileReadValue = string | Uint8Array | ArrayBuffer | { content?: unknown };

export type WorkspacePort = {
  files: {
    exists(path: string): Promise<boolean>;
    read(path: string): Promise<FileReadValue>;
    write(path: string, content: string | Uint8Array): Promise<unknown>;
    makeDir(path: string): Promise<unknown>;
    /** Optional: hosts without it fall back to `rm -rf` through `commands.run`. */
    remove?(path: string): Promise<unknown>;
  };
  commands: {
    run(
      command: string,
      options?: {
        cwd?: string;
        timeout?: number;
        env?: Record<string, string>;
        onStdout?: (data: string) => void;
        onStderr?: (data: string) => void;
      },
    ): Promise<CommandResult>;
  };
  /** Snapshot the workspace so it survives a recycled sandbox. */
  persist(args: { path: string }): Promise<unknown>;
  restore(args: { path: string }): Promise<unknown>;
  /** Public host for a port served from the workspace, when the host supports it. */
  getHost?(port: number): Promise<string> | string;
  getInfo?(): Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Extend the workspace lease, where the host recycles idle sandboxes. A local
   * checkout has no lease to extend, so this stays optional.
   */
  extendTimeout?(seconds: number): Promise<unknown> | unknown;
  /**
   * Origin of a hosted browser session, when the host exposes previews through
   * one. Distinct from getHost: some sandboxes serve previews from a browser
   * session origin rather than the raw port host.
   */
  readonly browserLiveUrl?: string;
  /** Token some hosts require on preview URLs. */
  readonly accessToken?: string;
};

/** Read-only configuration. Keys stay strings so no host leaks its own env object. */
export type ConfigPort = {
  get(key: string): string;
};

/**
 * Sandbox tools exposed to the model.
 *
 * On Makers this is `context.tools.toClaudeMcpServer(...)`, which today is
 * reached straight from the agent loop — the one capability that has no
 * plausible local equivalent, and therefore the one most likely to pin the
 * engine to a single host if left unwrapped. A CLI host supplies its own tools
 * (or none) through the same port.
 */
export type ProvidedTool = { name: string };

export type ToolProviderPort = {
  /** Tool definitions the host contributes, plus the names the model may call. */
  provide(serverName: string): { tools: ProvidedTool[]; allowedTools: string[] };
};

/** Everything needed to reach a model, resolved by the host from its own config. */
export type ModelAccess = {
  model: string;
  baseUrl: string;
  apiKey?: string;
  authToken?: string;
  customHeaders?: string;
  /** Extra process env for a subprocess-based SDK. */
  env?: Record<string, string>;
};

/** Structured diagnostics. Hosts route these to a console, a log, or nowhere. */
export type LoggerPort = {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
};

/** Cooperative cancellation, so `stop` does not need an HTTP abort signal. */
export type CancellationPort = {
  readonly aborted: boolean;
  onAbort(listener: () => void): () => void;
};

export type AgentPorts = {
  store: ConversationStorePort;
  workspace: WorkspacePort;
  config: ConfigPort;
  cancellation?: CancellationPort;
  /** Absent means the model runs with only the core's own project tools. */
  tools?: ToolProviderPort;
  logger?: LoggerPort;
};
