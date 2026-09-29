import type { AgentContext } from '../runtime/context.ts';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { OBSERVER_STREAM_MAX_MS } from '../lazy/budgets.ts';
import { getRequestQueryParam, resolveConversationId } from '../runtime/request.ts';
import { createSSEResponse, sseEvent } from '../runtime/sse.ts';
import { getBlobStore, getConversationRecord, patchConversationRecord, transcriptBlobKey } from './store.ts';
import { assertCanWrite } from './ownership.ts';

const TRANSCRIPT_WATCH_MS = 250;

const TRANSCRIPT_WARN_BYTES = 32 * 1024 * 1024;

function toNodeReadable(value: unknown): Readable | null {
  if (!value) return null;
  if (value instanceof Readable) return value;
  if (typeof (value as ReadableStream).getReader === 'function') {
    return Readable.fromWeb(value as import('node:stream/web').ReadableStream);
  }
  if (typeof value === 'string') {
    return Readable.from([value]);
  }
  return null;
}

export async function downloadTranscript(options: {
  context: { blobStore?: import('../runtime/context.ts').BlobStoreLike };
  conversationId: string;
  sessionId: string;
  destPath: string;
}): Promise<boolean> {
  const store = getBlobStore(options.context);
  const body = await store.get(transcriptBlobKey(options.sessionId), { type: 'stream' });
  const readable = toNodeReadable(body);
  if (!readable) return false;

  await mkdir(path.dirname(options.destPath), { recursive: true });
  await pipeline(readable, createWriteStream(options.destPath));
  return true;
}

export async function uploadTranscript(options: {
  context: { blobStore?: import('../runtime/context.ts').BlobStoreLike; epoch?: number };
  conversationId: string;
  sessionId: string;
  sourcePath: string;
}): Promise<void> {
  const info = await stat(options.sourcePath).catch(() => null);
  if (!info) {
    console.warn('[transcript] local file missing; skip upload', options.sourcePath);
    return;
  }
  // A replaced owner's transcript is behind the new owner's; it must not land.
  await assertCanWrite(options.context, options.conversationId);
  if (info.size >= TRANSCRIPT_WARN_BYTES) {
    console.warn('[transcript] large session file', {
      sessionId: options.sessionId,
      bytes: info.size,
    });
  }

  const store = getBlobStore(options.context);
  // PagesBlob's Node `fetch` PUT omits `duplex: 'half'`, which undici requires
  // for a ReadableStream body. Buffer the JSONL so the PUT is a string body.
  await store.set(transcriptBlobKey(options.sessionId), await readFile(options.sourcePath, 'utf8'));
  await patchConversationRecord(options.context, options.conversationId, {
    claudeSessionId: options.sessionId,
    transcriptPath: options.sourcePath,
  });
}

