'use client';

import type { FormEvent, KeyboardEvent } from 'react';
import { BookOpen, Server, Sparkles } from 'lucide-react';
import type { HomeFeatureIcon, Locale, UiCopy } from '@/app/i18n';
import { ModelPicker } from './model-picker';
import type { ModelOption } from '../../../../shared/models';

type HomeStageProps = {
  copy: UiCopy;
  locale: Locale;
  input: string;
  placeholder: string;
  canSend: boolean;
  loading: boolean;
  stopping: boolean;
  models: readonly ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSend: () => void;
};

// lucide fits every glyph to the same 24×24 box but they fill very different
// amounts of it, so one shared size draws them at visibly different weights.
// These are matched on each drawing's own extent instead: Server and BookOpen
// both reach all four edges of the box, so they share a size.
function FeatureIcon({ icon }: { icon: HomeFeatureIcon }) {
  if (icon === 'skills') return <BookOpen aria-hidden="true" size={15} />;
  return <Server aria-hidden="true" size={15} />;
}

export function HomeStage({
  copy,
  locale,
  input,
  placeholder,
  canSend,
  loading,
  stopping,
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
      if (!loading && !stopping && canSend) onSend();
    }
  };

  return (
    <section className="home-stage scroll-quiet">
      {/* my-auto centers the hero when it fits and keeps the top reachable when it
          does not, which justify-center would clip. */}
      <div className="home-inner my-auto">
        <h1 className="home-title">
          {copy.home.titleBefore}
          {locale === 'en' ? ' ' : ''}
          <span className="home-title-accent">{copy.home.titleAccent}</span>
          {locale === 'en' ? ' ' : ''}
          {copy.home.titleAfter}
        </h1>
        <p className="home-subtitle">{copy.home.subtitle}</p>

        <form className="home-composer" onSubmit={onSubmit}>
          <textarea
            value={input}
            onChange={(event) => onInputChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || copy.home.placeholder}
            rows={3}
            disabled={stopping}
          />
          <div className="home-composer-actions">
            <div className="home-examples">
              {copy.home.examples.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  className="home-example"
                  onClick={() => onInputChange(example.prompt)}
                >
                  {/* Carries the truncation itself: text sitting directly in a
                      flex container becomes an anonymous item, and text-overflow
                      does not inherit onto it, so the chip would clip its label
                      mid-character instead of ellipsizing it. */}
                  <span className="home-example-label">{example.label}</span>
                </button>
              ))}
            </div>
            {/* Sits with the submit button rather than among the example chips:
                both are about how this run happens, the chips are about what to
                ask for. */}
            <ModelPicker
              models={models}
              value={model}
              ariaLabel={copy.workspace.modelLabel}
              disabled={loading || stopping}
              onChange={onModelChange}
            />
            <button type="submit" disabled={!canSend} className="home-submit">
              {loading || stopping ? <span className="home-submit-spinner" /> : <Sparkles />}
              {stopping ? copy.workspace.stopping : copy.home.fastBuild}
            </button>
          </div>
        </form>

        {copy.home.features.length > 0 && (
        <ul className="home-features">
          {copy.home.features.map((feature) => (
            <li key={feature.title} className="home-feature">
              <span className="home-feature-copy">
                <strong>
                  <span className="home-feature-icon">
                    <FeatureIcon icon={feature.icon} />
                  </span>
                  {feature.title}
                </strong>
                <span className="home-feature-desc">{feature.desc}</span>
              </span>
            </li>
          ))}
        </ul>
        )}
      </div>
    </section>
  );
}
