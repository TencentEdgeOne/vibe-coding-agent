/**
 * Normalize and throttle sandbox command output so a chatty process
 * (`npm install`, compilers) does not flood the SSE stream.
 */

export type CommandStreamChunk = {
  stream: 'stdout' | 'stderr';
  data: string;
};

export function normalizeCommandChunk(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const record = data as { line?: unknown; text?: unknown };
    if (typeof record.line === 'string') return record.line;
    if (typeof record.text === 'string') return record.text;
  }
  return data == null ? '' : String(data);
}

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
