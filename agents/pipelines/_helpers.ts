import { createProjectArchive } from '../_project';
import { saveProjectSnapshot } from '../_memory';
import type { ProjectState } from '../_types';
import { debugLog } from '../utils/_debug';

const SANDBOX_EXTENSION_SECONDS = 1800;

// Caps for streaming generated file contents to the frontend (see
// handleProjectFilesChanged). Per-file keeps a single large asset off the stream;
// the per-turn budget bounds how much the replay buffer can hold.
export const FILE_PUSH_MAX_BYTES = 96 * 1024;
export const FILE_PUSH_TURN_BUDGET_BYTES = 2 * 1024 * 1024;

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string) {
  return utf8Encoder.encode(value).length;
}

/** Reject if `promise` does not settle within `ms`. Clears the timer on settle. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SandboxWithTimeoutExtension = {
  extendTimeout?: (seconds: number) => unknown;
};

export function stripReturnedPreviewLinks(text: string, previewUrl?: string) {
  if (!text || !previewUrl) {
    return text;
  }
  const escapedUrl = escapeRegExp(previewUrl);
  return text
    .replace(new RegExp(`\\s*\\[[^\\]]*(?:打开预览|预览|preview)[^\\]]*\\]\\(${escapedUrl}\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*${escapedUrl}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildRequirementConclusionFallback(
  request: string,
  status: 'pending' | 'ready' | 'generated',
) {
  const summary = summarizeUserRequest(request);
  const isEnglish = !/[\u3400-\u9fff]/.test(request);

  if (isEnglish) {
    if (status === 'ready') {
      return `Built this for your request: ${summary}. The preview is ready in the right preview panel.`;
    }
    if (status === 'generated') {
      return `Generated the project for your request: ${summary}.`;
    }
    return `Handled your request: ${summary}. Verification and preview results are being prepared.`;
  }

  if (status === 'ready') {
    return `Built this for your request: ${summary}. The preview is ready in the right preview panel.`;
  }
  if (status === 'generated') {
    return `Generated the project for your request: ${summary}.`;
  }
  return `Handled your request: ${summary}. Verification and preview results are being prepared.`;
}

function summarizeUserRequest(request: string) {
  const normalized = request.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'your web project';
  }
  const maxLength = 80;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trimEnd()}...`
    : normalized;
}

export function isGenericCompletionReply(text: string) {
  const normalized = text.replace(/\s+/g, '').replace(/[。.!！]+$/g, '');
  return normalized === '已编写完成，请查看结果'
    || normalized === '已完成，请查看结果'
    || /^theagentdidnotreturnanythingdisplayable$/i.test(normalized);
}

export async function extendExistingSandboxTimeout(context: any) {
  const sandbox = context?.sandbox as SandboxWithTimeoutExtension | undefined;
  if (!sandbox || typeof sandbox.extendTimeout !== 'function') {
    return;
  }

  try {
    await sandbox.extendTimeout(SANDBOX_EXTENSION_SECONDS);
    debugLog(context, '[sandbox]', {
      stage: 'extend-timeout',
      seconds: SANDBOX_EXTENSION_SECONDS,
    });
  } catch (error) {
    console.warn('[sandbox]', {
      stage: 'extend-timeout-failed',
      seconds: SANDBOX_EXTENSION_SECONDS,
      error: error instanceof Error ? error.message : String(error || ''),
    });
  }
}

// Code persistence (防丢失): snapshot the current project into the store so the
// generated code survives sandbox recycling. Best-effort — a snapshot failure must
// never break the turn's result. Called on every path where the project has files
// on disk, INCLUDING fatal-build turns: the code was still generated, so it must not
// be lost just because verification failed (a later restore/resume needs it).
export async function persistProjectSnapshot(
  context: any,
  conversationId: string,
  state: ProjectState,
): Promise<boolean> {
  try {
    const archive = await createProjectArchive(context, state);
    if (archive.ok) {
      await saveProjectSnapshot(context, conversationId, {
        base64: archive.base64,
        filename: archive.filename,
        contentType: archive.contentType,
        size: archive.size,
        updatedAt: Date.now(),
      });
      return true;
    }
  } catch (error) {
    debugLog(context, '[snapshot]', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

// Debounce window for mid-turn checkpoints. Long enough to coalesce rapid
// write_project_file calls; short enough that stop/refresh mid-generation still
// has a recent snapshot in the store before the sandbox can recycle.
const CHECKPOINT_DEBOUNCE_MS = 2_000;

export type ProjectCheckpointController = {
  /** Mark the project dirty and (re)start the debounce timer. */
  schedule: () => void;
  /** Cancel the timer and persist immediately (await until the store write finishes). */
  flush: () => Promise<void>;
};

// Mid-turn + exit-path snapshot controller. schedule() is cheap and coalesces;
// flush() forces a final zip→store write so stop/fatal/success never leave the
// conversation without a restorable projectSnapshot.
export function createProjectCheckpointController(
  context: any,
  conversationId: string,
  state: ProjectState,
): ProjectCheckpointController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let chain: Promise<void> = Promise.resolve();

  const kick = () => {
    chain = chain
      .then(async () => {
        while (dirty) {
          dirty = false;
          await persistProjectSnapshot(context, conversationId, state);
        }
      })
      .catch((error) => {
        debugLog(context, '[checkpoint]', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return chain;
  };

  return {
    schedule() {
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void kick();
      }, CHECKPOINT_DEBOUNCE_MS);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      dirty = true;
      await kick();
    },
  };
}
