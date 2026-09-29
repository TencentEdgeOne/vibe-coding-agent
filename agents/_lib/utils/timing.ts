import { instanceId } from '../runtime/instance.ts';

/**
 * Wake latency is otherwise unmeasurable from production: the only other
 * signal is the frontend progress bar, whose stage durations are hardcoded.
 */
export async function timeStage<T>(
  scope: string,
  details: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let failed = false;
  try {
    return await run();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    console.info(`[${scope}]`, {
      instance: instanceId(),
      ...details,
      ms: Date.now() - startedAt,
      ...(failed ? { failed: true } : {}),
    });
  }
}
