import type { TimelineCopy } from '../i18n';
import type {
  NormalizedStep,
  NormalizedStepPhase,
  NormalizedStepStatus,
  ProcessEvent,
  TimelineStep,
} from '../types/workspace';
import { PHASE_ORDER } from '../types/workspace';
import {
  isInstallCommand as sharedIsInstallCommand,
  isPreviewCommand as sharedIsPreviewCommand,
  shortenToolName as sharedShortenToolName,
} from '../../agents/utils/_tool-phase';

export const PROCESS_STEP_REVEAL_DELAY_MS = 420;
export const TYPEWRITER_INTERVAL_MS = 18;
export const TYPEWRITER_CHARS_PER_TICK = 3;
export const NARRATION_TYPEWRITER_INTERVAL_MS = 34;
export const NARRATION_TYPEWRITER_CHARS_PER_TICK = 1;

export function getProcessEventKey(event: ProcessEvent, index: number) {
  if (event.kind === 'thinking') {
    return `thinking-${index}`;
  }
  return `step-${event.phase}`;
}

export function appendOrUpdateTimelineStep(steps: TimelineStep[], nextStep: TimelineStep): TimelineStep[] {
  if (nextStep.kind !== 'tool_use' || !nextStep.id) {
    return [...steps, nextStep];
  }

  const existingIndex = steps.findIndex((step) =>
    step.kind === 'tool_use' && step.id === nextStep.id,
  );
  if (existingIndex < 0) {
    return [...steps, nextStep];
  }

  return steps.map((step, index) => {
    if (index !== existingIndex || step.kind !== 'tool_use') {
      return step;
    }
    return {
      ...step,
      name: nextStep.name || step.name,
      command: nextStep.command || step.command,
      phaseHint: nextStep.phaseHint || step.phaseHint,
      fileCount: nextStep.fileCount || step.fileCount,
    };
  });
}

export function appendOrUpdateProcessThinking(events: ProcessEvent[], content: string): ProcessEvent[] {
  const tail = events[events.length - 1];
  if (tail?.kind === 'thinking') {
    return events.map((event, index) =>
      index === events.length - 1 && event.kind === 'thinking'
        ? { ...event, content }
        : event,
    );
  }
  return [...events, { kind: 'thinking', content }];
}

export function appendOrUpdateProcessStep(
  events: ProcessEvent[],
  steps: TimelineStep[],
  changedStep: TimelineStep,
  copy: TimelineCopy,
): ProcessEvent[] {
  const processStep = getProcessStepForTimelineStep(changedStep, steps, copy);
  if (!processStep) {
    return events;
  }

  const existingIndex = events.findIndex((event) =>
    event.kind === 'step' && event.phase === processStep.phase,
  );
  if (existingIndex >= 0) {
    return events.map((event, index) =>
      index === existingIndex ? processStep : event,
    );
  }

  return [...events, processStep];
}

export function shouldDelayProcessStepReveal(previousEvents: ProcessEvent[], nextEvents: ProcessEvent[]) {
  const previousTail = previousEvents[previousEvents.length - 1];
  return previousTail?.kind === 'thinking'
    && countProcessSteps(nextEvents) > countProcessSteps(previousEvents);
}

export function appendPendingProcessSteps(
  events: ProcessEvent[],
  steps: TimelineStep[],
  copy: TimelineCopy,
): ProcessEvent[] {
  const existingPhases = new Set(
    events
      .filter((event): event is Extract<ProcessEvent, { kind: 'step' }> => event.kind === 'step')
      .map((event) => event.phase),
  );
  const pendingSteps = normalizeTimelineSteps(steps, copy)
    .filter((step) => !existingPhases.has(step.phase));
  if (pendingSteps.length === 0) {
    return events;
  }
  return [
    ...events,
    ...pendingSteps.map((step): Extract<ProcessEvent, { kind: 'step' }> => ({
      kind: 'step',
      phase: step.phase,
      step,
    })),
  ];
}

export function countProcessSteps(events: ProcessEvent[]) {
  return events.reduce((count, event) => count + (event.kind === 'step' ? 1 : 0), 0);
}

