'use client';

import { MessageCircle } from 'lucide-react';
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

const BRAND_MARK = 'MAKERS VIBE CODING';

type SiteHeaderProps = {
  copy: UiCopy;
  language: Locale;
  hasWorkspace: boolean;
  contactUrl: string;
  showDeploy: boolean;
  onLanguageChange: (language: Locale) => void;
  onNewProject: () => void;
  onDeploy: () => void;
  showExportTranscript?: boolean;
  canExportTranscript?: boolean;
  onExportTranscript?: () => void;
  canExportSession?: boolean;
  exportSessionBusy?: boolean;
  onExportSession?: () => void;
};

export function SiteHeader({
  copy,
  language,
  hasWorkspace,
  contactUrl,
  showDeploy,
  onLanguageChange,
  onNewProject,
  onDeploy,
  showExportTranscript = false,
  canExportTranscript = false,
  onExportTranscript,
  canExportSession = false,
  exportSessionBusy = false,
  onExportSession,
}: SiteHeaderProps) {
  const isZh = language === 'zh';

  return (
    <header className="site-topbar">
      <div className="site-brand-cluster">
        {hasWorkspace ? (
          <button
            type="button"
            onClick={onNewProject}
            className="site-brand is-back"
            aria-label={copy.workspace.back}
            title={copy.workspace.back}
            style={{ gap: 8 }}
          >
            <svg
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="none"
              aria-hidden="true"
              style={{ color: '#17181c', flex: '0 0 13px' }}
            >
              <path
                d="M10.2 3.2 5.4 8l4.8 4.8"
                stroke="currentColor"
                strokeWidth="1.85"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{BRAND_MARK}</span>
          </button>
        ) : (
          <div className="site-brand" aria-label={BRAND_MARK}>{BRAND_MARK}</div>
        )}
        {showExportTranscript && (
          <>
            <button
              type="button"
              onClick={onExportTranscript}
              disabled={!canExportTranscript}
              className="site-secondary-button"
              title={canExportTranscript ? copy.workspace.exportTranscript : copy.workspace.exportTranscriptEmpty}
            >
              {copy.workspace.exportTranscript}
            </button>
            <button
              type="button"
              onClick={onExportSession}
              disabled={!canExportSession || exportSessionBusy}
              className="site-secondary-button"
              title={
                exportSessionBusy
                  ? copy.workspace.exportSessionBusy
                  : canExportSession
                    ? copy.workspace.exportSession
                    : copy.workspace.exportSessionEmpty
              }
            >
              {exportSessionBusy
                ? copy.workspace.exportSessionBusy
                : copy.workspace.exportSession}
            </button>
          </>
        )}
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
        {hasWorkspace && showDeploy && (
          <button type="button" onClick={onDeploy} className="site-secondary-button">
            {copy.deployLabel}
          </button>
        )}
        <Dialog>
          <DialogTrigger asChild>
            <Button size="sm" className="h-7 px-3 text-xs">
              {isZh ? '联系我们' : 'Contact'}
            </Button>
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
    </header>
  );
}
