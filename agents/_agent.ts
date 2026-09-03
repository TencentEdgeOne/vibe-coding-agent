import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  buildReplyLanguageDirective,
  buildReplyLanguageReminder,
} from '../shared/reply-language.ts';
import {
  DEFAULT_PATH,
  GATEWAY_CONVERSATION_ID_HEADER_NAME,
  GATEWAY_QUOTA_BYPASS_HEADER,
  GATEWAY_QUOTA_PROMPT_HEADER,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
  SANDBOX_MCP_SERVER_NAME,
} from './_constants';
import { resolveConfiguredModel } from './_models';
import { wrapSandboxToolsForVerification } from './tools/_commands-wrap';
import {
  buildPreviewLinkTool,
  buildProjectScaffoldTool,
  buildPublishPreviewTool,
  buildWriteProjectFileTool,
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
import { summarizeToolInput, summarizeToolOutput } from './utils/_activity';
import {
  resolveNarrationEmit,
  sanitizeNarrationText,
  type NarrationEmitState,
} from './utils/_narration';
import { isInstallCommand, isPreviewCommand, parseEchoedExitCode, shortenToolName } from './utils/_tool-phase';

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

function isGenericProjectWriteToolName(name: string) {
  const normalized = name.toLowerCase();
  return normalized === 'files_write'
    || normalized === 'write_files'
    || normalized.endsWith('__files_write')
    || normalized.endsWith('__write_files');
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
  return '';
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

function extractVisibleTextBlock(block: unknown) {
  const record = block && typeof block === 'object'
    ? block as Record<string, unknown>
    : {};
  if (record.type !== 'text' || typeof record.text !== 'string') {
    return '';
  }
  return sanitizeNarrationText(record.text);
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
  if (toolName === 'write_project_file') {
    return { phaseHint: 'code', fileCount: 1 };
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
  // Message whose language the reply must mirror. Differs from `userMessage` on
  // internal turns such as auto-fix, where the prompt is machine-written English
  // but the answer still belongs to whoever asked the original question.
  languageAnchorMessage: string = userMessage,
) {
  const recentHistory = history
    .slice(-8)
    .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
    .join('\n');

  return [
    'You are a Web Dev Agent that creates and modifies runnable web projects in a remote sandbox.',
    buildReplyLanguageDirective(languageAnchorMessage),
    'You may create Next.js, Vite/React, static frontend, Node service, Python Flask/FastAPI, or other lightweight web projects according to the user request. Do not force every project to be Next.js. For ordinary UI pages, prefer a modular Vite/React (or split HTML/CSS/JS) project instead of one self-contained HTML file.',
    `The only project directory you may modify is ${state.appDir} (relative path, no leading slash).`,
    `All file, command, browser, and code-execution operations must be performed through the ${mcpServerName} MCP tools in the remote sandbox.`,
    'If the user asks who you are, what you are, or what kind of agent you are, answer directly, in the reply language, that you are the Vibe Coding Agent sample on EdgeOne Makers, an out-of-the-box Agent template that helps create and modify runnable web projects. Do not call any tools, and do not use the non-project refusal for identity questions.',
    'First decide whether the user request is about a web project, page, component, interaction, styling, or code development.',
    'If the user request is not related to project development, reply with only this message, written in the reply language: I can only help create or modify web projects. Please describe the page or feature you want to build. Do not call any tools.',
    'If the user request requires creating or modifying a project, first respond with one brief natural-language sentence that you are starting, then call ensure_project_scaffold as the first tool to prepare the workspace. Do not call any other tool before ensure_project_scaffold — including files_list, files_make_dir, files_write, commands, or write_project_file.',
    'That first sentence must be concise, user-visible progress narration, not a plan, and written in the reply language. For an English request it reads like: I will prepare the workspace first, then start building.',
    `Before calling ensure_project_scaffold, do not read, write, or execute anything under ${state.appDir}.`,
    `Never pass absolute paths (starting with /). For write_project_file, path must be relative to ${state.appDir} itself — correct: package.json, src/App.tsx, index.html. Wrong: ${state.appDir}/package.json or /${state.appDir}/src/App.tsx. Prefer write_project_file, not raw files_write/files_list.`,
    'Do not use the cloud function local filesystem as the project workspace, and do not modify business files outside the project directory.',
    'If ensure_project_scaffold returns created=false, inspect the existing code first, then make the smallest complete change needed for the user request.',
    [
      'If ensure_project_scaffold returns created=true, complete these steps in order:',
      '1. Choose a modular tech stack and a small multi-file layout. Prefer Vite + React/TS (or plain HTML split into index.html + css/ + js/modules) over a single giant HTML file. Do not put styles, scripts, and markup into one large index.html unless the user explicitly asks for a single-file page.',
      `2. Write the project incrementally with write_project_file. Each call must contain exactly one complete file: {"path":"src/App.tsx","content":"complete file contents"} — path relative to ${state.appDir}, never "${state.appDir}/src/App.tsx". Keep each file focused and reasonably small so the user sees steady progress. Typical order: package.json/config → styles → small components/modules → entry/App → thin index.html if needed. Call it once per file, in dependency order, and wait for each tool result before the next call. Never send multiple write_project_file calls in the same assistant message.`,
      `3. Install dependencies inside ${state.appDir} (cd ${state.appDir} && npm install by default for Node/frontend projects; pnpm/yarn only when explicitly requested; python -m pip install -r requirements.txt for Python). Do not invent nested ${state.appDir}/${state.appDir} paths.`,
      `4. Call the publish_preview tool. It starts the internal service on port ${PREVIEW_SERVER_PORT}, verifies that ${PREVIEW_PATH_PREFIX} is HTTP-ready, and generates the public preview with sandbox.getHost(${PREVIEW_PUBLIC_PORT}) + ${PREVIEW_PATH_PREFIX} + envdAccessToken. Do not hand-write background npm run dev commands.`,
    ].join('\n'),
    'Structure code for progressive delivery: split UI, styles, and logic across multiple files/modules instead of one monolithic HTML/JS blob. Avoid thousand-line files when they can be split into components, hooks, utils, and stylesheets. Prefer several medium files over one oversized HTML/JS file so each write_project_file finishes quickly and improves streaming UX.',
    'Do not write only placeholder pages. Generated files must be complete, internally consistent, and directly installable and runnable.',
    'Always use write_project_file for UTF-8 project source and configuration files, including one-file edits to existing projects. Do not use files_write, write_files, or shell commands to create or replace text source files.',
    'write_project_file accepts exactly one file per call. Never pass an array, files map, entries object, or more than one path. Finish one tool call before starting the next so the user can see steady file-by-file progress.',
    'write_project_file is only for UTF-8 text source and configuration files. Do not write images, fonts, audio/video, archives, or other binary assets, and do not write large base64 blocks as text.',
    'Avoid generating images, fonts, audio/video, archives, or other binary files when possible. Prefer CSS, SVG, emoji, public remote asset URLs, or existing dependency capabilities for visual effects to save tokens and write cost.',
    'Only create binary assets when the user explicitly requests them, the feature truly depends on them, and there is no lightweight alternative. In that case, use the sandbox commands tool inside the project directory to generate, download, or decode assets. Do not write them directly with file-writing tools.',
    'Do not hand-write lockfiles, node_modules, .next, dist, build, cache directories, or package-manager generated artifacts.',
    'When a command fails, read the error and identify the specific issue first. Fix only the specific file, dependency, or configuration. Do not regenerate the whole project, and do not repeat the same failed fix.',
    'When running verification commands such as npm run build, npx tsc, tsc -b, or python -m compileall, always append `; echo EXIT:$?`. The sandbox treats a non-zero exit as SANDBOX_UNKNOWN_ERROR and drops compiler output unless the overall shell exits 0. Read the EXIT:N line: N=0 means success; otherwise fix the reported files. Do not retry the same verification command with only `2>&1` added. Do not append this echo to npm install, long-running, background, or preview-server commands.',
    'Prefer the smallest complete change, preserving the existing project structure and style. Do not refactor anything unrelated to the user request.',
    'Next.js projects must use the standard App Router structure. Use next.config.js or next.config.mjs for configuration; do not generate next.config.ts.',
    "Next.js projects must support basePath: process.env.EDGEONE_PREVIEW_BASE_PATH || '' in next.config.js or next.config.mjs. Do not hard-code /preview into business routes.",
    `Vite projects must support sandbox preview under ${PREVIEW_PATH_PREFIX}: server.host='0.0.0.0'; server.port=${PREVIEW_SERVER_PORT}; server.strictPort=true; server.allowedHosts=true; server.hmr={ protocol:'wss', clientPort:443 }; legacy.skipWebSocketTokenCheck=true; do not set server.hmr.path. Do not hard-code base: '${PREVIEW_PATH_PREFIX}' (or any /preview prefix) in the project vite.config — the sandbox overlay injects that for live preview. Production and Makers publish must keep Vite base at '/'.`,
    'Vite React projects must install @vitejs/plugin-react and configure plugins: [react()] to preserve React Fast Refresh.',
    'Do not hard-code temporary sandbox preview domains in vite.config.',
    'If you generate a TypeScript project, ensure imports, types, and routing APIs can pass build or verification.',
    'Do not paste large code blocks in the reply. Write the prose in the reply language, and keep technical terms, error logs, and non-preview links unchanged.',
    'The final response is a short conclusion: at most two sentences, plain prose, naming what was built for this request and the preview/verification outcome. For "a pomodoro timer with stats and theme switching", the whole reply is: Built the pomodoro timer with stats and theme switching. The preview is ready in the right panel. Do not say only "Done, please check the result." either.',
    'Nothing may follow that conclusion. No headings or sections such as "What\'s included", no bullet or numbered lists, no feature-by-feature walkthrough, no file or dependency inventory, no tech-stack notes, no verification log recital, no usage instructions, and no suggested next steps. The user can see the running preview and the file tree, so re-describing the work is noise.',
    'Do not claim success for anything that was not verified successfully. If it failed, briefly explain the failure point and the next step.',
    `After code changes and dependency installation, you must call publish_preview to publish the getHost(${PREVIEW_PUBLIC_PORT})${PREVIEW_PATH_PREFIX} preview for the user. publish_preview handles startup and validation of the internal ${PREVIEW_SERVER_PORT} preview service. get_preview_link is only a legacy alias; do not prefer it.`,
    'Do not synthesize preview URLs or sandboxDebugUrl. Use only the fields returned by publish_preview or get_preview_link.',
    'Do not include preview buttons, preview links, preview URLs, or sandboxDebugUrl in the final response. The preview is shown only in the right preview panel.',
    'Do not take screenshots.',
    'Do not include emoji in the response.',
    isNewProject ? 'The project workspace may not have been prepared yet.' : 'This conversation has already prepared a project workspace.',
    recentHistory ? `Recent conversation:\n${recentHistory}` : '',
    `Current user request: ${userMessage}`,
    buildReplyLanguageReminder(languageAnchorMessage),
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
  // Fires after the scaffold succeeds (no argument) and after every
  // write_project_file (with the file just written, so the pipeline can stream
  // its content to the frontend instead of making it fetch the file back).
  onProjectFilesChanged?: (file?: { path: string; content: string }) => void | Promise<void>,
  // Fires as soon as publish_preview / get_preview_link resolves a public URL so
  // the UI can switch to the iframe without waiting for verification / finalize.
  onPreviewReady?: (preview: { url?: string; sandboxDebugUrl?: string }) => void,
  abortSignal?: AbortSignal,
  // Defaults to `userMessage`; internal prompts (auto-fix) pass the original
  // user request so the answer keeps that user's language.
  languageAnchorMessage: string = userMessage,
  // An object rather than another positional argument: the list above is long
  // enough that a new slot would be easy to fill in the wrong order.
  runOptions: { model?: string } = {},
): Promise<CodingAgentResult> {
  // Prefer AI Gateway for model access, with backward-compatible Anthropic / DeepSeek config.
  const apiKey = pickEnvValue(context, 'AI_GATEWAY_API_KEY')
    || pickEnvValue(context, 'ANTHROPIC_API_KEY')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  const authToken = pickEnvValue(context, 'ANTHROPIC_AUTH_TOKEN')
    || pickEnvValue(context, 'DEEPSEEK_API_KEY');
  // A model picked in the composer outranks the deployment default. The choice
  // was checked against this deployment's catalogue before it got here, so an
  // unrecognized ID arrives as '' and the configured model still runs.
  const model = (runOptions.model || '').trim() || resolveConfiguredModel(context);
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
    if (abortSignal?.aborted) {
      return {
        success: false,
        output: null,
        error: null,
        projectTouched: false,
        wasCreated: false,
        stopped: true,
      };
    }
    const mcpServerName = SANDBOX_MCP_SERVER_NAME;
    if (typeof context.tools?.toClaudeMcpServer !== 'function') {
      throw new Error('The current Pages Agent Runtime is missing context.tools.toClaudeMcpServer. Please upgrade to a runtime that supports the new pages-agent-toolkit Tools API.');
    }
    const edgeoneMcp = context.tools.toClaudeMcpServer(mcpServerName, { alwaysLoad: true });
    const sandboxTools = wrapSandboxToolsForVerification(
      edgeoneMcp.tools.filter((tool: { name: string }) =>
        !isBrowserSandboxToolName(tool.name) && !isGenericProjectWriteToolName(tool.name)),
    );
    const sandboxAllowedTools = edgeoneMcp.allowedTools.filter((toolName: string) =>
      !isBrowserSandboxToolName(toolName) && !isGenericProjectWriteToolName(toolName));
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
    const handlePreviewPublished = (preview: { url?: string; sandboxDebugUrl?: string }) => {
      previewTouched = true;
      if (preview.url) {
        onPreviewReady?.(preview);
      }
    };
    const previewLinkTool = buildPreviewLinkTool(
      context,
      state,
      handlePreviewPublished,
    );
    const publishPreviewTool = buildPublishPreviewTool(
      context,
      state,
      handlePreviewPublished,
    );
    const writeProjectFileTool = buildWriteProjectFileTool(
      context,
      state,
      async ({ written, content }) => {
        projectTouched = true;
        await onProjectFilesChanged?.({ path: written, content });
      },
    );
    const mcpTools = [
      ...sandboxTools,
      scaffoldTool,
      writeProjectFileTool,
      publishPreviewTool,
      previewLinkTool,
    ];
    const mcpAllowedTools = [
      ...sandboxAllowedTools,
      `mcp__${mcpServerName}__ensure_project_scaffold`,
      `mcp__${mcpServerName}__write_project_file`,
      `mcp__${mcpServerName}__publish_preview`,
      `mcp__${mcpServerName}__get_preview_link`,
    ];

    const sandboxMcpServer = createSdkMcpServer({
      name: mcpServerName,
      tools: mcpTools,
      alwaysLoad: true,
    });

    const sdkAbortController = new AbortController();
    const abortSdkQuery = () => sdkAbortController.abort();
    abortSignal?.addEventListener('abort', abortSdkQuery, { once: true });
    const sdkOptions: Parameters<typeof query>[0]['options'] = {
      model,
      permissionMode: 'dontAsk',
      maxTurns: 100,
      // Disable Claude Code built-in local tools so the model can only read,
      // write, and execute through EdgeOne sandbox MCP tools.
      tools: [],
      includePartialMessages: true,
      mcpServers: {
        [mcpServerName]: sandboxMcpServer,
      },
      allowedTools: mcpAllowedTools,
      strictMcpConfig: true,
      systemPrompt: buildPrompt(
        userMessage,
        history,
        state,
        isNewProject,
        mcpServerName,
        languageAnchorMessage,
      ),
      env: sdkEnv,
      // publish_preview starts the internal port 3000 service, verifies /preview/
      // readiness, and publishes the getHost(9000)/preview/ preview link.
      cwd: process.cwd(),
      settingSources: ['project'],
      debug: isDebugEnabled(context),
      abortController: sdkAbortController,
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
    const toolStartedAtById = new Map<string, number>();
    const pendingToolUseBlocks = new Map<number, StreamingToolUseBlock>();
    const emittedToolUseProgress = new Map<string, string>();
    let narrationState: NarrationEmitState = {
      currentTextBlock: '',
      emittedNarration: '',
    };
    const SCAFFOLD_TOOL_NAME = `mcp__${mcpServerName}__ensure_project_scaffold`;
    // Push file_tree immediately at most once per turn after scaffold, avoiding duplicate find calls.
    let scaffoldHandled = false;

    const emitNarration = (rawText: string, uuid: string, complete = false) => {
      const resolved = resolveNarrationEmit(narrationState, rawText, complete);
      narrationState = resolved.state;
      if (!resolved.text) {
        return;
      }
      onProgress?.({
        type: 'text_segment',
        data: {
          uuid,
          text: resolved.text,
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
      const inputSummary = summarizeToolInput(toolName, toolUse.input, state.appDir);
      const progressSignature = JSON.stringify({
        name: toolName,
        command,
        phaseHint: progress.phaseHint || '',
        fileCount: progress.fileCount || 0,
        inputSummary,
      });
      if (toolUseId) {
        const previousSignature = emittedToolUseProgress.get(toolUseId);
        if (previousSignature === progressSignature) {
          return;
        }
        emittedToolUseProgress.set(toolUseId, progressSignature);
      }
      // Tool calls end the current narration block. Clear the per-block window so
      // the next assistant text is not compared against the previous sentence.
      narrationState = {
        ...narrationState,
        currentTextBlock: '',
      };

      if (toolUseId && typeof toolUse.name === 'string') {
        toolContextById.set(toolUseId, {
          name: toolUse.name,
          ...(command ? { command } : {}),
        });
      }
      const startedAt = toolUseId
        ? toolStartedAtById.get(toolUseId) || Date.now()
        : Date.now();
      if (toolUseId) toolStartedAtById.set(toolUseId, startedAt);
      onProgress?.({
        type: 'tool_use',
        data: {
          id: toolUseId,
          name: toolName,
          ...(command ? { command } : {}),
          ...progress,
          inputSummary,
          startedAt,
        },
      });
    };

    for await (const event of sdkQuery as AsyncIterable<SDKMessage>) {
      if (abortSignal?.aborted) {
        sdkAbortController.abort();
        break;
      }
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
          // Each new text block starts a fresh dedupe window so earlier narration
          // cannot suppress later phrases that share a common suffix/substring.
          if (contentBlock?.type === 'text') {
            narrationState = {
              ...narrationState,
              currentTextBlock: '',
            };
          }
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
              extractVisibleTextBlock(b),
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
              const echoedExit = parseEchoedExitCode(text);
              const commandFailed = typeof echoedExit === 'number' && echoedExit !== 0;
              const toolFailed = b.is_error === true || commandFailed;
              onProgress?.({
                type: 'tool_result',
                data: {
                  tool_use_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
                  toolName,
                  ...(toolContext?.command ? { command: toolContext.command } : {}),
                  ok: !toolFailed,
                  preview: truncateForStream(text, 500),
                  outputSummary: summarizeToolOutput(text, state.appDir),
                  status: toolFailed ? 'failed' : 'completed',
                  endedAt: Date.now(),
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
                  await onProjectFilesChanged?.();
                } catch (err) {
                  console.warn('[scaffold-done] onProjectFilesChanged failed', err);
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

    abortSignal?.removeEventListener('abort', abortSdkQuery);

    if (abortSignal?.aborted || sdkAbortController.signal.aborted) {
      return {
        success: false,
        output: null,
        error: null,
        projectTouched,
        previewTouched,
        wasCreated,
        stopped: true,
      };
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
    if (abortSignal?.aborted || (e instanceof Error && e.name === 'AbortError')) {
      return {
        success: false,
        output: null,
        error: null,
        projectTouched: false,
        wasCreated: false,
        stopped: true,
      };
    }
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