// 语言切换时重刷已渲染的卡片文案。processEvents 里的 title/summary 是事件到达时
// 按当时语言算好的字符串，切换语言不会自动重算；但每条消息保留了语言无关的原始
// `steps`，这里用当前 copy 重新派生 step 文案。thinking 是模型自由文本，原样保留。
export function relocalizeProcessEvents(
  events: ProcessEvent[],
  steps: TimelineStep[],
  copy: TimelineCopy,
): ProcessEvent[] {
  const normalizedByPhase = new Map(
    normalizeTimelineSteps(steps, copy).map((step) => [step.phase, step] as const),
  );
  return events.map((event) =>
    event.kind === 'step'
      ? { ...event, step: normalizedByPhase.get(event.phase) ?? event.step }
      : event,
  );
}

export function getProcessStepForTimelineStep(
  changedStep: TimelineStep,
  steps: TimelineStep[],
  copy: TimelineCopy,
): Extract<ProcessEvent, { kind: 'step' }> | null {
  const phase = getTimelineStepPhase(changedStep, steps, copy);
  if (!phase) {
    return null;
  }
  const normalizedStep = normalizeTimelineSteps(steps, copy)
    .find((step) => step.phase === phase);
  return normalizedStep ? { kind: 'step', phase, step: normalizedStep } : null;
}

export function getTimelineStepPhase(
  step: TimelineStep,
  steps: TimelineStep[],
  copy: TimelineCopy,
): NormalizedStepPhase | null {
  if (step.kind === 'tool_use') {
    return classifyToolUse(step, copy)?.phase ?? null;
  }
  if (step.kind === 'tool_result') {
    const relatedToolUse = [...steps].reverse().find((item) =>
      item.kind === 'tool_use' && item.id === step.toolUseId,
    ) as Extract<TimelineStep, { kind: 'tool_use' }> | undefined;
    if (relatedToolUse) {
      return classifyToolUse(relatedToolUse, copy)?.phase ?? null;
    }
    if (!step.ok && step.command) {
      return isInstallCommand(step.command) ? 'install' : 'code';
    }
    return null;
  }
  if (step.kind === 'status') {
    return classifyStatusText(step.text, copy)?.phase ?? null;
  }
  if (step.kind === 'log') {
    return classifyLogText(step.text, step.stream, copy)?.phase ?? null;
  }
  if (step.kind === 'error') {
    return /preview|预览|link|链接/i.test(step.text)
      ? 'link'
      : isInstallText(step.text)
        ? 'install'
        : 'code';
  }
  return null;
}

