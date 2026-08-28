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
  MAKERS_SKILL_NAMES,
  SANDBOX_MCP_SERVER_NAME,
} from './_constants';
import { wrapSandboxTools } from './tools/_commands-wrap';
import {
  buildProjectScaffoldTool,
  buildWriteProjectFileTool,
} from './tools/_project-tools';
import { buildLoadMakersSkillTool } from './tools/_makers-skills';
import { buildPrompt } from './_prompt';
import { resolveMakersProjectName } from './project/_makers-deploy';
import type {
  AgentProgressEvent,
  CodingAgentResult,
  ConversationMessage,
  DeploymentInfo,
  PreviewKind,
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
import {
  isInstallCommand,
  isMakersDeployCommand,
  isPreviewCommand,
  parseEchoedExitCode,
  shortenToolName,
} from './utils/_tool-phase';

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
    if (isPreviewCommand(cmd) || isMakersDeployCommand(cmd)) {
      return { phaseHint: 'preview' };
    }
  }
  return {};
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
  // Fires as soon as a direct Makers CLI command resolves a public URL so the
  // UI can switch to the iframe without waiting for verification / finalize.
  onPreviewReady?: (preview: { url?: string; sandboxDebugUrl?: string; kind?: PreviewKind }) => void,
  // Deploy is durable product state, not an iframe preview. Stream each state
  // transition independently so the UI can show running/success/failure.
  onDeploymentStatus?: (deployment: DeploymentInfo) => void,
  abortSignal?: AbortSignal,
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
    const makersProjectName = resolveMakersProjectName(context, state);
    if (typeof context.tools?.toClaudeMcpServer !== 'function') {
      throw new Error('The current Pages Agent Runtime is missing context.tools.toClaudeMcpServer. Please upgrade to a runtime that supports the new pages-agent-toolkit Tools API.');
    }
    const edgeoneMcp = context.tools.toClaudeMcpServer(mcpServerName, { alwaysLoad: true });
    let projectTouched = false;
    let previewTouched = false;
    let deploymentTouched = false;
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
    const handlePreviewPublished = (preview: { url?: string; sandboxDebugUrl?: string; kind?: PreviewKind }) => {
      previewTouched = true;
      if (preview.url) {
        onPreviewReady?.(preview);
      }
    };
    const handleDeploymentStatus = (deployment: DeploymentInfo) => {
      deploymentTouched = true;
      onDeploymentStatus?.(deployment);
    };
    const sandboxTools = wrapSandboxTools(
      edgeoneMcp.tools.filter((tool: { name: string }) =>
        !isBrowserSandboxToolName(tool.name) && !isGenericProjectWriteToolName(tool.name)),
      {
        context,
        state,
        onPreviewReady: handlePreviewPublished,
        onDeploymentStatus: handleDeploymentStatus,
      },
    );
    const sandboxAllowedTools = edgeoneMcp.allowedTools.filter((toolName: string) =>
      !isBrowserSandboxToolName(toolName) && !isGenericProjectWriteToolName(toolName));
    const writeProjectFileTool = buildWriteProjectFileTool(
      context,
      state,
      async ({ written, content }) => {
        projectTouched = true;
        await onProjectFilesChanged?.({ path: written, content });
      },
    );
    const loadMakersSkillTool = buildLoadMakersSkillTool();
    const mcpTools = [
      ...sandboxTools,
      scaffoldTool,
      loadMakersSkillTool,
      writeProjectFileTool,
    ];
    const mcpAllowedTools = [
      ...sandboxAllowedTools,
      `mcp__${mcpServerName}__ensure_project_scaffold`,
      `mcp__${mcpServerName}__load_makers_skill`,
      `mcp__${mcpServerName}__write_project_file`,
      'Skill',
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
      // Built-in local Read/Write/Bash stay off. Skill is enabled so the model
      // can load official Makers skills from .claude/skills/ on demand.
      tools: ['Skill'],
      skills: [...MAKERS_SKILL_NAMES],
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
        makersProjectName,
      ),
      env: sdkEnv,
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
                  outputSummary: summarizeToolOutput(text, state.appDir, toolName),
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
        deploymentTouched,
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
        deploymentTouched,
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
        deploymentTouched,
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
        deploymentTouched,
        wasCreated,
      };
    }

    return {
      success: true,
      output: sanitizeAssistantText((resultMessage.result || '').trim()),
      error: null,
      projectTouched,
      previewTouched,
      deploymentTouched,
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
