import { HISTORY_FETCH_LIMIT } from './_constants';
import { createProjectState } from './_project';
import type {
  ChatTask,
  ConversationMessage,
  PersistedActivityTurn,
  ProjectSnapshot,
  ProjectState,
} from './_types';
import { sanitizeAssistantText } from './utils/_text';
import { appendTrimmedActivityTurn, dedupeActivityTurns } from './utils/_activity';

export async function getHistory(
  context: any,
  conversationId: string,
  options: { excludeLatestUserMessage?: string } = {},
): Promise<ConversationMessage[]> {
  // context.store only exposes conversation-scoped message APIs, not a generic KV store.
  // Read this conversation's messages and filter them into user/assistant text pairs.
  try {
    const messages = await context.store.getMessages({
      conversationId,
      limit: HISTORY_FETCH_LIMIT,
      order: 'asc',
    });
    const items = Array.isArray(messages) ? messages : (messages?.items || []);
    const history = items
      .filter((item: any) => item.role === 'user' || item.role === 'assistant')
      .map((item: any) => ({
        role: item.role as 'user' | 'assistant',
        content: typeof item.content === 'string'
          ? item.content
          : JSON.stringify(item.content ?? ''),
      }));

    // /chat persists the submitted user message before /chat/stream starts the
    // agent. Remove that one record from the prompt history; the pipeline passes
    // it separately as the current user turn.
    const currentMessage = options.excludeLatestUserMessage;
    if (currentMessage && history.at(-1)?.role === 'user' && history.at(-1)?.content === currentMessage) {
      history.pop();
    }
    return history;
  } catch (error: any) {
    if (error?.code === 'MemoryNotFoundError') {
      return [];
    }
    throw error;
  }
}

export async function getChatTask(context: any, conversationId: string): Promise<ChatTask | null> {
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const task = conversation?.metadata?.chatTask;
    return task && typeof task === 'object' && typeof task.id === 'string'
      ? task as ChatTask
      : null;
  } catch (error: any) {
    if (error?.code === 'MemoryNotFoundError') {
      return null;
    }
    throw error;
  }
}

export async function saveChatTask(context: any, conversationId: string, task: ChatTask) {
  await context.store.updateConversation({
    conversationId,
    metadata: { chatTask: task },
  });
}

export async function appendTurn(
  context: any,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
) {
  // Sanitize assistant content before writing history so control sequences or raw JSON
  // from new concatenation paths do not pollute the next prompt.
  const safeContent = role === 'assistant' ? sanitizeAssistantText(content) : content;
  await context.store.appendMessage({
    conversationId,
    role,
    content: safeContent,
  });
}

export async function getProjectState(context: any, conversationId: string): Promise<ProjectState> {
  // Project state is conversation metadata, not a chat message. On first access,
  // the conversation may not exist yet, so fall back to the default state.
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.projectState as ProjectState | undefined;
    if (stored && typeof stored === 'object') {
      return stored;
    }
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
  return createProjectState(conversationId);
}

export async function saveProjectState(
  context: any,
  conversationId: string,
  state: ProjectState,
) {
  // updateConversation shallow-merges metadata; replace projectState as a whole.
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { projectState: state },
    });
  } catch (error: any) {
    // If no messages have been written, the conversation does not exist yet and
    // updateConversation throws MemoryNotFoundError. appendMessage will create it
    // later in this turn, and the next saveProjectState call can write normally.
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}

// Code persistence (防丢失): the sandbox /tmp is volatile and may be cleared
// between requests, so the generated project only living there is not durable.
// We persist a base64 zip snapshot of the project alongside projectState in the
// conversation metadata, and restore it when the sandbox no longer has the code.
//
// Why metadata (not Blob): this project is Claude Agent SDK, so context.store has
// no generic KV; conversation metadata mirrors saveProjectState with the least
// code. Source archives exclude node_modules/.next/etc (see ARCHIVE_EXCLUDED_
// DIRECTORIES) so they are typically KB-sized, well under the 50MB message limit.
// Trade-off: getProjectState reads getConversation every turn, which pulls the
// snapshot along with it — negligible at KB scale. If projects grow large or hit
// an (undocumented) metadata size limit, migrate this to platform Blob
// (@edgeone/pages-blob) as the original plan §四 specified.

// ---- 惰性清理：回收超时项目，避免项目快照在 store 里随会话数无限膨胀 ----
// 触发点：每次保存项目快照时顺带扫一小批会话（游标滚动，多次写入最终覆盖全量）。
// 判定：距 lastMessageAt（平台自带的最后活跃时间戳）超过 TTL、且存过项目快照的会话即回收。
// 安全：best-effort，任何错误都不影响本次存储；永不删除当前正在操作的会话。
const PROJECT_TTL_MS = 24 * 60 * 60 * 1000; // 1 天没有新对话即视为超时
const SWEEP_BATCH = 20;                      // 每次顺带扫描的会话数
// ⚠️ 删除不可逆：先 dry-run（只记录不真删）。在 dev 里确认 sweepExpiredProjects
// 扫描出的候选列表正确、且 deleteConversation 签名可用后，再改成 false 启用真删。
const SWEEP_DRY_RUN = true;
let sweepCursor: string | undefined;         // 进程内清理进度，丢失无害（下轮重扫）