export function normalizeTimelineSteps(steps: TimelineStep[], copy: TimelineCopy): NormalizedStep[] {
  const byPhase = new Map<NormalizedStepPhase, NormalizedStep>();
  const phaseByToolUseId = new Map<string, NormalizedStepPhase>();
  const commandByToolUseId = new Map<string, string>();

  const ensureStep = (phase: NormalizedStepPhase) => {
    const existing = byPhase.get(phase);
    if (existing) {
      return existing;
    }
    const definition = copy.definitions[phase];
    const step: NormalizedStep = {
      phase,
      title: definition.title,
      status: 'waiting',
      summary: definition.waiting,
    };
    byPhase.set(phase, step);
    return step;
  };

  const updateStep = (
    phase: NormalizedStepPhase,
    status: NormalizedStepStatus,
    summary: string,
  ) => {
    const step = ensureStep(phase);
    if (step.status === 'done' && status === 'running') {
      return;
    }
    step.status = status;
    step.summary = summary;
    if (phase === 'code') {
      const modifyStep = byPhase.get('modify');
      if (modifyStep) {
        modifyStep.status = 'done';
        modifyStep.summary = copy.summaries.modifyStarted;
      }
    }
  };

  for (const step of steps) {
    if (step.kind === 'modify_marker') {
      updateStep('modify', 'running', copy.definitions.modify.waiting);
      continue;
    }

    if (step.kind === 'tool_use') {
      if (step.command) {
        commandByToolUseId.set(step.id, step.command);
      }
      const classification = classifyToolUse(step, copy);
      if (!classification) {
        continue;
      }
      phaseByToolUseId.set(step.id, classification.phase);
      updateStep(classification.phase, 'running', classification.runningSummary);
      continue;
    }

    if (step.kind === 'tool_result') {
      const command = step.command || commandByToolUseId.get(step.toolUseId) || '';
      const phase = phaseByToolUseId.get(step.toolUseId) || (!step.ok && command ? 'code' : undefined);
      if (!phase) {
        continue;
      }
      if (phase === 'link' && step.ok) {
        updateStep('preview', 'done', copy.summaries.previewReady);
      }
      updateStep(
        phase,
        step.ok ? 'done' : 'error',
        summarizeToolResult(phase, step.ok, step.preview, copy, command),
      );
      continue;
    }

    if (step.kind === 'status') {
      const statusUpdate = classifyStatusText(step.text, copy);
      if (statusUpdate) {
        if (statusUpdate.phase === 'link' && statusUpdate.status === 'done') {
          updateStep('preview', 'done', copy.summaries.previewReady);
        }
        updateStep(statusUpdate.phase, statusUpdate.status, statusUpdate.summary);
      }
      continue;
    }

    if (step.kind === 'log') {
      const logUpdate = classifyLogText(step.text, step.stream, copy);
      if (logUpdate) {
        updateStep(logUpdate.phase, logUpdate.status, logUpdate.summary);
      }
      continue;
    }

    if (step.kind === 'error') {
      const phase = /preview|预览|link|链接/i.test(step.text)
        ? 'link'
        : isInstallText(step.text)
          ? 'install'
          : 'code';
      updateStep(phase, 'error', compactErrorSummary(step.text, copy.summaries.stepFailed(getStepTitle(phase, copy))));
    }
  }

  return PHASE_ORDER
    .map((phase) => byPhase.get(phase))
    .filter((step): step is NormalizedStep => Boolean(step));
}

export function classifyToolUse(step: Extract<TimelineStep, { kind: 'tool_use' }>, copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  runningSummary: string;
} | null {
  if (step.phaseHint) {
    return {
      phase: step.phaseHint,
      runningSummary: step.phaseHint === 'code' && step.fileCount && step.fileCount > 0
        ? copy.summaries.codeWritingFiles(step.fileCount)
        : getRunningSummary(step.phaseHint, copy),
    };
  }

  const toolName = shortenToolName(step.name);

  if (toolName === 'ensure_project_scaffold') {
    return { phase: 'scaffold', runningSummary: copy.summaries.scaffoldRunning };
  }

  if (toolName === 'write_project_file' || toolName === 'write_project_files' || toolName === 'write_files') {
    return {
      phase: 'code',
      runningSummary: copy.summaries.codeRunningUpdate,
    };
  }

  if (toolName === 'publish_preview' || toolName === 'get_preview_link') {
    return { phase: 'preview', runningSummary: copy.summaries.previewRunning };
  }

  if (toolName === 'files_write' || toolName === 'files_make_dir' || toolName === 'files_remove') {
    return { phase: 'code', runningSummary: copy.summaries.codeRunningUpdate };
  }

  if (toolName === 'files_read' || toolName === 'files_list' || toolName === 'files_exists') {
    return null;
  }

  if (toolName === 'commands') {
    if (step.command && isInstallCommand(step.command)) {
      return { phase: 'install', runningSummary: copy.summaries.installRunning };
    }
    if (step.command && isPreviewCommand(step.command)) {
      return { phase: 'preview', runningSummary: copy.summaries.previewRunning };
    }
    return null;
  }

  return null;
}

export function getRunningSummary(phase: NormalizedStepPhase, copy: TimelineCopy) {
  if (phase === 'scaffold') return copy.summaries.scaffoldRunning;
  if (phase === 'code') return copy.summaries.codeRunningUpdate;
  if (phase === 'install') return copy.summaries.installRunning;
  if (phase === 'preview') return copy.summaries.previewRunning;
  return copy.summaries.linkRunning;
}

