import type { AssistantActivity } from '../../shared/protocol';
import type { ProgressPhase } from '../../shared/protocol';

export type {
  ActivityStatus,
  AssistantActivity,
  BuildInfo,
  BuildStatus,
  ChatResponse,
  ChatStreamEvent,
  FileTree,
  FileTreeItem,
  LinkInfo,
  ResumeData,
  ResumeStreamEvent,
} from '../../shared/protocol';

export type TimelineStep =
  | { kind: 'status'; text: string }
  | { kind: 'modify_marker' }
  | { kind: 'tool_use'; id: string; name: string; command?: string; phaseHint?: NormalizedStepPhase; fileCount?: number }
  | { kind: 'tool_result'; toolUseId: string; toolName?: string; command?: string; ok: boolean; preview: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr' | 'status'; text: string }
  | { kind: 'error'; text: string };

export type AssistantStatus = 'running' | 'done' | 'error' | 'stopped';
export type NormalizedStepStatus = 'waiting' | 'running' | 'done' | 'error';
export type NormalizedStepPhase = ProgressPhase;

export type NormalizedStep = {
  phase: NormalizedStepPhase;
  title: string;
  status: NormalizedStepStatus;
  summary: string;
};

export type ProcessEvent =
  | { kind: 'thinking'; content: string }
  | { kind: 'step'; phase: NormalizedStepPhase; step: NormalizedStep };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: AssistantStatus;
  thinkingContent?: string;
  processEvents?: ProcessEvent[];
  steps?: TimelineStep[];
};

export type InitLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

export const PHASE_ORDER: NormalizedStepPhase[] = ['scaffold', 'modify', 'code', 'install', 'preview', 'link'];
