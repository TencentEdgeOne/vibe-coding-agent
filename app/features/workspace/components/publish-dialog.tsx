'use client';

import { AlertCircle, Check, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { UiCopy } from '@/app/i18n';
import type { PublishResult, PublishStage } from '@/app/types/workspace';
import { displayPublishOrigin } from '../../../../shared/publish-target';

const STAGES: PublishStage[] = ['packaging', 'uploading', 'deploying'];

type PublishDialogProps = {
  copy: UiCopy;
  open: boolean;
  busy: boolean;
  stage: PublishStage | null;
  error: string | null;
  result: PublishResult | null;
  copied: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  onCopy: () => void;
  onOpen: () => void;
};

function stageLabel(copy: UiCopy, stage: PublishStage) {
  if (stage === 'packaging') return copy.workspace.publishStagePackaging;
  if (stage === 'uploading') return copy.workspace.publishStageUploading;
  return copy.workspace.publishStageDeploying;
}

function stepStatus(
  step: PublishStage,
  current: PublishStage | null,
  busy: boolean,
  failed: boolean,
  succeeded: boolean,
): 'done' | 'active' | 'error' | 'pending' {
  const index = STAGES.indexOf(step);
  const currentIndex = current ? STAGES.indexOf(current) : -1;
  if (succeeded) return 'done';
  if (failed && index === currentIndex) return 'error';
  if (failed && index < currentIndex) return 'done';
  if (busy && index < currentIndex) return 'done';
  if (busy && index === currentIndex) return 'active';
  if (busy && currentIndex < 0 && index === 0) return 'active';
  return 'pending';
}

export function PublishDialog({
  copy,
  open,
  busy,
  stage,
  error,
  result,
  copied,
  onOpenChange,
  onRetry,
  onCopy,
  onOpen,
}: PublishDialogProps) {
  const previewUrl = result?.previewUrl || '';
  const origin = previewUrl ? displayPublishOrigin(previewUrl) : '';
  const failed = Boolean(error) && !busy;
  const succeeded = !busy && !error && Boolean(previewUrl);
  const finishedWithoutUrl = !busy && !error && result && !previewUrl;
  const tokenMissing = Boolean(error?.includes('MAKERS_API_TOKEN'));

  const title = busy
    ? copy.workspace.publishDialogTitle
    : failed
      ? copy.workspace.publishFailedTitle
      : copy.workspace.publishSuccessTitle;

  const description = busy
    ? copy.workspace.publishDialogDescription
    : failed
      ? (tokenMissing ? copy.workspace.publishTokenMissing : error)
      : succeeded
        ? copy.workspace.publishSuccessDescription
        : copy.workspace.publishNoUrl;

  const icon = failed
    ? <AlertCircle />
    : succeeded || finishedWithoutUrl
      ? <Check />
      : <Upload />;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen: boolean) => {
        if (!nextOpen && busy) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="contact-dialog"
        overlayClassName="contact-dialog-overlay"
        showCloseButton={false}
      >
        <DialogHeader>
          <div className="contact-dialog-icon" aria-hidden="true">{icon}</div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          {(busy || failed) && (
            <ol className="publish-steps">
              {STAGES.map((step) => {
                const status = stepStatus(step, stage, busy, failed, succeeded);
                return (
                  <li key={step} className={`publish-step is-${status}`}>
                    <span className="publish-step-mark" aria-hidden="true">
                      {status === 'active'
                        ? <span className="publish-step-spinner" />
                        : status === 'done'
                          ? <Check />
                          : status === 'error'
                            ? <AlertCircle />
                            : null}
                    </span>
                    <span>{stageLabel(copy, step)}</span>
                  </li>
                );
              })}
            </ol>
          )}
          {succeeded && origin && (
            <a
              className="publish-origin-link"
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {origin}
            </a>
          )}
        </DialogHeader>
        <DialogFooter className="contact-dialog-footer publish-dialog-footer">
          {busy ? (
            <p className="publish-cannot-close">{copy.workspace.publishCannotClose}</p>
          ) : (
            <DialogClose asChild>
              <Button variant="outline">{copy.workspace.publishClose}</Button>
            </DialogClose>
          )}
          {failed && (
            <Button onClick={onRetry}>{copy.workspace.publishRetry}</Button>
          )}
          {succeeded && (
            <>
              <Button variant="outline" onClick={onCopy}>
                {copied ? copy.workspace.publishCopied : copy.workspace.publishCopy}
              </Button>
              <Button onClick={onOpen}>{copy.workspace.publishOpen}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
