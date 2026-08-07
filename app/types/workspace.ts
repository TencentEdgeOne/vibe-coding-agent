import type { AssistantActivity } from '../components/agent-conversation';
import type { ConversationMessage as WorkspaceConversationMessage } from '../components/agent-conversation';

export type TimelineStep =
  | { kind: 'status'; text: string }
  | { kind: 'modify_marker' }
  | { kind: 'tool_use'; id: string; name: string; command?: string; phaseHint?: NormalizedStepPhase; fileCount?: number }
  | { kind: 'tool_result'; toolUseId: string; toolName?: string; command?: string; ok: boolean; preview: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr' | 'status'; text: string }
  | { kind: 'error'; text: string };

export type AssistantStatus = 'running' | 'done' | 'error' | 'stopped';
export type NormalizedStepStatus = 'waiting' | 'running' | 'done' | 'error';
export type NormalizedStepPhase = 'scaffold' | 'modify' | 'code' | 'install' | 'preview' | 'link';

export type NormalizedStep = {
  phase: NormalizedStepPhase;
  title: string;
  status: NormalizedStepStatus;
  summary: string;
};

export type ProcessEvent =
  | { kind: 'thinking'; content: string }
  | { kind: 'step'; phase: NormalizedStepPhase; step: NormalizedStep };

export type ChatMessage = WorkspaceConversationMessage & {
  thinkingContent?: string;
  processEvents?: ProcessEvent[];
  steps?: TimelineStep[];
};

export type BuildInfo = {
  status: 'success' | 'failed' | 'skipped';
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
};

export type LinkInfo = {
  url?: string;
  sandboxDebugUrl?: string;
  filename?: string;
  error?: string;
};

export type InitLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

export type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
  // Cache key for the file content cache: while these are unchanged, a click can
  // render from cache instead of hitting /file. Absent on sandboxes whose `find`
  // cannot report them, in which case caching is disabled.
  mtime?: number;
  size?: number;
};

export type FileTree = {
  root: string;
  items: FileTreeItem[];
};

export type ResumeData = {
  ok?: boolean;
  stage?: 'history' | 'workspace';
  conversation_id?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  hasProject?: boolean;
  /** Project previously published a live preview; workspace resume should restart it. */
  hasPreview?: boolean;
  needsWorkspace?: boolean;
  preview?: LinkInfo;
  files?: FileTree;
  download?: LinkInfo;
  activityHistory?: Array<{
    id: string;
    user: string;
    assistant: string;
    status: 'completed' | 'failed' | 'stopped';
    activities: AssistantActivity[];
  }>;
  /** In-flight chat task the client should reconnect to after a refresh. */
  activeTask?: {
    id: string;
    message: string;
    status: 'queued' | 'running';
    resetProject?: boolean;
    createdAt?: number;
    startedAt?: number;
    streamUrl?: string;
  } | null;
  error?: string;
};

export type ChatResponse = {
  ok?: boolean;
  reply?: string;
  conversation_id?: string;
  build?: BuildInfo;
  files?: FileTree;
  preview?: LinkInfo;
  download?: LinkInfo;
  error?: string;
  stopped?: boolean;
};

export type ChatTaskSubmission = {
  ok?: boolean;
  conversation_id?: string;
  runId?: string;
  streamUrl?: string;
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  error?: string;
};

export type ChatStreamEvent =
  | {
      type: 'status';
      message?: string;
    }
  | {
      type: 'result';
      data?: ChatResponse;
    }
  | {
      type: 'agent';
      data?: Pick<ChatResponse, 'ok' | 'reply' | 'error'>;
    }
  | {
      type: 'file_tree';
      data?: FileTree;
    }
  | {
      // Full text of a file the agent just wrote, pushed so the Files panel can
      // render it without fetching it back over /file.
      type: 'file_content';
      data?: {
        path?: string;
        content?: string;
        size?: number;
      };
    }
  | {
      type: 'preview_ready';
      data?: {
        preview?: LinkInfo;
        download?: LinkInfo;
      };
    }
  | {
      type: 'tool_use';
      data?: {
        id?: string;
        name?: string;
        command?: string;
        phaseHint?: NormalizedStepPhase;
        fileCount?: number;
        inputSummary?: string;
        startedAt?: number;
      };
    }
  | {
      type: 'tool_result';
      data?: {
        tool_use_id?: string;
        toolName?: string;
        command?: string;
        ok?: boolean;
        preview?: string;
        outputSummary?: string;
        status?: 'running' | 'completed' | 'failed' | 'stopped';
        endedAt?: number;
      };
    }
  | {
      type: 'text_segment';
      data?: {
        uuid?: string;
        text?: string;
      };
    }
  | {
      type: 'error';
      error?: string;
    }
  | {
      type: 'log';
      phase?: 'scaffold' | 'agent';
      stream?: InitLog['stream'];
      message?: string;
    }
  | {
      type: 'ping';
      ts?: number;
    };

export const PHASE_ORDER: NormalizedStepPhase[] = ['scaffold', 'modify', 'code', 'install', 'preview', 'link'];
