import type { ChatMessage } from '@/app/types/workspace';
import type { AssistantActivity } from '../../../../../shared/protocol';
import type { ReferenceTopic, ToolAction } from '../../../../../shared/timeline';
import type { ModelOption } from '../../../../../shared/models';

export type AgentTurnStatus = 'running' | 'done' | 'error' | 'stopped';

export type ConversationMessage = ChatMessage;

export type ConversationCopy = {
  preparingAgent: string;
  prepareAccepted: string;
  prepareWorkspace: string;
  prepareAgent: string;
  analyzing: string;
  running: string;
  completed: string;
  failed: string;
  stopped: string;
  thinking: string;
  info: string;
  usage: string;
  compact: string;
  status: string;
  /** What the agent did, in the words a user would use for it. */
  toolActions: Record<ToolAction, string>;
  /** What a document the agent read was about, standing in for its id. */
  referenceTopics: Record<ReferenceTopic, string>;
  referenceDetail: string;
  input: string;
  output: string;
  /** Carries a `{count}` placeholder for the size of a folded run. */
  steps: string;
  placeholder: string;
  send: string;
  stop: string;
  stopping: string;
  modelLabel: string;
  copyLink: string;
  linkCopied: string;
  copyMessage: string;
  messageCopied: string;
  scrollToLatest: string;
  styleLabel: string;
  styleRefined: string;
  styleClassic: string;
};

export type DeployOfferCopy = {
  prompt: string;
  deploy: string;
  dismiss: string;
};

export type GatewayPromptCopy = {
  title: string;
  description?: string;
  docs: string;
  docsUrl: string;
  apiKey: string;
  continue: string;
  skip: string;
};

export type { AssistantActivity, ModelOption };
