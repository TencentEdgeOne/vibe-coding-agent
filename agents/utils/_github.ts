import { unzipSync, gunzipSync } from 'fflate';

import { ARCHIVE_EXCLUDED_DIRECTORIES } from '../_constants';

// One file extracted from the project snapshot, ready to push as a git blob.
export type GitFile = { path: string; bytes: Uint8Array };

const EXCLUDED = new Set(ARCHIVE_EXCLUDED_DIRECTORIES);

// Normalize an archive entry path: drop leading "./" / "/", reject traversal, and
// skip anything under an excluded dir (node_modules/.next/... — defensive; the
// snapshot already excludes them). Returns '' for paths that must be dropped.
function normalizeEntryPath(raw: string): string {
  let path = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
  if (!path || path.endsWith('/')) return '';
  const segments = path.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return '';
  if (segments.some((s) => EXCLUDED.has(s))) return '';
  return path;
}

// Minimal POSIX/ustar tar reader: 512-byte header blocks, octal size at 124, type
// flag at 156, optional ustar name prefix at 345. Handles regular files (type '0'
// or '\0'); skips directories and other entry types. Enough for `tar -czf . `.
function parseTar(buf: Uint8Array): GitFile[] {
  const files: GitFile[] = [];
  const decoder = new TextDecoder();
  let offset = 0;

  const readString = (start: number, len: number) => {
    const slice = buf.subarray(start, start + len);
    const nul = slice.indexOf(0);
    return decoder.decode(nul === -1 ? slice : slice.subarray(0, nul)).trim();
  };

  while (offset + 512 <= buf.length) {
    // Two consecutive zero blocks mark the end of the archive.
    if (buf.subarray(offset, offset + 512).every((b) => b === 0)) break;

    const name = readString(offset, 100);
    const sizeOctal = readString(offset + 124, 12);
    const typeFlag = String.fromCharCode(buf[offset + 156] || 0);
    const prefix = readString(offset + 345, 155);
    const size = parseInt(sizeOctal || '0', 8) || 0;
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += 512;
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      const path = normalizeEntryPath(fullName);
      if (path) files.push({ path, bytes: buf.subarray(offset, offset + size) });
    }
    // Advance past the (512-aligned) content.
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

// Decode the base64 snapshot and unpack it to a flat file list. Supports both
// formats §四 can produce: zip (default) and tar.gz (fallback when the sandbox has
// no `zip` binary). See plan/github-oauth-claim.md §5.3-④.
export function decompressSnapshot(base64: string, isTar: boolean): GitFile[] {
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (isTar) {
    return parseTar(gunzipSync(bytes));
  }
  const entries = unzipSync(bytes);
  const files: GitFile[] = [];
  for (const [raw, content] of Object.entries(entries)) {
    const path = normalizeEntryPath(raw);
    // unzipSync yields 0-byte entries for directories; skip those.
    if (path && content.length >= 0 && !raw.endsWith('/')) {
      files.push({ path, bytes: content });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// GitHub API helpers. All requests go through global fetch (Node 18+ runtime).
// The access token is passed in and used only in-memory — never persisted.
// ---------------------------------------------------------------------------

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'vibe-coding-agent';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Retry `fn` while GitHub reports the target not yet ready (404/409) — used for the
// first git write right after a repo is created, whose backend may lag a beat. Other
// statuses (and the final attempt) propagate unchanged.
async function retryOnNotReady<T>(
  fn: () => Promise<T>,
  { tries = 3, delayMs = 800 }: { tries?: number; delayMs?: number } = {},
): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const notReady = error?.status === 404 || error?.status === 409;
      if (!notReady || attempt === tries - 1) throw error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function ghRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = json?.message || text || `${res.status}`;
    const error = new Error(message) as Error & { status?: number; body?: any };
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return json;
}

// Exchange the OAuth `code` for a user access token. client_secret is read by the
// caller from context.env and passed here — it stays server-side, never logged.
export async function exchangeCodeForToken(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri?: string;
}): Promise<string> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      ...(params.redirectUri ? { redirect_uri: params.redirectUri } : {}),
    }),
  });
  const data = await res.json().catch(() => null);
  const token = data?.access_token;
  if (!res.ok || !token || typeof token !== 'string') {
    throw new Error(data?.error_description || data?.error || 'token exchange failed');
  }
  return token;
}

export async function getAuthenticatedUser(token: string): Promise<{ login: string }> {
  const user = await ghRequest(token, 'GET', '/user');
  if (!user?.login) throw new Error('could not resolve authenticated user');
  return { login: String(user.login) };
}

