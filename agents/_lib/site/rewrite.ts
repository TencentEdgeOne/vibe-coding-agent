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
 * Strip sandbox-only `/preview/` URL prefixes so a Pages site at the root can
 * load JS and CSS. Vite preview hard-codes `base: '/preview/'` for the iframe.
 */
export function rewritePreviewPathsForPublish(content: string, relativePath: string): string {
  const name = basename(relativePath);
  const isViteConfig = /^vite\.config\.[cm]?[jt]s$/i.test(name);
  const isHtml = /\.html?$/i.test(name);
  const isScript = /\.[cm]?[jt]sx?$/i.test(name);

  let next = content;

  if (isViteConfig) {
    next = next.replace(/\bbase\s*:\s*(['"])\/preview\/?\1/g, 'base: \'/\'');
    next = next.replace(/\|\|\s*(['"])\/preview\/?\1/g, '|| \'/\'');
  }

  if (isHtml) {
    next = next.replace(/\b(src|href)=(['"])\/preview\//gi, '$1=$2/');
  }

  if (isScript && !isViteConfig) {
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
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
