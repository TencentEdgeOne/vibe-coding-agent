/**
 * Throttle sandbox command output so a chatty process (`npm install`,
 * compilers) does not flood the SSE stream. The toolkit already hands us
 * normalized string chunks.
 */

export function createCommandOutputBuffer(options: {
  emit: (accumulated: string) => void;
  intervalMs?: number;
}) {
  let accumulated = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let emittedOnce = false;
  const intervalMs = options.intervalMs ?? 80;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!accumulated) return;
    emittedOnce = true;
    options.emit(accumulated);
  };

  return {
    push(chunk: string) {
      if (!chunk) return;
      accumulated += chunk;
      // First bytes go out immediately so the UI can open the output pane.
      if (!emittedOnce) {
        flush();
        return;
      }
      if (timer) return;
      timer = setTimeout(flush, intervalMs);
    },
    flush,
    get value() {
      return accumulated;
    },
  };
}
