import { runCodingAgent } from '../_agent';
import { AUTO_FIX_MAX_ATTEMPTS } from '../_constants';
import {
  appendTurn,
  clearProjectSnapshot,
  getHistory,
  getProjectSnapshot,
  getProjectState,
  saveProjectState,
  saveActivityTurn,
} from '../_memory';
import {
  createProjectState,
  getFileTree,
  resetProjectWorkspace,
  restoreProjectArchive,
  runVerification,
} from '../_project';
import type {
  AgentProgressEvent,
  BuildStatus,
  FileTreeItem,
  PersistedActivity,
  ScaffoldLog,
  StreamSend,
} from '../_types';
import { buildAutoFixPrompt } from '../utils/_build-errors';
import { toAppRelPath } from '../utils/_paths';
import { sanitizeAssistantText } from '../utils/_text';
import { resolveConversationId } from '../utils/_request';
import {
  FILE_PUSH_MAX_BYTES,
  FILE_PUSH_TURN_BUDGET_BYTES,
  buildRequirementConclusionFallback,
  createProjectCheckpointController,
  extendExistingSandboxTimeout,
  isGenericCompletionReply,
  stripReturnedPreviewLinks,
  utf8ByteLength,
} from './_helpers';

export async function runChatPipeline(
  context: any,
  message: string,
  send: StreamSend,
  options: { resetProject?: boolean; turnId?: string; userMessagePersisted?: boolean } = {},
) {
  const { conversationId } = resolveConversationId(context);
  const abortSignal = context?.request?.signal as AbortSignal | undefined;

  if (!message) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: conversationId,
        reply: 'Please describe the page or feature you want to build first.',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  if (!conversationId) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: '',
        reply: 'Missing conversationId. The project workspace cannot be prepared.',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  await extendExistingSandboxTimeout(context);

  send({
    type: 'status',
    message: 'Running the agent workflow',
  });

  const shouldResetProject = options.resetProject === true;
  const state = shouldResetProject
    ? createProjectState(conversationId)
    : await getProjectState(context, conversationId);
  if (shouldResetProject) {
    await resetProjectWorkspace(context, state);
    // Starting over: drop any stale snapshot so a later empty-appDir turn cannot
    // restore the previous project. (The frontend also rotates conversationId on a
    // fresh start, so this is belt-and-suspenders.)
    await clearProjectSnapshot(context, conversationId);
  } else {
    // Code persistence (防丢失): the sandbox /tmp is volatile, so the generated
    // project may be gone between requests. Restore from snapshot when the appDir
    // is missing OR empty, then always ensure the session directories exist so an
    // early agent files_list cannot hit "lstat /projects: no such file".
    try {
      let hasProjectFiles = false;
      try {
        if (await context.sandbox.files.exists(state.appDir)) {
          const tree = await getFileTree(context, state);
          hasProjectFiles = tree.some((item) => item.type === 'file');
        }
      } catch {
        hasProjectFiles = false;
      }

      if (!hasProjectFiles) {
        const snapshot = await getProjectSnapshot(context, conversationId);
        if (snapshot) {
          send({ type: 'status', message: 'Restoring project from snapshot' });
          const restored = await restoreProjectArchive(context, state, snapshot);
          if (!restored.ok) {
            send({
              type: 'log',
              phase: 'scaffold',
              stream: 'stderr',
              message: restored.error || 'Failed to restore the project from snapshot.',
            });
          } else {
            hasProjectFiles = true;
          }
        }
      }

      await context.sandbox.files.makeDir(state.sessionDir);
      await context.sandbox.files.makeDir(state.appDir);
      if (hasProjectFiles) {
        state.created = true;
      }
    } catch (error) {
      // Restore is best-effort: if it fails, fall through and let the agent
      // scaffold/regenerate as usual rather than aborting the turn.
      send({
        type: 'log',
        phase: 'scaffold',
        stream: 'stderr',
        message: error instanceof Error ? error.message : 'Snapshot restore check failed.',
      });
      try {
        await context.sandbox.files.makeDir(state.sessionDir);
        await context.sandbox.files.makeDir(state.appDir);
      } catch {
        // Scaffold tool will surface a clearer error if dirs still cannot be created.
      }
    }
  }
  const history = shouldResetProject
    ? []
    : await getHistory(context, conversationId, {
      excludeLatestUserMessage: options.userMessagePersisted ? message : undefined,
    });
  const isInitialProjectTurn = !state.created;
  const hiddenScaffoldToolUseIds = new Set<string>();
  const activityTurnId = options.turnId
    || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const activities: PersistedActivity[] = [];

  // Mid-turn debounced snapshots + exit-path flush so a recycled sandbox still
  // has a restorable projectSnapshot in the store.
  const checkpoint = createProjectCheckpointController(context, conversationId, state);

  const recordProgress = (event: AgentProgressEvent) => {
    if (event.type === 'text_segment') {
      const text = event.data.text;
      if (!text) return;
      const last = activities.at(-1);
      if (last?.kind === 'text') {
        if (last.content.endsWith(text) || last.content.endsWith(text.trim())) {
          return;
        }
        activities[activities.length - 1] = {
          ...last,
          content: `${last.content}${text}`,
        };
      } else {
        activities.push({ kind: 'text', content: text });
      }
      return;
    }

    if (event.type === 'tool_use') {
      const existing = activities.find(
        (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
          item.kind === 'tool' && item.toolUseId === event.data.id,
      );
      if (existing) {
        existing.name = event.data.name || existing.name;
        existing.inputSummary = event.data.inputSummary || existing.inputSummary;
        return;
      }
      activities.push({
        kind: 'tool',
        toolUseId: event.data.id,
        name: event.data.name,
        status: 'running',
        inputSummary: event.data.inputSummary,
        startedAt: event.data.startedAt || Date.now(),
      });
      return;
    }

    const existing = activities.find(
      (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
        item.kind === 'tool' && item.toolUseId === event.data.tool_use_id,
    );
    if (existing) {
      existing.status = event.data.status || (event.data.ok ? 'completed' : 'failed');
      existing.outputSummary = event.data.outputSummary || event.data.preview;
      existing.endedAt = event.data.endedAt || Date.now();
    }
  };

  const persistConversationTurn = async (
    assistant: string,
    status: 'completed' | 'failed' | 'stopped',
  ) => {
    if (status === 'stopped') {
      for (const activity of activities) {
        if (activity.kind === 'tool' && activity.status === 'running') {
          activity.status = 'stopped';
          activity.endedAt = Date.now();
        }
      }
    }
    if (!options.userMessagePersisted) {
      await appendTurn(context, conversationId, 'user', message);
    }
    await appendTurn(context, conversationId, 'assistant', assistant);
    await saveActivityTurn(context, conversationId, {
      id: activityTurnId,
      user: message,
      assistant,
      status,
      createdAt: Date.now(),
      activities,
    });
  };

  // Exit-path order: code snapshot first, then projectState, then conversation.
  // Survives a crash between steps better than conversation-without-code.
  const finalizeTurn = async (
    assistant: string,
    status: 'completed' | 'failed' | 'stopped',
    finalizeOptions?: { withSnapshot?: boolean; withState?: boolean },
  ) => {
    const withSnapshot = finalizeOptions?.withSnapshot === true;
    const withState = finalizeOptions?.withState !== false;
    if (withSnapshot) {
      await checkpoint.flush();
    }
    if (withState) {
      await saveProjectState(context, conversationId, state);
    }
    await persistConversationTurn(assistant, status);
  };

  const handleScaffoldLog = (log: ScaffoldLog) => {
    if (!isInitialProjectTurn) {
      return;
    }
    send({
      type: 'log',
      phase: 'scaffold',
      stream: log.stream,
      message: log.content,
    });
  };
  const forwardProgress = (event: AgentProgressEvent) => {
    // Forward structured progress events directly; the frontend renders by type.
    if (
      !isInitialProjectTurn
      && event.type === 'tool_use'
      && (event.data.name === 'ensure_project_scaffold' || event.data.name.endsWith('__ensure_project_scaffold'))
    ) {
      hiddenScaffoldToolUseIds.add(event.data.id);
      return;
    }
    if (!isInitialProjectTurn && event.type === 'tool_result' && hiddenScaffoldToolUseIds.has(event.data.tool_use_id)) {
      return;
    }
    if (event.type === 'text_segment') {
      const text = state.previewUrl
        ? stripReturnedPreviewLinks(event.data.text, state.previewUrl)
        : event.data.text;
      if (text.length === 0) {
        return;
      }
      recordProgress({ ...event, data: { ...event.data, text } });
      send({
        ...event,
        data: {
          ...event.data,
          text,
        },
      } as unknown as Record<string, unknown>);
      return;
    }
    recordProgress(event);
    send(event as unknown as Record<string, unknown>);
  };
  const pushFileTree = async (fallbackMessage: string): Promise<FileTreeItem[]> => {
    try {
      const tree = await getFileTree(context, state);
      send({
        type: 'file_tree',
        data: {
          root: state.appDir,
          items: tree,
        },
      });
      return tree;
    } catch (error) {
      send({
        type: 'log',
        phase: 'agent',
        stream: 'stderr',
        message: error instanceof Error ? error.message : fallbackMessage,
      });
      return [];
    }
  };
  // The model already handed us the full text of every file it wrote, so stream it
  // to the frontend instead of making it fetch the file back over /file (which costs
  // a sandbox shell round trip per click). Bounded per file and per turn so a large
  // asset cannot bloat the stream or the in-process replay buffer — anything over
  // budget simply falls back to /file.
  let filePushBudgetBytes = FILE_PUSH_TURN_BUDGET_BYTES;
  const handleProjectFilesChanged = async (file?: { path: string; content: string }) => {
    if (file) {
      const bytes = utf8ByteLength(file.content);
      if (bytes <= FILE_PUSH_MAX_BYTES && bytes <= filePushBudgetBytes) {
        filePushBudgetBytes -= bytes;
        send({
          type: 'file_content',
          data: {
            path: toAppRelPath(file.path, state.appDir) || file.path,
            content: file.content,
            size: bytes,
          },
        });
      }
    }
    // Push the tree right after the content so its mtime stamps what was just
    // sent, and so the Files panel does not wait for the whole turn. Failures are
    // non-fatal because the final state is pushed again at turn completion.
    await pushFileTree('Failed to read the file list after scaffold.');
    // Debounced store backup while the agent is still writing — covers the long
    // window where files live only in the volatile sandbox.
    checkpoint.schedule();
  };

  // Switch the iframe the moment publish_preview returns — do not wait for
  // verification / finalizeTurn, which can take several more seconds.
  const handlePreviewReady = (preview: { url?: string; sandboxDebugUrl?: string }) => {
    if (!preview.url) {
      return;
    }
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: preview.url,
          sandboxDebugUrl: preview.sandboxDebugUrl,
        },
        download: { url: '/download', filename: 'source.zip' },
      },
    });
  };

  // The model handles creative code work; build and service steps remain deterministic.
  const modelResult = await runCodingAgent(
    context,
    conversationId,
    message,
    history,
    state,
    !state.created,
    handleScaffoldLog,
    forwardProgress,
    handleProjectFilesChanged,
    handlePreviewReady,
    abortSignal,
  );

  if (modelResult.stopped || abortSignal?.aborted) {
    const stoppedReply = /[\u3400-\u9fff]/.test(message)
      ? '已停止本次生成，你可以继续描述下一步修改。'
      : 'Generation stopped. You can continue with another change.';
    await finalizeTurn(stoppedReply, 'stopped', {
      withSnapshot: modelResult.projectTouched,
    });
    send({
      type: 'result',
      data: {
        ok: false,
        stopped: true,
        reply: stoppedReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: state.previewUrl ? { url: state.previewUrl, sandboxDebugUrl: state.sandboxDebugUrl } : {},
      },
    });
    return;
  }
  const sanitizedModelOutput = modelResult.success && modelResult.output
    ? sanitizeAssistantText(modelResult.output)
    : '';
  const modelOutput = sanitizedModelOutput && !isGenericCompletionReply(sanitizedModelOutput)
    ? sanitizedModelOutput
    : '';
  const fallbackReply = modelResult.success
    ? buildRequirementConclusionFallback(message, state.previewUrl ? 'ready' : 'pending')
    : (modelResult.error || 'An error occurred during processing. Please try again.');
  const assistantReply = stripReturnedPreviewLinks(sanitizeAssistantText(
    modelOutput || fallbackReply
  ) || fallbackReply, state.previewUrl);

  send({
    type: 'agent',
    data: {
      ok: modelResult.success,
      reply: assistantReply,
      ...(modelResult.error ? { error: modelResult.error } : {}),
    },
  });

  if (modelResult.fatal) {
    await finalizeTurn(assistantReply, 'failed', {
      withSnapshot: modelResult.projectTouched,
    });

    send({
      type: 'result',
      data: {
        ok: false,
        reply: assistantReply,
        conversation_id: conversationId,
        build: {
          status: 'skipped' as BuildStatus,
          stderr: modelResult.error || assistantReply,
        },
        preview: {},
      },
    });
    return;
  }

  if (!modelResult.projectTouched && modelResult.previewTouched) {
    if (state.previewUrl) {
      send({
        type: 'preview_ready',
        data: {
          preview: {
            url: state.previewUrl,
            sandboxDebugUrl: state.sandboxDebugUrl,
          },
        },
      });
    }

    await finalizeTurn(assistantReply, modelResult.success ? 'completed' : 'failed');

    send({
      type: 'result',
      data: {
        ok: modelResult.success && Boolean(state.previewUrl),
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
          ...(!state.previewUrl ? { error: 'The agent did not complete publish_preview.' } : {}),
        },
      },
    });
    return;
  }

  if (!modelResult.projectTouched) {
    await finalizeTurn(assistantReply, modelResult.success ? 'completed' : 'failed', {
      withState: false,
    });

    send({
      type: 'result',
      data: {
        ok: modelResult.success,
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  // Files are on disk now — flush before verification/auto-fix so that long
  // build window cannot recycle the sandbox with only an in-memory project.
  await checkpoint.flush();

  let fileTree = await pushFileTree('Failed to read the file list.');
  let build = await runVerification(context, state);
  let autoFixAttempts = 0;
  let autoFixApplied = false;
  let autoFixReply = '';

  // The project has files on disk from here on, so expose a download link. The
  // archive is built on demand by /download; this is just a pointer (the
  // authoritative filename comes from the /download response).
  const downloadLink = { url: '/download', filename: 'source.zip' };

  if (build.fatal) {
    const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
    await finalizeTurn(fatalReply, 'failed', { withSnapshot: true });

    send({
      type: 'result',
      data: {
        ok: false,
        reply: fatalReply,
        conversation_id: conversationId,
        project: {
          dir: state.appDir,
          created: modelResult.wasCreated,
        },
        build,
        files: {
          root: state.appDir,
          items: fileTree,
        },
        download: downloadLink,
        preview: {},
      },
    });
    return;
  }

  if (build.status === 'failed' && modelResult.success) {
    autoFixAttempts = AUTO_FIX_MAX_ATTEMPTS;
    autoFixApplied = true;
    send({
      type: 'status',
      message: `Verification failed. Running auto-fix 1/${AUTO_FIX_MAX_ATTEMPTS}`,
    });

    const autoFixPrompt = buildAutoFixPrompt(
      message,
      assistantReply,
      build,
      1,
      AUTO_FIX_MAX_ATTEMPTS,
    );
    const autoFixResult = await runCodingAgent(
      context,
      conversationId,
      autoFixPrompt,
      [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: assistantReply },
      ],
      state,
      false,
      handleScaffoldLog,
      forwardProgress,
      handleProjectFilesChanged,
      handlePreviewReady,
      abortSignal,
    );
    if (autoFixResult.stopped || abortSignal?.aborted) {
      const stoppedReply = /[\u3400-\u9fff]/.test(message)
        ? '已停止本次生成，你可以继续描述下一步修改。'
        : 'Generation stopped. You can continue with another change.';
      await finalizeTurn(stoppedReply, 'stopped', { withSnapshot: true });
      send({
        type: 'result',
        data: {
          ok: false,
          stopped: true,
          reply: stoppedReply,
          conversation_id: conversationId,
          build: { status: 'skipped' as BuildStatus },
          preview: state.previewUrl ? { url: state.previewUrl, sandboxDebugUrl: state.sandboxDebugUrl } : {},
        },
      });
      return;
    }
    autoFixReply = stripReturnedPreviewLinks(sanitizeAssistantText(
      autoFixResult.success && autoFixResult.output
        ? autoFixResult.output
        : autoFixResult.error || ''
    ), state.previewUrl);

    if (autoFixReply) {
      send({
        type: 'agent',
        data: {
          ok: autoFixResult.success,
          reply: autoFixReply,
          ...(autoFixResult.error ? { error: autoFixResult.error } : {}),
        },
      });
    }

    fileTree = await pushFileTree('Failed to read the file list after auto-fix.');
    build = await runVerification(context, state);
    if (build.fatal) {
      const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
      await finalizeTurn(fatalReply, 'failed', { withSnapshot: true });

      send({
        type: 'result',
        data: {
          ok: false,
          reply: fatalReply,
          conversation_id: conversationId,
          project: {
            dir: state.appDir,
            created: modelResult.wasCreated,
          },
          build,
          files: {
            root: state.appDir,
            items: fileTree,
          },
          download: downloadLink,
          preview: {},
        },
      });
      return;
    }
  }

  build = {
    ...build,
    ...(autoFixAttempts > 0 ? { autoFixAttempts, autoFixApplied } : {}),
  };

  // Preview startup, HTTP readiness checks, and link generation are handled by publish_preview.
  // publish_preview, or the legacy get_preview_link alias, writes state.previewUrl / state.sandboxDebugUrl.
  if (state.previewUrl) {
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
        },
      },
    });
  }

  const autoFixSuffix = autoFixAttempts > 0
    ? build.status === 'success'
      ? ` Auto-fix ran ${autoFixAttempts} time(s) based on the verification error, and verification now passes.`
      : ` Auto-fix ran ${autoFixAttempts} time(s), but verification still fails. The final logs are preserved for further debugging.`
    : '';
  const buildFailedSuffix = build.status === 'failed' && autoFixAttempts === 0
    ? ' Verification currently fails, so I did not describe the update as successful. Please continue debugging from the logs.'
    : '';
  const missingPreviewSuffix = state.previewUrl
    ? ''
    : ' No preview link was obtained. Please continue by asking the agent to call publish_preview.';
  const finalFallbackReply = buildRequirementConclusionFallback(
    message,
    build.status !== 'failed' && state.previewUrl ? 'ready' : 'generated',
  );
  const baseReply = autoFixReply || (modelOutput ? assistantReply : finalFallbackReply);
  const reply = stripReturnedPreviewLinks(
    `${baseReply}${autoFixSuffix}${buildFailedSuffix}${missingPreviewSuffix}`,
    state.previewUrl,
  );

  // Code first, then state, then conversation — so a crash mid-finalize still
  // leaves a restorable projectSnapshot for resume after sandbox recycle.
  await finalizeTurn(
    reply,
    modelResult.success && build.status !== 'failed' && Boolean(state.previewUrl) ? 'completed' : 'failed',
    { withSnapshot: true },
  );

  send({
    type: 'result',
    data: {
      ok: modelResult.success && build.status !== 'failed' && Boolean(state.previewUrl),
      reply,
      conversation_id: conversationId,
      project: {
        dir: state.appDir,
        created: modelResult.wasCreated,
      },
      build,
      files: {
        root: state.appDir,
        items: fileTree,
      },
      download: downloadLink,
      preview: {
        url: state.previewUrl,
        sandboxDebugUrl: state.sandboxDebugUrl,
        ...(!state.previewUrl ? { error: 'The agent did not complete publish_preview.' } : {}),
      },
    },
  });
}
