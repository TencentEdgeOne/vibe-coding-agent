import type { ProjectState } from '../types.ts';

export type SandboxFiles = {
  exists?(path: string): Promise<unknown>;
  read?(path: string): Promise<unknown>;
  write?(path: string, content: string | Uint8Array): Promise<unknown>;
  makeDir?(path: string): Promise<unknown>;
  remove?(path: string): Promise<unknown>;
};

export type SandboxCommands = {
  run?(command: string, options?: Record<string, unknown>): Promise<unknown>;
};

export type ReadySandboxFiles = {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | Uint8Array>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  makeDir(path: string): Promise<void>;
  remove?(path: string): Promise<void>;
};

export type ReadySandboxCommands = {
  run(command: string, options?: Record<string, unknown>): Promise<unknown>;
};

export type Sandbox = {
  files?: SandboxFiles;
  commands?: SandboxCommands;
  persist?: (options: { path: string }) => Promise<unknown>;
  restore?: (options: { path: string }) => Promise<{ restored?: boolean } | undefined>;
  getHost?: (port: number) => Promise<string | undefined> | string | undefined;
  envdAccessToken?: string;
  browser?: { liveUrl?: string };
  extendTimeout?: (seconds: number) => unknown;
  /** Throws until the first sandbox call acquires the client. */
  getInfo?: () => { instanceId?: string; expiresAt?: string } | undefined;
};

export type ReadySandbox = Sandbox & {
  files: ReadySandboxFiles;
  commands: ReadySandboxCommands;
};

/** The slice of the Makers agent `context` this template actually reads. */
export type AgentContext = {
  conversation_id?: string;
  run_id?: string;
  /**
   * The conversation epoch this request acts under, set once it holds or claims
   * the conversation. A turn keeps the epoch it started with: its writes are
   * checked against it and never claim a newer one.
   */
  epoch?: number;
  env?: Record<string, string | undefined>;
  request?: {
    body?: unknown;
    headers?: Headers | Record<string, string>;
    signal?: AbortSignal;
    url?: string;
    path?: string;
    query?: unknown;
    params?: unknown;
    [key: string]: unknown;
  };
  sandbox?: Sandbox;
  tools?: {
    toClaudeMcpServer: (name: string, options?: { alwaysLoad?: boolean }) => {
      tools: unknown[];
      allowedTools: string[];
    };
    /**
     * Routes sandbox command output to a handler while the command runs, as
     * `{ stream, data, command, toolUseId }` chunks. Absent on a runtime that
     * predates it, which leaves commands unstreamed rather than broken.
     */
    setCommandOutputHandler?: (handler: (chunk: {
      stream?: 'stdout' | 'stderr';
      data?: string;
      command?: string;
      toolUseId?: string;
    }) => void) => unknown;
  };
  /** Test seam: an in-memory Blob stand-in. Production uses `@edgeone/pages-blob`. */
  blobStore?: BlobStoreLike;
  /** Test seam: replaces the chat and deploy pipelines a task runs. */
  runTurn?: TurnRunner;
};

export type TurnRunner = (
  context: AgentContext,
  input: { kind: 'prompt' | 'deploy'; message: string; turnId: string; model?: string },
  send: (event: import('../../../shared/protocol.ts').ChatStreamEvent) => void,
) => Promise<void>;

export type SandboxCapable = Pick<AgentContext, 'sandbox'>;
export type PersistCapable = Pick<AgentContext, 'blobStore'>;
export type RequestCapable = Pick<AgentContext, 'request' | 'conversation_id'>;
export type EnvCapable = Pick<AgentContext, 'env'>;

export function requireSandbox(context: SandboxCapable): ReadySandbox {
  const sandbox = context.sandbox;
  if (!sandbox) {
    throw new Error('Sandbox is not available');
  }
  return sandbox as ReadySandbox;
}

export type BlobStoreLike = {
  set: (key: string, value: string | ArrayBuffer | Blob | ReadableStream, options?: { onlyIfNew?: boolean }) => Promise<void>;
  setJSON: (key: string, value: unknown, options?: { onlyIfNew?: boolean }) => Promise<void>;
  get: (key: string, options?: { type?: 'text' | 'json' | 'arrayBuffer' | 'blob' | 'stream'; consistency?: 'strong' | 'eventual' }) => Promise<unknown>;
  delete: (key: string) => Promise<void>;
  list: (options?: { prefix?: string }) => Promise<{ blobs: Array<{ key: string; etag?: string }> }>;
};

export type WorkspaceMode = 'prepare' | 'resume';

export type { ProjectState };
