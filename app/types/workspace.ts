import type { AssistantActivity } from '../../shared/protocol';
import type { PreparePhase } from '../../shared/protocol';

export type {
  AssistantActivity,
  BuildInfo,
  ChatResponse,
  ChatStreamEvent,
  DeploymentInfo,
  FileTree,
  LinkInfo,
  ResumeData,
  ResumeStreamEvent,
  SessionStreamEvent,
  WorkspaceSnapshot,
} from '../../shared/protocol';

export type AssistantStatus = 'running' | 'done' | 'error' | 'stopped';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: AssistantStatus;
  /** When this turn started running; the status bar ticks from here. */
  startedAt?: number;
  /** When this turn reached a terminal status; absent while still running. */
  endedAt?: number;
  /** Real startup milestone before the first visible agent output. */
  preparePhase?: PreparePhase;
};