export async function readTranscriptText(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

export type TranscriptLocateOptions = {
  configDir?: string;
  cwd?: string;
};

/** Claude persists JSONL at `$CLAUDE_CONFIG_DIR/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[/\\]/g, '-');
}

export function resolveClaudeTranscriptPath(
  sessionId: string,
  options?: TranscriptLocateOptions & { explicitPath?: string },
): string {
  const explicit = (options?.explicitPath || '').trim();
  if (explicit && existsSync(explicit)) return explicit;
  if (!sessionId) return explicit;

  const configDir = (options?.configDir || '').trim() || '/tmp/.claude';
  const cwd = (options?.cwd || '').trim() || process.cwd();
  const conventional = path.join(
    configDir,
    'projects',
    claudeProjectDirName(cwd),
    `${sessionId}.jsonl`,
  );
  if (existsSync(conventional)) return conventional;

  const legacy = path.join(configDir, 'sessions', `${sessionId}.jsonl`);
  if (existsSync(legacy)) return legacy;

  const projects = path.join(configDir, 'projects');
  if (existsSync(projects)) {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(projects, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  }

  return explicit || conventional;
}

/**
 * The local path of the conversation's Claude JSONL, downloading it from Blob
 * when this process has no copy. Empty when the conversation has none yet.
 */
export async function ensureLocalTranscript(
  context: { blobStore?: import('../runtime/context.ts').BlobStoreLike },
  conversationId: string,
  livePath = '',
  locate?: TranscriptLocateOptions & { sessionId?: string },
): Promise<string> {
  const record = await getConversationRecord(context, conversationId);
  const sessionId = locate?.sessionId || record.claudeSessionId || '';
  const resolved = resolveClaudeTranscriptPath(sessionId, {
    explicitPath: livePath || record.transcriptPath,
    configDir: locate?.configDir,
    cwd: locate?.cwd,
  });
  if (resolved && existsSync(resolved)) return resolved;
  if (!sessionId) return '';
  const dest = resolved || path.join('/tmp/.claude/sessions', `${sessionId}.jsonl`);
  const restored = await downloadTranscript({
    context,
    conversationId,
    sessionId,
    destPath: dest,
  });
  return restored ? dest : '';
}

/**
 * The Claude JSONL file is the only history this product keeps. Resume and the
 * Session tab both read it here so they cannot drift onto a second copy.
 */
export async function loadTranscriptJsonl(
  context: { blobStore?: import('../runtime/context.ts').BlobStoreLike },
  conversationId: string,
  livePath = '',
  locate?: TranscriptLocateOptions & { sessionId?: string },
): Promise<string> {
  const local = await ensureLocalTranscript(context, conversationId, livePath, locate);
  return local ? readTranscriptText(local) : '';
}

/**
 * Bytes of the file from `start`. While the file is still being written only
 * whole lines are returned, so a chunk never ends inside a JSON record or a
 * multi-byte character.
 */
async function readTranscriptFrom(filePath: string, start: number, wholeLinesOnly: boolean) {
  const info = await stat(filePath).catch(() => null);
  if (!info || info.size <= start) return { text: '', end: Math.min(start, info?.size ?? 0) };
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(info.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    const usable = wholeLinesOnly ? bytes.lastIndexOf(0x0a) + 1 : bytes.length;
    return { text: bytes.subarray(0, usable).toString('utf8'), end: start + usable };
  } finally {
    await handle.close();
  }
}

function jsonResponse(obj: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export type LiveTranscriptRef = {
  path?: string;
  sessionId?: string;
  active?: boolean;
};

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * GET /transcript — the JSONL file, then what is appended to it while the turn
 * writes it. `cursor` and `sessionId` from a previous stream continue after
 * the bytes that stream already delivered.
 */
export async function createTranscriptStreamResponse(
  context: AgentContext,
  resolveLive: (conversationId: string) => LiveTranscriptRef | null,
  options: { maxMs?: number } = {},
): Promise<Response> {
  const { conversationId } = resolveConversationId(context);
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }
  const resumeSessionId = getRequestQueryParam(context, 'sessionId').value;
  const resumeCursor = Number.parseInt(getRequestQueryParam(context, 'cursor').value, 10);
  const maxMs = options.maxMs ?? OBSERVER_STREAM_MAX_MS;

  return createSSEResponse(async function* (signal) {
    const deadline = Date.now() + maxMs;
    let sentSessionId: string | undefined;
    let sentPath = '';
    let sentLive: boolean | undefined;
    let cursor = 0;

    while (!signal?.aborted) {
      const live = resolveLive(conversationId);
      // This loop exists to notice the session id another request writes, so
      // it is the one reader that must bypass the per-request record memo.
      const record = !live?.sessionId || !live?.path
        ? await getConversationRecord(context, conversationId, { refresh: true })
        : null;
      const sessionId = live?.sessionId || record?.claudeSessionId || '';
      const livePath = resolveClaudeTranscriptPath(sessionId, {
        explicitPath: live?.path || record?.transcriptPath,
      });
      const transcriptPath = await ensureLocalTranscript(context, conversationId, livePath, { sessionId })
        || livePath;
      const active = Boolean(live?.active);

      // A different session, or a file shorter than what was sent, is a new
      // file: start it over rather than append to the old one.
      const sameFile = sentSessionId === undefined
        ? resumeSessionId === sessionId && Number.isFinite(resumeCursor) && resumeCursor > 0
        : sentSessionId === sessionId && sentPath === transcriptPath;
      if (sentSessionId === undefined && sameFile) cursor = resumeCursor;
      const fileSize = transcriptPath ? (await stat(transcriptPath).catch(() => null))?.size ?? 0 : 0;
      const append = sameFile && fileSize >= cursor;
      const chunk = transcriptPath
        ? await readTranscriptFrom(transcriptPath, append ? cursor : 0, active)
        : { text: '', end: 0 };

      if (sentSessionId === undefined || !append || chunk.text || sentLive !== active) {
        yield sseEvent({
          type: 'transcript',
          data: {
            ok: true,
            conversation_id: conversationId,
            sessionId,
            transcriptPath,
            jsonl: chunk.text,
            live: active,
            append,
            cursor: chunk.end,
          },
        });
      }
      sentSessionId = sessionId;
      sentPath = transcriptPath;
      sentLive = active;
      cursor = chunk.end;

      if (!active) break;
      if (Date.now() >= deadline) {
        yield sseEvent({ type: 'reconnect', data: { cursor, sessionId } });
        break;
      }
      await sleep(TRANSCRIPT_WATCH_MS, signal);
    }
  }, context?.request?.signal);
}
