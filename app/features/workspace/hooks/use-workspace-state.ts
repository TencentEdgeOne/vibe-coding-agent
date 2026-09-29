'use client';

import { useCallback, useState } from 'react';
import {
  base64ToBlob,
  getOrCreateCachedConversationId,
} from '@/app/lib/conversation';
import type {
  BuildInfo,
  DeploymentInfo,
  FileTree,
  LinkInfo,
} from '@/app/types/workspace';
import { fetchProjectArchive } from '../workspace-api';

export type SandboxTab = 'preview' | 'files' | 'session';

export function useWorkspaceState() {
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [download, setDownload] = useState<LinkInfo | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  /**
   * Whether this conversation ever published a preview. The panel restores a
   * preview that already exists; it must not boot one the agent never started,
   * which is why this arrives with the resume payload and gates the lazy boot.
   */
  const [hasPublishedPreview, setHasPublishedPreview] = useState(false);
  const [sandboxTab, setSandboxTab] = useState<SandboxTab | null>(null);
  const [fileTree, setFileTree] = useState<FileTree | null>(null);
  const [filesFocusPath, setFilesFocusPath] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [unseenPanel, setUnseenPanel] = useState(false);
  const [resultPanelOpen, setResultPanelOpen] = useState(false);
  const [dismissedDeployTurnId, setDismissedDeployTurnId] = useState('');
  const [gatewayNeeded, setGatewayNeeded] = useState(false);
  const [gatewayDeferred, setGatewayDeferred] = useState(false);
  const [gatewayConfigured, setGatewayConfigured] = useState(false);
  const [gatewaySavedVisible, setGatewaySavedVisible] = useState(false);
  const [gatewayPromptVariant, setGatewayPromptVariant] = useState<'default' | 'deploy'>('default');
  const [gatewayBusy, setGatewayBusy] = useState(false);

  const resetWorkspace = useCallback(() => {
    setDeployment(null);
    setDownload(null);
    setBuild(null);
    setHasPublishedPreview(false);
    setFileTree(null);
    setFilesFocusPath(null);
    setFilesLoading(false);
    setPreviewLoading(false);
    setUnseenPanel(false);
    setResultPanelOpen(false);
    setDismissedDeployTurnId('');
    setGatewayNeeded(false);
    setGatewayDeferred(false);
    setGatewayConfigured(false);
    setGatewaySavedVisible(false);
    setGatewayPromptVariant('default');
    setGatewayBusy(false);
    setSandboxTab(null);
  }, []);

  async function handleDownload(conversationId: string | null, failedMessage: string) {
    if (!download?.url || downloadBusy) return;
    setDownloadBusy(true);
    setDownload((current) => (current ? { ...current, error: undefined } : current));
    try {
      const cid = conversationId || getOrCreateCachedConversationId();
      const resp = await fetchProjectArchive(download.url, cid);
      const data = (await resp.json().catch(() => null)) as
        | { ok?: boolean; base64?: string; filename?: string; contentType?: string; error?: string }
        | null;
      if (!resp.ok || !data?.ok || !data.base64) {
        const message = data?.error || `${resp.status}`;
        setDownload((current) => (current ? { ...current, error: message } : current));
        return;
      }
      const blob = base64ToBlob(data.base64, data.contentType || 'application/zip');
      const filename = data.filename || download.filename || 'source.zip';
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : failedMessage;
      setDownload((current) => (current ? { ...current, error: message } : current));
    } finally {
      setDownloadBusy(false);
    }
  }

  return {
    deployment,
    setDeployment,
    download,
    setDownload,
    downloadBusy,
    build,
    setBuild,
    hasPublishedPreview,
    setHasPublishedPreview,
    sandboxTab,
    setSandboxTab,
    fileTree,
    setFileTree,
    filesFocusPath,
    setFilesFocusPath,
    filesLoading,
    setFilesLoading,
    previewLoading,
    setPreviewLoading,
    unseenPanel,
    setUnseenPanel,
    resultPanelOpen,
    setResultPanelOpen,
    dismissedDeployTurnId,
    setDismissedDeployTurnId,
    gatewayNeeded,
    setGatewayNeeded,
    gatewayDeferred,
    setGatewayDeferred,
    gatewayConfigured,
    setGatewayConfigured,
    gatewaySavedVisible,
    setGatewaySavedVisible,
    gatewayPromptVariant,
    setGatewayPromptVariant,
    gatewayBusy,
    setGatewayBusy,
    resetWorkspace,
    handleDownload,
  };
}

export type WorkspaceStateApi = ReturnType<typeof useWorkspaceState>;
