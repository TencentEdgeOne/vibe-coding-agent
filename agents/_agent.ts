import {
  buildReplyLanguageDirective,
  buildReplyLanguageReminder,
} from '../shared/reply-language.ts';
import {
  GATEWAY_CONVERSATION_ID_HEADER_NAME,
  GATEWAY_QUOTA_BYPASS_HEADER,
  GATEWAY_QUOTA_PROMPT_HEADER,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
  SANDBOX_MCP_SERVER_NAME,
} from './_constants.ts';
import { resolveConfiguredModel } from './_models.ts';
import {
  createMakersConfigPort,
  createSignalCancellationPort,
} from './core/adapters/_makers.ts';
import { resolveModelAccess } from './core/_model-access.ts';
import { classifyTool, extractCommandFromInput } from './core/_tool-kind.ts';
import type { DomainEvent, ToolKind } from './core/_events.ts';
import { createClaudeDriver } from './core/drivers/_claude.ts';
import { getFileTree } from './_project.ts';
import {
  buildExistingProjectGuidance,
  formatExistingFilePaths,
  resolveAgentSdkSession,
} from './_session.ts';
import { extractToolUseId, wrapSandboxToolsForVerification } from './tools/_commands-wrap.ts';
import { createCommandOutputBuffer } from './utils/_command-stream.ts';
import {
  buildPublishPreviewTool,
  buildWriteProjectFileTool,
} from './tools/_project-tools.ts';
import type {
  AgentProgressEvent,
  CodingAgentResult,
  ConversationMessage,
  PreviewRestartSignal,
  ProjectState,
} from './_types.ts';
import {
  detectFatalToolError,
  sanitizeAssistantText,
  truncateForStream,
} from './utils/_text.ts';
import { debugLog, isDebugEnabled } from './utils/_debug.ts';
import { summarizeToolInput, summarizeToolOutput } from './utils/_activity.ts';
import {
  resolveNarrationEmit,
  sanitizeNarrationText,
  type NarrationEmitState,
} from './utils/_narration.ts';
import {
  isInstallCommand,
  isPreviewCommand,
  isPreviewRestartConfigPath,
  parseEchoedExitCode,
  shortenToolName,
} from './utils/_tool-phase.ts';

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
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

type ToolProgressPhase = 'code' | 'install' | 'preview' | 'link';

// Progress phases are this UI's vocabulary, so they are derived from the core's
// ToolKind rather than classified a second time. Keeping one classifier means a
// new tool cannot be understood differently in two places.
const PHASE_BY_TOOL_KIND: Partial<Record<ToolKind, ToolProgressPhase>> = {
  'file.write': 'code',
  'file.remove': 'code',
  'dir.create': 'code',
  'dependency.install': 'install',
  'preview.publish': 'preview',
};

/**
 * The invariant half of the prompt, sent as `systemPrompt`.
 *
 * Everything here depends only on the project directory and the MCP server
 * name, both of which are fixed for the life of a conversation, so the string
 * is byte-identical on every turn and the provider can serve the prefix from
 * cache. Anything that varies per turn — the request itself, the reply
 * language, recent history, the new-project checklist — belongs in
 * `buildTurnPrompt`, because putting it here would change the very start of the
 * cached prefix and force a full prefill of a conversation that only grows.
 */
