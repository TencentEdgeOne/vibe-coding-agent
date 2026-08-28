import {
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  ExternalLink,
  LoaderCircle,
  Rocket,
} from 'lucide-react';
import type { UiCopy } from '@/app/i18n';
import type { DeploymentInfo } from '@/app/types/workspace';

type DeploymentStatusProps = {
  deployment: DeploymentInfo;
  copy: UiCopy['workspace']['deployment'];
  copied: boolean;
  onCopy: () => void;
};

export function DeploymentStatus({
  deployment,
  copy,
  copied,
  onCopy,
}: DeploymentStatusProps) {
  const statusCopy = deployment.status === 'running'
    ? copy.running
    : deployment.status === 'success'
      ? copy.success
      : copy.failed;

  return (
    <section
      className={`workspace-deployment-status is-${deployment.status}`}
      aria-live="polite"
    >
      <div className="workspace-deployment-heading">
        <span className="workspace-deployment-icon" aria-hidden="true">
          {deployment.status === 'running'
            ? <LoaderCircle className="animate-spin" />
            : deployment.status === 'success'
              ? <CheckCircle2 />
              : <CircleAlert />}
        </span>
        <span>
          <strong>{copy.title}</strong>
          <small>{statusCopy}</small>
        </span>
      </div>

      <div className="workspace-deployment-detail">
        {deployment.status === 'success' && deployment.url && (
          <>
            <a
              href={deployment.url}
              target="_blank"
              rel="noopener noreferrer"
              className="workspace-deployment-url"
              dir="ltr"
            >
              {deployment.url}
            </a>
            {(deployment.projectId || deployment.deploymentId) && (
              <span className="workspace-deployment-meta">
                {deployment.projectId && `${copy.projectId}: ${deployment.projectId}`}
                {deployment.projectId && deployment.deploymentId && ' · '}
                {deployment.deploymentId && `${copy.deploymentId}: ${deployment.deploymentId}`}
              </span>
            )}
          </>
        )}
        {deployment.status === 'failed' && (
          <span className="workspace-deployment-error">
            {deployment.error || copy.failed}
          </span>
        )}
        {deployment.status === 'running' && (
          <span className="workspace-deployment-progress">
            <Rocket aria-hidden="true" />
            {copy.running}
          </span>
        )}
      </div>

      {deployment.status === 'success' && deployment.url && (
        <div className="workspace-deployment-actions">
          <button
            type="button"
            onClick={onCopy}
            className="workspace-deployment-action"
            aria-label={copied ? copy.copied : copy.copyUrl}
            title={copied ? copy.copied : copy.copyUrl}
          >
            {copied ? <Check /> : <Copy />}
            <span>{copied ? copy.copied : copy.copyUrl}</span>
          </button>
          <a
            href={deployment.url}
            target="_blank"
            rel="noopener noreferrer"
            className="workspace-deployment-action"
          >
            <ExternalLink aria-hidden="true" />
            <span>{copy.openUrl}</span>
          </a>
          {deployment.consoleUrl && (
            <a
              href={deployment.consoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="workspace-deployment-action"
            >
              <ExternalLink aria-hidden="true" />
              <span>{copy.openConsole}</span>
            </a>
          )}
        </div>
      )}
    </section>
  );
}
