import { stripReturnedPreviewLinks } from '../../shared/preview-links.ts';
import { stripReturnedPublishLinks } from '../../shared/publish-target.ts';
import { buildStoppedReply } from '../../shared/reply-language.ts';
import { runCodingAgent } from '../_agent.ts';
import { AUTO_FIX_MAX_ATTEMPTS } from '../_constants.ts';
import { getHistory, saveProjectState } from '../_memory.ts';
import { getFileTree, runVerification } from '../_project.ts';
import type {
  AgentProgressEvent,
  BuildStatus,
  ConversationMessage,
  FileTreeItem,
  StreamSend,
} from '../_types.ts';
import { buildAutoFixPrompt } from '../utils/_build-errors.ts';
import { toAppRelPath } from '../utils/_paths.ts';
import { sanitizeAssistantText } from '../utils/_text.ts';
import { createTurnTimer, formatTimingLog } from '../utils/_timing.ts';
import { resolveConversationId } from '../utils/_request.ts';
import {
  FILE_PUSH_MAX_BYTES,
  FILE_PUSH_TURN_BUDGET_BYTES,
  buildDeployConclusionFallback,
  buildOutcomeSuffix,
  buildRequirementConclusionFallback,
  createProjectCheckpointController,
  extendExistingSandboxTimeout,
  isGenericCompletionReply,
  utf8ByteLength,
} from './_helpers.ts';
import { createTurnLifecycle } from './_turn-lifecycle.ts';
import { prepareProjectWorkspace } from './_workspace.ts';

