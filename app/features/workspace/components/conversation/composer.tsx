'use client';

import { FormEvent, memo } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { ModelPicker } from '../model-picker';
import type { ConversationCopy, ModelOption } from './types';

export const Composer = memo(function Composer({
  input,
  loading,
  stopping,
  canSend,
  copy,
  models,
  model,
  onModelChange,
  onInputChange,
  onSubmit,
  onStop,
}: {
  input: string;
  loading: boolean;
  stopping: boolean;
  canSend: boolean;
  copy: ConversationCopy;
  models: readonly ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      onSubmit={submit}
      className={`conversation-composer${stopping ? ' is-stopping' : ''}`}
      aria-busy={stopping}
    >
      <textarea
        value={input}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (!loading && !stopping && canSend) onSubmit();
          }
        }}
        disabled={stopping}
        placeholder={copy.placeholder}
        rows={1}
      />
      {/* Locked mid-run: the turn already went out on a model, and letting the
          control move would show one name while another was answering. */}
      <ModelPicker
        models={models}
        value={model}
        ariaLabel={copy.modelLabel}
        disabled={loading || stopping}
        onChange={onModelChange}
      />
      {loading || stopping ? (
        <button
          type="button"
          className={`composer-stop${stopping ? ' is-stopping' : ''}`}
          onClick={onStop}
          disabled={stopping}
          title={stopping ? copy.stopping : copy.stop}
          aria-label={stopping ? copy.stopping : copy.stop}
          aria-busy={stopping}
        >
          {stopping ? (
            <span className="composer-stop-spinner" aria-hidden="true" />
          ) : (
            <Square className="size-3" fill="currentColor" />
          )}
          {stopping && (
            <span className="composer-stop-label" role="status" aria-live="polite">
              {copy.stopping}
            </span>
          )}
        </button>
      ) : (
        <button type="submit" className="composer-send" disabled={!canSend} title={copy.send} aria-label={copy.send}>
          <ArrowUp className="size-4" />
        </button>
      )}
    </form>
  );
});
