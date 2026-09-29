'use client';

import {
  lastFinishedAssistant,
  resolveDeployOffer,
} from '../../../../shared/timeline';
import type { UiCopy } from '@/app/i18n';
import type { LiveTurnApi } from './use-live-turn';
import type { WorkspaceStateApi } from './use-workspace-state';

export function useDeployOffer(options: {
  t: UiCopy;
  workspace: WorkspaceStateApi;
  live: LiveTurnApi;
}) {
  const { t, workspace, live } = options;
  const messages = live.messages;
  const hasDeployableProject = Boolean(workspace.download?.url);
  const publishing = workspace.deployment?.status === 'running';
  const deployRunning = live.loading || live.stopping || publishing;
  const canDeployProject = hasDeployableProject && !deployRunning;
  const deployOfferKind = resolveDeployOffer(messages, {
    canDownload: hasDeployableProject,
    loading: deployRunning,
    hasLiveDeployment: workspace.deployment?.status === 'success',
  });
  const deployOfferTurnId = lastFinishedAssistant(messages)?.id || '';
  const deployOffer = deployOfferKind && deployOfferTurnId && deployOfferTurnId !== workspace.dismissedDeployTurnId
    ? {
      prompt: deployOfferKind === 'again'
        ? t.workspace.deployOfferAgain
        : t.workspace.deployOffer,
      deploy: t.workspace.deployOfferAction,
      dismiss: t.workspace.deployOfferDismiss,
    }
    : null;

  function handleDeployProject() {
    if (!canDeployProject) return;
    if (!workspace.gatewayConfigured && (workspace.gatewayNeeded || workspace.gatewayDeferred)) {
      workspace.setGatewayPromptVariant('deploy');
      workspace.setGatewayNeeded(true);
    }
    if (deployOfferTurnId) {
      workspace.setDismissedDeployTurnId(deployOfferTurnId);
    }
    void live.sendMessage(t.workspace.deployRequest, { deploy: true });
  }

  return {
    hasDeployableProject,
    publishing,
    deployRunning,
    canDeployProject,
    deployOfferKind,
    deployOfferTurnId,
    deployOffer,
    handleDeployProject,
  };
}