export async function sweepExpiredProjects(
  context: any,
  currentConversationId: string,
): Promise<{ scanned: number; expired: string[]; dryRun: boolean }> {
  const expired: string[] = [];
  let scanned = 0;
  try {
    const now = Date.now();
    const listed = await context.store.listConversations({ limit: SWEEP_BATCH, after: sweepCursor });
    const items = Array.isArray(listed) ? listed : (listed?.items ?? []);
    scanned = items.length;
    // 游标滚动：取到底（nextCursor 为空）就重置，下一轮从头再扫。
    sweepCursor = (!Array.isArray(listed) && listed?.nextCursor) ? listed.nextCursor : undefined;

    for (const conv of items) {
      const id = conv?.conversationId;
      if (!id || id === currentConversationId) continue;      // 不动当前会话
      if (!conv?.metadata?.projectSnapshot?.base64) continue; // 只回收占空间的项目快照会话
      const lastActive = typeof conv?.lastMessageAt === 'number' ? conv.lastMessageAt : conv?.createdAt;
      if (typeof lastActive !== 'number') continue;
      if (now - lastActive <= PROJECT_TTL_MS) continue;       // 未超时
      expired.push(id);
      if (!SWEEP_DRY_RUN) {
        await context.store.deleteConversation({ conversationId: id });
      }
    }
    if (expired.length > 0) {
      console.log(
        `[sweep] ${SWEEP_DRY_RUN ? 'DRY-RUN would delete' : 'deleted'} ${expired.length} expired conversation(s):`,
        expired,
      );
    }
  } catch (error: any) {
    // 清理是附带动作，绝不能让本次存储失败。
    console.warn('[sweep] skipped due to error:', error?.message);
  }
  return { scanned, expired, dryRun: SWEEP_DRY_RUN };
}

export async function saveProjectSnapshot(
  context: any,
  conversationId: string,
  snapshot: ProjectSnapshot,
) {
  // 先删后存：存本次快照前，顺带回收一批超时项目。
  await sweepExpiredProjects(context, conversationId);
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { projectSnapshot: snapshot },
    });
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}

export async function getProjectSnapshot(
  context: any,
  conversationId: string,
): Promise<ProjectSnapshot | null> {
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.projectSnapshot as ProjectSnapshot | undefined;
    if (stored && typeof stored === 'object' && typeof stored.base64 === 'string' && stored.base64) {
      return stored;
    }
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
  return null;
}

export async function clearProjectSnapshot(context: any, conversationId: string) {
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { projectSnapshot: null },
    });
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}

const ACTIVITY_TURN_LIMIT = 25;
const ACTIVITY_ITEM_LIMIT = 50;

export async function getActivityHistory(
  context: any,
  conversationId: string,
): Promise<PersistedActivityTurn[]> {
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.activityHistory;
    return Array.isArray(stored)
      ? dedupeActivityTurns(stored.slice(-ACTIVITY_TURN_LIMIT))
      : [];
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') throw error;
    return [];
  }
}

export async function saveActivityTurn(
  context: any,
  conversationId: string,
  turn: PersistedActivityTurn,
) {
  const current = await getActivityHistory(context, conversationId);
  const next = appendTrimmedActivityTurn(
    current,
    turn,
    ACTIVITY_TURN_LIMIT,
    ACTIVITY_ITEM_LIMIT,
  );
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { activityHistory: next },
    });
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') throw error;
  }
}

// GitHub OAuth CSRF nonce (plan/github-oauth-claim.md §5.2/§5.3): the flow is
// session-less, so we bind "which conversation" + a random nonce into the OAuth
// `state`, storing the nonce here (same metadata drawer as projectState/snapshot)
// so the callback can verify it once, within a short TTL, then clear it.
export type GithubOAuthNonce = { nonce: string; ts: number };

export async function saveGithubNonce(
  context: any,
  conversationId: string,
  value: GithubOAuthNonce,
) {
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { githubOAuth: value },
    });
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}

export async function getGithubNonce(
  context: any,
  conversationId: string,
): Promise<GithubOAuthNonce | null> {
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.githubOAuth as GithubOAuthNonce | undefined;
    if (stored && typeof stored === 'object' && typeof stored.nonce === 'string' && stored.nonce) {
      return stored;
    }
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
  return null;
}

export async function clearGithubNonce(context: any, conversationId: string) {
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { githubOAuth: null },
    });
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}
