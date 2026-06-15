export function isDebugEnabled(context: any) {
  const value = context?.env?.WEB_DEV_AGENT_DEBUG;
  if (typeof value !== 'string') {
    return false;
  }
  return value === 'true' || value === '1';
}

export function debugLog(context: any, label: string, data?: unknown) {
  if (!isDebugEnabled(context)) {
    return;
  }
  if (data === undefined) {
    console.warn(label);
    return;
  }
  console.warn(label, data);
}
