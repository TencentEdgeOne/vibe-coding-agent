import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export type BuildStatus = 'success' | 'failed' | 'skipped';

export type ProjectState = {
  created: boolean;
  sessionDir: string;
  appDir: string;
  previewUrl?: string;
  sandboxDebugUrl?: string;
};

// A base64 archive of the whole project, persisted outside the volatile sandbox so
// the code survives sandbox recycling (see agents/_memory.ts snapshot helpers). The
// fields mirror createProjectArchive's success result plus a write timestamp.
export type ProjectSnapshot = {
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
};

export type BuildResult = {
  status: BuildStatus;
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
  fatal?: boolean;
};

export type ProjectFileInput = {
  path: string;
  content: string;
};

export type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
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
        phaseHint?: 'scaffold' | 'code' | 'install' | 'preview' | 'link';
        fileCount?: number;
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
