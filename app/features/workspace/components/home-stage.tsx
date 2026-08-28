'use client';

import type { FormEvent, KeyboardEvent } from 'react';
import { Bot, Database, Layers, Server, Sparkles } from 'lucide-react';
import type { HomeFeatureIcon, Locale, UiCopy } from '@/app/i18n';

type HomeStageProps = {
  copy: UiCopy;
  locale: Locale;
  input: string;
  placeholder: string;
  canSend: boolean;
  loading: boolean;
  onInputChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSend: () => void;
};

function FeatureIcon({ icon }: { icon: HomeFeatureIcon }) {
  if (icon === 'agent') return <Bot aria-hidden="true" />;
  if (icon === 'functions') return <Server aria-hidden="true" />;
  if (icon === 'storage') return <Database aria-hidden="true" />;
  return <Layers aria-hidden="true" />;
}

export function HomeStage({
  copy,
  locale,
  input,
  placeholder,
  canSend,
  loading,
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
    <section className="home-stage scroll-quiet">
      {/* my-auto centers the hero when it fits and keeps the top reachable when it
          does not, which justify-center would clip. */}
      <div className="home-inner my-auto">
        <ol className="home-pipeline">
          {copy.home.pipeline.map((phase) => (
            <li key={phase} className="home-pipeline-step">
              {phase}
            </li>
          ))}
        </ol>

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
          />
          <div className="home-composer-actions">
            <div className="home-examples">
              {copy.home.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="home-example"
                  onClick={() => onInputChange(example)}
                >
                  {example}
                </button>
              ))}
            </div>
            <button type="submit" disabled={!canSend} className="home-submit">
              {loading ? <span className="home-submit-spinner" /> : <Sparkles />}
              {copy.home.fastBuild}
            </button>
          </div>
        </form>

        {/* Platform capabilities, shown for context only — nothing here is a control. */}
        <ul className="home-features">
          {copy.home.features.map((feature) => (
            <li key={feature.title} className="home-feature">
              <span className="home-feature-icon">
                <FeatureIcon icon={feature.icon} />
              </span>
              <span className="home-feature-copy">
                <strong>{feature.title}</strong>
                <span>{feature.desc}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
