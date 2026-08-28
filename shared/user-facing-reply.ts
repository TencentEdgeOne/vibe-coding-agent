const URL_PATTERN = /https?:\/\/[^\s，。、）)]+/g;
const URL_SLOT = /\u0000(\d+)\u0000/g;

export function compactUserFacingReply(text: string, fallback: string) {
  const normalized = text.replace(/\r/g, '').trim();
  if (!normalized) return fallback;

  // A live deployment URL is part of the outcome, but its dots and query string
  // read as sentence ends and its length alone can exceed the prose budget. It
  // is held aside while the prose is trimmed, then put back whole.
  const urls: string[] = [];
  const masked = normalized.replace(URL_PATTERN, (url) => {
    urls.push(url);
    return `\u0000${urls.length - 1}\u0000`;
  });

  // The first paragraph should contain the user-facing outcome. Everything
  // after it is usually filenames, routes, model IDs, commands, or diagnostics.
  const firstParagraph = masked.split(/\n\s*\n/)[0]
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstParagraph) return fallback;

  const sentences = firstParagraph.match(/[^。！？.!?]+[。！？.!?]?/g) || [firstParagraph];
  const concise = sentences.slice(0, 2).join('').trim();
  if (concise.length > 180) return fallback;

  return concise.replace(URL_SLOT, (_, index) => urls[Number(index)] ?? '');
}

/**
 * A live deployment is the one link the reply must carry: unlike the sandbox
 * preview, it outlives the conversation and has nowhere else to be copied from
 * once the turn scrolls away.
 */
export function withLiveDeploymentUrl(reply: string, url?: string) {
  if (!url || reply.includes(url)) {
    return reply;
  }
  const label = /[\u3400-\u9fff]/.test(reply) ? '线上地址：' : 'Live URL: ';
  return `${reply.trim()}\n\n${label}${url}`;
}
