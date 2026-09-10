import type { AssistantActivity, TurnResult } from '../../shared/protocol';

export type {
  AssistantActivity,
  BuildInfo,
  ChatResponse,
  ChatStreamEvent,
  FileTree,
  LinkInfo,
  PublishResult,
  PublishStage,
  ResumeData,
  ResumeStreamEvent,
} from '../../shared/protocol';

export type AssistantStatus = 'running' | 'done' | 'error' | 'stopped';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Simulated toolbar actions use a distinct bubble from typed user input. */
  origin?: 'user' | 'agent-action';
  activities?: AssistantActivity[];
  status?: AssistantStatus;
  startedAt?: number;
  endedAt?: number;
  turnResult?: TurnResult;
};