export function summarizeToolResult(
  phase: NormalizedStepPhase,
  ok: boolean,
  preview: string,
  copy: TimelineCopy,
  command = '',
) {
  if (!ok) {
    const detail = compactErrorSummary(preview, copy.summaries.stepFailed(getStepTitle(phase, copy)));
    return command
      ? copy.summaries.commandFailed(compactCommandSummary(command), detail)
      : detail;
  }

  if (phase === 'scaffold') {
    const result = getRecord(parseJsonPreview(preview));
    if (typeof result?.created === 'boolean') {
      return result.created ? copy.summaries.scaffoldCreated : copy.summaries.scaffoldExisting;
    }
    return copy.summaries.scaffoldReady;
  }

  if (phase === 'code') {
    const result = getRecord(parseJsonPreview(preview));
    const written = Array.isArray(result?.written) ? result.written : [];
    return written.length > 0 ? copy.summaries.codeUpdatedFiles(written.length) : copy.summaries.codeUpdated;
  }

  if (phase === 'install') {
    return copy.summaries.installDone;
  }

  if (phase === 'preview') {
    return copy.summaries.previewStarted;
  }

  const result = getRecord(parseJsonPreview(preview));
  const url = typeof result?.url === 'string'
    ? result.url
    : typeof result?.previewUrl === 'string'
      ? result.previewUrl
      : '';
  return url ? copy.summaries.linkDone : copy.summaries.linkDoneNoUrl;
}

export function classifyStatusText(text: string, copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  status: NormalizedStepStatus;
  summary: string;
} | null {
  if (/准备项目工作区|prepar(?:e|ing) the project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'running', summary: copy.summaries.scaffoldRunning };
  }
  if (/检测到已有工作区|existing project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'done', summary: copy.summaries.scaffoldExisting };
  }
  if (/已准备空项目工作区|empty project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'done', summary: copy.summaries.scaffoldCreated };
  }
  if (/自动修复|验证失败|auto-fix|validation|verification/i.test(text)) {
    return { phase: 'code', status: 'running', summary: copy.summaries.codeAutoFix };
  }
  if (/已获取预览链接|预览链接已获取|preview link (found|retrieved)/i.test(text)) {
    return { phase: 'link', status: 'done', summary: copy.summaries.linkDone };
  }
  if (/预览链接未返回|preview link (was not returned|missing)/i.test(text)) {
    return { phase: 'link', status: 'error', summary: copy.summaries.linkMissing };
  }
  return null;
}

export function classifyLogText(text: string, stream: 'stdout' | 'stderr' | 'status', copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  status: NormalizedStepStatus;
  summary: string;
} | null {
  if (stream === 'status') {
    return classifyStatusText(text, copy);
  }
  if (stream === 'stderr') {
    if (isInstallText(text)) {
      return { phase: 'install', status: 'error', summary: compactErrorSummary(text, copy.summaries.installFailed) };
    }
    if (/preview|预览|8080|3000|proxy|link|链接/i.test(text)) {
      return { phase: 'link', status: 'error', summary: compactErrorSummary(text, copy.summaries.previewFailed) };
    }
    return { phase: 'code', status: 'error', summary: compactErrorSummary(text, copy.summaries.processFailed) };
  }
  return null;
}

export function parseJsonPreview(value: string): unknown {
  if (!value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isPreviewCommand(cmd: string) {
  // Re-exported from shared heuristics; keep local name for timeline classifiers.
  return sharedIsPreviewCommand(cmd);
}

export function isInstallCommand(cmd: string) {
  return sharedIsInstallCommand(cmd);
}

export function isInstallText(text: string) {
  return (
    sharedIsInstallCommand(text)
    || /\b(dependency|dependencies|package install|install failed|failed to install)\b/i.test(text)
    || /依赖|安装失败/.test(text)
  );
}

export function compactErrorSummary(value: string, fallback: string) {
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/"content"\s*:\s*"[^"]+"/g, '"content":"<hidden>"')
    .trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.length > 140 ? `${cleaned.slice(0, 140)}...` : cleaned;
}

export function compactCommandSummary(value: string) {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 220)}...` : cleaned;
}

export function getStepTitle(phase: NormalizedStepPhase, copy: TimelineCopy) {
  return copy.definitions[phase]?.title || copy.summaries.unknownStep;
}

export function shortenToolName(name: string) {
  return sharedShortenToolName(name);
}
