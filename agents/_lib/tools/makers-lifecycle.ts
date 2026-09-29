import type { AgentContext } from '../runtime/context.ts';
import type {
  DeploymentInfo,
  PreviewKind,
  ProjectState,
  StreamSend,
} from '../types.ts';
import type { CommandOutputStream } from './command-stream.ts';

export type MakersCommandLifecycle = {
  context: AgentContext;
  state: ProjectState;
  conversationId: string;
  send?: StreamSend;
  signal?: AbortSignal;
  /**
   * Live command output for this session, installed when the tools were
   * assembled. Null when the runtime does not expose an output sink.
   */
  commandStream?: CommandOutputStream | null;
  onPreviewReady?: (preview: {
    url?: string;
    sandboxDebugUrl?: string;
    kind?: PreviewKind;
  }) => void;
  onDeploymentStatus?: (deployment: DeploymentInfo) => void;
};
