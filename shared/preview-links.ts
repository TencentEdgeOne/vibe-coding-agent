/**
 * The preview lives in the right panel, so any preview URL the model repeats in
 * its text is removed before the frontend sees it.
 *
 * `preserveEdges` is required for streamed narration: every delta is a fragment of
 * one sentence, so trimming it would eat the space between two tokens and paint
 * "I can only help" as "Icanonlyhelp".
 */
export function stripReturnedPreviewLinks(
  text: string,
  previewUrl?: string,
  options: { preserveEdges?: boolean } = {},
) {
  if (!text || !previewUrl) {
    return text;
  }
  const escapedUrl = escapeRegExp(previewUrl);
  const stripped = text
    .replace(new RegExp(`\\s*\\[[^\\]]*(?:打开预览|预览|preview)[^\\]]*\\]\\(${escapedUrl}\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*${escapedUrl}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n');
  return options.preserveEdges ? stripped : stripped.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
