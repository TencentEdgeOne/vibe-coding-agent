'use client';

import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { HighlightProps } from 'prism-react-renderer';
import type { FileCopy } from '@/app/i18n';
import { Spinner } from '@/app/components/spinner';
import { CODE_THEME, prismLanguage } from './code-theme';
import { formatFileSize, type FilePreviewState } from './format';

type HighlightComponent = (props: HighlightProps) => ReactElement;

let cachedHighlight: HighlightComponent | null = null;
let highlightLoad: Promise<HighlightComponent> | null = null;

function loadHighlight() {
  if (!highlightLoad) {
    highlightLoad = import('prism-react-renderer')
      .then((mod) => {
        cachedHighlight = mod.Highlight as HighlightComponent;
        return cachedHighlight;
      })
      .catch((error) => {
        highlightLoad = null;
        throw error;
      });
  }
  return highlightLoad;
}

function usePrismHighlight() {
  const [ready, setReady] = useState(() => cachedHighlight !== null);

  useEffect(() => {
    if (cachedHighlight) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void loadHighlight()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        // A missing vendor chunk should not unmount the files tab.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return ready ? cachedHighlight : null;
}

function CodeLine({ lineNumber, children }: { lineNumber: number; children: ReactNode }) {
  return (
    <span className="grid min-w-max grid-cols-[3.5rem_minmax(0,1fr)] gap-3 px-4">
      <span className="select-none border-r border-[var(--secondary)] pr-3 text-right text-[var(--code-gutter)]">
        {lineNumber}
      </span>
      <span className="whitespace-pre">{children}</span>
    </span>
  );
}

function CodePre({ children }: { children: ReactNode }) {
  return (
    <pre className="min-h-0 flex-1 overflow-auto bg-[var(--code-paper)] py-3 font-mono text-[12px] leading-5 text-[var(--code-ink)]">
      <code>{children}</code>
    </pre>
  );
}

function PlainCode({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <CodePre>
      {lines.map((line, lineIndex) => (
        <CodeLine key={lineIndex} lineNumber={lineIndex + 1}>
          {line}
        </CodeLine>
      ))}
    </CodePre>
  );
}

function MobileFileBack({ copy, onBack }: { copy: FileCopy; onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="files-view-back h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--n-700)] hover:bg-[var(--secondary)]"
      aria-label={copy.projectFiles}
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      <span>{copy.projectFiles}</span>
    </button>
  );
}

export function FileContentView({
  preview,
  copy,
  onBack,
}: {
  preview: FilePreviewState;
  copy: FileCopy;
  onBack?: () => void;
}) {
  const Highlight = usePrismHighlight();

  if (preview.status === 'idle') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center text-muted-foreground">
        {copy.selectFile}
      </div>
    );
  }
  if (preview.status === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="files-view-header flex min-h-10 items-center gap-2 border-b border-[var(--border)] bg-[var(--code-rail)] px-3 py-1 text-xs text-primary">
          {onBack && <MobileFileBack copy={copy} onBack={onBack} />}
          <Spinner />
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {copy.loading(preview.path)}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }
  if (preview.status === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="files-view-header flex min-h-10 items-center gap-2 border-b border-[var(--border)] bg-[var(--code-rail)] px-3 py-1">
          {onBack && <MobileFileBack copy={copy} onBack={onBack} />}
          <p className="truncate font-mono text-[11px] text-muted-foreground">{preview.path}</p>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-destructive">
          {preview.error}
        </div>
      </div>
    );
  }

  const lines = preview.content.split('\n');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="files-view-header flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--code-rail)] px-3 py-2">
        {onBack && <MobileFileBack copy={copy} onBack={onBack} />}
        <p className="min-w-0 truncate font-mono text-[11px] font-medium text-[var(--n-800)]">
          {preview.path}
        </p>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>{copy.lines(lines.length)}</span>
          <span>{formatFileSize(preview.size)}</span>
          {preview.truncated && (
            <span className="rounded-full bg-[color-mix(in_srgb,var(--gold)_15%,transparent)] px-2 py-0.5 text-[var(--gold)]">
              {copy.truncated}
            </span>
          )}
        </div>
      </div>
      {Highlight ? (
        <Highlight code={preview.content} language={prismLanguage(preview.path)} theme={CODE_THEME}>
          {({ tokens, getTokenProps }) => (
            <CodePre>
              {tokens.map((line, lineIndex) => (
                <CodeLine key={lineIndex} lineNumber={lineIndex + 1}>
                  {line.map((token, key) => (
                    <span key={key} {...getTokenProps({ token })} />
                  ))}
                </CodeLine>
              ))}
            </CodePre>
          )}
        </Highlight>
      ) : (
        <PlainCode content={preview.content} />
      )}
    </div>
  );
}
