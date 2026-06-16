import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  DEFAULT_MODEL,
  DEFAULT_PATH,
  GATEWAY_CONVERSATION_ID_HEADER_NAME,
  GATEWAY_QUOTA_BYPASS_HEADER,
  GATEWAY_QUOTA_PROMPT_HEADER,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
  SANDBOX_MCP_SERVER_NAME,
} from './_constants';
import {
  buildPreviewLinkTool,
  buildProjectScaffoldTool,
  buildPublishPreviewTool,
  buildWriteProjectFilesTool,
} from './tools/_project-tools';
import type {
  AgentProgressEvent,
  CodingAgentResult,
  ConversationMessage,
  ProjectState,
  ScaffoldLog,
} from './_types';
import {
  detectFatalToolError,
  sanitizeAssistantText,
  truncateForStream,
} from './utils/_text';
import { debugLog, isDebugEnabled } from './utils/_debug';

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function buildAnthropicCustomHeaders(customHeaders: string, conversationId: string) {
  const safeConversationId = sanitizeHeaderValue(conversationId);
  return [
    customHeaders,
    GATEWAY_QUOTA_BYPASS_HEADER,
    GATEWAY_QUOTA_PROMPT_HEADER,
    safeConversationId
      ? `${GATEWAY_CONVERSATION_ID_HEADER_NAME}: ${safeConversationId}`
      : '',
  ].filter(Boolean).join('\n');
}

function shortenToolName(name: string) {
  const match = name.match(/^mcp__[^_]+__(.+)$/);
  return match ? match[1] : name;
}

function extractSandboxCommand(input: unknown) {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return command.trim();
}

function isBrowserSandboxToolName(name: string) {
  return name.toLowerCase().includes('browser');
}

function extractVisibleNarrationDelta(event: SDKMessage) {
  if (event.type !== 'stream_event') {
    return '';
  }
  const streamEvent = (event as any).event;
  if (streamEvent?.type !== 'content_block_delta') {
    return '';
  }
  const delta = streamEvent.delta;
  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
    return sanitizeNarrationText(delta.text);
  }
  if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return sanitizeNarrationText(delta.thinking);
  }
  return '';
}

function sanitizeNarrationText(input: string) {
  if (!input) return '';
  return input
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/\[20[01]~/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/<think\b[^>]*>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

type StreamingToolUseBlock = {
  id: string;
  name: string;
  inputJson: string;
  input?: unknown;
};

function isToolUseContentBlock(block: unknown): block is {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
} {
  const record = block && typeof block === 'object'
    ? block as Record<string, unknown>
    : {};
  return record.type === 'tool_use' || record.type === 'mcp_tool_use';
}

function extractThinkingBlockText(block: unknown) {
  const record = block && typeof block === 'object'
    ? block as Record<string, unknown>
    : {};
  if (record.type !== 'thinking' || typeof record.thinking !== 'string') {
    return '';
  }
  return sanitizeNarrationText(record.thinking);
}

function parseToolInputJson(rawJson: string, fallback: unknown) {
  if (!rawJson.trim()) {
    return fallback ?? {};
  }
  try {
    return JSON.parse(rawJson);
  } catch {
    return fallback ?? {};
  }
}

function summarizeSdkMessage(event: SDKMessage): Record<string, unknown> {
  if (event.type === 'stream_event') {
    const streamEvent = (event as any).event;
    return {
      type: event.type,
      uuid: typeof event.uuid === 'string' ? event.uuid : '',
      eventType: streamEvent?.type,
      index: typeof streamEvent?.index === 'number' ? streamEvent.index : undefined,
      deltaType: streamEvent?.delta?.type,
      blockType: streamEvent?.content_block?.type,
      toolName: typeof streamEvent?.content_block?.name === 'string'
        ? streamEvent.content_block.name
        : undefined,
    };
  }

  if (event.type === 'assistant') {
    const blocks = (event as any).message?.content;
    return {
      type: event.type,
      uuid: typeof (event as any).uuid === 'string' ? (event as any).uuid : '',
      blocks: Array.isArray(blocks)
        ? blocks.map((block: any) => ({
            type: block?.type,
            id: typeof block?.id === 'string' ? block.id : undefined,
            name: typeof block?.name === 'string' ? block.name : undefined,
          }))
        : [],
    };
  }

  return {
    type: event.type,
    uuid: typeof (event as any).uuid === 'string' ? (event as any).uuid : '',
    subtype: typeof (event as any).subtype === 'string' ? (event as any).subtype : undefined,
  };
}

function isInstallCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\bnpm\s+(install|i)\b/.test(normalized)
    || /\bpnpm\s+install\b/.test(normalized)
    || /\byarn\s+install\b/.test(normalized)
    || /\bbun\s+install\b/.test(normalized)
    || /\bpython3?\s+-m\s+pip\s+install\b/.test(normalized)
    || /\bpip3?\s+install\b/.test(normalized)
  );
}

function isPreviewCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/.test(normalized)
    || /\b(next|vite|astro|nuxt)\s+dev\b/.test(normalized)
    || /\bpython\s+-m\s+http\.server\b/.test(normalized)
    || /\b(3000|8080)\b/.test(normalized) && /\b(dev|serve|server|preview|proxy)\b/.test(normalized)
  );
}

type ToolProgressPhase = 'scaffold' | 'code' | 'install' | 'preview' | 'link';

function inferToolProgress(name: string, input: unknown): {
  phaseHint?: ToolProgressPhase;
  fileCount?: number;
} {
  const toolName = shortenToolName(name);
  if (toolName === 'ensure_project_scaffold') {
    return { phaseHint: 'scaffold' };
  }
  if (toolName === 'publish_preview' || toolName === 'get_preview_link') {
    return { phaseHint: 'preview' };
  }
  if (toolName === 'files_write' || toolName === 'write_files' || toolName === 'files_make_dir' || toolName === 'files_remove') {
    return { phaseHint: 'code' };
  }
  if (toolName === 'write_project_files') {
    const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const files = Array.isArray(record.files) ? record.files : [];
    return {
      phaseHint: 'code',
      ...(files.length > 0 ? { fileCount: files.length } : {}),
    };
  }
  if (toolName === 'commands') {
    const cmd = extractSandboxCommand(input);
    if (isInstallCommand(cmd)) {
      return { phaseHint: 'install' };
    }
    if (isPreviewCommand(cmd)) {
      return { phaseHint: 'preview' };
    }
  }
  return {};
}

