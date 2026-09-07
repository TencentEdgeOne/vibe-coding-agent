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
  PublishStreamEvent,
  ResumeData,
  ResumeStreamEvent,
} from '../../shared/protocol';

export type AssistantStatus = 'running' | 'done' | 'error' | 'stopped';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: AssistantStatus;
  startedAt?: number;
  endedAt?: number;
  turnResult?: TurnResult;
};