export function buildSystemPrompt(
  state: ProjectState,
  mcpServerName: string,
) {
  return [
    'You are a Web Dev Agent that creates and modifies runnable web projects in a remote sandbox.',
    'You may create Next.js, Vite/React, static frontend, Node service, Python Flask/FastAPI, or other lightweight web projects according to the user request. Do not force every project to be Next.js. For ordinary UI pages, prefer a modular Vite/React (or split HTML/CSS/JS) project instead of one self-contained HTML file.',
    `The only project directory you may modify is ${state.appDir} (relative path, no leading slash).`,
    `All file, command, browser, and code-execution operations must be performed through the ${mcpServerName} MCP tools in the remote sandbox.`,
    'If the user asks who you are, what you are, or what kind of agent you are, answer directly, in the reply language, that you are the Vibe Coding Agent sample on EdgeOne Makers, an out-of-the-box Agent template that helps create and modify runnable web projects. Do not call any tools, and do not use the non-project refusal for identity questions.',
    'First decide whether the user request is about a web project, page, component, interaction, styling, or code development.',
    'If the user request is not related to project development, reply with only this message, written in the reply language: I can only help create or modify web projects. Please describe the page or feature you want to build. Do not call any tools.',
    'If the user request requires creating or modifying a project, first respond with one brief natural-language sentence that you are starting, then begin writing files with write_project_file. Do not call files_list, files_make_dir, files_write, or commands before the first write_project_file.',
    'That first sentence must be concise, user-visible progress narration, not a plan, and written in the reply language. For an English request it reads like: I will start building now.',
    `Never pass absolute paths (starting with /). For write_project_file, path must be relative to ${state.appDir} itself — correct: package.json, src/App.tsx, index.html. Wrong: ${state.appDir}/package.json or /${state.appDir}/src/App.tsx. Prefer write_project_file, not raw files_write/files_list.`,
    'Do not use the cloud function local filesystem as the project workspace, and do not modify business files outside the project directory.',
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
    `After code changes and dependency installation, you must call publish_preview to publish the getHost(${PREVIEW_PUBLIC_PORT})${PREVIEW_PATH_PREFIX} preview for the user. publish_preview reuses a ready internal ${PREVIEW_SERVER_PORT} service when possible, otherwise starts and validates it.`,
    'Do not synthesize preview URLs. Use only the url field returned by publish_preview.',
    'Do not include preview buttons, preview links, or preview URLs in the final response. The preview is shown only in the right preview panel.',
    'Do not take screenshots.',
    'Do not include emoji in the response.',
    'If the user request is unclear, ask the user for the specific requirement.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The per-turn half of the prompt, sent as the query's `prompt`.
 *
 * Only what actually changes between turns lives here, so the cached system
 * prefix above stays intact.
 */
export function buildTurnPrompt(
  userMessage: string,
  history: ConversationMessage[],
  state: ProjectState,
  isNewProject: boolean,
  // Message whose language the reply must mirror. Differs from `userMessage` on
  // internal turns such as auto-fix, where the prompt is machine-written English
  // but the answer still belongs to whoever asked the original question.
  languageAnchorMessage: string = userMessage,
  contextOptions: {
    sessionResumed?: boolean;
    existingFiles?: string[];
  } = {},
) {
  const sessionResumed = contextOptions.sessionResumed === true;
  // A resumed session already carries these turns in its transcript, so
  // restating them here would only pay for the same tokens twice and grow the
  // per-turn prompt for the life of the conversation.
  const recentHistory = sessionResumed
    ? ''
    : history
      .slice(-8)
      .map((item) => `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.content}`)
      .join('\n');
  const existingProjectGuidance = buildExistingProjectGuidance({
    isNewProject,
    sessionResumed,
    existingFiles: contextOptions.existingFiles,
  });

  return [
    buildReplyLanguageDirective(languageAnchorMessage),
    existingProjectGuidance,
    isNewProject
      ? [
        `The workspace at ${state.appDir} is empty and already prepared. Complete these steps in order:`,
        '1. Choose a modular tech stack and a small multi-file layout. Prefer Vite + React/TS (or plain HTML split into index.html + css/ + js/modules) over a single giant HTML file. Do not put styles, scripts, and markup into one large index.html unless the user explicitly asks for a single-file page.',
        `2. Write the project incrementally with write_project_file. Each call must contain exactly one complete file: {"path":"src/App.tsx","content":"complete file contents"} — path relative to ${state.appDir}, never "${state.appDir}/src/App.tsx". Keep each file focused and reasonably small so the user sees steady progress. Typical order: package.json/config → styles → small components/modules → entry/App → thin index.html if needed. Call it once per file, in dependency order, and wait for each tool result before the next call. Never send multiple write_project_file calls in the same assistant message.`,
        `3. Install dependencies inside ${state.appDir} (cd ${state.appDir} && npm install by default for Node/frontend projects; pnpm/yarn only when explicitly requested; python -m pip install -r requirements.txt for Python). Do not invent nested ${state.appDir}/${state.appDir} paths.`,
        `4. Call the publish_preview tool. It starts the internal service on port ${PREVIEW_SERVER_PORT}, verifies that ${PREVIEW_PATH_PREFIX} is HTTP-ready, and generates the public preview with sandbox.getHost(${PREVIEW_PUBLIC_PORT}) + ${PREVIEW_PATH_PREFIX} + envdAccessToken. Do not hand-write background npm run dev commands.`,
      ].join('\n')
      : 'This conversation has already prepared a project workspace.',
    recentHistory ? `Recent conversation:\n${recentHistory}` : '',
    `Current user request: ${userMessage}`,
    buildReplyLanguageReminder(languageAnchorMessage),
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
  onProgress?: (event: AgentProgressEvent) => void,
  // Fires after an existing workspace is ready (no argument) and after every
  // write_project_file (with the file just written, so the pipeline can stream
  // its content to the frontend instead of making it fetch the file back).
  onProjectFilesChanged?: (file?: { path: string; content: string }) => void | Promise<void>,
  // Fires as soon as publish_preview resolves a public URL so
  // the UI can switch to the iframe without waiting for verification / finalize.
  onPreviewReady?: (preview: { url?: string }) => void,
  abortSignal?: AbortSignal,
  // Defaults to `userMessage`; internal prompts (auto-fix) pass the original
  // user request so the answer keeps that user's language.
  languageAnchorMessage: string = userMessage,
  // An object rather than another positional argument: the list above is long
  // enough that a new slot would be easy to fill in the wrong order.
  runOptions: {
    model?: string;
    resetSession?: boolean;
    onTiming?: (stage: string, startedAt: number, fields?: Record<string, string | number | boolean | undefined>) => void;
  } = {},
): Promise<CodingAgentResult> {
  // Credential, base URL, and model resolution now lives in the core, reachable
  // through a ConfigPort. The messages below stay here: they are host-facing
  // copy, and the core deliberately returns reason codes instead of prose.
  const accessResult = resolveModelAccess(createMakersConfigPort(context), {
    conversationId,
    requestedModel: runOptions.model,
    defaultModel: resolveConfiguredModel(context),
    extraHeaders: [GATEWAY_QUOTA_BYPASS_HEADER, GATEWAY_QUOTA_PROMPT_HEADER],
    conversationIdHeaderName: GATEWAY_CONVERSATION_ID_HEADER_NAME,
  });

  if (!accessResult.ok) {
    return {
      success: false,
      output: null,
      error: accessResult.reason === 'missing_credentials'
        ? 'Missing AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / DEEPSEEK_API_KEY. The agent cannot call the model.'
        : 'Missing AI_GATEWAY_BASE_URL / ANTHROPIC_BASE_URL / DEEPSEEK_BASE_URL. The agent cannot call the model.',
      projectTouched: false,
      wasCreated: false,
    };
  }

  const { model } = accessResult.access;
  // @anthropic-ai/sdk injects ANTHROPIC_CUSTOM_HEADERS into each model request.
  const sdkEnv: Record<string, string> = accessResult.access.env ?? {};
  const executablePath = pickEnvValue(context, 'CLAUDE_CODE_EXECUTABLE_PATH');
  // Declared out here so the finally block can unsubscribe: the tools context
  // outlives this turn, and a leaked handler would emit into a stale stream.
  let stopCommandOutput: (() => void) | undefined;
  // Declared out here so the catch block can reach it; see the assignment below.
  let sessionRecovery: {
    resumed: boolean;
    sawEvent: boolean;
    forget: () => Promise<void>;
  } | undefined;
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
    const setupStartedAt = Date.now();
    const edgeoneMcp = context.tools.toClaudeMcpServer(mcpServerName, { alwaysLoad: true });
    const previewRestart: PreviewRestartSignal = { mustRestart: false };
    const commandOutputById = new Map<string, ReturnType<typeof createCommandOutputBuffer>>();
    let latestCommandToolUseId = '';
    // `latestCommandToolUseId` is set the moment a commands tool is announced,
    // so it already is the most recent one; output that arrives before any
    // announcement falls back to the shared buffer key below.
    const resolveCommandToolUseId = (preferred = '') => preferred || latestCommandToolUseId;
    const emitCommandOutput = (toolUseId: string, chunk: string) => {
      if (!chunk) return;
      const id = resolveCommandToolUseId(toolUseId);
      const bufferKey = id || '__latest_command__';
      let buffer = commandOutputById.get(bufferKey);
      if (!buffer) {
        buffer = createCommandOutputBuffer({
          emit: (accumulated) => {
            onProgress?.({
              type: 'tool_output',
              data: {
                tool_use_id: id,
                outputSummary: summarizeToolOutput(accumulated, state.appDir),
              },
            });
          },
        });
        commandOutputById.set(bufferKey, buffer);
      }
      buffer.push(chunk);
    };
    // The runtime builds context.tools before this template runs, so live
    // command output has to be subscribed to on the existing context.
    if (typeof context.tools?.setCommandOutputHandler === 'function') {
      stopCommandOutput = context.tools.setCommandOutputHandler(
        (chunk: { data?: string; toolUseId?: string }) => {
          emitCommandOutput(chunk.toolUseId || latestCommandToolUseId, chunk.data || '');
        },
      );
    }
    const sandboxTools = wrapSandboxToolsForVerification(
      edgeoneMcp.tools.filter((tool: { name: string }) =>
        !isBrowserSandboxToolName(tool.name) && !isGenericProjectWriteToolName(tool.name)),
      {
        onCommand: (command, meta) => {
          if (meta?.toolUseId) {
            latestCommandToolUseId = meta.toolUseId;
          } else {
            const resolved = resolveCommandToolUseId();
            if (resolved) latestCommandToolUseId = resolved;
          }
          if (isInstallCommand(command)) {
            previewRestart.mustRestart = true;
          }
        },
      },
    );
    const sandboxAllowedTools = edgeoneMcp.allowedTools.filter((toolName: string) =>
      !isBrowserSandboxToolName(toolName) && !isGenericProjectWriteToolName(toolName));
    let projectTouched = false;
    let previewTouched = false;
    const handlePreviewPublished = (preview: { url?: string }) => {
      previewTouched = true;
      if (preview.url) {
        onPreviewReady?.(preview);
      }
    };
    const publishPreviewTool = buildPublishPreviewTool(
      context,
      state,
      handlePreviewPublished,
      previewRestart,
    );
    const writeProjectFileTool = buildWriteProjectFileTool(
      context,
      state,
      async ({ written, content }) => {
        if (isPreviewRestartConfigPath(written)) {
          previewRestart.mustRestart = true;
        }
        projectTouched = true;
        await onProjectFilesChanged?.({ path: written, content });
      },
    );
    const mcpTools = [
      ...sandboxTools,
      writeProjectFileTool,
      publishPreviewTool,
    ];
    const mcpAllowedTools = [
      ...sandboxAllowedTools,
      `mcp__${mcpServerName}__write_project_file`,
      `mcp__${mcpServerName}__publish_preview`,
    ];

    const sessionStartedAt = Date.now();
    const sdkSession = await resolveAgentSdkSession(context, conversationId, {
      reset: runOptions.resetSession === true,
    });
    runOptions.onTiming?.('session_resolve', sessionStartedAt, {
      resumed: sdkSession.sessionResumed,
    });
    // Resume materialization happens in the SDK parent before the subprocess
    // spawns, so a transcript the store can no longer serve fails before the
    // first event. Recorded here so the catch below can drop the stale id and
    // let the next turn start clean instead of failing the same way forever.
    sessionRecovery = {
      resumed: sdkSession.sessionResumed,
      sawEvent: false,
      forget: sdkSession.forgetSession,
    };
    let existingFiles: string[] = [];
    if (!isNewProject) {
      try {
        await onProjectFilesChanged?.();
      } catch (err) {
        console.warn('[workspace-ready] onProjectFilesChanged failed', err);
      }
    }
    if (!sdkSession.sessionResumed && !isNewProject) {
      try {
        existingFiles = formatExistingFilePaths(await getFileTree(context, state));
      } catch {
        existingFiles = [];
      }
    }
    // The agent loop itself lives behind a driver, so this function no longer
    // knows which SDK runs it — only how to describe a turn and how to project
    // the resulting domain events onto this host's progress stream.
    const driver = createClaudeDriver({
      helpers: {
        sanitizeText: sanitizeNarrationText,
        resolveNarration: resolveNarrationEmit,
        classifyTool: (name, input) =>
          classifyTool(name, input, { isInstallCommand, isPreviewCommand }),
        extractCommand: (name, input) =>
          (shortenToolName(name) === 'commands' ? extractCommandFromInput(input) : ''),
        parseEchoedExitCode,
        detectFatalError: detectFatalToolError,
      },
    });

    const turn = driver.runTurn({
      runId: conversationId,
      systemPrompt: buildSystemPrompt(state, mcpServerName),
      prompt: buildTurnPrompt(
        userMessage,
        history,
        state,
        isNewProject,
        languageAnchorMessage,
        {
          sessionResumed: sdkSession.sessionResumed,
          existingFiles,
        },
      ),
      model,
      tools: mcpTools,
      allowedTools: mcpAllowedTools,
      toolNamespace: mcpServerName,
      session: {
        ...sdkSession.binding,
        ...(sdkSession.sessionStore ? { store: sdkSession.sessionStore } : {}),
      },
      env: sdkEnv,
      // publish_preview reuses or starts the internal port 3000 service, then
      // publishes the getHost(9000)/preview/ preview link.
      cwd: process.cwd(),
      debug: isDebugEnabled(context),
      ...(executablePath ? { executablePath } : {}),
      onStderr: (data: string) => {
        debugLog(context, '[claude-code stderr]', data.trimEnd());
      },
      cancellation: createSignalCancellationPort(abortSignal),
    });

    runOptions.onTiming?.('agent_setup', setupStartedAt, {
      resumed: sdkSession.sessionResumed,
      existing_files: existingFiles.length,
    });
    const firstEventStartedAt = Date.now();
    let firstSdkEventLogged = false;

    // A tool result names only the id it belongs to, so the invocation's name
    // and command are remembered here for the progress event that reports it.
    const toolContextById = new Map<string, { name: string; command?: string }>();

    const emitDomainEvent = (event: DomainEvent) => {
      if (event.type === 'assistant.text') {
        onProgress?.({
          type: 'text_segment',
          data: { uuid: event.blockId, text: event.text },
        });
        return;
      }

      if (event.type === 'tool.invoked') {
        // The translator already classified the tool, so the phase is read from
        // that rather than classifying a second time.
        const phaseHint = PHASE_BY_TOOL_KIND[event.kind];
        const fileCount = shortenToolName(event.name) === 'write_project_file' ? 1 : undefined;
        if (event.toolUseId) {
          toolContextById.set(event.toolUseId, {
            name: event.name,
            ...(event.command ? { command: event.command } : {}),
          });
          if (shortenToolName(event.name) === 'commands') {
            latestCommandToolUseId = event.toolUseId;
          }
        }
        onProgress?.({
          type: 'tool_use',
          data: {
            id: event.toolUseId,
            name: event.name,
            ...(event.command ? { command: event.command } : {}),
            ...(phaseHint ? { phaseHint } : {}),
            ...(fileCount ? { fileCount } : {}),
            inputSummary: summarizeToolInput(event.name, event.raw, state.appDir),
            startedAt: event.at,
          },
        });
        return;
      }

      if (event.type === 'tool.settled') {
        const known = toolContextById.get(event.toolUseId);
        const output = event.output || '';
        commandOutputById.get(event.toolUseId)?.flush();
        onProgress?.({
          type: 'tool_result',
          data: {
            tool_use_id: event.toolUseId,
            toolName: known?.name || '<unknown>',
            ...(known?.command ? { command: known.command } : {}),
            ok: event.ok,
            preview: truncateForStream(output, 500),
            outputSummary: summarizeToolOutput(output, state.appDir),
            status: event.ok ? 'completed' : 'failed',
            endedAt: event.at,
          },
        });
      }
    };

    for await (const domainEvent of turn.events) {
      if (!firstSdkEventLogged) {
        firstSdkEventLogged = true;
        if (sessionRecovery) sessionRecovery.sawEvent = true;
        runOptions.onTiming?.('agent_first_event', firstEventStartedAt, {
          type: domainEvent.type,
        });
        // The session is open now, so the id is safe to hand to the next turn.
        void sdkSession.markSessionStarted().catch((error) => {
          console.warn('[session] failed to persist the sdk session id', error);
        });
      }
      emitDomainEvent(domainEvent);
    }

    const turnResult = turn.result();

    if (turnResult.outcome === 'stopped') {
      return {
        success: false,
        output: null,
        error: null,
        projectTouched,
        previewTouched,
        wasCreated: isNewProject && projectTouched,
        stopped: true,
      };
    }

    if (turnResult.outcome === 'failed') {
      if (turnResult.fatal) {
        console.warn('[fatal] aborting agent loop:', turnResult.error);
      }
      return {
        success: false,
        output: null,
        error: turnResult.error || 'Model execution failed.',
        projectTouched,
        previewTouched,
        wasCreated: isNewProject && projectTouched,
        ...(turnResult.fatal ? { fatal: true } : {}),
      };
    }

    return {
      success: true,
      output: sanitizeAssistantText(turnResult.summary),
      error: null,
      projectTouched,
      previewTouched,
      wasCreated: isNewProject && projectTouched,
    };
  } catch(e) {
    // Failing before the first event on a resumed session means the transcript
    // could not be materialized. Forget the id so the next turn starts fresh
    // rather than repeating the same failure for the rest of the conversation.
    if (sessionRecovery?.resumed && !sessionRecovery.sawEvent) {
      await sessionRecovery.forget().catch((error) => {
        console.warn('[session] failed to clear the unusable sdk session id', error);
      });
    }
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
    stopCommandOutput?.();
    // sdkQuery.close();
  }
}