// Prompt-level guardrails: understand the request, generate or modify the project,
// then publish the preview link.
export function buildPrompt(
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  mcpServerName: string,
) {
  const recentHistory = history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
    .join('\n');

  return [
    'You are a Web Dev Agent that creates and modifies runnable web projects in a remote sandbox.',
    'You may create Next.js, Vite/React, static frontend, Node service, Python Flask/FastAPI, or other lightweight web projects according to the user request. Do not force every project to be Next.js.',
    `The only project directory you may modify is ${state.appDir}.`,
    `All file, command, browser, and code-execution operations must be performed through the ${mcpServerName} MCP tools in the remote sandbox.`,
    'If the user asks who you are, what you are, or what kind of agent you are, answer directly that you are the Vibe Coding Agent示例 on EdgeOne Makers, an out-of-the-box Agent template. In Chinese, reply: 我是 EdgeOne Makers 上的 Vibe Coding Agent示例，一个开箱即用的 Agent 模板，可以帮助你创建和修改可运行的 Web 项目。 Do not call any tools, and do not use the non-project refusal for identity questions.',
    'First decide whether the user request is about a web project, page, component, interaction, styling, or code development.',
    'If the user request is not related to project development, reply exactly: I can only help create or modify web projects. Please describe the page or feature you want to build. Do not call any tools.',
    'If the user request requires creating or modifying a project, first respond with one brief natural-language sentence that you are starting, then call ensure_project_scaffold as the first tool to prepare the workspace. Do not call any other tool before ensure_project_scaffold.',
    'That first sentence must be concise, user-visible progress narration, not a plan. Use the user language when obvious. Example: 我先准备项目环境，然后开始实现。 / I will prepare the workspace first, then start building.',
    `Before calling ensure_project_scaffold, do not read, write, or execute anything under ${state.appDir}.`,
    'Do not use the cloud function local filesystem as the project workspace, and do not modify business files outside the project directory.',
    'If ensure_project_scaffold returns created=false, inspect the existing code first, then make the smallest complete change needed for the user request.',
    [
      'If ensure_project_scaffold returns created=true, complete these steps in order:',
      '1. Choose the tech stack and file list based on the user request.',
      '2. Call write_project_files once or a small number of times to batch-write complete runnable files. The argument must be {"files":[{"path":"relative/path","content":"complete file contents"}]}.',
      '3. Install dependencies for the generated project. Use npm install by default for Node/frontend projects, use pnpm/yarn only when explicitly requested, and use python -m pip install -r requirements.txt for Python projects.',
      `4. Call the publish_preview tool. It starts the internal service on port ${PREVIEW_SERVER_PORT}, verifies that ${PREVIEW_PATH_PREFIX} is HTTP-ready, and generates the public preview with sandbox.getHost(${PREVIEW_PUBLIC_PORT}) + ${PREVIEW_PATH_PREFIX} + envdAccessToken. Do not hand-write background npm run dev commands.`,
    ].join('\n'),
    'Do not write only placeholder pages. Generated files must be complete, internally consistent, and directly installable and runnable.',
    'Prefer write_project_files to create or replace multiple project files. Paths must be relative to the project directory. Prefer passing files as an array, not a string.',
    'write_project_files / files_write are only for UTF-8 text source and configuration files. Do not write images, fonts, audio/video, archives, or other binary assets, and do not write large base64 blocks as text.',
    'Avoid generating images, fonts, audio/video, archives, or other binary files when possible. Prefer CSS, SVG, emoji, public remote asset URLs, or existing dependency capabilities for visual effects to save tokens and write cost.',
    'Only create binary assets when the user explicitly requests them, the feature truly depends on them, and there is no lightweight alternative. In that case, use the sandbox commands tool inside the project directory to generate, download, or decode assets. Do not write them directly with file-writing tools.',
    'Do not hand-write lockfiles, node_modules, .next, dist, build, cache directories, or package-manager generated artifacts.',
    'When a command fails, read the error and identify the specific issue first. Fix only the specific file, dependency, or configuration. Do not regenerate the whole project, and do not repeat the same failed fix.',
    'Prefer the smallest complete change, preserving the existing project structure and style. Do not refactor anything unrelated to the user request.',
    'Next.js projects must use the standard App Router structure. Use next.config.js or next.config.mjs for configuration; do not generate next.config.ts.',
    "Next.js projects must support basePath: process.env.EDGEONE_PREVIEW_BASE_PATH || '' in next.config.js or next.config.mjs. Do not hard-code /preview into business routes.",
    `Vite projects must support sandbox preview under ${PREVIEW_PATH_PREFIX}: use base ${PREVIEW_PATH_PREFIX}; server.host='0.0.0.0'; server.port=${PREVIEW_SERVER_PORT}; server.strictPort=true; server.allowedHosts=true; server.hmr={ protocol:'wss', clientPort:443 }; legacy.skipWebSocketTokenCheck=true; do not set server.hmr.path.`,
    'Vite React projects must install @vitejs/plugin-react and configure plugins: [react()] to preserve React Fast Refresh.',
    'Do not hard-code temporary sandbox preview domains in vite.config.',
    'If you generate a TypeScript project, ensure imports, types, and routing APIs can pass build or verification.',
    'Do not paste large code blocks in the reply. The final response should use the main language of the current user prompt by default; if the prompt mixes languages, follow the primary language. Keep technical terms, error logs, and non-preview links unchanged.',
    'The final response must be a concrete conclusion tailored to the current user request, explaining what was completed and the preview/verification result. For example, if the user asks for "a pomodoro timer with stats and theme switching", reply with something like "Built the pomodoro timer with stats and theme switching. The preview is ready in the right panel." Do not say only "Done, please check the result."',
    'Do not claim success for anything that was not verified successfully. If it failed, briefly explain the failure point and the next step.',
    `After code changes and dependency installation, you must call publish_preview to publish the getHost(${PREVIEW_PUBLIC_PORT})${PREVIEW_PATH_PREFIX} preview for the user. publish_preview handles startup and validation of the internal ${PREVIEW_SERVER_PORT} preview service. get_preview_link is only a legacy alias; do not prefer it.`,
    'Do not synthesize preview URLs or sandboxDebugUrl. Use only the fields returned by publish_preview or get_preview_link.',
    'Do not include preview buttons, preview links, preview URLs, or sandboxDebugUrl in the final response. The preview is shown only in the right preview panel.',
    'Do not take screenshots.',
    'Do not include emoji in the response.',
    isNewProject ? 'The project workspace may not have been prepared yet.' : 'This conversation has already prepared a project workspace.',
    recentHistory ? `Recent conversation:\n${recentHistory}` : '',
    `Current user request: ${userMessage}`,
    'If the user request is unclear, ask the user for the specific requirement.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function runCodingAgent(
  context: any,
  conversationId: string,
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  onScaffoldLog?: (log: ScaffoldLog) => void,
  onProgress?: (event: AgentProgressEvent) => void,
  onScaffoldDone?: () => void | Promise<void>,
): Promise<CodingAgentResult> {
  // Prefer AI Gateway for model access, with backward-compatible Anthropic / DeepSeek config.
  const apiKey = pickEnvValue(context, 'AI_GATEWAY_API_KEY')
    || pickEnvValue(context, 'ANTHROPIC_API_KEY')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const authToken = pickEnvValue(context, 'ANTHROPIC_AUTH_TOKEN')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const model = pickEnvValue(context, 'AI_GATEWAY_MODEL')
    || pickEnvValue(context, 'ANTHROPIC_MODEL')
    || pickEnvValue(context, 'DEEPSEEK_MODEL')
    || DEFAULT_MODEL;
  const baseURL = pickEnvValue(context, 'AI_GATEWAY_BASE_URL')
    || pickEnvValue(context, 'ANTHROPIC_BASE_URL')
    || pickEnvValue(context, 'DEEPSEEK_BASE_URL')
    || '';
  const customHeaders = pickEnvValue(context, 'ANTHROPIC_CUSTOM_HEADERS');
  const executablePath = pickEnvValue(context, 'CLAUDE_CODE_EXECUTABLE_PATH');

  if (!apiKey && !authToken) {
    return {
      success: false,
      output: null,
      error: 'Missing AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY. The agent cannot call the model.',
      projectTouched: false,
      wasCreated: false,
    };
  }

  if (!baseURL) {
    return {
      success: false,
      output: null,
      error: 'Missing AI_GATEWAY_BASE_URL / ANTHROPIC_BASE_URL / DEEPSEEK_BASE_URL. The agent cannot call the model.',
      projectTouched: false,
      wasCreated: false,
    };
  }

  const sdkEnv: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseURL,
    ANTHROPIC_MODEL: model,
    // @anthropic-ai/sdk injects ANTHROPIC_CUSTOM_HEADERS into each model request.
    ANTHROPIC_CUSTOM_HEADERS: buildAnthropicCustomHeaders(customHeaders, conversationId),
    PATH: pickEnvValue(context, 'PATH') || DEFAULT_PATH,
    HOME: pickEnvValue(context, 'HOME') || '/tmp',
    CLAUDE_CONFIG_DIR: pickEnvValue(context, 'CLAUDE_CONFIG_DIR') || '/tmp/.claude',
  };

  if (apiKey) {
    sdkEnv.ANTHROPIC_API_KEY = apiKey;
  }
  if (authToken) {
    sdkEnv.ANTHROPIC_AUTH_TOKEN = authToken;
  }
  if (!sdkEnv.ANTHROPIC_API_KEY && authToken) {
    sdkEnv.ANTHROPIC_API_KEY = authToken;
  }
  try {
    const mcpServerName = SANDBOX_MCP_SERVER_NAME;
    if (typeof context.tools?.toClaudeMcpServer !== 'function') {
      throw new Error('The current Pages Agent Runtime is missing context.tools.toClaudeMcpServer. Please upgrade to a runtime that supports the new pages-agent-toolkit Tools API.');
    }
    const edgeoneMcp = context.tools.toClaudeMcpServer(mcpServerName, { alwaysLoad: true });
    const sandboxTools = edgeoneMcp.tools.filter((tool) => !isBrowserSandboxToolName(tool.name));
    const sandboxAllowedTools = edgeoneMcp.allowedTools.filter((toolName) => !isBrowserSandboxToolName(toolName));
    let projectTouched = false;
    let previewTouched = false;
    let wasCreated = false;
    const scaffoldTool = buildProjectScaffoldTool(
      context,
      state,
      onScaffoldLog,
      ({ created }) => {
        projectTouched = true;
        wasCreated = created;
      },
    );
    const previewLinkTool = buildPreviewLinkTool(
      context,
      state,
      () => {
        previewTouched = true;
      },
    );
    const publishPreviewTool = buildPublishPreviewTool(
      context,
      state,
      () => {
        previewTouched = true;
      },
    );
    const writeProjectFilesTool = buildWriteProjectFilesTool(
      context,
      state,
      async () => {
        projectTouched = true;
        await onScaffoldDone?.();
      },
    );
    const mcpTools = [
      ...sandboxTools,
      scaffoldTool,
      writeProjectFilesTool,
      publishPreviewTool,
      previewLinkTool,
    ];
    const mcpAllowedTools = [
      ...sandboxAllowedTools,
      `mcp__${mcpServerName}__ensure_project_scaffold`,
      `mcp__${mcpServerName}__write_project_files`,
      `mcp__${mcpServerName}__publish_preview`,
      `mcp__${mcpServerName}__get_preview_link`,
    ];

    const sandboxMcpServer = createSdkMcpServer({
      name: mcpServerName,
      tools: mcpTools,
      alwaysLoad: true,
    });

    const sdkOptions: Parameters<typeof query>[0]['options'] = {
      model,
      permissionMode: 'dontAsk',
      // maxTurns: 100,
      // Disable Claude Code built-in local tools so the model can only read,
      // write, and execute through EdgeOne sandbox MCP tools.
      tools: [],
      includePartialMessages: true,
      mcpServers: {
        [mcpServerName]: sandboxMcpServer,
      },
      allowedTools: mcpAllowedTools,
      strictMcpConfig: true,
      systemPrompt: buildPrompt(userMessage, history, state, isNewProject, mcpServerName),
      env: sdkEnv,
      // publish_preview starts the internal port 3000 service, verifies /preview/
      // readiness, and publishes the getHost(9000)/preview/ preview link.
      cwd: process.cwd(),
      settingSources: ['project'],
      debug: isDebugEnabled(context),
      stderr: (data: string) => {
        debugLog(context, '[claude-code stderr]', data.trimEnd());
      },
    };

    if (executablePath) {
      sdkOptions.pathToClaudeCodeExecutable = executablePath;
    }

    const sdkQuery = query({
      prompt: userMessage,
      options: sdkOptions,
    });

    let resultMessage: SDKResultMessage | null = null;
    // Sandbox infrastructure failures, such as EdgeOne LazySandbox routes returning
    // Not Found, make all later tool calls fail. Retrying only consumes turns and
    // pollutes context, so stop this query immediately with a clear upper-layer error.
    let fatalError: string | null = null;
    // Independently record tool_use_id -> tool context so tool_result events
    // can update the correct progress step even when model providers stream
    // partial tool inputs differently.
    const toolContextById = new Map<string, { name: string; command?: string }>();
    const pendingToolUseBlocks = new Map<number, StreamingToolUseBlock>();
    const emittedToolUseProgress = new Map<string, string>();
    let emittedNarration = '';
    const SCAFFOLD_TOOL_NAME = `mcp__${mcpServerName}__ensure_project_scaffold`;
    // Push file_tree immediately at most once per turn after scaffold, avoiding duplicate find calls.
    let scaffoldHandled = false;

    const emitNarration = (rawText: string, uuid: string, complete = false) => {
      const text = sanitizeNarrationText(rawText);
      if (!text) {
        return;
      }

      const trimmedText = text.trim();
      if (complete && trimmedText && emittedNarration.includes(trimmedText)) {
        return;
      }

      const cleanNextText = sanitizeNarrationText(text);
      if (!cleanNextText) {
        return;
      }

      emittedNarration = sanitizeNarrationText(`${emittedNarration}${cleanNextText}`);
      onProgress?.({
        type: 'text_segment',
        data: {
          uuid,
          text: cleanNextText,
        },
      });
    };

    const emitToolUseProgress = (toolUse: {
      id?: string;
      name?: string;
      input?: unknown;
    }) => {
      const toolName = typeof toolUse.name === 'string' ? toolUse.name : '<unknown>';
      const toolUseId = typeof toolUse.id === 'string' ? toolUse.id : '';
      const shortToolName = shortenToolName(toolName);
      const command = shortToolName === 'commands' ? extractSandboxCommand(toolUse.input) : '';
      const progress = typeof toolUse.name === 'string'
        ? inferToolProgress(toolName, toolUse.input)
        : {};
      const progressSignature = JSON.stringify({
        name: toolName,
        command,
        phaseHint: progress.phaseHint || '',
        fileCount: progress.fileCount || 0,
      });
      if (toolUseId) {
        const previousSignature = emittedToolUseProgress.get(toolUseId);
        if (previousSignature === progressSignature) {
          return;
        }
        emittedToolUseProgress.set(toolUseId, progressSignature);
      }

      if (toolUseId && typeof toolUse.name === 'string') {
        toolContextById.set(toolUseId, {
          name: toolUse.name,
          ...(command ? { command } : {}),
        });
      }
      onProgress?.({
        type: 'tool_use',
        data: {
          id: toolUseId,
          name: toolName,
          ...(command ? { command } : {}),
          ...progress,
        },
      });
    };

    for await (const event of sdkQuery as AsyncIterable<SDKMessage>) {
      debugLog(context, '[agent-event]', summarizeSdkMessage(event));
      // Forward structured tool progress and high-level model narration. Tool
      // input JSON and non-text stream deltas stay out of the UI.
      if (event.type === 'stream_event') {
        emitNarration(
          extractVisibleNarrationDelta(event),
          typeof event.uuid === 'string' ? event.uuid : '',
          false,
        );
        const streamEvent = (event as any).event;
        if (streamEvent?.type === 'content_block_start') {
          const contentBlock = streamEvent.content_block;
          if (isToolUseContentBlock(contentBlock) && typeof streamEvent.index === 'number') {
            pendingToolUseBlocks.set(streamEvent.index, {
              id: typeof contentBlock.id === 'string' ? contentBlock.id : '',
              name: typeof contentBlock.name === 'string' ? contentBlock.name : '',
              inputJson: '',
              input: contentBlock.input,
            });
            emitToolUseProgress({
              id: contentBlock.id,
              name: contentBlock.name,
              input: contentBlock.input,
            });
          }
        } else if (streamEvent?.type === 'content_block_delta') {
          const delta = streamEvent.delta;
          const pendingToolUse = typeof streamEvent.index === 'number'
            ? pendingToolUseBlocks.get(streamEvent.index)
            : undefined;
          if (
            pendingToolUse
            && delta?.type === 'input_json_delta'
            && typeof delta.partial_json === 'string'
          ) {
            pendingToolUse.inputJson += delta.partial_json;
          }
        } else if (streamEvent?.type === 'content_block_stop') {
          const pendingToolUse = typeof streamEvent.index === 'number'
            ? pendingToolUseBlocks.get(streamEvent.index)
            : undefined;
          if (pendingToolUse) {
            pendingToolUseBlocks.delete(streamEvent.index);
            emitToolUseProgress({
              id: pendingToolUse.id,
              name: pendingToolUse.name,
              input: parseToolInputJson(pendingToolUse.inputJson, pendingToolUse.input),
            });
          }
        }
      } else if (event.type === 'assistant') {
        const blocks = (event as any).message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            emitNarration(
              extractThinkingBlockText(b),
              typeof event.uuid === 'string' ? event.uuid : '',
              true,
            );
            if (isToolUseContentBlock(b)) {
              emitToolUseProgress({
                id: b.id,
                name: b.name,
                input: b.input,
              });
            }
          }
        }
      } else if (event.type === 'user') {
        const blocks = (event as any).message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b?.type === 'tool_result') {
              const text = Array.isArray(b.content)
                ? b.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ')
                : (typeof b.content === 'string' ? b.content : '');
              const toolContext = toolContextById.get(b.tool_use_id);
              const toolName = toolContext?.name || '<unknown>';
              onProgress?.({
                type: 'tool_result',
                data: {
                  tool_use_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
                  toolName,
                  ...(toolContext?.command ? { command: toolContext.command } : {}),
                  ok: b.is_error !== true,
                  preview: truncateForStream(text, 500),
                },
              });
              // Once ensure_project_scaffold succeeds, notify the outer pipeline to
              // push file_tree so the Files panel does not wait for the whole runCodingAgent turn.
              if (
                !scaffoldHandled
                && toolName === SCAFFOLD_TOOL_NAME
                && b.is_error !== true
              ) {
                scaffoldHandled = true;
                try {
                  await onScaffoldDone?.();
                } catch (err) {
                  console.warn('[scaffold-done] onScaffoldDone failed', err);
                }
              }
              // Detect sandbox infrastructure failures only on is_error=true tool
              // results, avoiding false positives from normal text containing "Not Found".
              if (b.is_error === true && !fatalError) {
                const fatal = detectFatalToolError(text);
                if (fatal) {
                  fatalError = `${fatal} (tool=${toolName})`;
                  console.warn('[fatal] aborting agent loop:', fatalError);
                }
              }
            }
          }
        }
      }
      if (event.type === 'system' && event.subtype === 'init') {
        debugLog(context, '[agent-init]', { mcpServers: event.mcp_servers });
      }
      if (event.type === 'result') {
        resultMessage = event;
        break;
      }
      // Exit the loop immediately after a fatal error instead of waiting for more model turns.
      if (fatalError) {
        break;
      }
    }

    // Fatal errors take priority over normal results, even if the SDK produced
    // a result for this turn.
    if (fatalError) {
      try {
        await (sdkQuery as any)?.return?.();
      } catch {
        // Ignore this because the SDK may not support return(); stop it when possible.
      }
      return {
        success: false,
        output: null,
        error: fatalError,
        projectTouched,
        previewTouched,
        wasCreated,
        fatal: true,
      };
    }

    if (!resultMessage) {
      return {
        success: false,
        output: null,
        error: 'The model stream ended without returning a result.',
        projectTouched,
        previewTouched,
        wasCreated,
      };
    }

    if (resultMessage.subtype !== 'success') {
      return {
        success: false,
        output: null,
        error: Array.isArray(resultMessage.errors) && resultMessage.errors.length > 0
          ? resultMessage.errors[0]
          : 'Model execution failed.',
        projectTouched,
        previewTouched,
        wasCreated,
      };
    }

    return {
      success: true,
      output: sanitizeAssistantText((resultMessage.result || '').trim()),
      error: null,
      projectTouched,
      previewTouched,
      wasCreated,
    };
  } catch(e) {
    console.error(e);
    const message = e instanceof Error ? e.message : String(e);
    const fatal = detectFatalToolError(message);
    return {
      success: false,
      output: null,
      error: fatal || message || 'Execution failed.',
      projectTouched: false,
      wasCreated: false,
      ...(fatal ? { fatal: true } : {}),
    };
  } finally {
    // sdkQuery.close();
  }
}
