/** Stable for the life of this process. Logs use it to tell instances apart. */
const INSTANCE_ID = Math.random().toString(36).slice(2, 10);

export function instanceId() {
  return INSTANCE_ID;
}
