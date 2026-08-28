'use client';

import { ArrowLeft, Download, MessageCircle, Rocket, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { LanguageSwitch } from '@/app/components/language-switch';
import type { Locale, UiCopy } from '@/app/i18n';

type SiteHeaderProps = {
  copy: UiCopy;
  language: Locale;
  hasWorkspace: boolean;
  canDownload: boolean;
  downloadBusy: boolean;
  contactUrl: string;
  canDeploy: boolean;
  deployBusy: boolean;
  deployHint: string;
  onLanguageChange: (language: Locale) => void;
  onDownload: () => void;
  onBack: () => void;
  onDeploy: () => void;
  showExportTranscript?: boolean;
  canExportTranscript?: boolean;
  onExportTranscript?: () => void;
};

export function SiteHeader({
  copy,
  language,
  hasWorkspace,
  canDownload,
  downloadBusy,
  contactUrl,
  canDeploy,
  deployBusy,
  deployHint,
  onLanguageChange,
  onDownload,
  onBack,
  onDeploy,
  showExportTranscript = false,
  canExportTranscript = false,
  onExportTranscript,
}: SiteHeaderProps) {
  const isZh = language === 'zh';

  const downloadHint = downloadBusy ? copy.workspace.downloading : copy.workspace.downloadSource;
  const exportHint = canExportTranscript
    ? copy.workspace.exportTranscript
    : copy.workspace.exportTranscriptEmpty;

  return (
    <header className="site-topbar">
      <div className="site-brand-cluster">
        {hasWorkspace && (
          <span className="site-hint is-start" data-hint={copy.workspace.back}>
            <button
              type="button"
              onClick={onBack}
              className="site-icon-button is-ghost"
              aria-label={copy.workspace.back}
            >
              <ArrowLeft />
            </button>
          </span>
        )}
        <div className="site-brand" aria-label="MAKERS VIBE CODING">MAKERS VIBE CODING</div>
      </div>
      <div className="site-topbar-actions">
        {!hasWorkspace && (
          <LanguageSwitch
            language={language}
            onChange={onLanguageChange}
            ariaLabel={copy.languageToggleAria}
            className="site-language"
          />
        )}
        {/* Taking something out of this session: quiet icons, kept together. */}
        {(showExportTranscript || hasWorkspace) && (
          <div className="site-topbar-group">
            {showExportTranscript && (
              <span className="site-hint" data-hint={exportHint}>
                <button
                  type="button"
                  onClick={onExportTranscript}
                  disabled={!canExportTranscript}
                  className="site-icon-button"
                  aria-label={exportHint}
                >
                  <ScrollText />
                </button>
              </span>
            )}
            {hasWorkspace && (
              <span className="site-hint" data-hint={downloadHint}>
                <button
                  type="button"
                  onClick={onDownload}
                  disabled={downloadBusy || !canDownload}
                  className="site-icon-button"
                  aria-label={downloadHint}
                >
                  {downloadBusy
                    ? <span className="size-3.5 animate-spin rounded-full border-2 border-transparent border-t-current" />
                    : <Download />}
                </button>
              </span>
            )}
          </div>
        )}
        {/* Reaching outside the session: shipping the project, then talking
            to us about it. */}
        <div className="site-topbar-group">
          {hasWorkspace && (
            /* Only worth a hint while it refuses to run; when it is ready the
               label already says everything. */
            <span className="site-hint" data-hint={canDeploy ? undefined : deployHint}>
              <button
                type="button"
                onClick={onDeploy}
                disabled={!canDeploy}
                className="site-primary-button"
              >
                {deployBusy
                  ? <span className="size-3.5 animate-spin rounded-full border-2 border-transparent border-t-current" />
                  : <Rocket aria-hidden="true" />}
                {deployBusy ? copy.workspace.deployBusy : copy.deployLabel}
              </button>
            </span>
          )}
          <Dialog>
            <DialogTrigger asChild>
              <button type="button" className="site-accent-button">
                {isZh ? '联系我们' : 'Contact'}
              </button>
            </DialogTrigger>
            <DialogContent
              className="contact-dialog"
              overlayClassName="contact-dialog-overlay"
              showCloseButton={false}
            >
              <DialogHeader>
                <div className="contact-dialog-icon" aria-hidden="true"><MessageCircle /></div>
                <DialogTitle>
                  {isZh ? '集成平台化部署能力' : 'Integrate deployment capabilities'}
                </DialogTitle>
                <DialogDescription>
                  {isZh
                    ? '希望把代码生成、实时预览与全球加速部署能力集成到你自己的产品中？我们提供开放 API 与专属技术支持，可根据你的业务场景定制接入方案。欢迎与我们联系，一起聊聊具体需求。'
                    : "Want to bring code generation, live preview, and globally accelerated deployment into your own product? We provide open APIs and dedicated technical support tailored to your business needs. Get in touch and let's talk."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="contact-dialog-footer">
                <DialogClose asChild>
                  <Button variant="outline">{isZh ? '取消' : 'Cancel'}</Button>
                </DialogClose>
                <Button asChild>
                  <a href={contactUrl} target="_blank" rel="noreferrer">
                    {isZh ? '联系我们' : 'Contact us'}
                  </a>
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </header>
  );
}
