export function compactUserFacingReply(text: string, fallback: string) {
  const normalized = text.replace(/\r/g, '').trim();
  if (!normalized) return fallback;

  // The first paragraph should contain the user-facing outcome. Everything
  // after it is usually filenames, routes, model IDs, commands, or diagnostics.
  const firstParagraph = normalized.split(/\n\s*\n/)[0]
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstParagraph) return fallback;

  const sentences = firstParagraph.match(/[^。！？.!?]+[。！？.!?]?/g) || [firstParagraph];
  const concise = sentences.slice(0, 2).join('').trim();
  return concise.length <= 180 ? concise : fallback;
}