export async function runChatPipeline(
  context: any,
  message: string,
  send: StreamSend,
  options: {
    resetProject?: boolean;
    turnId?: string;
    userMessagePersisted?: boolean;
    /** Validated model for this turn; '' or absent runs the configured default. */
    model?: string;
    /** Host domain used to pick the Makers publish acceleration area. */
    siteDomain?: string;
    /** Server clock when the user message was persisted; first-visible metrics are since this. */
    timingOriginMs?: number;
    persistMs?: number;
    dispatchMs?: number;
  } = {},
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

  const pendingLogs: Array<{
    phase?: 'scaffold' | 'agent';
    stream?: 'status' | 'stdout' | 'stderr';
    message: string;
    startedAt?: number;
    endedAt?: number;
  }> = [];
  let recordLog: ((log: (typeof pendingLogs)[number]) => void) | undefined;
  const captureLog = (event: Record<string, unknown>) => {
    const message = typeof event.message === 'string' ? event.message : '';
    if (!message) return;
    if (event.type !== 'log' && event.type !== 'status') return;
    const stream = event.type === 'status'
      ? 'status' as const
      : event.stream === 'stdout'
        ? 'stdout' as const
        : event.stream === 'stderr'
          ? 'stderr' as const
          : 'status' as const;
    const startedAt = typeof event.startedAt === 'number' ? event.startedAt : undefined;
    const endedAt = typeof event.endedAt === 'number' ? event.endedAt : undefined;
    const log: (typeof pendingLogs)[number] = {
      phase: event.type === 'status'
        ? 'agent'
        : event.phase === 'scaffold' ? 'scaffold' : 'agent',
      stream,
      message,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
    };
    if (recordLog) recordLog(log);
    else pendingLogs.push(log);
  };
  const sendAndCapture = (event: Record<string, unknown>) => {
    send(event);
    captureLog(event);
  };

  sendAndCapture({
    type: 'status',
    message: 'Running the agent workflow',
  });

  const timer = createTurnTimer(options.timingOriginMs ?? Date.now());
  const emitMark = (mark: ReturnType<typeof timer.mark>) => {
    sendAndCapture({
      type: 'log',
      phase: 'agent',
      stream: 'status',
      message: formatTimingLog(mark),
      startedAt: mark.startedAt,
      endedAt: mark.endedAt,
    });
    return mark;
  };
  const reportTiming = (
    stage: string,
    startedAt: number,
    fields?: Parameters<typeof timer.mark>[2],
  ) => emitMark(timer.mark(stage, startedAt, fields));

  const shouldResetProject = options.resetProject === true;
  if (typeof options.persistMs === 'number') {
    emitMark(timer.record('task_persist', timer.originMs, timer.originMs + options.persistMs));
  }
  if (typeof options.dispatchMs === 'number') {
    emitMark(timer.record('task_start', timer.originMs, timer.originMs + options.dispatchMs));
  }
  // Lease extension, history, and workspace prep touch three different systems
  // and none of them reads the others' result, so they are started together.
  // The sandbox client dedupes concurrent initialization, which is what the
  // extension and the workspace prep would otherwise race on.
  const extendStartedAt = Date.now();
  void extendExistingSandboxTimeout(context)
    .then(() => {
      reportTiming('extend_sandbox', extendStartedAt);
    })
    .catch(() => {
      // extendExistingSandboxTimeout already reports its own failures.
    });

  const historyPromise = shouldResetProject
    ? Promise.resolve([] as ConversationMessage[])
    : (async () => {
      const historyStartedAt = Date.now();
      const messages = await getHistory(context, conversationId, {
        excludeLatestUserMessage: options.userMessagePersisted ? message : undefined,
      });
      reportTiming('history', historyStartedAt, { messages: messages.length });
      return messages;
    })();

  const [state, history] = await Promise.all([
    prepareProjectWorkspace(
      context,
      conversationId,
      shouldResetProject,
      sendAndCapture,
      timer,
    ),
    historyPromise,
  ]);
  const activityTurnId = options.turnId
    || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // Mid-turn debounced snapshots + exit-path flush so a recycled sandbox still
  // has a restorable workspace in project Blob storage.
  const checkpoint = createProjectCheckpointController(context, conversationId, state, (persistenceError) => {
    sendAndCapture({
      type: 'log',
      phase: 'agent',
      stream: 'stderr',
      message: persistenceError,
    });
  });
  const turn = createTurnLifecycle({
    context,
    conversationId,
    message,
    turnId: activityTurnId,
    userMessagePersisted: options.userMessagePersisted === true,
    state,
    checkpoint,
  });
  const recordProgress = turn.recordProgress;
  const recordPublish = turn.recordPublish;
  const finalizeTurn = turn.finalize;
  recordLog = turn.recordLog;
  for (const log of pendingLogs) recordLog(log);
  pendingLogs.length = 0;

  let firstVisibleLogged = false;
  const logFirstVisible = (via: 'narration' | 'tool') => {
    if (firstVisibleLogged) return;
    firstVisibleLogged = true;
    reportTiming('first_visible', timer.originMs, { via });
    sendAndCapture({
      type: 'log',
      phase: 'agent',
      stream: 'status',
      message: timer.formatSummary(),
      startedAt: timer.originMs,
      endedAt: Date.now(),
    });
  };

  const forwardProgress = (event: AgentProgressEvent) => {
    // Forward structured progress events directly; the frontend renders by type.
    if (event.type === 'text_segment') {
      const strippedPreview = state.previewUrl
        ? stripReturnedPreviewLinks(event.data.text, state.previewUrl, { preserveEdges: true })
        : event.data.text;
      const text = stripReturnedPublishLinks(strippedPreview, state.makersPreviewUrl, {
        preserveEdges: true,
      });
      if (text.length === 0) {
        return;
      }
      logFirstVisible('narration');
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
    if (event.type === 'tool_use') {
      logFirstVisible('tool');
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
      sendAndCapture({
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
    await pushFileTree('Failed to read the file list after project files changed.');
    // Debounced store backup while the agent is still writing — covers the long
    // window where files live only in the volatile sandbox.
    checkpoint.schedule();
  };

  const handleProjectPublished = (result: {
    ok?: boolean;
    previewUrl?: string;
    projectId?: string;
    deploymentId?: string;
    error?: string;
  }) => {
    recordPublish({
      ok: result.ok,
      url: result.previewUrl,
      projectId: result.projectId,
      deploymentId: result.deploymentId,
      error: result.error,
    });
    send({
      type: 'publish_result',
      data: result,
    });
  };

  // Switch the iframe the moment publish_preview returns — do not wait for
  // verification / finalizeTurn, which can take several more seconds.
  const handlePreviewReady = (preview: { url?: string }) => {
    if (!preview.url) {
      return;
    }
    state.previewUrl = preview.url;
    state.previewPublished = true;
    // Persist before the turn finishes so a refresh during verification still
    // resumes into the preview pane and restarts the live server.
    void saveProjectState(context, conversationId, state);
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: preview.url,
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
    forwardProgress,
    handleProjectFilesChanged,
    handlePreviewReady,
    abortSignal,
    message,
    {
      model: options.model,
      resetSession: shouldResetProject,
      siteDomain: options.siteDomain,
      onProjectPublished: handleProjectPublished,
      onTiming: reportTiming,
    },
  );

  if (!firstVisibleLogged) {
    reportTiming('first_visible_missing', timer.originMs);
    sendAndCapture({
      type: 'log',
      phase: 'agent',
      stream: 'status',
      message: timer.formatSummary(),
      startedAt: timer.originMs,
      endedAt: Date.now(),
    });
  }

  if (modelResult.stopped || abortSignal?.aborted) {
    const stoppedReply = buildStoppedReply(message);
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
        preview: state.previewUrl ? { url: state.previewUrl } : {},
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
  const fallbackReply = modelResult.publishTouched && !modelResult.projectTouched
    ? (modelResult.success
      ? buildDeployConclusionFallback(message, true)
      : (modelResult.error || buildDeployConclusionFallback(message, false)))
    : modelResult.success
      ? buildRequirementConclusionFallback(message, state.previewUrl ? 'ready' : 'pending')
      : (modelResult.error || 'An error occurred during processing. Please try again.');
  const assistantReply = stripReturnedPublishLinks(
    stripReturnedPreviewLinks(sanitizeAssistantText(
      modelOutput || fallbackReply
    ) || fallbackReply, state.previewUrl),
    state.makersPreviewUrl,
  ) || fallbackReply;

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
    await finalizeTurn(fatalReply, 'failed', {
      withSnapshot: true,
      turnResult: { buildStatus: build.status },
    });

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
    sendAndCapture({
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
      forwardProgress,
      handleProjectFilesChanged,
      handlePreviewReady,
      abortSignal,
      message,
      // Repairing on a different model than the one that wrote the code would
      // make a failed build hard to attribute to either.
      {
        model: options.model,
        siteDomain: options.siteDomain,
        onProjectPublished: handleProjectPublished,
        onTiming: reportTiming,
      },
    );
    if (autoFixResult.stopped || abortSignal?.aborted) {
      const stoppedReply = buildStoppedReply(message);
      await finalizeTurn(stoppedReply, 'stopped', { withSnapshot: true });
      send({
        type: 'result',
        data: {
          ok: false,
          stopped: true,
          reply: stoppedReply,
          conversation_id: conversationId,
          build: { status: 'skipped' as BuildStatus },
          preview: state.previewUrl ? { url: state.previewUrl } : {},
        },
      });
      return;
    }
    autoFixReply = stripReturnedPublishLinks(stripReturnedPreviewLinks(sanitizeAssistantText(
      autoFixResult.success && autoFixResult.output
        ? autoFixResult.output
        : autoFixResult.error || ''
    ), state.previewUrl), state.makersPreviewUrl);

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
  if (state.previewUrl) {
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: state.previewUrl,
        },
      },
    });
  }

  const finalFallbackReply = buildRequirementConclusionFallback(
    message,
    build.status !== 'failed' && state.previewUrl ? 'ready' : 'generated',
  );
  const baseReply = autoFixReply || (modelOutput ? assistantReply : finalFallbackReply);
  const outcomeSuffix = buildOutcomeSuffix(message, {
    autoFixAttempts,
    buildFailed: build.status === 'failed',
    hasPreview: Boolean(state.previewUrl),
  });
  const reply = stripReturnedPublishLinks(
    stripReturnedPreviewLinks(
      `${baseReply}${outcomeSuffix}`,
      state.previewUrl,
    ),
    state.makersPreviewUrl,
  );

  // Code first, then state, then conversation — so a crash mid-finalize still
  // leaves a restorable workspace for resume after sandbox recycle.
  await finalizeTurn(
    reply,
    modelResult.success && build.status !== 'failed' && Boolean(state.previewUrl) ? 'completed' : 'failed',
    { withSnapshot: true, turnResult: { buildStatus: build.status } },
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
        ...(!state.previewUrl ? { error: 'The agent did not complete publish_preview.' } : {}),
      },
    },
  });
}
