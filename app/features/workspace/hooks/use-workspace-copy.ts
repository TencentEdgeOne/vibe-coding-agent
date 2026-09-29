'use client';

import { useMemo } from 'react';
import type { UiCopy } from '@/app/i18n';

export function useWorkspaceCopy(t: UiCopy, options: {
  hasDeployableProject: boolean;
  canDeployProject: boolean;
  downloadBusy: boolean;
}) {
  const deployHint = options.hasDeployableProject
    ? (options.canDeployProject ? t.deployLabel : t.workspace.deployNeedsIdle)
    : t.workspace.deployNeedsProject;
  const downloadHint = options.downloadBusy ? t.workspace.downloading : t.workspace.downloadSource;
  const previewFrameCopy = useMemo(() => ({
    unavailable: t.workspace.previewUnavailable,
    loading: t.workspace.loadingPreview,
    retry: t.workspace.retryPreview,
  }), [t]);
  const previewAddressCopy = useMemo(() => ({
    back: t.workspace.previewBack,
    forward: t.workspace.previewForward,
    routeList: t.workspace.previewRouteList,
    routeEmpty: t.workspace.previewRouteEmpty,
    viewportToDesktop: t.workspace.viewportDesktop,
    viewportToMobile: t.workspace.viewportMobile,
    open: t.workspace.openPreview,
    refresh: t.workspace.refreshPreview,
    pausedForDeploy: t.workspace.previewPausedForDeploy,
    loading: t.workspace.previewNavigating,
  }), [t]);
  const conversationCopy = useMemo(() => ({
    preparingAgent: t.workspace.activityPreparingAgent,
    prepareAccepted: t.workspace.activityPrepareAccepted,
    prepareWorkspace: t.workspace.activityPrepareWorkspace,
    prepareAgent: t.workspace.activityPrepareAgent,
    analyzing: t.workspace.activityAnalyzing,
    running: t.workspace.activityRunning,
    completed: t.workspace.activityCompleted,
    failed: t.workspace.activityFailed,
    stopped: t.workspace.activityStopped,
    thinking: t.workspace.activityThinking,
    info: t.workspace.activityInfo,
    usage: t.workspace.activityUsage,
    compact: t.workspace.activityCompact,
    status: t.workspace.activityStatus,
    toolActions: t.workspace.toolActions,
    referenceTopics: t.workspace.referenceTopics,
    referenceDetail: t.workspace.referenceDetail,
    input: t.workspace.activityInput,
    output: t.workspace.activityOutput,
    steps: t.workspace.activitySteps,
    placeholder: t.workspace.changePlaceholder,
    send: t.workspace.send,
    stop: t.workspace.stop,
    stopping: t.workspace.stopping,
    modelLabel: t.workspace.modelLabel,
    copyLink: t.workspace.copyLink,
    linkCopied: t.workspace.linkCopied,
    copyMessage: t.workspace.copyMessage,
    messageCopied: t.workspace.messageCopied,
    scrollToLatest: t.workspace.scrollToLatest,
    styleLabel: t.workspace.activityStyleLabel,
    styleRefined: t.workspace.activityStyleRefined,
    styleClassic: t.workspace.activityStyleClassic,
  }), [t]);

  return {
    deployHint,
    downloadHint,
    previewFrameCopy,
    previewAddressCopy,
    conversationCopy,
  };
}
