'use client';

import { Download, MessageCircle } from 'lucide-react';
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
  showDeploy: boolean;
  onLanguageChange: (language: Locale) => void;
  onDownload: () => void;
  onNewProject: () => void;
  onDeploy: () => void;
};

export function SiteHeader({
  copy,
  language,
  hasWorkspace,
  canDownload,
  downloadBusy,
  contactUrl,
  showDeploy,
  onLanguageChange,
  onDownload,
  onNewProject,
  onDeploy,
}: SiteHeaderProps) {
  const isZh = language === 'zh';

  return (
    <header className="site-topbar">
      <div className="site-brand" aria-label="MAKERS VIBE CODING">MAKERS VIBE CODING</div>
      <div className="site-topbar-actions">
        {!hasWorkspace && (
          <LanguageSwitch
            language={language}
            onChange={onLanguageChange}
            ariaLabel={copy.languageToggleAria}
            className="site-language"
          />
        )}
        {hasWorkspace && canDownload && (
          <button
            type="button"
            onClick={onDownload}
            disabled={downloadBusy}
            className="site-icon-button"
            aria-label={downloadBusy ? copy.workspace.downloading : copy.workspace.downloadSource}
            title={downloadBusy ? copy.workspace.downloading : copy.workspace.downloadSource}
          >
            {downloadBusy
              ? <span className="size-4 animate-spin rounded-full border-2 border-transparent border-t-current" />
              : <Download />}
          </button>
        )}
        {hasWorkspace && (
          <button type="button" onClick={onNewProject} className="site-secondary-button">
            {copy.workspace.newProject}
          </button>
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
