import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import type {
  BuildInfo,
  BuildStatus,
  ChatStreamEvent,
  DeploymentInfo,
  PreviewKind,
  PreviewRoute,
  PreparePhase,
} from '../../shared/protocol.ts';

export type {
  ActivityStatus,
  AssistantActivity as PersistedActivity,
  BuildInfo,
  BuildStatus,
  DeploymentInfo,
  FileTreeItem,
  PersistedActivityTurn,
  PreviewKind,
  PreviewRoute,
  PreparePhase,
} from '../../shared/protocol.ts';

export type ProjectState = {
  created: boolean;
  sessionDir: string;
  appDir: string;
  /** Opaque, non-secret tenant ID used to mint short-lived Makers tokens for direct sandbox CLI calls. */
  makersTenantId?: string;
  /** Public site root (`edgeone.dev` / `edgeone.cool`) used to pick the publish acceleration area. */
  siteDomain?: string;
  /** Site the minted sandbox token belongs to. Injected as EDGEONE_PAGES_API_REGION so the CLI can pick a CAPI host. */
  makersApiRegion?: 'china' | 'global';
  previewUrl?: string;
  sandboxDebugUrl?: string;
  /** Latched once Makers dev succeeds so resume can restore the sandbox preview. */
  previewPublished?: boolean;
  previewKind?: PreviewKind;
  /** Routes the address bar can offer; persisted so a resume keeps the list. */
  previewRoutes?: PreviewRoute[];
  /** Latest live deployment, kept separate from the sandbox preview iframe. */
  deployment?: DeploymentInfo;
  /** Last verification result; streamed on `workspace` and also on GET /workspace. */
  lastBuild?: BuildInfo;
  /** The host is waiting for a Models API key in the next user turn. */
  gatewayPromptPending?: boolean;
  /** The user skipped the Models API key for this conversation. */
  gatewaySkipped?: boolean;
};

export type ChatTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * What the task slot is running. Publishing is a service step with one correct
 * command, so 'deploy' skips the model entirely — but it still occupies the
 * same slot, so it cannot race a generation over the same sandbox.
 */
export type ChatTaskKind = 'prompt' | 'deploy';

export type ChatTask = {
  id: string;
  message: string;
  kind?: ChatTaskKind;
  /** Public site root from the browser; picks overseas vs global acceleration. */
  siteDomain?: string;
  /** Model this turn runs on. Absent means the deployment's configured default. */
  model?: string;
  /** Startup milestone shown before the first user-visible agent output. */
  preparePhase?: PreparePhase;
  status: ChatTaskStatus;
  createdAt: number;
  startedAt?: number;
  /**
   * Written by the running turn at a steady interval. A running turn whose
   * progress is fresh has a live owner somewhere, even if not in this process.
   */
  progressAt?: number;
  finishedAt?: number;
  error?: string;
};

export type StreamSend = (event: ChatStreamEvent) => void;

export type ScaffoldLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

export type CodingAgentResult = {
  success: boolean;
  output: string | null;
  error: string | null;
  projectTouched: boolean;
  /**
   * Whether this turn wrote a project file, as opposed to merely reaching the
   * project. Answering a question is not a build that failed.
   */
  filesWritten?: boolean;
  previewTouched?: boolean;
  deploymentTouched?: boolean;
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

export type AgentProgressEvent = Extract<
  ChatStreamEvent,
  { type: 'tool_use' | 'tool_result' | 'text_segment' | 'thinking_segment' | 'system_info' }
>;

export type ClaudeMcpTool = SdkMcpToolDefinition<any>;
