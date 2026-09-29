/**
 * Transport contracts shared by the Makers agent runtime and the browser.
 *
 * Keep this module runtime-agnostic: no React, Next.js, or EdgeOne imports.
 */

export type BuildStatus = 'success' | 'failed' | 'skipped';

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type ProgressPhase = 'scaffold' | 'modify' | 'code' | 'install' | 'preview' | 'link';

/** What the status line may name before the model speaks. `workspace` is sent
 *  only while a cold sandbox is being created or a snapshot is being unpacked. */
export type PreparePhase = 'accepted' | 'workspace' | 'agent';

export type SystemInfoType = 'compact' | 'usage' | 'status' | 'system' | 'sdk';

export type AssistantActivity =
  | {
      kind: 'text';
      content: string;
    }
  | {
      kind: 'thinking';
      content: string;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: 'info';
      infoType: SystemInfoType;
      title: string;
      content: string;
    }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      status: ActivityStatus;
      command?: string;
      phaseHint?: ProgressPhase;
      fileCount?: number;
      inputSummary?: string;
      outputSummary?: string;
      startedAt?: number;
      endedAt?: number;
    };

export type PersistedActivityTurn = {
  id: string;
  user: string;
  assistant: string;
  status: 'completed' | 'failed' | 'stopped';
  createdAt: number;
  /** When the first user-visible agent output arrived; absent if it never did. */
  startedAt?: number;
  activities: AssistantActivity[];
};

export type BuildInfo = {
  status: BuildStatus;
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
};

export type PreviewKind = 'sandbox' | 'makers';

/** One page route a generated project serves. */
export type PreviewRoute = {
  /** Route relative to the app root, with a leading slash. */
  path: string;
};

export type DeploymentStatus = 'running' | 'success' | 'failed';

export type DeploymentInfo = {
  status: DeploymentStatus;
  startedAt: number;
  finishedAt?: number;
  url?: string;
  projectId?: string;
  deploymentId?: string;
  consoleUrl?: string;
  error?: string;
};

export type LinkInfo = {
  url?: string;
  sandboxDebugUrl?: string;
  filename?: string;
  error?: string;
  /**
   * Frontend routes found in the generated project. The address bar offers
   * these to switch routes without guessing at the file layout first.
   */
  routes?: PreviewRoute[];
  /** Preview resume restarted the server, invalidating an already loaded iframe. */
  restarted?: boolean;
  /** Makers deploy URLs skip sandbox envdAccessToken refresh. */
  kind?: PreviewKind;
};

export type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
  mtime?: number;
  size?: number;
};

export type FileTree = {
  root: string;
  items: FileTreeItem[];
};

type ActiveChatTask = {
  id: string;
  message: string;
  status: 'queued' | 'running';
  createdAt?: number;
  startedAt?: number;
  preparePhase?: PreparePhase;
  /**
   * Running on another instance that still owns it, as after a redeploy. Its
   * events do not come through this stream; the client asks again shortly.
   */
  elsewhere?: boolean;
};

export type ResumeData = {
  ok?: boolean;
  stage?: 'history' | 'workspace' | 'preview';
  conversation_id?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  hasProject?: boolean;
  hasPreview?: boolean;
  needsWorkspace?: boolean;
  preview?: LinkInfo;
  deployment?: DeploymentInfo;
  files?: FileTree;
  download?: LinkInfo;
  activityHistory?: PersistedActivityTurn[];
  activeTask?: ActiveChatTask | null;
  /** Model chosen for this conversation; '' or absent means the deployment default. */
  model?: string;
  /** UI language chosen for this conversation. */
  language?: 'zh' | 'en';
  /** Resume should show the Models API key card. */
  gatewayNeeded?: boolean;
  /** User deferred the key; resume should show the reopen chip. */
  gatewaySkipped?: boolean;
  error?: string;
};

/** Workspace projection the frontend can fetch without the chat stream. */
export type WorkspaceSnapshot = {
  ok?: boolean;
  conversation_id?: string;
  files?: FileTree;
  preview?: LinkInfo;
  deployment?: DeploymentInfo;
  download?: LinkInfo;
  build?: BuildInfo;
};

