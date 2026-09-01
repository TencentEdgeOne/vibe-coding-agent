import { posix } from 'node:path';
import JSZip from 'jszip';

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.html',
  '.htm',
  '.json',
  '.css',
]);

function basename(relativePath: string) {
  return posix.basename(relativePath.replace(/\\/g, '/'));
}

/**
 * Strip sandbox-only `/preview/` URL prefixes so a Makers Pages build at the
 * site root can load JS/CSS. Agent-generated Vite apps hard-code
 * `base: '/preview/'` for the in-sandbox iframe; that produces
 * `<script src="/preview/assets/...">` which 404s (or SPA-falls-back to HTML)
 * when the same build is served at `https://*.edgeone.cool/`.
 */
export function rewritePreviewPathsForPublish(content: string, relativePath: string): string {
  const name = basename(relativePath);
  const isViteConfig = /^vite\.config\.[cm]?[jt]s$/i.test(name);
  const isNextConfig = /^next\.config\.[cm]?[jt]s$/i.test(name);
  const isHtml = /\.html?$/i.test(name);
  const isScript = /\.[cm]?[jt]sx?$/i.test(name);

  let next = content;

  if (isViteConfig) {
    next = next.replace(/\bbase\s*:\s*(['"])\/preview\/?\1/g, 'base: \'/\'');
    next = next.replace(/\|\|\s*(['"])\/preview\/?\1/g, '|| \'/\'');
  }

  if (isNextConfig) {
    // Next.js root is empty string, not '/'.
    next = next.replace(/\bbasePath\s*:\s*(['"])\/preview\/?\1/g, "basePath: ''");
    next = next.replace(/\|\|\s*(['"])\/preview\/?\1/g, '|| \'\'');
  }

  if (isHtml) {
    next = next.replace(/\b(src|href)=(['"])\/preview\//gi, '$1=$2/');
  }

  if (isScript && !isViteConfig && !isNextConfig) {
    next = next.replace(/\bbasename\s*:\s*(['"])\/preview\/?\1/g, "basename: '/'");
    next = next.replace(/\bbasename\s*=\s*(['"])\/preview\/?\1/g, "basename='/'");
  }

  return next;
}

export async function rewritePublishZip(archive: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(archive);
  const rewrites: Promise<void>[] = [];

  zip.forEach((relativePath, file) => {
    if (file.dir) return;
    const ext = posix.extname(relativePath.replace(/\\/g, '/')).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return;

    rewrites.push((async () => {
      const text = await file.async('string');
      const rewritten = rewritePreviewPathsForPublish(text, relativePath);
      if (rewritten !== text) {
        zip.file(relativePath, rewritten);
      }
    })());
  });

  await Promise.all(rewrites);
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
  });
}
