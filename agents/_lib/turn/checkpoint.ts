import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import { assertCanWrite } from '../session/ownership.ts';
import type { ProjectState } from '../types.ts';
export {
  compactUserFacingReply,
  replyLocaleFor,
  resolveFinishedTurn,
  withLiveDeploymentUrl,
} from '../../../shared/user-facing-reply.ts';

/**
 * Remove a preview link the model echoed back.
 *
 * This runs on every streamed text chunk, so it must not normalize the chunk:
 * trimming each one deletes the space that separates two words and the reply
 * arrives as "Yourguestbookisready". Callers that want an edge trim (the
 * complete reply) do it themselves.
 */
export function stripReturnedPreviewLinks(text: string, previewUrl?: string) {
  if (!text || !previewUrl) {
    return text;
  }
  const escapedUrl = escapeRegExp(previewUrl);
  return text
    .replace(new RegExp(`\\s*\\[[^\\]]*(?:打开预览|预览|preview)[^\\]]*\\]\\(${escapedUrl}\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*${escapedUrl}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n');
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
    return `已按你的需求完成：${summary}。右侧预览已就绪。`;
  }
  if (status === 'generated') {
    return `已按你的需求生成项目：${summary}。`;
  }
  return `正在完成你的需求：${summary}。预览准备中。`;
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

// Persist the project through the sandbox SDK. Archive bytes travel directly from
// the sandbox to project Blob storage and never enter conversation metadata.
export async function persistProjectSnapshot(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
): Promise<boolean> {
  try {
    // The sandbox keeps one restore point per conversation; a replaced owner
    // must not overwrite the new owner's.
    await assertCanWrite(context, conversationId);
    await requireSandbox(context).persist?.({ path: state.appDir });
    return true;
  } catch (error) {
    // Losing a snapshot silently means the next resume rebuilds from an older
    // workspace with nothing to explain the gap.
    console.warn('[snapshot]', {
      stage: 'persist-failed',
      conversationIdPresent: Boolean(conversationId),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

// Debounce window for mid-turn checkpoints. Long enough to coalesce rapid
// files_write calls; short enough that stop/refresh mid-generation still
// has a recent snapshot in the store before the sandbox can recycle.
const CHECKPOINT_DEBOUNCE_MS = 2_000;

export type ProjectCheckpointController = {
  /** Mark the project dirty and (re)start the debounce timer. */
  schedule: () => void;
  /** Cancel the timer and persist immediately (await until the store write finishes). */
  flush: () => Promise<boolean>;
};

// Mid-turn + exit-path persistence controller. schedule() is cheap and coalesces;
// flush() forces a final sandbox-to-Blob write on stop/fatal/success paths.
export function createProjectCheckpointController(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  onFailure?: (message: string) => void,
): ProjectCheckpointController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let chain: Promise<void> = Promise.resolve();
  let lastSucceeded = true;

  const kick = () => {
    chain = chain
      .then(async () => {
        while (dirty) {
          dirty = false;
          lastSucceeded = await persistProjectSnapshot(context, conversationId, state);
          if (!lastSucceeded) onFailure?.('Project persistence failed; the current sandbox files are still available until the sandbox expires.');
        }
      })
      .catch((error) => {
        console.warn('[checkpoint]', {
          stage: 'persist-failed',
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
      return lastSucceeded;
    },
  };
}
