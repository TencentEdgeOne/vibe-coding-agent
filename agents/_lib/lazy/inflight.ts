/**
 * In-flight work, scoped to the request object.
 *
 * Two concurrent callers in one request must share a promise. The memo cannot
 * outlive the request: each request holds its own `ProjectState`, and sharing
 * that object across requests would persist one request's copy from another.
 */
const inFlight = new WeakMap<object, Map<string, Promise<unknown>>>();

function trackerFor(context: object) {
  let pending = inFlight.get(context);
  if (!pending) {
    pending = new Map();
    inFlight.set(context, pending);
  }
  return pending;
}

/** Share concurrent work, then forget it, so the next caller re-checks. */
export function once<T>(context: object, key: string, run: () => Promise<T>): Promise<T> {
  if (!context || typeof context !== 'object') return run();
  const pending = trackerFor(context);
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const entry: { promise?: Promise<T> } = {};
  entry.promise = run().finally(() => {
    if (pending.get(key) === entry.promise) pending.delete(key);
  });
  pending.set(key, entry.promise);
  return entry.promise;
}

/**
 * Share the answer for the rest of the request.
 *
 * A rejection is dropped rather than kept, so a failed activation can be
 * retried within the same request.
 */
export function settled<T>(context: object, key: string, run: () => Promise<T>): Promise<T> {
  if (!context || typeof context !== 'object') return run();
  const pending = trackerFor(context);
  const existing = pending.get(key);
  if (existing) return existing as Promise<T>;
  const entry: { promise?: Promise<T> } = {};
  entry.promise = run().catch((error) => {
    if (pending.get(key) === entry.promise) pending.delete(key);
    throw error;
  });
  pending.set(key, entry.promise);
  return entry.promise;
}