/** Raw Claude JSONL for the Session tab. The file is the source of truth. */
export type TranscriptData = {
  ok?: boolean;
  conversation_id?: string;
  sessionId?: string;
  transcriptPath?: string;
  jsonl?: string;
  /** The live query still has a turn in flight; more snapshots may follow. */
  live?: boolean;
  /** `jsonl` continues what was already sent instead of replacing it. */
  append?: boolean;
  /** Byte offset in the file just past `jsonl`; send it back to resume. */
  cursor?: number;
  error?: string;
};

/**
 * An observer stream reached its time limit while the turn was still going.
 * The client reopens it with the cursor it carries. Only the turn's own
 * `/prompt` stream stays open until the turn ends: a stream whose reader went
 * away keeps holding an instance's request slot until the server closes it.
 */
export type ReconnectEvent = {
  type: 'reconnect';
  data?: {
    turnId?: string;
    afterSeq?: number;
    cursor?: number;
    sessionId?: string;
  };
};

export type ChatResponse = {
  ok?: boolean;
  reply?: string;
  conversation_id?: string;
  error?: string;
  stopped?: boolean;
};

export type ChatStreamEvent =
  | {
      type: 'task_started';
      data?: {
        runId?: string;
        conversation_id?: string;
        status?: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
        preparePhase?: PreparePhase;
      };
    }
  | { type: 'prepare_phase'; data?: { phase?: PreparePhase } }
  | { type: 'result'; data?: ChatResponse }
  | { type: 'agent'; data?: Pick<ChatResponse, 'ok' | 'reply' | 'error'> }
  | { type: 'workspace'; data?: WorkspaceSnapshot }
  | { type: 'file_tree'; data?: FileTree }
  | {
      type: 'file_changed';
      data?: { paths?: string[] };
    }
  | {
      type: 'preview_ready';
      data?: { preview?: LinkInfo; download?: LinkInfo };
    }
  | {
      type: 'deployment_status';
      data?: DeploymentInfo;
    }
  | {
      type: 'tool_use';
      data?: {
        id?: string;
        name?: string;
        command?: string;
        phaseHint?: ProgressPhase;
        fileCount?: number;
        inputSummary?: string;
        /**
         * Output from a call that has not finished. Re-sent with the same `id`
         * as the call goes on, which patches the row in place; a publish runs
         * for minutes and this is what it shows while it does.
         */
        outputSummary?: string;
        startedAt?: number;
      };
    }
  | {
      type: 'tool_result';
      data?: {
        id?: string;
        toolName?: string;
        command?: string;
        ok?: boolean;
        preview?: string;
        outputSummary?: string;
        status?: ActivityStatus;
        endedAt?: number;
      };
    }
  | { type: 'text_segment'; data?: { uuid?: string; text?: string } }
  | { type: 'thinking_segment'; data?: { uuid?: string; text?: string } }
  | {
      type: 'system_info';
      data?: {
        infoType?: SystemInfoType;
        title?: string;
        content?: string;
      };
    }
  | {
      type: 'gateway_credentials';
      data?: {
        status?: 'needed' | 'resolved';
        keys?: string[];
        skipped?: boolean;
      };
    }
  | { type: 'error'; error?: string }
  | { type: 'ping'; ts?: number };

export type ResumeStreamEvent =
  | { type: 'resume_history'; data?: ResumeData }
  | { type: 'resume_workspace'; data?: ResumeData }
  | { type: 'file_changed'; data?: { paths?: string[] } }
  | ReconnectEvent
  | { type: 'error'; error?: string }
  | { type: 'ping'; ts?: number };

export type TranscriptStreamEvent =
  | { type: 'transcript'; data?: TranscriptData }
  | ReconnectEvent
  | { type: 'error'; error?: string }
  | { type: 'ping'; ts?: number };

/** `seq` numbers a live turn's events, so a reopened stream resumes after it. */
export type SessionStreamEvent = (ChatStreamEvent | ResumeStreamEvent | TranscriptStreamEvent) & { seq?: number };
