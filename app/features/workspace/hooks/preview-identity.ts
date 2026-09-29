export function isSamePreviewTarget(a: string, b: string) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

export function isPreviewMessageOrigin(origin: string, previewUrls: readonly string[]) {
  if (!origin || origin === 'null') return false;
  return previewUrls.some((url) => {
    if (!url) return false;
    try {
      return new URL(url).origin === origin;
    } catch {
      return false;
    }
  });
}
