'use client';

import type { FormEvent, KeyboardEvent } from 'react';
import { Sparkles } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { ModelPicker } from '@/app/components/model-picker';
import type { Locale, UiCopy } from '@/app/i18n';
import type { ModelOption } from '../../../../shared/models';

type HomeStageProps = {
  copy: UiCopy;
  locale: Locale;
  input: string;
  placeholder: string;
  canSend: boolean;
  loading: boolean;
  models: readonly ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSend: () => void;
};

export function HomeStage({
  copy,
  locale,
  input,
  placeholder,
  canSend,
  loading,
  models,
  model,
  onModelChange,
  onInputChange,
  onSubmit,
  onSend,
}: HomeStageProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSend();
    }
  };

  return (
    <section className="home-stage flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="w-full max-w-[820px]">
        <h1 className="text-[clamp(2rem,4vw,2.75rem)] font-bold leading-[1.18]">
          {copy.home.titleBefore}
          {locale === 'en' ? ' ' : ''}
          <span className="text-primary">{copy.home.titleAccent}</span>
          {locale === 'en' ? ' ' : ''}
          {copy.home.titleAfter}
        </h1>
        <p className="mt-3 text-[15px] text-muted-foreground">{copy.home.subtitle}</p>

        <Card className="home-composer mt-8 gap-0 overflow-visible rounded-[10px] border-border p-4 text-left shadow-none transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(47,107,255,0.12)]">
          <form onSubmit={onSubmit}>
            <Textarea
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder || copy.home.placeholder}
              rows={3}
              className="min-h-[104px] resize-none border-0 bg-transparent px-1 py-1 text-[14px] leading-relaxed shadow-none focus-visible:ring-0"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              {/* Sits with the submit button rather than among the example chips:
                  both are about how this run happens, the chips are about what to
                  ask for. */}
              <ModelPicker
                models={models}
                value={model}
                ariaLabel={copy.workspace.modelLabel}
                disabled={loading}
                onChange={onModelChange}
              />
              <button
                type="submit"
                disabled={!canSend}
                aria-label={copy.home.fastBuild}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-[var(--brand-deep)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? (
                  <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                {copy.home.fastBuild}
              </button>
            </div>
          </form>
        </Card>

        <div className="mt-5 flex flex-wrap justify-center gap-2.5">
          {copy.home.examples.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => onInputChange(example)}
              className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-[12px] text-secondary-foreground transition-colors hover:border-primary/45 hover:bg-accent hover:text-accent-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
