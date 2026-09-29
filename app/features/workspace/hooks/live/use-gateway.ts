import type { MutableRefObject } from 'react';
import { applyGatewayDecision } from '../../workspace-api';
import type { PreviewSurfaceApi } from '../use-preview-surface';
import type { WorkspaceStateApi } from '../use-workspace-state';

export function createApplyGateway(options: {
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  conversationId: string | null;
  conversationIdRef: MutableRefObject<string | null>;
}) {
  const { workspace, preview, conversationId, conversationIdRef } = options;

  async function applyGateway(decision: { apiKey?: string; skip?: boolean }) {
    if (workspace.gatewayBusy) return;
    const cid = conversationIdRef.current || conversationId;
    if (!cid) return;
    const apiKey = (decision.apiKey || '').trim();
    if (!decision.skip && !apiKey) return;

    workspace.setGatewayBusy(true);
    if (decision.skip) {
      workspace.setGatewayNeeded(false);
      workspace.setGatewayDeferred(true);
      workspace.setGatewayConfigured(false);
      workspace.setGatewaySavedVisible(false);
    } else {
      workspace.setGatewayNeeded(false);
      workspace.setGatewayDeferred(false);
      workspace.setGatewayConfigured(true);
      workspace.setGatewaySavedVisible(false);
      workspace.setGatewayPromptVariant('default');
    }

    const revertApply = () => {
      workspace.setGatewayNeeded(true);
      workspace.setGatewayConfigured(false);
      workspace.setGatewaySavedVisible(false);
      workspace.setGatewayBusy(false);
    };

    try {
      const response = await applyGatewayDecision({
        conversationId: cid,
        ...(apiKey ? { apiKey } : {}),
        ...(decision.skip ? { gatewaySkip: true } : {}),
      });
      const data = await response.json().catch(() => null) as {
        ok?: boolean;
        live?: boolean;
        skipped?: boolean;
        configured?: boolean;
        preview?: {
          url?: string;
          sandboxDebugUrl?: string;
          kind?: 'sandbox' | 'makers';
          routes?: { path: string }[];
          restarted?: boolean;
        };
        download?: { url?: string; filename?: string };
      } | null;
      if (!response.ok || !data?.ok) {
        revertApply();
        return;
      }
      if (!decision.skip) {
        workspace.setGatewaySavedVisible(false);
      }
      workspace.setGatewayBusy(false);
      if (data.preview && !data.live) {
        workspace.setHasPublishedPreview(true);
        preview.activatePreview(data.preview, new Map());
      }
      if (data.download) {
        workspace.setDownload(data.download);
      }
    } catch {
      revertApply();
    }
  }

  return applyGateway;
}
