import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type {
  ActivityStatus,
  BuildStatus,
  ProgressPhase,
  TurnResult,
} from '../shared/protocol.ts';

export type { ActivityStatus, BuildStatus, FileTreeItem, ProgressPhase, TurnResult } from '../shared/protocol.ts';

export type ProjectState = {
  created: boolean;
  sessionDir: string;
  appDir: string;
  previewUrl?: string;
  /** Latched once publish_preview succeeds; survives live URL invalidation so resume can restart preview. */
  previewPublished?: boolean;
  /** Pages project reused for header Publish across turns in this conversation. */
  makersProjectId?: string;
  /** Last signed preview URL from a successful Publish. Expires. */
  makersPreviewUrl?: string;
};

/** Turn-scoped: an install or preview-config write means publish_preview must restart. */
export type PreviewRestartSignal = {
  mustRestart: boolean;
};

// A base64 archive of the whole project, persisted outside the volatile sandbox so
// the code survives sandbox recycling (see agents/_memory.ts snapshot helpers). The
// fields mirror createProjectArchive's success result plus a write timestamp.
export type LegacyProjectSnapshot = {
  base64: string;
  filename: string;
  contentType: string;
  size: number;
  updatedAt: number;
};

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ChatTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

export type ChatTask = {
  id: string;
  message: string;
  /** Model this turn runs on. Absent means the deployment's configured default. */
  model?: string;
  resetProject: boolean;
  status: ChatTaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  finalEvent?: Record<string, unknown>;
  error?: string;
};

export type PersistedActivity =
  | {
      kind: 'text';
      content: string;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      status: ActivityStatus;
      inputSummary?: string;
      outputSummary?: string;
      command?: string;
      phaseHint?: ProgressPhase;
      startedAt: number;
      endedAt?: number;
    }
  | {
      kind: 'log';
      phase?: 'scaffold' | 'agent';
      stream?: 'status' | 'stdout' | 'stderr';
      message: string;
      startedAt?: number;
      endedAt?: number;
    };

export type PersistedActivityTurn = {
  id: string;
  user: string;
  assistant: string;
  status: 'completed' | 'failed' | 'stopped';
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  turnResult?: TurnResult;
  activities: PersistedActivity[];
};

export type StreamSend = (event: Record<string, unknown>) => void;

export type ScaffoldLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

export type CodingAgentResult = {
  success: boolean;
  output: string | null;
  error: string | null;
  projectTouched: boolean;
  previewTouched?: boolean;
  wasCreated: boolean;
  fatal?: boolean;
  stopped?: boolean;
};

export type BuildResult = {
  status: BuildStatus;
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
  fatal?: boolean;
};

// Progress events streamed to the frontend. tool_use is the model's tool request,
// and tool_result is the tool response. The assistant message renders these live.
export type AgentProgressEvent =
  | {
      type: 'tool_use';
      data: {
        id: string;
        name: string;
        command?: string;
        phaseHint?: ProgressPhase;
        fileCount?: number;
        inputSummary?: string;
        startedAt?: number;
      };
    }
  | {
      type: 'tool_result';
      data: {
        tool_use_id: string;
        toolName?: string;
        command?: string;
        ok: boolean;
        preview: string;
        outputSummary?: string;
        status?: ActivityStatus;
        endedAt?: number;
      };
    }
  | {
      type: 'tool_output';
      data: {
        tool_use_id: string;
        stream?: 'stdout' | 'stderr';
        chunk?: string;
        outputSummary?: string;
      };
    }
  | {
      type: 'text_segment';
      data: {
        uuid: string;
        text: string;
      };
    };

export type ClaudeMcpTool = SdkMcpToolDefinition<any>;