export type CreatedRepo = {
  fullName: string;
  htmlUrl: string;
  owner: string;
  name: string;
  defaultBranch: string;
};

// Create a repo under the authenticated user, retrying once with a suffixed name
// on a name collision. auto_init:true so the repo has an initial commit — the Git
// Data API's create-tree returns 409 "Git Repository is empty" on a repo with zero
// commits, so a truly empty repo can never be written to. We push our own commit on
// top and force-update the default branch (that auto-init commit is left dangling).
export async function createRepoWithRetry(
  token: string,
  owner: string,
  name: string,
): Promise<CreatedRepo> {
  const attempt = async (repoName: string): Promise<CreatedRepo> => {
    const repo = await ghRequest(token, 'POST', '/user/repos', {
      name: repoName,
      private: false,
      auto_init: true,
      description: 'Generated by Vibe Coding Agent',
    });
    return {
      fullName: String(repo.full_name),
      htmlUrl: String(repo.html_url),
      owner,
      name: String(repo.name),
      defaultBranch: String(repo.default_branch || 'main'),
    };
  };

  try {
    return await attempt(name);
  } catch (error: any) {
    const exists = error?.status === 422
      && /already exists|name already/i.test(String(error?.message || ''));
    if (!exists) throw error;
    // One retry with a short suffix; use the code's length as a cheap, deterministic
    // variator (Math.random is fine at runtime, but keep it simple/stable).
    const suffix = String(Date.now()).slice(-4);
    return attempt(`${name}-${suffix}`);
  }
}

// Push the whole file set as a single commit via the Git Data API (tree → commit →
// ref). To stay well under the cloud-function time limit we avoid one-blob-per-file
// round-trips: text files are inlined into the tree via `content` (GitHub creates
// their blobs as part of the tree call), so an all-text project needs just 3 API
// calls total. Only binary files still need explicit base64 blobs, created with
// bounded concurrency. The repo was created with auto_init:true (so create-tree does
// not 409 on an empty repo); we commit as an orphan (no parents) and force-update the
// default branch, leaving the auto-init commit dangling.
export async function pushFilesAsCommit(params: {
  token: string;
  owner: string;
  repo: string;
  files: GitFile[];
  message: string;
  branch?: string;
}): Promise<void> {
  const { token, owner, repo, files } = params;
  const branch = params.branch || 'main';
  const base = `/repos/${owner}/${repo}`;

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const tree: Array<Record<string, string>> = [];
  const binaryFiles: GitFile[] = [];

  for (const file of files) {
    let text: string | null = null;
    if (!file.bytes.includes(0)) {
      try {
        text = decoder.decode(file.bytes);
      } catch {
        text = null; // Not valid UTF-8 → treat as binary.
      }
    }
    if (text !== null) {
      tree.push({ path: file.path, mode: '100644', type: 'blob', content: text });
    } else {
      binaryFiles.push(file);
    }
  }

  // Create blobs for binary files only, in bounded-concurrency batches.
  const CONCURRENCY = 8;
  for (let i = 0; i < binaryFiles.length; i += CONCURRENCY) {
    const batch = binaryFiles.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((file) =>
      ghRequest(token, 'POST', `${base}/git/blobs`, {
        content: Buffer.from(file.bytes).toString('base64'),
        encoding: 'base64',
      }).then((blob) => ({ path: file.path, sha: blob.sha as string })),
    ));
    for (const r of results) {
      tree.push({ path: r.path, mode: '100644', type: 'blob', sha: r.sha });
    }
  }

  // A repo created via POST /user/repos is often not immediately writable by the
  // Git Data API: the git backend can lag a beat, so the first write (this tree
  // call) returns 404/409 ("Git Repository is empty"/not found) and leaves the repo
  // empty. Retry the first write a few times before giving up.
  const createdTree = await retryOnNotReady(() =>
    ghRequest(token, 'POST', `${base}/git/trees`, { tree }),
  );
  const commit = await ghRequest(token, 'POST', `${base}/git/commits`, {
    message: params.message,
    tree: createdTree.sha,
  });

  // The default branch already exists (auto_init), so force-update it to our orphan
  // commit. Fall back to creating the ref if it is somehow missing.
  try {
    await ghRequest(token, 'PATCH', `${base}/git/refs/heads/${branch}`, {
      sha: commit.sha,
      force: true,
    });
  } catch (error: any) {
    if (error?.status === 404 || error?.status === 422) {
      await ghRequest(token, 'POST', `${base}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    } else {
      throw error;
    }
  }
}
