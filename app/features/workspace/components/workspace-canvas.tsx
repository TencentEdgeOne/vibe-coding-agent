'use client';

import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import type { UiCopy } from '@/app/i18n';
import type { ModelOption } from '../../../../shared/models';
import { workspaceShellClassName } from '../workspace-split';
import type { LiveTurnApi } from '../hooks/use-live-turn';
import type { PreviewSurfaceApi } from '../hooks/use-preview-surface';
import type { WorkspaceSplitApi } from '../hooks/use-workspace-split';
import type { WorkspaceStateApi } from '../hooks/use-workspace-state';
import type { useWorkspaceCopy } from '../hooks/use-workspace-copy';
import { AgentConversation } from './lazy-panels';
import type { PreviewAddressCopy } from './preview-address-bar';
import { ResultPanel, ResultPanelToggle } from './result-panel';
import { WorkspaceSplitHandle } from './workspace-split-handle';
import { maskApiKey } from '../../../../shared/gateway-secret';
import type { DeployOfferCopy } from './conversation/types';
import { usePresence } from '@/app/hooks/use-presence';

type WorkspaceCopy = ReturnType<typeof useWorkspaceCopy>;

export function WorkspaceCanvas({
  hasWorkspace,
  workspace,
  preview,
  live,
  split,
  t,
  copy,
  models,
  model,
  onModelChange,
  conversationId,
  previewDisplayPath,
  previewAddressCopy,
  deployOffer,
  deployOfferTurnId,
  canSend,
  canDeployProject,
  publishing,
  cache,
  makersModelsDocsUrl,
  handleDeployProject,
}: {
  hasWorkspace: boolean;
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  live: LiveTurnApi;
  split: WorkspaceSplitApi;
  t: UiCopy;
  copy: WorkspaceCopy;
  models: ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  conversationId: string | null;
  previewDisplayPath: string;
  previewAddressCopy: PreviewAddressCopy;
  deployOffer: DeployOfferCopy | null;
  deployOfferTurnId: string;
  canSend: boolean;
  canDeployProject: boolean;
  publishing: boolean;
  cache: FileContentCache;
  makersModelsDocsUrl: string;
  handleDeployProject: () => void;
}) {
  const resultPanelPresence = usePresence(hasWorkspace && workspace.resultPanelOpen ? true : null);
  const resultPanelVisible = workspace.resultPanelOpen || resultPanelPresence.mounted;

  return (
    <section
      ref={(node) => {
        split.shellRef.current = node;
      }}
      className={workspaceShellClassName(
        hasWorkspace,
        resultPanelVisible,
        split.resizing,
        resultPanelPresence.exiting,
      )}
    >
      {hasWorkspace && (
        <AgentConversation
          messages={live.messages}
          input={live.input}
          loading={live.loading}
          stopping={live.stopping}
          canSend={canSend}
          compact
          models={models}
          model={model}
          onModelChange={onModelChange}
          copy={copy.conversationCopy}
          onInputChange={live.setInput}
          onSubmit={() => void live.sendMessage(live.input)}
          onStop={() => void live.stopCurrentTask()}
          deployOffer={workspace.gatewayNeeded ? null : deployOffer}
          onDeployOffer={handleDeployProject}
          onDismissDeployOffer={() => {
            if (deployOfferTurnId) workspace.setDismissedDeployTurnId(deployOfferTurnId);
          }}
          gatewayPrompt={workspace.gatewayNeeded && !live.loading && !live.stopping ? {
            title: t.workspace.gatewayPromptTitle,
            ...(workspace.gatewayPromptVariant === 'deploy'
              ? { description: t.workspace.gatewayPromptDeployHint }
              : {}),
            docs: t.workspace.gatewayPromptDocs,
            docsUrl: makersModelsDocsUrl,
            apiKey: t.workspace.gatewayPromptApiKey,
            continue: t.workspace.gatewayPromptContinue,
            skip: t.workspace.gatewayPromptSkip,
          } : null}
          gatewayChip={workspace.gatewayDeferred && !workspace.gatewayNeeded
            ? t.workspace.gatewayPromptChip
            : null}
          gatewayBusy={workspace.gatewayBusy}
          onGatewaySubmit={(values: { apiKey: string }) => {
            const apiKey = values.apiKey.trim();
            if (!apiKey || workspace.gatewayBusy || live.loading || live.stopping) return;
            void live.sendMessage(
              t.workspace.gatewayRequest.replace('{key}', maskApiKey(apiKey)),
              { apiKey },
            );
          }}
          onGatewaySkip={() => {
            if (workspace.gatewayBusy) return;
            void live.applyGateway({ skip: true });
          }}
          onGatewayReopen={() => {
            workspace.setGatewayNeeded(true);
          }}
        />
      )}

      {hasWorkspace && resultPanelVisible && (
        <WorkspaceSplitHandle
          label={t.workspace.resizePanel}
          value={Math.round(split.chatShare * 100)}
          {...split.splitHandleProps}
        />
      )}

      {hasWorkspace && !resultPanelVisible && (
        <div className="workspace-panel-toggle">
          <ResultPanelToggle
            open={false}
            attention={workspace.unseenPanel}
            showLabel={t.workspace.showPanel}
            hideLabel={t.workspace.hidePanel}
            attentionLabel={t.workspace.panelReady}
            onToggle={() => {
              if (workspace.unseenPanel || !workspace.sandboxTab) {
                workspace.setSandboxTab('preview');
              }
              workspace.setUnseenPanel(false);
              workspace.setResultPanelOpen(true);
            }}
          />
        </div>
      )}

      {hasWorkspace && resultPanelVisible && (
        <ResultPanel
          presence={resultPanelPresence.exiting ? 'exiting' : 'entering'}
          onExited={resultPanelPresence.finishExit}
          workspace={workspace}
          preview={preview}
          t={t}
          previewDisplayPath={previewDisplayPath}
          previewAddressCopy={previewAddressCopy}
          deployHint={copy.deployHint}
          downloadHint={copy.downloadHint}
          canDeployProject={canDeployProject}
          publishing={publishing}
          conversationId={conversationId}
          previewFrameCopy={copy.previewFrameCopy}
          restoring={workspace.previewLoading}
          cache={cache}
          loading={live.loading}
          handleDeployProject={handleDeployProject}
        />
      )}
    </section>
  );
}
