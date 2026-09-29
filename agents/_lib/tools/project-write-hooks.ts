import type { HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import { markCreated } from '../project/workspace-store.ts';
import {
  buildNpmWarmupCommand,
  resolveSandboxNpmEnv,
} from '../makers/npm-install.ts';
import {
  ensureMakersAgentDeclarations,
  ensureMakersFrameworkAdapter,
} from '../makers/declarations.ts';
import {
  askUserForGatewayCredentials,
  writeSuggestsAiGatewayProject,
  type GatewayPromptOptions,
} from '../project/gateway.ts';
import type { ProjectState, StreamSend } from '../types.ts';
import { shortenToolName } from '../makers/tool-phase.ts';
import { getBlockedProjectWriteReason, toAppRelPath } from '../utils/paths.ts';
import { stringifyToolResult } from '../utils/text.ts';

const PROJECT_WRITE_TOOLS = new Set(['files_write', 'write_files']);

const ADAPTER_NOTE = 'Platform declarations written for you, including the platform adapter this framework cannot build without — it is in dependencies and the install already has it. Wiring it into the framework config is still yours to do; makers-frameworks says where it goes. Edit a value that is wrong; do not write these files again from scratch.';

const DECLARATION_NOTE = 'Platform declarations an agents/ project requires, written for you. Edit a value that is wrong; do not write these files again from scratch.';

export type ProjectWriteHost = {
  context: AgentContext;
  state: ProjectState;
  conversationId?: string;
  send?: StreamSend;
  onWritten?: (file: { path: string; content: string }) => void | Promise<void>;
};

export function isProjectWriteToolName(name: string) {
  return PROJECT_WRITE_TOOLS.has(shortenToolName(name));
}

type WriteFields = {
  record: Record<string, unknown>;
  pathKey: 'path' | 'file_path';
  contentKey: 'content' | 'contents';
  path?: string;
  content?: string;
};

function writeFields(input: unknown): WriteFields | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const pathKey = typeof record.file_path === 'string' && typeof record.path !== 'string'
    ? 'file_path'
    : 'path';
  const contentKey = typeof record.contents === 'string' && typeof record.content !== 'string'
    ? 'contents'
    : 'content';
  const path = record[pathKey];
  const content = record[contentKey];
  return {
    record,
    pathKey,
    contentKey,
    path: typeof path === 'string' ? path : undefined,
    content: typeof content === 'string' ? content : undefined,
  };
}

function deny(reason: string): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function toolResultFailed(response: unknown) {
  if (!response || typeof response !== 'object') return false;
  const record = response as { isError?: unknown; is_error?: unknown };
  return record.isError === true || record.is_error === true;
}

/**
 * Before the sandbox write tool runs: keep the file inside the project, reject
 * paths the host does not allow, and create the parent directory. The sandbox
 * tool still performs the write.
 */
export async function guardProjectWrite(
  host: ProjectWriteHost,
  call: { toolName: string; toolInput: unknown },
): Promise<SyncHookJSONOutput> {
  if (!isProjectWriteToolName(call.toolName)) return {};

  const fields = writeFields(call.toolInput);
  if (!fields?.path || fields.content === undefined) {
    return deny('Call files_write with {"path":"src/App.tsx","content":"complete file contents"}.');
  }

  const relPath = toAppRelPath(fields.path, host.state.appDir);
  if (!relPath) {
    return deny(
      `Invalid file path: ${fields.path}. Use a path relative to ${host.state.appDir} (example: src/App.tsx), not ${host.state.appDir}/src/App.tsx.`,
    );
  }
  const blockedReason = getBlockedProjectWriteReason(relPath);
  if (blockedReason) {
    return deny(`Refusing to write ${relPath}: ${blockedReason}`);
  }

  const parent = relPath.split('/').slice(0, -1).join('/');
  if (parent) {
    try {
      await requireSandbox(host.context).files.makeDir(`${host.state.appDir}/${parent}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return deny(message);
    }
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {
        ...fields.record,
        [fields.pathKey]: `${host.state.appDir}/${relPath}`,
        [fields.contentKey]: fields.content,
      },
    },
  };
}

/**
 * After a sandbox write succeeds: tell the workspace, fill in platform
 * declarations, warm the install, and ask for a gateway key when the project
 * needs one. None of this is part of the write tool itself.
 */
export async function finishProjectWrite(
  host: ProjectWriteHost,
  call: { toolName: string; toolInput: unknown; toolResponse?: unknown },
): Promise<SyncHookJSONOutput> {
  if (!isProjectWriteToolName(call.toolName) || toolResultFailed(call.toolResponse)) return {};

  const fields = writeFields(call.toolInput);
  if (!fields?.path || fields.content === undefined) return {};
  const relPath = toAppRelPath(fields.path, host.state.appDir);
  if (!relPath || getBlockedProjectWriteReason(relPath)) return {};

  markCreated(host.state);
  await host.onWritten?.({ path: relPath, content: fields.content });

  let adapterAdded = false;
  const declared = relPath.startsWith('agents/')
    ? await ensureMakersAgentDeclarations(host.context, host.state).catch(() => [])
    : [];
  if (relPath === 'package.json') {
    const adapter = await ensureMakersFrameworkAdapter(host.context, host.state, fields.content)
      .catch(() => undefined);
    if (adapter) {
      declared.push(adapter);
      adapterAdded = true;
    }
    await requireSandbox(host.context).commands
      .run(buildNpmWarmupCommand(), {
        cwd: host.state.appDir,
        env: resolveSandboxNpmEnv(host.state.siteDomain),
      })
      .catch(() => undefined);
  }
  for (const declaration of declared) {
    await host.onWritten?.({ path: declaration.path, content: declaration.content });
  }
  if (
    writeSuggestsAiGatewayProject(relPath, fields.content)
    || declared.some((declaration) => writeSuggestsAiGatewayProject(declaration.path, declaration.content))
  ) {
    const gateway: GatewayPromptOptions = {
      conversationId: host.conversationId,
      send: host.send,
    };
    await askUserForGatewayCredentials(host.context, host.state, gateway).catch(() => undefined);
  }

  if (declared.length === 0) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: stringifyToolResult({
        alsoWritten: declared.map((declaration) => declaration.path),
        note: adapterAdded ? ADAPTER_NOTE : DECLARATION_NOTE,
      }),
    },
  };
}

export function projectWriteHooks(host: ProjectWriteHost) {
  return {
    PreToolUse: [{
      hooks: [async (input: HookInput) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        return guardProjectWrite(host, {
          toolName: input.tool_name,
          toolInput: input.tool_input,
        });
      }],
    }],
    PostToolUse: [{
      hooks: [async (input: HookInput) => {
        if (input.hook_event_name !== 'PostToolUse') return {};
        return finishProjectWrite(host, {
          toolName: input.tool_name,
          toolInput: input.tool_input,
          toolResponse: input.tool_response,
        });
      }],
    }],
  };
}
