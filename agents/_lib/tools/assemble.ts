import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { SANDBOX_MCP_SERVER_NAME } from '../constants.ts';
import type { AgentContext } from '../runtime/context.ts';
import type {
  ClaudeMcpTool,
  CodingAgentResult,
  DeploymentInfo,
  PreviewKind,
  ProjectState,
  StreamSend,
} from '../types.ts';
import { wrapSandboxTools, type MakersCommandLifecycle } from './commands-wrap.ts';
import { installCommandOutputStream } from './command-stream.ts';
import { wrapWebSearchTool } from './web-search-wrap.ts';
import {
  WEB_SEARCH_API_KEY_ENV,
  isWebSearchConfigured,
  isWebSearchToolName,
} from '../../../shared/web-search.ts';
import { buildDeployProjectTool, DEPLOY_PROJECT_TOOL_NAME } from './deploy-tools.ts';
import { buildStartPreviewTool } from './preview-tools.ts';

export type LiveTurnCallbacks = {
  onProjectFilesChanged?: (file?: { path: string; content: string }) => void | Promise<void>;
  onPreviewReady?: (preview: { url?: string; sandboxDebugUrl?: string; kind?: PreviewKind }) => void;
  onDeploymentStatus?: (deployment: DeploymentInfo) => void;
  send?: StreamSend;
  abortSignal?: AbortSignal;
};

export type LiveSessionHandle = {
  conversationId: string;
  context: AgentContext;
  getState: () => ProjectState;
  getCallbacks: () => LiveTurnCallbacks;
  flags: {
    projectTouched: boolean;
    filesWritten: boolean;
    previewTouched: boolean;
    deploymentTouched: boolean;
  };
};

function isBrowserSandboxToolName(name: string) {
  return name.toLowerCase().includes('browser');
}

function pickEnvValue(context: AgentContext, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function assembleAgentTools(session: LiveSessionHandle) {
  const context = session.context;
  if (typeof context.tools?.toClaudeMcpServer !== 'function') {
    throw new Error('The current Pages Agent Runtime is missing context.tools.toClaudeMcpServer. Please upgrade to a runtime that supports the new pages-agent-toolkit Tools API.');
  }

  const mcpServerName = SANDBOX_MCP_SERVER_NAME;
  const edgeoneMcp = context.tools.toClaudeMcpServer(mcpServerName, { alwaysLoad: true });
  const webSearchAvailable = isWebSearchConfigured(
    pickEnvValue(context, WEB_SEARCH_API_KEY_ENV),
  );
  const offerSandboxTool = (name: string) =>
    !isBrowserSandboxToolName(name)
    && (webSearchAvailable || !isWebSearchToolName(name));

  // Installed once, against the context this session was assembled with. The
  // sandbox toolkit memoizes its tools per context object, so an install from a
  // later context would be sending into a sandbox nobody runs commands in.
  const commandStream = installCommandOutputStream({
    context,
    getSend: () => session.getCallbacks().send,
    getProjectDir: () => session.getState().appDir,
  });
  const sandboxTools = wrapWebSearchTool(wrapSandboxTools(
    (edgeoneMcp.tools as ClaudeMcpTool[]).filter((tool) => offerSandboxTool(tool.name)),
    {
      context,
      get state() {
        return session.getState();
      },
      conversationId: session.conversationId,
      get send() {
        return session.getCallbacks().send;
      },
      get signal() {
        return session.getCallbacks().abortSignal;
      },
      commandStream,
      onPreviewReady: (preview) => {
        session.flags.previewTouched = true;
        if (preview.url) session.getCallbacks().onPreviewReady?.(preview);
      },
      onDeploymentStatus: (deployment: DeploymentInfo) => {
        session.flags.deploymentTouched = true;
        session.getCallbacks().onDeploymentStatus?.(deployment);
      },
    } as MakersCommandLifecycle,
  ));
  const mcpTools = [
    ...sandboxTools,
    buildStartPreviewTool({
      context,
      conversationId: session.conversationId,
      get state() {
        return session.getState();
      },
      onPreviewReady: (preview) => {
        session.flags.previewTouched = true;
        if (preview.url) session.getCallbacks().onPreviewReady?.(preview);
      },
      get send() {
        return session.getCallbacks().send;
      },
    }),
    buildDeployProjectTool({
      context,
      conversationId: session.conversationId,
      get state() {
        return session.getState();
      },
      get send() {
        return session.getCallbacks().send;
      },
      onDeploymentStatus: (deployment) => {
        session.flags.deploymentTouched = true;
        session.getCallbacks().onDeploymentStatus?.(deployment);
      },
    }),
  ];
  const mcpAllowedTools = [
    ...edgeoneMcp.allowedTools.filter(offerSandboxTool),
    `mcp__${mcpServerName}__start_preview`,
    `mcp__${mcpServerName}__${DEPLOY_PROJECT_TOOL_NAME}`,
  ];

  return {
    mcpServerName,
    webSearchAvailable,
    sandboxMcpServer: createSdkMcpServer({
      name: mcpServerName,
      tools: mcpTools,
      alwaysLoad: true,
    }),
    mcpAllowedTools,
  };
}

export function emptyCodingResult(partial: Partial<CodingAgentResult> = {}): CodingAgentResult {
  return {
    success: false,
    output: null,
    error: null,
    projectTouched: false,
    filesWritten: false,
    wasCreated: false,
    ...partial,
  };
}
