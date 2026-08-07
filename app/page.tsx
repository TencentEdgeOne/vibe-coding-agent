'use client';

import { FormEvent, memo, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, ArrowUp, CheckCircle2, Download, ExternalLink, Plus, Sparkles, X } from 'lucide-react';
import { Highlight, type PrismTheme } from 'prism-react-renderer';
import { sanitizeAssistantText } from '../agents/utils/_text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  AgentConversation,
  type AssistantActivity,
  type ConversationMessage as WorkspaceConversationMessage,
} from './components/agent-conversation';

type TimelineStep =
  | { kind: 'status'; text: string }
  | { kind: 'modify_marker' }
  | { kind: 'tool_use'; id: string; name: string; command?: string; phaseHint?: NormalizedStepPhase; fileCount?: number }
  | { kind: 'tool_result'; toolUseId: string; toolName?: string; command?: string; ok: boolean; preview: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr' | 'status'; text: string }
  | { kind: 'error'; text: string };

type AssistantStatus = 'running' | 'done' | 'error' | 'stopped';
type NormalizedStepStatus = 'waiting' | 'running' | 'done' | 'error';
type NormalizedStepPhase = 'scaffold' | 'modify' | 'code' | 'install' | 'preview' | 'link';

type NormalizedStep = {
  phase: NormalizedStepPhase;
  title: string;
  status: NormalizedStepStatus;
  summary: string;
};

type ProcessEvent =
  | { kind: 'thinking'; content: string }
  | { kind: 'step'; phase: NormalizedStepPhase; step: NormalizedStep };

type ChatMessage = WorkspaceConversationMessage & {
  thinkingContent?: string;
  processEvents?: ProcessEvent[];
  steps?: TimelineStep[];
};

type BuildInfo = {
  status: 'success' | 'failed' | 'skipped';
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
};

type LinkInfo = {
  url?: string;
  sandboxDebugUrl?: string;
  filename?: string;
  error?: string;
};

type InitLog = {
  stream: 'status' | 'stdout' | 'stderr';
  content: string;
};

type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
};

type FileTree = {
  root: string;
  items: FileTreeItem[];
};

type ResumeData = {
  ok?: boolean;
  conversation_id?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  hasProject?: boolean;
  preview?: LinkInfo;
  files?: FileTree;
  download?: LinkInfo;
  activityHistory?: Array<{
    id: string;
    user: string;
    assistant: string;
    status: 'completed' | 'failed' | 'stopped';
    activities: AssistantActivity[];
  }>;
};

const resumeRequests = new Map<string, Promise<ResumeData | null>>();

function fetchResume(conversationId: string) {
  const existing = resumeRequests.get(conversationId);
  if (existing) return existing;
  const request = fetch('/resume', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      conversationId,
      'makers-conversation-id': conversationId,
    },
    body: '{}',
  }).then((response) => response.json().catch(() => null) as Promise<ResumeData | null>);
  resumeRequests.set(conversationId, request);
  void request.finally(() => window.setTimeout(() => resumeRequests.delete(conversationId), 1_000));
  return request;
}

type ChatResponse = {
  ok?: boolean;
  reply?: string;
  conversation_id?: string;
  build?: BuildInfo;
  files?: FileTree;
  preview?: LinkInfo;
  download?: LinkInfo;
  error?: string;
  stopped?: boolean;
};

type ChatStreamEvent =
  | {
      type: 'status';
      message?: string;
    }
  | {
      type: 'result';
      data?: ChatResponse;
    }
  | {
      type: 'agent';
      data?: Pick<ChatResponse, 'ok' | 'reply' | 'error'>;
    }
  | {
      type: 'file_tree';
      data?: FileTree;
    }
  | {
      type: 'preview_ready';
      data?: {
        preview?: LinkInfo;
        download?: LinkInfo;
      };
    }
  | {
      type: 'tool_use';
      data?: {
        id?: string;
        name?: string;
        command?: string;
        phaseHint?: NormalizedStepPhase;
        fileCount?: number;
        inputSummary?: string;
        startedAt?: number;
      };
    }
  | {
      type: 'tool_result';
      data?: {
        tool_use_id?: string;
        toolName?: string;
        command?: string;
        ok?: boolean;
        preview?: string;
        outputSummary?: string;
        status?: 'running' | 'completed' | 'failed' | 'stopped';
        endedAt?: number;
      };
    }
  | {
      type: 'text_segment';
      data?: {
        uuid?: string;
        text?: string;
      };
    }
  | {
      type: 'error';
      error?: string;
    }
  | {
      type: 'log';
      phase?: 'scaffold' | 'agent';
      stream?: InitLog['stream'];
      message?: string;
    }
  | {
      type: 'ping';
      ts?: number;
    };

type Locale = 'zh' | 'en';

const LANGUAGE_STORAGE_KEY = 'web-dev-agent-language';
const EDGEONE_AI_DEPLOY_URL = 'https://edgeone.ai/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript';
const TENCENT_CLOUD_DEPLOY_URL = 'https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript';
// 认领部署（EdgeOne）功能暂不上线，先隐藏入口。上线时改回 true 即可。
const CLAIM_DEPLOY_ENABLED = false;

// Toolbar "Export to GitHub" (plan/github-oauth-claim.md). Visibility is decided at
// runtime by probing GET /github/config — an instance without GITHUB_CLIENT_ID
// hides the button and stays fully usable (users still have "Download source").

const PHASE_ORDER: NormalizedStepPhase[] = ['scaffold', 'modify', 'code', 'install', 'preview', 'link'];
const TYPEWRITER_INTERVAL_MS = 18;
const TYPEWRITER_CHARS_PER_TICK = 3;
const NARRATION_TYPEWRITER_INTERVAL_MS = 34;
const NARRATION_TYPEWRITER_CHARS_PER_TICK = 1;
const PROCESS_STEP_REVEAL_DELAY_MS = 420;

const TRANSLATIONS = {
  zh: {
    languageToggleLabel: 'English',
    languageToggleAria: 'Switch language to English',
    deployLabel: '一键部署',
    home: {
      titleBefore: '今天想',
      titleAccent: '创建',
      titleAfter: '什么？',
      subtitle: '把一个粗略想法变成精致的应用、网站或原型。',
      placeholder: '请输入你想构建的内容',
      buildNow: '立即构建',
      building: '构建中...',
      fastBuild: '极速生成',
      examples: [
        '做一个简洁好用的 Todolist',
        '为产品设计师创建一个作品集网站',
        '做一个带统计和主题切换的番茄钟',
      ],
      galleryTitle: '灵感作品墙',
      gallerySubtitle: '官方精选样例，点开即可作为起点',
    },
    response: {
      noDisplay: '已编写完成，请查看结果。',
      requestFailedPrefix: '请求失败：',
      unknownError: '未知错误',
      agentFlowEnded: 'Agent 流程已结束。',
      processingFailed: '请求处理失败。',
    },
    workspace: {
      conversationEyebrow: '对话',
      buildThread: '构建线程',
      hideSteps: '隐藏',
      viewSteps: '查看',
      steps: '过程',
      keepThinking: '保留思考',
      changePlaceholder: '描述你想修改的内容',
      send: '发送',
      stop: '停止生成',
      you: '你',
      agentName: 'EdgeOne Agent',
      activityRunning: '正在执行',
      activityCompleted: '已完成',
      activityFailed: '失败',
      activityStopped: '已停止',
      activityInput: '输入',
      activityOutput: '输出',
      sandboxEyebrow: '沙箱',
      livePreview: '实时预览',
      files: '文件',
      preview: '预览',
      application: '应用',
      code: '代码',
      downloadSource: '下载源码',
      downloading: '打包中...',
      newProject: '新建项目',
      resuming: '正在恢复上次的项目…',
      downloadFailed: '下载失败，请重试。',
      exportGithub: '导出到 GitHub',
      githubExporting: '跳转中...',
      githubSuccessPrefix: '已推送到 ',
      githubErrorPrefix: 'GitHub 导出失败：',
      githubSuccessTitle: '已推送到 GitHub',
      githubSuccessDesc: '项目代码已作为首次提交推送到你的仓库。',
      githubErrorTitle: '导出失败',
      githubOpenRepo: '打开仓库',
      githubRetry: '重试',
      githubClose: '关闭',
      githubReasons: {
        not_ready: '代码尚未就绪，请稍候重试。',
        repo_exists: '同名仓库已存在，请重试。',
        token_exchange_failed: 'GitHub 授权失败，请重试。',
        push_failed: '推送失败，请稍后重试。',
        state_expired: '授权已过期，请重新发起。',
        state_mismatch: '授权校验失败，请重新发起。',
        not_configured: '未配置 GitHub OAuth。',
        missing_cid: '缺少会话标识，请重试。',
        invalid_request: '请求无效，请重试。',
      } as Record<string, string>,
      claimDeploy: '认领部署',
      claimDeployHint: '认领部署到我的账号',
      loadingPreview: '正在加载实时预览...',
      previewEmpty: '首次构建完成后会在这里显示预览。',
      constructionDisclaimer: '当前仅为模板演示流程使用，模型效果可能较差，简易部署后替换自有模型',
      previewError: '预览错误：',
      downloadError: '下载错误：',
      buildFailedMessage: '构建失败。源码包仍保留当前文件，便于调试。',
      buildFailedAfter: (attempts: number) =>
        `自动修复 ${attempts} 次后构建仍失败。源码包仍保留当前文件，便于调试。`,
      previewLinkReady: '已获取预览链接。',
      previewLinkMissing: '预览链接未返回。',
    },
    timeline: {
      empty: '等待 Agent 响应...',
      processing: '正在处理...',
      statusLabels: {
        waiting: '等待中',
        running: '进行中',
        done: '完成',
        error: '失败',
      },
      definitions: {
        scaffold: { title: '初始化沙箱', waiting: '等待准备项目工作区' },
        modify: { title: '开始修改', waiting: '准备修改项目文件' },
        code: { title: '写代码', waiting: '等待生成或修改项目文件' },
        install: { title: '安装依赖', waiting: '等待安装项目依赖' },
        preview: { title: '启动预览', waiting: '等待启动本地预览服务' },
        link: { title: '获取链接', waiting: '等待获取预览链接' },
      },
      summaries: {
        scaffoldRunning: '正在准备项目工作区',
        scaffoldExisting: '已复用现有项目工作区',
        scaffoldCreated: '已准备空项目工作区',
        scaffoldReady: '沙箱工作区已准备完成',
        modifyStarted: '已开始修改项目文件',
        codeAutoFix: '正在根据验证结果修复项目代码',
        codeRunningUpdate: '正在更新项目文件',
        codeWritingFiles: (count: number) => `正在写入 ${count} 个项目文件`,
        codeUpdated: '已更新项目文件',
        codeUpdatedFiles: (count: number) => `已更新 ${count} 个项目文件`,
        installRunning: '正在安装项目依赖',
        installDone: '项目依赖安装完成',
        installFailed: '依赖安装失败',
        commandFailed: (command: string, detail: string) => `命令失败：${command}${detail ? `。${detail}` : ''}`,
        previewRunning: '正在启动本地预览服务',
        previewWarmup: '正在预热预览页面',
        previewStarted: '预览服务已启动',
        previewReady: '预览服务已可访问',
        previewFailed: '预览失败',
        linkRunning: '正在获取预览链接',
        linkDone: '预览链接已获取',
        linkDoneNoUrl: '已完成预览链接获取',
        linkMissing: '预览链接未返回',
        processFailed: '处理失败',
        stepFailed: (title: string) => `${title}失败`,
        unknownStep: '步骤',
      },
    },
    files: {
      empty: '暂无文件。',
      refreshing: '更新中...',
      projectFiles: '项目文件',
      selectFile: '从左侧选择一个文件以预览内容。',
      loading: (path: string) => `正在加载 ${path}...`,
      readFailed: '读取失败',
      requestFailed: '请求失败',
      lines: (count: number) => `${count} 行`,
      truncated: '已截断',
    },
  },
  en: {
    languageToggleLabel: '中文',
    languageToggleAria: '切换语言为中文',
    deployLabel: 'Deploy',
    home: {
      titleBefore: 'What will you',
      titleAccent: 'create',
      titleAfter: 'today?',
      subtitle: 'Turn a rough idea into a polished app, site, or prototype.',
      placeholder: "Let's build a",
      buildNow: 'Build now',
      building: 'Building...',
      fastBuild: 'Fast build',
      examples: [
        'Build a SaaS dashboard for an analytics startup',
        'Create a portfolio site for a product designer',
        'Make a Pomodoro timer with stats and themes',
      ],
      galleryTitle: 'Inspiration gallery',
      gallerySubtitle: 'Official picks — open one to use as a starting point',
    },
    response: {
      noDisplay: 'The agent did not return anything displayable.',
      requestFailedPrefix: 'Request failed: ',
      unknownError: 'unknown error',
      agentFlowEnded: 'Agent flow has ended.',
      processingFailed: 'Request processing failed.',
    },
    workspace: {
      conversationEyebrow: 'Conversation',
      buildThread: 'Build thread',
      hideSteps: 'Hide',
      viewSteps: 'View',
      steps: 'process',
      keepThinking: 'Keep thinking',
      changePlaceholder: 'Ask for a change',
      send: 'Send',
      stop: 'Stop generation',
      you: 'You',
      agentName: 'EdgeOne Agent',
      activityRunning: 'Running',
      activityCompleted: 'Completed',
      activityFailed: 'Failed',
      activityStopped: 'Stopped',
      activityInput: 'Input',
      activityOutput: 'Output',
      sandboxEyebrow: 'Sandbox',
      livePreview: 'Live preview',
      files: 'Files',
      preview: 'Preview',
      application: 'Application',
      code: 'Code',
      downloadSource: 'Download source',
      downloading: 'Packaging...',
      newProject: 'New project',
      resuming: 'Restoring your last project…',
      downloadFailed: 'Download failed, please retry.',
      exportGithub: 'Export to GitHub',
      githubExporting: 'Redirecting...',
      githubSuccessPrefix: 'Pushed to ',
      githubErrorPrefix: 'GitHub export failed: ',
      githubSuccessTitle: 'Pushed to GitHub',
      githubSuccessDesc: 'Your project code was pushed as the initial commit to your repository.',
      githubErrorTitle: 'Export failed',
      githubOpenRepo: 'Open repository',
      githubRetry: 'Retry',
      githubClose: 'Close',
      githubReasons: {
        not_ready: 'The code is not ready yet. Please retry shortly.',
        repo_exists: 'A repository with that name already exists. Please retry.',
        token_exchange_failed: 'GitHub authorization failed. Please retry.',
        push_failed: 'Push failed. Please try again later.',
        state_expired: 'The authorization expired. Please start again.',
        state_mismatch: 'Authorization check failed. Please start again.',
        not_configured: 'GitHub OAuth is not configured.',
        missing_cid: 'Missing conversation id. Please retry.',
        invalid_request: 'Invalid request. Please retry.',
      } as Record<string, string>,
      claimDeploy: 'Claim deployment',
      claimDeployHint: 'Claim this deployment to my account',
      loadingPreview: 'Loading live preview...',
      previewEmpty: 'Preview will appear after the first build finishes.',
      constructionDisclaimer: 'This is only a template demo flow. Model quality may be limited; replace it with your own model after simple deployment.',
      previewError: 'Preview error: ',
      downloadError: 'Download error: ',
      buildFailedMessage: 'Build failed. The source package still keeps the current files for debugging.',
      buildFailedAfter: (attempts: number) =>
        `Build failed after ${attempts} auto-fix attempt${attempts === 1 ? '' : 's'}. The source package still keeps the current files for debugging.`,
      previewLinkReady: 'Preview link found.',
      previewLinkMissing: 'Preview link was not returned.',
    },
    timeline: {
      empty: 'Waiting for agent response...',
      processing: 'Processing...',
      statusLabels: {
        waiting: 'waiting',
        running: 'running',
        done: 'done',
        error: 'error',
      },
      definitions: {
        scaffold: { title: 'Initialize sandbox', waiting: 'Waiting to prepare the project workspace' },
        modify: { title: 'Start modifying', waiting: 'Preparing to update project files' },
        code: { title: 'Write code', waiting: 'Waiting to generate or update project files' },
        install: { title: 'Install dependencies', waiting: 'Waiting to install project dependencies' },
        preview: { title: 'Start preview', waiting: 'Waiting to start the local preview server' },
        link: { title: 'Get link', waiting: 'Waiting to get the preview link' },
      },
      summaries: {
        scaffoldRunning: 'Preparing the project workspace',
        scaffoldExisting: 'Reused the existing project workspace',
        scaffoldCreated: 'Prepared an empty project workspace',
        scaffoldReady: 'Sandbox workspace is ready',
        modifyStarted: 'Started updating project files',
        codeAutoFix: 'Fixing project code based on validation results',
        codeRunningUpdate: 'Updating project files',
        codeWritingFiles: (count: number) => `Writing ${count} project file${count === 1 ? '' : 's'}`,
        codeUpdated: 'Updated project files',
        codeUpdatedFiles: (count: number) => `Updated ${count} project file${count === 1 ? '' : 's'}`,
        installRunning: 'Installing project dependencies',
        installDone: 'Project dependencies installed',
        installFailed: 'Dependency installation failed',
        commandFailed: (command: string, detail: string) => `Command failed: ${command}${detail ? `. ${detail}` : ''}`,
        previewRunning: 'Starting the local preview server',
        previewWarmup: 'Warming up the preview page',
        previewStarted: 'Preview server started',
        previewReady: 'Preview server is reachable',
        previewFailed: 'Preview failed',
        linkRunning: 'Getting the preview link',
        linkDone: 'Preview link retrieved',
        linkDoneNoUrl: 'Finished getting the preview link',
        linkMissing: 'Preview link was not returned',
        processFailed: 'Processing failed',
        stepFailed: (title: string) => `${title} failed`,
        unknownStep: 'Step',
      },
    },
    files: {
      empty: 'No files captured yet.',
      refreshing: 'Refreshing...',
      projectFiles: 'Project files',
      selectFile: 'Select a file from the left to preview its contents.',
      loading: (path: string) => `Loading ${path}...`,
      readFailed: 'Read failed',
      requestFailed: 'Request failed',
      lines: (count: number) => `${count} line${count === 1 ? '' : 's'}`,
      truncated: 'truncated',
    },
  },
} as const;

type UiCopy = (typeof TRANSLATIONS)[Locale];
type TimelineCopy = UiCopy['timeline'];
type FileCopy = UiCopy['files'];

const CONVERSATION_STORAGE_KEY = 'web-dev-agent-conversation-id';

function createConversationId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function extractProjectName() {
  if (typeof window === 'undefined') {
    return {
      projectName: '',
      domain: '',
    };
  }

  var fullUrl = window.location.href;
  var urlObject = new URL(fullUrl);
  var hostname = urlObject.hostname;
  var parts = hostname.split('.');
  return {
    projectName: parts[0].replace('-zh', ''),
    domain: parts.slice(1).join('.'),
  };
}

function getDeployUrl(domain: string) {
  return domain === 'edgeone.dev' ? EDGEONE_AI_DEPLOY_URL : TENCENT_CLOUD_DEPLOY_URL;
}

// Decode a base64 string into a Blob. The source archive arrives base64-encoded
// inside a JSON envelope (the agent proxy only transports text reliably).
function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}

function getOrCreateCachedConversationId() {
  if (typeof window === 'undefined') {
    return createConversationId();
  }

  const stored = window.localStorage.getItem(CONVERSATION_STORAGE_KEY)?.trim();
  if (stored) {
    return stored;
  }

  const next = createConversationId();
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, next);
  return next;
}

// Read the cached conversationId without minting a new one. Returns null on a
// first visit — used to decide whether there is anything to resume at all, so a
// brand-new visitor skips the "restoring…" screen entirely.
function getStoredConversationId() {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(CONVERSATION_STORAGE_KEY)?.trim() || null;
}

function cacheConversationId(value: string) {
  const trimmed = value.trim();
  if (!trimmed || typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, trimmed);
}

function createMessageId(role: ChatMessage['role']) {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createWorkspaceTitle(messages: ChatMessage[], fallback: string) {
  const firstRequest = messages.find((message) => message.role === 'user')?.content
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstRequest) return fallback;
  return firstRequest.length > 48 ? `${firstRequest.slice(0, 48).trimEnd()}…` : firstRequest;
}

function sanitizeThinkingContent(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/\[20[01]~/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/<think\b[^>]*>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/<t(?:h(?:i(?:n(?:k(?:\b[^>]*)?)?)?)?)?$/i, '');
}

function getAssistantScrollSignature(message: ChatMessage) {
  const events = message.processEvents ?? [];
  const processSignature = events.map((event) =>
    event.kind === 'thinking'
      ? `thinking:${event.content}`
      : `step:${event.phase}:${event.step.status}:${event.step.summary}`,
  ).join('\u001e');
  return [
    message.status || '',
    message.content,
    events.length,
    processSignature,
  ].join('\u001f');
}

// Typewriter placeholder: types each phrase left-to-right, holds, deletes, then
// cycles to the next (mirrors the script in plan/design-mockup.html). Returns a
// static first phrase when the user prefers reduced motion, and idles (keeps the
// last rendered text) whenever `enabled` is false.
function useTypewriterPlaceholder(phrases: readonly string[], enabled: boolean) {
  const [text, setText] = useState('');

  useEffect(() => {
    if (!enabled || phrases.length === 0) {
      return;
    }

    const prefersReducedMotion =
      typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setText(phrases[0]);
      return;
    }

    let phraseIndex = 0;
    let charIndex = 0;
    let deleting = false;
    let timer = 0;

    const tick = () => {
      const full = phrases[phraseIndex];
      if (!deleting) {
        charIndex += 1;
        setText(full.slice(0, charIndex));
        if (charIndex === full.length) {
          deleting = true;
          timer = window.setTimeout(tick, 1600);
          return;
        }
        timer = window.setTimeout(tick, 70);
      } else {
        charIndex -= 1;
        setText(full.slice(0, charIndex));
        if (charIndex === 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % phrases.length;
          timer = window.setTimeout(tick, 400);
          return;
        }
        timer = window.setTimeout(tick, 35);
      }
    };

    setText('');
    timer = window.setTimeout(tick, 70);
    return () => window.clearTimeout(timer);
  }, [enabled, phrases]);

  return text;
}

// 语言切换：两个文字按钮 中 / En，选中的高亮为蓝色并略放大，点击切换。
function LanguageSwitch({
  language,
  onChange,
  ariaLabel,
  className = '',
}: {
  language: Locale;
  onChange: (next: Locale) => void;
  ariaLabel: string;
  className?: string;
}) {
  const itemClass = (active: boolean) =>
    `font-semibold leading-none transition-all ${
      active
        ? 'scale-110 text-primary'
        : 'text-muted-foreground hover:text-foreground'
    }`;
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex items-center gap-1.5 text-sm ${className}`}
    >
      <button
        type="button"
        onClick={() => onChange('zh')}
        aria-pressed={language === 'zh'}
        className={itemClass(language === 'zh')}
      >
        中
      </button>
      <span className="text-muted-foreground/40">/</span>
      <button
        type="button"
        onClick={() => onChange('en')}
        aria-pressed={language === 'en'}
        className={itemClass(language === 'en')}
      >
        En
      </button>
    </div>
  );
}

export default function Home() {
  const [language, setLanguage] = useState<Locale>('zh');
  const [deployUrl, setDeployUrl] = useState(TENCENT_CLOUD_DEPLOY_URL);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Resume-on-load: rehydrate the last conversation's workspace after a refresh.
  // `resumeChecked` gates the first render. It MUST init to a constant (not from
  // localStorage): SSR has no localStorage, so deriving it there would mismatch the
  // client's first paint and trigger a hydration error. Start `true` (render home),
  // matching SSR — a first-time visitor then stays on home and never flashes the
  // "restoring…" screen. A returning visitor is switched to `false` inside the
  // client-only effect below (after hydration), which shows the restore screen
  // while /resume runs.
  const [resumeChecked, setResumeChecked] = useState(true);
  const [preview, setPreview] = useState<LinkInfo | null>(null);
  const [download, setDownload] = useState<LinkInfo | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(true);
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubNotice, setGithubNotice] = useState<{ ok: boolean; repo?: string; reason?: string } | null>(null);
  const githubPopupRef = useRef<Window | null>(null);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-assistant-message progress expansion state. The running message is
  // expanded while active, then collapsed by default.
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [showProcessThinking, setShowProcessThinking] = useState(true);
  const [sandboxTab, setSandboxTab] = useState<'preview' | 'files'>('preview');
  const [showWorkspacePanel, setShowWorkspacePanel] = useState(false);
  const [fileTree, setFileTree] = useState<FileTree | null>(null);
  const [filesRefreshing, setFilesRefreshing] = useState(false);
  const [activePreviewUrl, setActivePreviewUrl] = useState('');
  const [activePreviewRevision, setActivePreviewRevision] = useState(0);
  const [activePreviewLoaded, setActivePreviewLoaded] = useState(false);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState('');
  const [pendingPreviewRevision, setPendingPreviewRevision] = useState(0);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const activePreviewUrlRef = useRef('');
  const activePreviewRevisionRef = useRef(0);
  const previewRevisionRef = useRef(0);
  const processStepRevealTimersRef = useRef<Record<string, number>>({});
  const showProcessThinkingRef = useRef(true);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef('');
  const stoppingRef = useRef(false);

  const t = TRANSLATIONS[language];
  const canSend = input.trim().length > 0 && !loading;
  const hasWorkspace = messages.length > 0 || Boolean(preview) || Boolean(build);
  const fileCount = fileTree?.items.filter((item) => item.type === 'file').length ?? 0;
  // Cycling typewriter placeholder for the landing prompt (see plan/design-mockup.html).
  // Reuses the localized example prompts; pauses while the field has text.
  const placeholderPhrases = useMemo(() => t.home.examples.map((example) => `${example}…`), [t]);
  const typedPlaceholder = useTypewriterPlaceholder(
    placeholderPhrases,
    !hasWorkspace && input.length === 0,
  );
  const latestAssistantMessage = messages.findLast((message) => message.role === 'assistant');
  const latestAssistantScrollSignature = latestAssistantMessage
    ? getAssistantScrollSignature(latestAssistantMessage)
    : '';
  const workspaceTitle = useMemo(
    () => createWorkspaceTitle(messages, language === 'zh' ? '未命名项目' : 'Untitled project'),
    [language, messages],
  );
  useEffect(() => {
    const { domain } = extractProjectName();
    setDeployUrl(getDeployUrl(domain));
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') {
      setLanguage(stored);
    }
  }, []);

  useEffect(() => {
    // On load, reuse the cached conversationId and ask the backend to restore the
    // last project (it unzips the persisted snapshot into a fresh sandbox, restarts
    // the preview, and returns history + files + preview). This is what makes a
    // refresh keep the generated code instead of dropping back to an empty home.
    let cancelled = false;
    // A first-time visitor has no cached conversationId, so there is nothing to
    // restore. Mint an in-memory id only (do NOT persist it) and go straight to
    // the home screen — skip the /resume round-trip and its "restoring…" screen.
    // Persisting here would make a refresh look like a returning user; the build
    // flow caches its own fresh id once the user actually starts a project.
    const existing = getStoredConversationId();
    if (!existing) {
      // resumeChecked already defaults to true → stay on the home screen.
      setConversationId(createConversationId());
      return;
    }

    // Returning visitor: switch to the "restoring…" screen now (client-only, after
    // hydration — so it never affects SSR match) and keep it until /resume settles.
    setResumeChecked(false);
    setConversationId(existing);

    (async () => {
      try {
        const data = await fetchResume(existing);
        if (cancelled || !data?.ok) {
          return;
        }
        const history = Array.isArray(data.messages) ? data.messages : [];
        if (!data.hasProject && history.length === 0) {
          return; // Nothing to resume — stay on the home screen.
        }
        if (data.conversation_id) {
          setConversationId(data.conversation_id);
        }
        const activityHistory = Array.isArray(data.activityHistory) ? data.activityHistory : [];
        setMessages(activityHistory.length > 0
          ? activityHistory.flatMap((turn) => [
              {
                id: `${turn.id}-user`,
                role: 'user' as const,
                content: turn.user,
                status: 'done' as AssistantStatus,
              },
              {
                id: `${turn.id}-assistant`,
                role: 'assistant' as const,
                content: turn.assistant,
                activities: turn.activities,
                status: turn.status === 'completed' ? 'done' as const : turn.status === 'failed' ? 'error' as const : 'stopped' as const,
              },
            ])
          : history.map((item) => ({
              id: createMessageId(item.role),
              role: item.role,
              content: item.content,
              status: 'done' as AssistantStatus,
            })));
        if (data.files) {
          setFileTree(data.files);
          if (data.files.items.some((item) => item.type === 'file')) setShowWorkspacePanel(true);
        }
        if (data.download?.url) {
          setDownload(data.download);
        }
        if (data.preview) {
          setPreview(data.preview);
          if (data.preview.url) {
            setShowWorkspacePanel(true);
            const revision = previewRevisionRef.current + 1;
            previewRevisionRef.current = revision;
            activePreviewUrlRef.current = data.preview.url;
            activePreviewRevisionRef.current = revision;
            setActivePreviewUrl(data.preview.url);
            setActivePreviewRevision(revision);
            setActivePreviewLoaded(false);
          }
        }
      } catch {
        // Resume is best-effort; on failure the user just sees the home screen.
      } finally {
        if (!cancelled) {
          setResumeChecked(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Probe GitHub OAuth config. Optimistic default (button shown): only hide when
    // the endpoint explicitly reports it is not configured, so a stale route or a
    // transient failure never wrongly hides a configured instance.
    // (plan/github-oauth-claim.md §6)
    let cancelled = false;
    fetch('/github/config')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setGithubEnabled(d?.enabled !== false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Fallback path only: when the popup was blocked, the OAuth flow ran as a full-page
    // navigation and the callback redirected this tab back with ?github=... Read it,
    // then strip the query so a refresh does not re-show it. The normal (popup) path
    // delivers the result via postMessage below and never reloads this page.
    const params = new URLSearchParams(window.location.search);
    const github = params.get('github');
    if (!github) {
      return;
    }
    if (github === 'success') {
      setGithubNotice({ ok: true, repo: params.get('repo') || undefined });
    } else {
      setGithubNotice({ ok: false, reason: params.get('reason') || 'push_failed' });
    }
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  useEffect(() => {
    // Normal path: the OAuth popup posts its result back here (see oauthPopupResult in
    // agents/utils/_request.ts), so the main page shows the outcome without reloading.
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { source?: string; github?: string; repo?: string; reason?: string };
      if (!data || data.source !== 'github-oauth') return;
      setGithubBusy(false);
      if (data.github === 'success') {
        setGithubNotice({ ok: true, repo: data.repo || undefined });
      } else {
        setGithubNotice({ ok: false, reason: data.reason || 'push_failed' });
      }
      if (githubPopupRef.current && !githubPopupRef.current.closed) {
        githubPopupRef.current.close();
      }
      githubPopupRef.current = null;
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    // 语言切换后，用每条消息保留的原始 steps 重刷已渲染的过程卡片文案。
    const copy = TRANSLATIONS[language].timeline;
    setMessages((current) =>
      current.map((item) =>
        item.steps && item.steps.length > 0
          ? {
              ...item,
              processEvents: relocalizeProcessEvents(item.processEvents ?? [], item.steps, copy),
            }
          : item,
      ),
    );
  }, [language]);

  useEffect(() => {
    showProcessThinkingRef.current = showProcessThinking;
  }, [showProcessThinking]);

  useEffect(() => {
    const container = conversationScrollRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages.length, latestAssistantScrollSignature]);

  const promotePendingPreview = () => {
    if (!pendingPreviewUrl) {
      return;
    }
    activePreviewUrlRef.current = pendingPreviewUrl;
    activePreviewRevisionRef.current = pendingPreviewRevision;
    setActivePreviewUrl(pendingPreviewUrl);
    setActivePreviewRevision(pendingPreviewRevision);
    setActivePreviewLoaded(true);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
  };

  // Cross-origin iframe onLoad may not fire in some environments. Hide the
  // overlay after 3 seconds as a fallback to avoid a permanently blank preview.
  useEffect(() => {
    if (!activePreviewUrl || activePreviewLoaded) {
      return;
    }
    const timer = window.setTimeout(() => setActivePreviewLoaded(true), 3000);
    return () => window.clearTimeout(timer);
  }, [activePreviewUrl, activePreviewLoaded, activePreviewRevision]);

  // Keep the same fallback for the background iframe so the old preview is not
  // kept forever when onLoad does not fire.
  useEffect(() => {
    if (!pendingPreviewUrl) {
      return;
    }
    const timer = window.setTimeout(() => {
      activePreviewUrlRef.current = pendingPreviewUrl;
      activePreviewRevisionRef.current = pendingPreviewRevision;
      setActivePreviewUrl(pendingPreviewUrl);
      setActivePreviewRevision(pendingPreviewRevision);
      setActivePreviewLoaded(true);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [pendingPreviewUrl, pendingPreviewRevision]);

  async function sendMessage(message: string) {
    const trimmed = message.trim();
    if (!trimmed || loading) {
      return;
    }

    const isStartingFromHome = !hasWorkspace;
    const requestConversationId = isStartingFromHome
      ? createConversationId()
      : conversationId || getOrCreateCachedConversationId();
    if (isStartingFromHome) {
      cacheConversationId(requestConversationId);
      setConversationId(requestConversationId);
      setPreview(null);
      setDownload(null);
      setBuild(null);
      setFileTree(null);
      setFilesRefreshing(false);
      setSandboxTab('preview');
      setShowWorkspacePanel(false);
      activePreviewUrlRef.current = '';
      activePreviewRevisionRef.current = 0;
      previewRevisionRef.current = 0;
      setActivePreviewUrl('');
      setActivePreviewRevision(0);
      setActivePreviewLoaded(false);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
    } else if (!conversationId) {
      setConversationId(requestConversationId);
    }

    const userMessageId = createMessageId('user');
    const assistantMessageId = createMessageId('assistant');
    activeTurnIdRef.current = assistantMessageId;

    setMessages((current) => [
      ...current,
      { id: userMessageId, role: 'user', content: trimmed },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        thinkingContent: '',
        processEvents: [],
        activities: [],
        status: 'running',
        steps: [],
      },
    ]);
    // Expand the running message by default while preserving older turn states.
    setOpenSteps((current) => ({ ...current, [assistantMessageId]: true }));
    setFilesRefreshing(true);
    setInput('');
    setLoading(true);
    const activatedPreviewRevisions = new Map<string, number>();
    let sawProjectActivity = false;
    let insertedModifyMarker = false;

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId ? { ...item, ...patch } : item,
        ),
      );
    };

    const clearProcessStepRevealTimer = () => {
      const timer = processStepRevealTimersRef.current[assistantMessageId];
      if (timer) {
        window.clearTimeout(timer);
        delete processStepRevealTimersRef.current[assistantMessageId];
      }
    };

    const scheduleProcessStepReveal = () => {
      clearProcessStepRevealTimer();
      processStepRevealTimersRef.current[assistantMessageId] = window.setTimeout(() => {
        delete processStepRevealTimersRef.current[assistantMessageId];
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantMessageId
              ? {
                  ...item,
                  thinkingContent: '',
                  processEvents: appendPendingProcessSteps(
                    item.processEvents ?? [],
                    item.steps ?? [],
                    t.timeline,
                  ),
                }
              : item,
          ),
        );
      }, PROCESS_STEP_REVEAL_DELAY_MS);
    };

    const appendStep = (step: TimelineStep) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? (() => {
                const nextSteps = appendOrUpdateTimelineStep(item.steps ?? [], step);
                const previousProcessEvents = item.processEvents ?? [];
                const nextProcessEvents = appendOrUpdateProcessStep(
                  previousProcessEvents,
                  nextSteps,
                  step,
                  t.timeline,
                );
                const didAppendProcessStep = countProcessSteps(nextProcessEvents) > countProcessSteps(previousProcessEvents);
                if (showProcessThinkingRef.current && shouldDelayProcessStepReveal(previousProcessEvents, nextProcessEvents)) {
                  scheduleProcessStepReveal();
                  return {
                    ...item,
                    steps: nextSteps,
                  };
                }
                return {
                  ...item,
                  steps: nextSteps,
                  thinkingContent: didAppendProcessStep && !showProcessThinkingRef.current ? '' : item.thinkingContent,
                  processEvents: nextProcessEvents,
                };
              })()
            : item,
        ),
      );
    };

    const appendTextActivity = (text: string) => {
      setMessages((current) =>
        current.map((item) => {
          if (item.id !== assistantMessageId) {
            return item;
          }
          const nextText = sanitizeThinkingContent(text);
          if (!nextText) {
            return item;
          }
          const activities = [...(item.activities ?? [])];
          const last = activities.at(-1);
          if (
            last?.kind === 'text'
            && nextText.trim().length > 24
            && last.content.includes(nextText.trim())
          ) {
            return item;
          }
          if (last?.kind === 'text') last.content += nextText;
          else activities.push({ kind: 'text', content: nextText });
          return {
            ...item,
            activities,
          };
        }),
      );
    };

    const upsertToolActivity = (
      toolUseId: string,
      patch: Partial<Extract<AssistantActivity, { kind: 'tool' }>>,
    ) => {
      setMessages((current) => current.map((item) => {
        if (item.id !== assistantMessageId) return item;
        const activities = [...(item.activities ?? [])];
        const index = activities.findIndex(
          (activity) => activity.kind === 'tool' && activity.toolUseId === toolUseId,
        );
        if (index >= 0) {
          activities[index] = { ...activities[index], ...patch } as AssistantActivity;
        } else {
          activities.push({
            kind: 'tool',
            toolUseId,
            name: patch.name || '<unknown>',
            status: patch.status || 'running',
            inputSummary: patch.inputSummary,
            outputSummary: patch.outputSummary,
            startedAt: patch.startedAt || Date.now(),
            endedAt: patch.endedAt,
          });
        }
        return { ...item, activities };
      }));
    };

    const finalizeAssistant = (
      finalContent: string,
      finalStatus: AssistantStatus,
    ) => {
      clearProcessStepRevealTimer();
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
              ? {
                  ...item,
                  content: finalContent,
                  activities: (item.activities ?? []).map((activity) =>
                    activity.kind === 'tool' && activity.status === 'running'
                      ? {
                          ...activity,
                          status: finalStatus === 'stopped' ? 'stopped' as const : finalStatus === 'error' ? 'failed' as const : 'completed' as const,
                          endedAt: Date.now(),
                        }
                      : activity,
                  ),
                  thinkingContent: '',
                processEvents: appendPendingProcessSteps(item.processEvents ?? [], item.steps ?? [], t.timeline),
                status: finalStatus,
              }
            : item,
        ),
      );
      // Collapse progress by default when the stream ends. The running-phase
      // forced expansion is temporary.
      setOpenSteps((current) => ({ ...current, [assistantMessageId]: false }));
    };

    const activatePreview = (nextPreview: LinkInfo) => {
      if (!nextPreview.url) {
        if (nextPreview.error) {
          setPreview((current) =>
            current?.url
              ? {
                  ...nextPreview,
                  url: current.url,
                  sandboxDebugUrl: nextPreview.sandboxDebugUrl ?? current.sandboxDebugUrl,
                }
              : nextPreview,
          );
        }
        return;
      }

      setPreview(nextPreview);
      setSandboxTab('preview');
      let revision = activatedPreviewRevisions.get(nextPreview.url);
      if (revision === undefined) {
        revision = previewRevisionRef.current + 1;
        previewRevisionRef.current = revision;
        activatedPreviewRevisions.set(nextPreview.url, revision);
      }

      if (!activePreviewUrlRef.current) {
        activePreviewUrlRef.current = nextPreview.url;
        activePreviewRevisionRef.current = revision;
        setActivePreviewUrl(nextPreview.url);
        setActivePreviewRevision(revision);
        setActivePreviewLoaded(false);
        setPendingPreviewUrl('');
        setPendingPreviewRevision(0);
        return;
      }

      if (
        activePreviewUrlRef.current === nextPreview.url
        && activePreviewRevisionRef.current === revision
      ) {
        return;
      }

      setPendingPreviewUrl(nextPreview.url);
      setPendingPreviewRevision(revision);
    };

    const applyResponse = (data: ChatResponse) => {
      if (data.conversation_id) {
        cacheConversationId(data.conversation_id);
        setConversationId(data.conversation_id);
      }
      if (data.preview) {
        activatePreview(data.preview);
      }
      if (data.download) {
        setDownload(data.download);
      }
      if (data.build) {
        setBuild(data.build);
      }
      if (data.files) {
        setFileTree(data.files);
      }
      setFilesRefreshing(false);

      const finalText = data.reply || data.error || t.response.noDisplay;
      const finalStatus: AssistantStatus = data.stopped ? 'stopped' : data.ok === false ? 'error' : 'done';
      finalizeAssistant(finalText, finalStatus);
    };

    const handleStreamEvent = (event: ChatStreamEvent) => {
      if (event.type === 'status' && event.message) {
        return;
      }
      if (event.type === 'ping') return;
      if (event.type === 'result' && event.data) {
        applyResponse(event.data);
        return;
      }
      if (event.type === 'agent' && event.data) {
        const agentData = event.data;
        const text = agentData.reply || agentData.error || t.response.noDisplay;
        // agent events can arrive before the final aggregate result with build
        // and preview data. For plain Q&A without project tool activity, the
        // agent event is already complete and can finish the frontend wait state.
        // If project tools ran, keep the message running until result finalizes it.
        if (!sawProjectActivity) {
          finalizeAssistant(text, agentData.ok === false ? 'error' : 'done');
          return;
        }
        patchAssistant({ content: text });
        return;
      }
      if (event.type === 'text_segment' && event.data?.text) {
        appendTextActivity(event.data.text);
        return;
      }
      if (event.type === 'tool_use' && event.data) {
        sawProjectActivity = true;
        const toolUseStep: TimelineStep = {
          kind: 'tool_use',
          id: event.data.id || '',
          name: event.data.name || '<unknown>',
          command: event.data.command,
          phaseHint: event.data.phaseHint,
          fileCount: event.data.fileCount,
        };
        const classification = classifyToolUse(toolUseStep, t.timeline);
        if (!isStartingFromHome && !insertedModifyMarker && classification?.phase === 'code') {
          appendStep({ kind: 'modify_marker' });
          insertedModifyMarker = true;
        }
        upsertToolActivity(toolUseStep.id, {
          name: toolUseStep.name,
          status: 'running',
          inputSummary: event.data.inputSummary || event.data.command,
          startedAt: event.data.startedAt,
        });
        const shortName = shortenToolName(toolUseStep.name);
        if (
          event.data.fileCount
          || ['write_project_file', 'write_project_files', 'files_write', 'write_files', 'files_make_dir'].includes(shortName)
        ) {
          setShowWorkspacePanel(true);
          setSandboxTab('files');
        }
        return;
      }
      if (event.type === 'tool_result' && event.data) {
        sawProjectActivity = true;
        upsertToolActivity(event.data.tool_use_id || '', {
          name: event.data.toolName || '<unknown>',
          status: event.data.status || (event.data.ok === false ? 'failed' : 'completed'),
          outputSummary: event.data.outputSummary || event.data.preview,
          endedAt: event.data.endedAt || Date.now(),
        });
        return;
      }
      if (event.type === 'file_tree' && event.data) {
        sawProjectActivity = true;
        setFileTree(event.data);
        setFilesRefreshing(false);
        if (event.data.items.some((item) => item.type === 'file')) {
          setShowWorkspacePanel(true);
          setSandboxTab((current) => preview?.url ? current : 'files');
        }
        return;
      }
      if (event.type === 'preview_ready' && event.data) {
        sawProjectActivity = true;
        if (event.data.preview) {
          setShowWorkspacePanel(true);
          activatePreview(event.data.preview);
        }
        if (event.data.download) {
          setDownload(event.data.download);
        }
        return;
      }
      if (event.type === 'error') {
        finalizeAssistant(event.error || t.response.processingFailed, 'error');
        return;
      }
      if (event.type === 'log' && event.message) {
        sawProjectActivity = true;
      }
    };

    try {
      const requestAbortController = new AbortController();
      chatAbortControllerRef.current = requestAbortController;
      stoppingRef.current = false;
      const response = await fetch('/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          conversationId: requestConversationId,
          'makers-conversation-id': requestConversationId,
        },
        body: JSON.stringify({
          message: trimmed,
          turnId: assistantMessageId,
          ...(isStartingFromHome ? { resetProject: true } : {}),
        }),
        signal: requestAbortController.signal,
      });

      const contentType = response.headers.get('content-type') || '';
      if (!response.body || !contentType.includes('application/x-ndjson')) {
        applyResponse((await response.json()) as ChatResponse);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          handleStreamEvent(JSON.parse(line) as ChatStreamEvent);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        handleStreamEvent(JSON.parse(buffer) as ChatStreamEvent);
      }
    } catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || stoppingRef.current) {
        return;
      }
      const msg = `${t.response.requestFailedPrefix}${error instanceof Error ? error.message : t.response.unknownError}`;
      appendStep({ kind: 'error', text: msg });
      finalizeAssistant(msg, 'error');
    } finally {
      clearProcessStepRevealTimer();
      // Fallback: ensure a running message cannot get stuck after an unexpected stream break.
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId && item.status === 'running'
            ? {
                ...item,
                status: 'done',
                content: item.content || t.response.agentFlowEnded,
                thinkingContent: '',
                processEvents: appendPendingProcessSteps(item.processEvents ?? [], item.steps ?? [], t.timeline),
              }
            : item,
        ),
      );
      setOpenSteps((current) => {
        if (current[assistantMessageId] === false) return current;
        return { ...current, [assistantMessageId]: false };
      });
      setLoading(false);
      setFilesRefreshing(false);
      chatAbortControllerRef.current = null;
      activeTurnIdRef.current = '';
      stoppingRef.current = false;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage(input);
  }

  async function handleStop() {
    const cid = conversationId;
    if (!loading || !cid || stoppingRef.current) return;
    stoppingRef.current = true;
    const stoppedText = language === 'zh'
      ? '已停止本次生成，你可以继续描述下一步修改。'
      : 'Generation stopped. You can continue with another change.';
    setMessages((current) => current.map((item, index) => {
      if (index !== current.length - 1 || item.role !== 'assistant' || item.status !== 'running') return item;
      return {
        ...item,
        content: stoppedText,
        status: 'stopped',
        activities: (item.activities ?? []).map((activity) =>
          activity.kind === 'tool' && activity.status === 'running'
            ? { ...activity, status: 'stopped' as const, endedAt: Date.now() }
            : activity,
        ),
      };
    }));
    setLoading(false);
    setFilesRefreshing(false);

    const currentAssistant = [...messages].reverse().find((item) => item.role === 'assistant' && item.status === 'running');
    const currentUser = [...messages].reverse().find((item) => item.role === 'user');
    const stoppedActivities = (currentAssistant?.activities ?? []).map((activity) =>
      activity.kind === 'tool' && activity.status === 'running'
        ? { ...activity, status: 'stopped' as const, endedAt: Date.now() }
        : activity,
    );
    const stoppedTurn = {
      id: activeTurnIdRef.current,
      user: currentUser?.content || '',
      assistant: stoppedText,
      status: 'stopped',
      createdAt: Date.now(),
      activities: stoppedActivities,
    };

    const stopRequest = (async () => {
      const request = (headers: HeadersInit) => fetch('/stop', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conversation_id: cid,
          turn: stoppedTurn,
        }),
      });
      const response = await request({ 'content-type': 'application/json' });
      if (response.status !== 400) return response;
      const error = await response.clone().json().catch(() => null) as { code?: string } | null;
      if (error?.code !== 'AGENT_CONVERSATION_ID_REQUIRED') return response;
      // Older local Makers runtimes validate every agent route before reading the
      // stop body. Retry with the header there; current production runtimes use
      // the body-only request above so cancellation is not sticky-routed.
      return request({
        'content-type': 'application/json',
        'makers-conversation-id': cid,
      });
    })().catch(() => null);
    chatAbortControllerRef.current?.abort();
    await stopRequest;
  }

  async function handleDownload() {
    if (!download?.url || downloadBusy) {
      return;
    }
    setDownloadBusy(true);
    setDownload((current) => (current ? { ...current, error: undefined } : current));
    try {
      // /download must hit the same sandbox the project lives in; sticky routing
      // keys off the conversation id header, so send it like /file and /chat do
      // (a plain <a download> could not set this header).
      const headers: HeadersInit = {};
      const cid = conversationId || getOrCreateCachedConversationId();
      if (cid) {
        headers['makers-conversation-id'] = cid;
        headers['conversationId'] = cid;
      }
      const resp = await fetch(download.url, { method: 'GET', headers });
      const data = (await resp.json().catch(() => null)) as
        | { ok?: boolean; base64?: string; filename?: string; contentType?: string; error?: string }
        | null;
      if (!resp.ok || !data?.ok || !data.base64) {
        const message = data?.error || `${resp.status}`;
        setDownload((current) => (current ? { ...current, error: message } : current));
        return;
      }
      const blob = base64ToBlob(data.base64, data.contentType || 'application/zip');
      const filename = data.filename || download.filename || 'source.zip';
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.workspace.downloadFailed;
      setDownload((current) => (current ? { ...current, error: message } : current));
    } finally {
      setDownloadBusy(false);
    }
  }

  // Kick off the GitHub OAuth push in a popup window so the main page never reloads.
  // The popup runs /github/start → GitHub → /github/callback, which posts the result
  // back via postMessage (handled above). If the popup is blocked, fall back to a
  // full-page navigation. See plan/github-oauth-claim.md §6.
  function handleExportGithub() {
    const cid = conversationId || getOrCreateCachedConversationId();
    if (!cid || githubBusy) {
      return;
    }
    setGithubBusy(true);
    const url = `/github/start?cid=${encodeURIComponent(cid)}`;
    const w = 520;
    const h = 680;
    const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
    const popup = window.open(url, 'github-oauth', `width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) {
      // Popup blocked: full-page navigation (result comes back via ?github= on reload).
      window.location.href = url;
      return;
    }
    githubPopupRef.current = popup;
    // Reset the spinner if the user closes the popup without finishing.
    const timer = window.setInterval(() => {
      if (githubPopupRef.current && githubPopupRef.current.closed) {
        window.clearInterval(timer);
        githubPopupRef.current = null;
        setGithubBusy(false);
      }
    }, 600);
  }

  // Placeholder for "claim deployment" (plan §3.1). Until the platform drop/claim API
  // is ready, this opens the EdgeOne console (plan's option A: finish the claim there).
  function handleClaimDeploy() {
    window.open(deployUrl, '_blank', 'noreferrer');
  }

  // Start a fresh project. Needed because resume-on-load means a refresh no longer
  // clears the workspace, so this is the explicit way back to an empty home screen
  // with a brand-new conversation.
  function handleNewProject() {
    if (loading) {
      return;
    }
    const next = createConversationId();
    cacheConversationId(next);
    setConversationId(next);
    setMessages([]);
    setPreview(null);
    setDownload(null);
    setBuild(null);
    setFileTree(null);
    setFilesRefreshing(false);
    setSandboxTab('preview');
    setShowWorkspacePanel(false);
    activePreviewUrlRef.current = '';
    activePreviewRevisionRef.current = 0;
    previewRevisionRef.current = 0;
    setActivePreviewUrl('');
    setActivePreviewRevision(0);
    setActivePreviewLoaded(false);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
    setInput('');
  }

  // Hold the first paint until the resume check resolves, so a returning user does
  // not see the home screen flash before their project is restored.
  if (!resumeChecked) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 text-foreground">
        <span
          className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">{t.workspace.resuming}</p>
      </main>
    );
  }

  return (
    <main
      className={`flex flex-col text-foreground ${
        hasWorkspace ? 'h-screen overflow-hidden' : 'min-h-screen'
      }`}
    >
      {!hasWorkspace && (
        <LanguageSwitch
          language={language}
          onChange={setLanguage}
          ariaLabel={t.languageToggleAria}
          className="fixed right-4 top-3 z-50"
        />
      )}
      {!hasWorkspace && (
        <section className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          <div className="w-full max-w-[820px]">
            <h1 className="text-[clamp(2.1rem,4.6vw,3.1rem)] font-extrabold leading-[1.16] tracking-[-0.025em]">
              {t.home.titleBefore}
              {language === 'en' ? ' ' : ''}
              <span className="text-brand-gradient">{t.home.titleAccent}</span>
              {language === 'en' ? ' ' : ''}
              {t.home.titleAfter}
            </h1>
            <p className="mt-4 text-[clamp(0.95rem,1.4vw,1.15rem)] text-muted-foreground">
              {t.home.subtitle}
            </p>

            <Card className="mt-10 gap-0 rounded-2xl border-border p-5 text-left shadow-[0_18px_50px_-30px_rgba(20,30,60,0.45)] transition-shadow focus-within:border-primary/50 focus-within:shadow-[0_20px_60px_-28px_rgba(47,107,255,0.35)]">
              <form onSubmit={handleSubmit}>
                <Textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    // 输入法合成中（如中文选词）按回车只用于选中候选词，不应提交。
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void sendMessage(input);
                    }
                  }}
                  placeholder={typedPlaceholder || t.home.placeholder}
                  rows={3}
                  className="min-h-[124px] resize-none border-0 bg-transparent px-2 py-1 text-lg leading-relaxed shadow-none focus-visible:ring-0 md:text-lg"
                />
                <div className="mt-3 flex items-center gap-2.5">
                  <button
                    type="submit"
                    disabled={!canSend}
                    aria-label={t.home.fastBuild}
                    className="btn-brand ml-auto inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {loading ? (
                      <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    {t.home.fastBuild}
                  </button>
                </div>
              </form>
            </Card>

            <div className="mt-5 flex flex-wrap justify-center gap-2.5">
              {t.home.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="rounded-full border border-border bg-card px-3.5 py-1.5 text-[13px] text-secondary-foreground transition hover:border-primary/45 hover:text-accent-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section
        className={`min-h-0 min-w-0 w-full flex-1 ${
          hasWorkspace
            ? showWorkspacePanel
              ? 'grid grid-rows-[minmax(0,0.46fr)_minmax(0,0.54fr)] lg:grid-cols-[minmax(420px,42%)_minmax(0,1fr)] lg:grid-rows-1'
              : 'block'
            : 'hidden'
        }`}
      >
        <AgentConversation
          title={workspaceTitle}
          messages={messages}
          input={input}
          loading={loading}
          canSend={canSend}
          compact={showWorkspacePanel}
          copy={{
            agentName: t.workspace.agentName,
            you: t.workspace.you,
            running: t.workspace.activityRunning,
            completed: t.workspace.activityCompleted,
            failed: t.workspace.activityFailed,
            stopped: t.workspace.activityStopped,
            input: t.workspace.activityInput,
            output: t.workspace.activityOutput,
            placeholder: t.workspace.changePlaceholder,
            send: t.workspace.send,
            stop: t.workspace.stop,
            newProject: t.workspace.newProject,
          }}
          onInputChange={setInput}
          onSubmit={() => void sendMessage(input)}
          onStop={() => void handleStop()}
          onNewProject={handleNewProject}
        />

        {/* ===== RIGHT: preview / files ===== */}
        {showWorkspacePanel && <div className="workspace-result-panel flex min-h-0 min-w-0 w-full flex-col overflow-hidden bg-[#fbfbfc]">
          <div className="flex items-center gap-1 px-3.5 py-2.5">
            <Tabs
              value={sandboxTab}
              onValueChange={(value) => setSandboxTab(value as 'preview' | 'files')}
            >
              <TabsList className="h-auto gap-1 bg-transparent p-0">
                <TabsTrigger
                  value="preview"
                  className="h-auto rounded-[8px] px-3 py-1.5 text-[13px] font-semibold text-muted-foreground transition hover:text-secondary-foreground data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
                >
                  {t.workspace.application}
                </TabsTrigger>
                <TabsTrigger
                  value="files"
                  className="h-auto rounded-[8px] px-3 py-1.5 text-[13px] font-semibold text-muted-foreground transition hover:text-secondary-foreground data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none"
                >
                  {t.workspace.code}
                  {fileCount ? ` ${fileCount}` : ''}
                  {filesRefreshing && (
                    <span className="ml-1 text-[10px] opacity-70">{t.files.refreshing}</span>
                  )}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <span className="flex-1" />
            {download?.url && (
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloadBusy}
                title={t.workspace.downloadSource}
                className="action-chip bg-muted text-secondary-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="action-chip-icon">
                  {downloadBusy ? (
                    <span className="size-4 animate-spin rounded-full border-2 border-transparent border-t-current" />
                  ) : (
                    <Download className="size-4" />
                  )}
                </span>
                <span className="action-chip-label">
                  {downloadBusy ? t.workspace.downloading : t.workspace.downloadSource}
                </span>
              </button>
            )}
            {githubEnabled && download?.url && (
              <button
                type="button"
                onClick={handleExportGithub}
                disabled={githubBusy}
                title={t.workspace.exportGithub}
                className="action-chip bg-muted text-secondary-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="action-chip-icon">
                  {githubBusy ? (
                    <span className="size-4 animate-spin rounded-full border-2 border-transparent border-t-current" />
                  ) : (
                    <GitHubIcon />
                  )}
                </span>
                <span className="action-chip-label">
                  {githubBusy ? t.workspace.githubExporting : t.workspace.exportGithub}
                </span>
              </button>
            )}
            {CLAIM_DEPLOY_ENABLED && (
              <button
                type="button"
                onClick={handleClaimDeploy}
                title={t.workspace.claimDeployHint}
                className="action-chip bg-muted text-accent-foreground hover:bg-accent"
              >
                <span className="action-chip-icon">
                  <img src="/edgeone.png" alt="EdgeOne" className="size-[22px] rounded-full" />
                </span>
                <span className="action-chip-label">{t.workspace.claimDeploy}</span>
              </button>
            )}
            <LanguageSwitch
              language={language}
              onChange={setLanguage}
              ariaLabel={t.languageToggleAria}
              className="ml-4"
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {sandboxTab === 'preview' ? (
              preview?.url ? (
                <div className="m-3.5 flex min-h-0 flex-1 overflow-hidden rounded-[12px] bg-white shadow-[0_10px_30px_-22px_rgba(20,30,60,0.35)]">
                  <div className="relative min-h-0 flex-1 bg-white">
                    {!activePreviewLoaded && (
                      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-white/85 px-6 text-center text-muted-foreground">
                        {t.workspace.loadingPreview}
                      </div>
                    )}
                    {activePreviewUrl && (
                      <iframe
                        key={`${activePreviewUrl}:${activePreviewRevision}`}
                        title="sandbox-preview"
                        src={activePreviewUrl}
                        onLoad={() => setActivePreviewLoaded(true)}
                        className="h-full w-full border-0"
                      />
                    )}
                    {pendingPreviewUrl && (
                      <iframe
                        key={`pending:${pendingPreviewUrl}:${pendingPreviewRevision}`}
                        title="sandbox-preview-pending"
                        src={pendingPreviewUrl}
                        onLoad={promotePendingPreview}
                        className="invisible pointer-events-none absolute inset-0 h-full w-full border-0"
                      />
                    )}
                  </div>
                </div>
              ) : (
                <div className="m-3.5 flex min-h-0 flex-1 flex-col items-center justify-center rounded-[12px] bg-white px-6 text-center text-secondary-foreground">
                  <p>{t.workspace.previewEmpty}</p>
                  <p className="mt-3 max-w-xl text-xs leading-5 text-muted-foreground">
                    {t.workspace.constructionDisclaimer}
                  </p>
                </div>
              )
            ) : (
              <FilesPanel
                tree={fileTree}
                refreshing={filesRefreshing}
                conversationId={conversationId}
                copy={t.files}
              />
            )}
          </div>

          {(build?.status === 'failed' || download?.error || preview?.error) && (
            <div className="space-y-2 border-t border-border bg-card p-4 text-xs text-secondary-foreground">
              {build?.status === 'failed' && (
                <p className="text-destructive">
                  {build.autoFixApplied && build.autoFixAttempts
                    ? t.workspace.buildFailedAfter(build.autoFixAttempts)
                    : t.workspace.buildFailedMessage}
                </p>
              )}
              {preview?.error && (
                <p>
                  {t.workspace.previewError}
                  {preview.error}
                </p>
              )}
              {download?.error && (
                <p>
                  {t.workspace.downloadError}
                  {download.error}
                </p>
              )}
            </div>
          )}
        </div>}
      </section>

      {githubNotice && (
        <div
          className="gh-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
          onClick={() => setGithubNotice(null)}
        >
          <Card
            className="gh-card relative w-full max-w-sm overflow-hidden rounded-2xl border-border p-0 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label={t.workspace.githubClose}
              onClick={() => setGithubNotice(null)}
              className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>

            <div className="flex flex-col items-center gap-3 px-6 pb-6 pt-8 text-center">
              <span
                className={`flex h-14 w-14 items-center justify-center rounded-full ${
                  githubNotice.ok ? 'bg-primary/10' : 'bg-destructive/10'
                }`}
              >
                {githubNotice.ok ? (
                  <CheckCircle2 className="h-7 w-7 text-primary" />
                ) : (
                  <AlertCircle className="h-7 w-7 text-destructive" />
                )}
              </span>

              <h3 className="text-base font-semibold text-foreground">
                {githubNotice.ok ? t.workspace.githubSuccessTitle : t.workspace.githubErrorTitle}
              </h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {githubNotice.ok
                  ? t.workspace.githubSuccessDesc
                  : t.workspace.githubReasons[githubNotice.reason || 'push_failed']
                    || t.workspace.githubReasons.push_failed}
              </p>

              {githubNotice.ok && githubNotice.repo && (
                <a
                  href={githubNotice.repo}
                  target="_blank"
                  rel="noreferrer"
                  className="max-w-full truncate rounded-lg bg-accent px-3 py-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {githubNotice.repo.replace(/^https?:\/\//, '')}
                </a>
              )}

              <div className="mt-3 flex w-full gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setGithubNotice(null)}>
                  {t.workspace.githubClose}
                </Button>
                {githubNotice.ok ? (
                  githubNotice.repo && (
                    <Button
                      className="btn-brand flex-1"
                      onClick={() => window.open(githubNotice.repo, '_blank', 'noreferrer')}
                    >
                      <ExternalLink className="mr-1.5 h-4 w-4" />
                      {t.workspace.githubOpenRepo}
                    </Button>
                  )
                ) : (
                  <Button
                    className="btn-brand flex-1"
                    onClick={() => {
                      setGithubNotice(null);
                      handleExportGithub();
                    }}
                  >
                    {t.workspace.githubRetry}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}

const ProcessPanel = memo(function ProcessPanel({
  events,
  running,
  open,
  showThinking,
  onToggle,
  onToggleThinking,
  copy,
  labels,
}: {
  events: ProcessEvent[];
  running: boolean;
  open: boolean;
  showThinking: boolean;
  onToggle: () => void;
  onToggleThinking: () => void;
  copy: TimelineCopy;
  labels: {
    hide: string;
    view: string;
    steps: string;
    keepThinking: string;
  };
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasProcessEvents = events.length > 0;
  const visibleEvents = useMemo(
    () => showThinking
      ? events
      : events.filter((event) => event.kind !== 'thinking'),
    [events, showThinking],
  );
  const isOpen = hasProcessEvents ? open : true;

  useEffect(() => {
    if (!running || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleEvents, running, isOpen]);

  if (!hasProcessEvents && !running) {
    return null;
  }

  return (
    <div className="min-w-0 rounded-xl border border-border bg-muted px-3 py-2 text-[12px] leading-5 text-muted-foreground">
      {hasProcessEvents && (
        <div
          role="button"
          tabIndex={0}
          aria-label={open ? `${labels.hide}${labels.steps}` : `${labels.view}${labels.steps}`}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
              return;
            }
            event.preventDefault();
            onToggle();
          }}
          className="flex min-w-0 w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-lg px-1 py-1 text-left transition focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
        >
          <span className="flex size-6 items-center justify-center rounded-full text-primary transition hover:text-accent-foreground">
            <span
              aria-hidden="true"
              className={`block size-0 border-y-[5px] border-y-transparent border-l-[8px] border-l-current transition-transform ${
                open ? 'rotate-90' : ''
              }`}
            />
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={showThinking}
            onClick={(event) => {
              event.stopPropagation();
              onToggleThinking();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
              showThinking
                ? 'bg-accent text-accent-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${
                showThinking ? 'bg-primary' : 'bg-muted-foreground'
              }`}
              aria-hidden="true"
            />
            {labels.keepThinking}
          </button>
        </div>
      )}
      {isOpen && (
        <div
          ref={scrollRef}
          className={`${hasProcessEvents ? 'mt-2' : ''} min-w-0 space-y-2`}
        >
          {visibleEvents.length === 0 ? (
            running ? (
              <ProcessWaitingItem copy={copy} />
            ) : null
          ) : (
            <>
              {visibleEvents.map((event, index) => (
                <ProcessEventItem
                  key={getProcessEventKey(event, index)}
                  event={event}
                  copy={copy}
                />
              ))}
              {running && visibleEvents[visibleEvents.length - 1]?.kind !== 'thinking' && (
                <ProcessWaitingItem copy={copy} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

function ProcessWaitingItem({ copy }: { copy: TimelineCopy }) {
  return (
    <div className="flex min-w-0 items-center gap-2 pt-1 text-primary">
      <Spinner />
      <span className="min-w-0 flex-1 break-words text-[11px] [overflow-wrap:anywhere]">{copy.processing}</span>
    </div>
  );
}

function ProcessEventItem({
  event,
  copy,
}: {
  event: ProcessEvent;
  copy: TimelineCopy;
}) {
  if (event.kind === 'thinking') {
    return <ProcessThinkingItem content={event.content} />;
  }
  return <NormalizedStepCard step={event.step} copy={copy} />;
}

function ProcessThinkingItem({ content }: { content: string }) {
  return <SmoothThinkingText content={content} />;
}

function SmoothThinkingText({ content }: { content: string }) {
  const [segments, setSegments] = useState({ stable: '', incoming: '' });

  useEffect(() => {
    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setSegments({ stable: content, incoming: '' });
      return;
    }

    setSegments((current) => {
      const rendered = `${current.stable}${current.incoming}`;
      if (content === rendered) {
        return current;
      }
      if (content.startsWith(rendered)) {
        return {
          stable: current.stable,
          incoming: `${current.incoming}${content.slice(rendered.length)}`,
        };
      }
      if (content.startsWith(current.stable)) {
        return {
          stable: current.stable,
          incoming: content.slice(current.stable.length),
        };
      }
      return {
        stable: '',
        incoming: content,
      };
    });
  }, [content]);

  const settleIncoming = () => {
    setSegments((current) => {
      if (!current.incoming) {
        return current;
      }
      return {
        stable: `${current.stable}${current.incoming}`,
        incoming: '',
      };
    });
  };

  return (
    <div className="process-thinking-text">
      {segments.stable}
      {segments.incoming && (
        <span className="process-thinking-delta" onAnimationEnd={settleIncoming}>
          {segments.incoming}
        </span>
      )}
    </div>
  );
}

function getProcessEventKey(event: ProcessEvent, index: number) {
  if (event.kind === 'thinking') {
    return `thinking-${index}`;
  }
  return `step-${event.phase}`;
}

function appendOrUpdateTimelineStep(steps: TimelineStep[], nextStep: TimelineStep): TimelineStep[] {
  if (nextStep.kind !== 'tool_use' || !nextStep.id) {
    return [...steps, nextStep];
  }

  const existingIndex = steps.findIndex((step) =>
    step.kind === 'tool_use' && step.id === nextStep.id,
  );
  if (existingIndex < 0) {
    return [...steps, nextStep];
  }

  return steps.map((step, index) => {
    if (index !== existingIndex || step.kind !== 'tool_use') {
      return step;
    }
    return {
      ...step,
      name: nextStep.name || step.name,
      command: nextStep.command || step.command,
      phaseHint: nextStep.phaseHint || step.phaseHint,
      fileCount: nextStep.fileCount || step.fileCount,
    };
  });
}

function appendOrUpdateProcessThinking(events: ProcessEvent[], content: string): ProcessEvent[] {
  const tail = events[events.length - 1];
  if (tail?.kind === 'thinking') {
    return events.map((event, index) =>
      index === events.length - 1 && event.kind === 'thinking'
        ? { ...event, content }
        : event,
    );
  }
  return [...events, { kind: 'thinking', content }];
}

function appendOrUpdateProcessStep(
  events: ProcessEvent[],
  steps: TimelineStep[],
  changedStep: TimelineStep,
  copy: TimelineCopy,
): ProcessEvent[] {
  const processStep = getProcessStepForTimelineStep(changedStep, steps, copy);
  if (!processStep) {
    return events;
  }

  const existingIndex = events.findIndex((event) =>
    event.kind === 'step' && event.phase === processStep.phase,
  );
  if (existingIndex >= 0) {
    return events.map((event, index) =>
      index === existingIndex ? processStep : event,
    );
  }

  return [...events, processStep];
}

function shouldDelayProcessStepReveal(previousEvents: ProcessEvent[], nextEvents: ProcessEvent[]) {
  const previousTail = previousEvents[previousEvents.length - 1];
  return previousTail?.kind === 'thinking'
    && countProcessSteps(nextEvents) > countProcessSteps(previousEvents);
}

function appendPendingProcessSteps(
  events: ProcessEvent[],
  steps: TimelineStep[],
  copy: TimelineCopy,
): ProcessEvent[] {
  const existingPhases = new Set(
    events
      .filter((event): event is Extract<ProcessEvent, { kind: 'step' }> => event.kind === 'step')
      .map((event) => event.phase),
  );
  const pendingSteps = normalizeTimelineSteps(steps, copy)
    .filter((step) => !existingPhases.has(step.phase));
  if (pendingSteps.length === 0) {
    return events;
  }
  return [
    ...events,
    ...pendingSteps.map((step): Extract<ProcessEvent, { kind: 'step' }> => ({
      kind: 'step',
      phase: step.phase,
      step,
    })),
  ];
}

function countProcessSteps(events: ProcessEvent[]) {
  return events.reduce((count, event) => count + (event.kind === 'step' ? 1 : 0), 0);
}

// 语言切换时重刷已渲染的卡片文案。processEvents 里的 title/summary 是事件到达时
// 按当时语言算好的字符串，切换语言不会自动重算；但每条消息保留了语言无关的原始
// `steps`，这里用当前 copy 重新派生 step 文案。thinking 是模型自由文本，原样保留。
function relocalizeProcessEvents(
  events: ProcessEvent[],
  steps: TimelineStep[],
  copy: TimelineCopy,
): ProcessEvent[] {
  const normalizedByPhase = new Map(
    normalizeTimelineSteps(steps, copy).map((step) => [step.phase, step] as const),
  );
  return events.map((event) =>
    event.kind === 'step'
      ? { ...event, step: normalizedByPhase.get(event.phase) ?? event.step }
      : event,
  );
}

function getProcessStepForTimelineStep(
  changedStep: TimelineStep,
  steps: TimelineStep[],
  copy: TimelineCopy,
): Extract<ProcessEvent, { kind: 'step' }> | null {
  const phase = getTimelineStepPhase(changedStep, steps, copy);
  if (!phase) {
    return null;
  }
  const normalizedStep = normalizeTimelineSteps(steps, copy)
    .find((step) => step.phase === phase);
  return normalizedStep ? { kind: 'step', phase, step: normalizedStep } : null;
}

function getTimelineStepPhase(
  step: TimelineStep,
  steps: TimelineStep[],
  copy: TimelineCopy,
): NormalizedStepPhase | null {
  if (step.kind === 'tool_use') {
    return classifyToolUse(step, copy)?.phase ?? null;
  }
  if (step.kind === 'tool_result') {
    const relatedToolUse = [...steps].reverse().find((item) =>
      item.kind === 'tool_use' && item.id === step.toolUseId,
    ) as Extract<TimelineStep, { kind: 'tool_use' }> | undefined;
    if (relatedToolUse) {
      return classifyToolUse(relatedToolUse, copy)?.phase ?? null;
    }
    if (!step.ok && step.command) {
      return isInstallCommand(step.command) ? 'install' : 'code';
    }
    return null;
  }
  if (step.kind === 'status') {
    return classifyStatusText(step.text, copy)?.phase ?? null;
  }
  if (step.kind === 'log') {
    return classifyLogText(step.text, step.stream, copy)?.phase ?? null;
  }
  if (step.kind === 'error') {
    return /preview|预览|link|链接/i.test(step.text)
      ? 'link'
      : isInstallText(step.text)
        ? 'install'
        : 'code';
  }
  return null;
}

function normalizeTimelineSteps(steps: TimelineStep[], copy: TimelineCopy): NormalizedStep[] {
  const byPhase = new Map<NormalizedStepPhase, NormalizedStep>();
  const phaseByToolUseId = new Map<string, NormalizedStepPhase>();
  const commandByToolUseId = new Map<string, string>();

  const ensureStep = (phase: NormalizedStepPhase) => {
    const existing = byPhase.get(phase);
    if (existing) {
      return existing;
    }
    const definition = copy.definitions[phase];
    const step: NormalizedStep = {
      phase,
      title: definition.title,
      status: 'waiting',
      summary: definition.waiting,
    };
    byPhase.set(phase, step);
    return step;
  };

  const updateStep = (
    phase: NormalizedStepPhase,
    status: NormalizedStepStatus,
    summary: string,
  ) => {
    const step = ensureStep(phase);
    if (step.status === 'done' && status === 'running') {
      return;
    }
    step.status = status;
    step.summary = summary;
    if (phase === 'code') {
      const modifyStep = byPhase.get('modify');
      if (modifyStep) {
        modifyStep.status = 'done';
        modifyStep.summary = copy.summaries.modifyStarted;
      }
    }
  };

  for (const step of steps) {
    if (step.kind === 'modify_marker') {
      updateStep('modify', 'running', copy.definitions.modify.waiting);
      continue;
    }

    if (step.kind === 'tool_use') {
      if (step.command) {
        commandByToolUseId.set(step.id, step.command);
      }
      const classification = classifyToolUse(step, copy);
      if (!classification) {
        continue;
      }
      phaseByToolUseId.set(step.id, classification.phase);
      updateStep(classification.phase, 'running', classification.runningSummary);
      continue;
    }

    if (step.kind === 'tool_result') {
      const command = step.command || commandByToolUseId.get(step.toolUseId) || '';
      const phase = phaseByToolUseId.get(step.toolUseId) || (!step.ok && command ? 'code' : undefined);
      if (!phase) {
        continue;
      }
      if (phase === 'link' && step.ok) {
        updateStep('preview', 'done', copy.summaries.previewReady);
      }
      updateStep(
        phase,
        step.ok ? 'done' : 'error',
        summarizeToolResult(phase, step.ok, step.preview, copy, command),
      );
      continue;
    }

    if (step.kind === 'status') {
      const statusUpdate = classifyStatusText(step.text, copy);
      if (statusUpdate) {
        if (statusUpdate.phase === 'link' && statusUpdate.status === 'done') {
          updateStep('preview', 'done', copy.summaries.previewReady);
        }
        updateStep(statusUpdate.phase, statusUpdate.status, statusUpdate.summary);
      }
      continue;
    }

    if (step.kind === 'log') {
      const logUpdate = classifyLogText(step.text, step.stream, copy);
      if (logUpdate) {
        updateStep(logUpdate.phase, logUpdate.status, logUpdate.summary);
      }
      continue;
    }

    if (step.kind === 'error') {
      const phase = /preview|预览|link|链接/i.test(step.text)
        ? 'link'
        : isInstallText(step.text)
          ? 'install'
          : 'code';
      updateStep(phase, 'error', compactErrorSummary(step.text, copy.summaries.stepFailed(getStepTitle(phase, copy))));
    }
  }

  return PHASE_ORDER
    .map((phase) => byPhase.get(phase))
    .filter((step): step is NormalizedStep => Boolean(step));
}

const NormalizedStepCard = memo(function NormalizedStepCard({ step, copy }: { step: NormalizedStep; copy: TimelineCopy }) {
  const isWaiting = step.status === 'waiting';
  const isRunning = step.status === 'running';
  const isError = step.status === 'error';

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : isWaiting
            ? 'border-border bg-card text-muted-foreground'
            : 'border-border bg-card text-foreground'
      }`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
          {isRunning ? (
            <Spinner />
          ) : (
            <span
              className={`text-xs font-semibold ${
                isError
                  ? 'text-destructive'
                  : step.status === 'done'
                    ? 'text-[var(--ok)]'
                    : 'text-muted-foreground/60'
              }`}
            >
              {isError ? '!' : step.status === 'done' ? '✓' : '·'}
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{step.title}</div>
          <div className="mt-0.5 min-w-0 break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {step.summary}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            isError
              ? 'bg-destructive/15 text-destructive'
              : isRunning
                ? 'bg-accent text-accent-foreground'
                : step.status === 'done'
                  ? 'bg-[color-mix(in_srgb,var(--ok)_15%,transparent)] text-[var(--ok)]'
                  : 'bg-secondary text-muted-foreground'
          }`}
        >
          {copy.statusLabels[step.status]}
        </span>
      </div>
    </div>
  );
});

function classifyToolUse(step: Extract<TimelineStep, { kind: 'tool_use' }>, copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  runningSummary: string;
} | null {
  if (step.phaseHint) {
    return {
      phase: step.phaseHint,
      runningSummary: step.phaseHint === 'code' && step.fileCount && step.fileCount > 0
        ? copy.summaries.codeWritingFiles(step.fileCount)
        : getRunningSummary(step.phaseHint, copy),
    };
  }

  const toolName = shortenToolName(step.name);

  if (toolName === 'ensure_project_scaffold') {
    return { phase: 'scaffold', runningSummary: copy.summaries.scaffoldRunning };
  }

  if (toolName === 'write_project_file' || toolName === 'write_project_files' || toolName === 'write_files') {
    return {
      phase: 'code',
      runningSummary: copy.summaries.codeRunningUpdate,
    };
  }

  if (toolName === 'publish_preview' || toolName === 'get_preview_link') {
    return { phase: 'preview', runningSummary: copy.summaries.previewRunning };
  }

  if (toolName === 'files_write' || toolName === 'files_make_dir' || toolName === 'files_remove') {
    return { phase: 'code', runningSummary: copy.summaries.codeRunningUpdate };
  }

  if (toolName === 'files_read' || toolName === 'files_list' || toolName === 'files_exists') {
    return null;
  }

  if (toolName === 'commands') {
    if (step.command && isInstallCommand(step.command)) {
      return { phase: 'install', runningSummary: copy.summaries.installRunning };
    }
    if (step.command && isPreviewCommand(step.command)) {
      return { phase: 'preview', runningSummary: copy.summaries.previewRunning };
    }
    return null;
  }

  return null;
}

function getRunningSummary(phase: NormalizedStepPhase, copy: TimelineCopy) {
  if (phase === 'scaffold') return copy.summaries.scaffoldRunning;
  if (phase === 'code') return copy.summaries.codeRunningUpdate;
  if (phase === 'install') return copy.summaries.installRunning;
  if (phase === 'preview') return copy.summaries.previewRunning;
  return copy.summaries.linkRunning;
}

function summarizeToolResult(
  phase: NormalizedStepPhase,
  ok: boolean,
  preview: string,
  copy: TimelineCopy,
  command = '',
) {
  if (!ok) {
    const detail = compactErrorSummary(preview, copy.summaries.stepFailed(getStepTitle(phase, copy)));
    return command
      ? copy.summaries.commandFailed(compactCommandSummary(command), detail)
      : detail;
  }

  if (phase === 'scaffold') {
    const result = getRecord(parseJsonPreview(preview));
    if (typeof result?.created === 'boolean') {
      return result.created ? copy.summaries.scaffoldCreated : copy.summaries.scaffoldExisting;
    }
    return copy.summaries.scaffoldReady;
  }

  if (phase === 'code') {
    const result = getRecord(parseJsonPreview(preview));
    const written = Array.isArray(result?.written) ? result.written : [];
    return written.length > 0 ? copy.summaries.codeUpdatedFiles(written.length) : copy.summaries.codeUpdated;
  }

  if (phase === 'install') {
    return copy.summaries.installDone;
  }

  if (phase === 'preview') {
    return copy.summaries.previewStarted;
  }

  const result = getRecord(parseJsonPreview(preview));
  const url = typeof result?.url === 'string'
    ? result.url
    : typeof result?.previewUrl === 'string'
      ? result.previewUrl
      : '';
  return url ? copy.summaries.linkDone : copy.summaries.linkDoneNoUrl;
}

function classifyStatusText(text: string, copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  status: NormalizedStepStatus;
  summary: string;
} | null {
  if (/准备项目工作区|prepar(?:e|ing) the project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'running', summary: copy.summaries.scaffoldRunning };
  }
  if (/检测到已有工作区|existing project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'done', summary: copy.summaries.scaffoldExisting };
  }
  if (/已准备空项目工作区|empty project workspace/i.test(text)) {
    return { phase: 'scaffold', status: 'done', summary: copy.summaries.scaffoldCreated };
  }
  if (/自动修复|验证失败|auto-fix|validation|verification/i.test(text)) {
    return { phase: 'code', status: 'running', summary: copy.summaries.codeAutoFix };
  }
  if (/已获取预览链接|预览链接已获取|preview link (found|retrieved)/i.test(text)) {
    return { phase: 'link', status: 'done', summary: copy.summaries.linkDone };
  }
  if (/预览链接未返回|preview link (was not returned|missing)/i.test(text)) {
    return { phase: 'link', status: 'error', summary: copy.summaries.linkMissing };
  }
  return null;
}

function classifyLogText(text: string, stream: 'stdout' | 'stderr' | 'status', copy: TimelineCopy): {
  phase: NormalizedStepPhase;
  status: NormalizedStepStatus;
  summary: string;
} | null {
  if (stream === 'status') {
    return classifyStatusText(text, copy);
  }
  if (stream === 'stderr') {
    if (isInstallText(text)) {
      return { phase: 'install', status: 'error', summary: compactErrorSummary(text, copy.summaries.installFailed) };
    }
    if (/preview|预览|8080|3000|proxy|link|链接/i.test(text)) {
      return { phase: 'link', status: 'error', summary: compactErrorSummary(text, copy.summaries.previewFailed) };
    }
    return { phase: 'code', status: 'error', summary: compactErrorSummary(text, copy.summaries.processFailed) };
  }
  return null;
}

function parseJsonPreview(value: string): unknown {
  if (!value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isPreviewCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/.test(normalized)
    || /\b(next|vite|astro|nuxt)\s+dev\b/.test(normalized)
    || /\bpython\s+-m\s+http\.server\b/.test(normalized)
    || /\b(3000|8080)\b/.test(normalized) && /\b(dev|serve|server|preview|proxy)\b/.test(normalized)
  );
}

function isInstallCommand(cmd: string) {
  const normalized = cmd.toLowerCase();
  return (
    /\bnpm\s+(install|i)\b/.test(normalized)
    || /\bpnpm\s+install\b/.test(normalized)
    || /\byarn\s+install\b/.test(normalized)
    || /\bbun\s+install\b/.test(normalized)
    || /\bpython3?\s+-m\s+pip\s+install\b/.test(normalized)
    || /\bpip3?\s+install\b/.test(normalized)
  );
}

function isInstallText(text: string) {
  return (
    isInstallCommand(text)
    || /\b(dependency|dependencies|package install|install failed|failed to install)\b/i.test(text)
    || /依赖|安装失败/.test(text)
  );
}

function compactErrorSummary(value: string, fallback: string) {
  const cleaned = value
    .replace(/\s+/g, ' ')
    .replace(/"content"\s*:\s*"[^"]+"/g, '"content":"<hidden>"')
    .trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.length > 140 ? `${cleaned.slice(0, 140)}...` : cleaned;
}

function compactCommandSummary(value: string) {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 220 ? `${cleaned.slice(0, 220)}...` : cleaned;
}

function getStepTitle(phase: NormalizedStepPhase, copy: TimelineCopy) {
  return copy.definitions[phase]?.title || copy.summaries.unknownStep;
}

function shortenToolName(name: string) {
  // mcp__edgeone-sandbox__files -> files
  const m = name.match(/^mcp__[^_]+__(.+)$/);
  return m ? m[1] : name;
}

function Spinner() {
  return (
    <span
      className="inline-block size-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
      aria-hidden="true"
    />
  );
}

function NarrationText({ content }: { content: string }) {
  return (
    <div className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {content}
    </div>
  );
}

function TypewriterNarrationText({
  content,
  onDisplayChange,
}: {
  content: string;
  onDisplayChange?: (content: string) => void;
}) {
  const [displayContent, setDisplayContent] = useState('');
  const targetRef = useRef(content);

  useEffect(() => {
    onDisplayChange?.(displayContent);
  }, [displayContent, onDisplayChange]);

  useEffect(() => {
    targetRef.current = content;

    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setDisplayContent(content);
      return;
    }

    setDisplayContent((current) =>
      content.startsWith(current) ? current : '',
    );
  }, [content]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        setDisplayContent(targetRef.current);
        return;
      }

      setDisplayContent((current) => {
        const target = targetRef.current;
        if (current === target) return current;
        return target.slice(0, current.length + NARRATION_TYPEWRITER_CHARS_PER_TICK);
      });
    }, NARRATION_TYPEWRITER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <NarrationText content={displayContent} />
      {displayContent.length < content.length && (
        <span
          className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-full bg-primary align-[-0.15em]"
          aria-hidden="true"
        />
      )}
    </>
  );
}

function TypewriterMarkdownMessage({ content }: { content: string }) {
  const targetContent = sanitizeAssistantText(content);
  const [displayContent, setDisplayContent] = useState('');
  const targetRef = useRef(targetContent);

  useEffect(() => {
    targetRef.current = targetContent;

    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setDisplayContent(targetContent);
      return;
    }

    setDisplayContent((current) =>
      targetContent.startsWith(current) ? current : '',
    );
  }, [targetContent]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        setDisplayContent(targetRef.current);
        return;
      }

      setDisplayContent((current) => {
        const target = targetRef.current;
        if (current === target) return current;
        return target.slice(0, current.length + TYPEWRITER_CHARS_PER_TICK);
      });
    }, TYPEWRITER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="min-w-0">
      <MarkdownMessage content={displayContent} />
      {displayContent.length < targetContent.length && (
        <span
          className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-full bg-primary align-[-0.15em]"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  const displayContent = sanitizeAssistantText(content);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="btn-brand my-1 inline-flex max-w-full items-center gap-1.5 break-all rounded-full px-3 py-1.5 text-xs font-semibold no-underline"
          >
            {children}
          </a>
        ),
        pre: ({ children }) => (
          <pre className="mb-2 max-w-full overflow-x-auto rounded-lg border border-border bg-muted p-3 text-[12px] leading-5 last:mb-0">
            {children}
          </pre>
        ),
        code: ({ children, className, ...props }) => (
          <code
            className={`rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground ${className || ''}`}
            {...props}
          >
            {children}
          </code>
        ),
      }}
    >
      {displayContent}
    </ReactMarkdown>
  );
}

type FilePreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | {
      status: 'ready';
      path: string;
      content: string;
      truncated: boolean;
      size: number;
    }
  | { status: 'error'; path: string; error: string };

function FilesPanel({
  tree,
  refreshing,
  conversationId,
  copy,
}: {
  tree: FileTree | null;
  refreshing: boolean;
  conversationId: string | null;
  copy: FileCopy;
}) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewState>({ status: 'idle' });
  // Track the latest requested path so slower responses cannot overwrite newer selections.
  const latestRequestRef = useRef<string | null>(null);

  // Clear local file preview state when the conversation changes and the file tree root changes.
  useEffect(() => {
    setCollapsedDirs(new Set());
    setSelectedPath(null);
    setPreview({ status: 'idle' });
    latestRequestRef.current = null;
  }, [tree?.root]);

  const visibleItems = useMemo(() => {
    if (!tree) {
      return [];
    }

    return tree.items.filter((item) => {
      for (const collapsedPath of collapsedDirs) {
        if (item.path !== collapsedPath && item.path.startsWith(`${collapsedPath}/`)) {
          return false;
        }
      }
      return true;
    });
  }, [collapsedDirs, tree]);

  const toggleDirectory = (path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const loadFile = async (path: string) => {
    setSelectedPath(path);
    latestRequestRef.current = path;
    setPreview({ status: 'loading', path });
    try {
      const headers: HeadersInit = {};
      const cid = conversationId || getOrCreateCachedConversationId();
      if (cid) {
        headers['makers-conversation-id'] = cid;
        headers['conversationId'] = cid;
      }
      const resp = await fetch(`/file?path=${encodeURIComponent(path)}`, {
        method: 'GET',
        headers,
      });
      const data = (await resp.json()) as {
        ok?: boolean;
        path?: string;
        content?: string;
        size?: number;
        truncated?: boolean;
        error?: string;
      };
      // Discard this response if the user selected another file while it was loading.
      if (latestRequestRef.current !== path) {
        return;
      }
      if (!data.ok) {
        setPreview({ status: 'error', path, error: data.error || copy.readFailed });
        return;
      }
      setPreview({
        status: 'ready',
        path,
        content: data.content || '',
        truncated: Boolean(data.truncated),
        size: typeof data.size === 'number' ? data.size : 0,
      });
    } catch (err) {
      if (latestRequestRef.current !== path) {
        return;
      }
      setPreview({
        status: 'error',
        path,
        error: err instanceof Error ? err.message : copy.requestFailed,
      });
    }
  };

  if (!tree || tree.items.length === 0) {
    return (
      <div className="m-3.5 flex min-h-0 flex-1 items-center justify-center rounded-[12px] bg-card px-6 text-center text-muted-foreground">
        {refreshing ? copy.refreshing : copy.empty}
      </div>
    );
  }

  return (
    <div className="m-3.5 grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)] overflow-hidden rounded-[12px] bg-card text-secondary-foreground shadow-[0_10px_30px_-22px_rgba(20,30,60,0.35)]">
      <aside className="flex min-h-0 flex-col border-r border-[#eef0f3] bg-[#fafbfd]">
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {copy.projectFiles}
          </div>
          <div className="space-y-0.5 font-mono text-[12.5px] leading-5">
            {visibleItems.map((item) => {
              const isDirectory = item.type === 'directory';
              const isCollapsed = collapsedDirs.has(item.path);
              const isSelected = !isDirectory && selectedPath === item.path;

              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    if (isDirectory) {
                      toggleDirectory(item.path);
                    } else {
                      loadFile(item.path);
                    }
                  }}
                  className={`flex w-full min-w-max items-center gap-2 rounded-[7px] px-2 py-1.5 text-left transition ${
                    isSelected
                      ? 'bg-accent font-semibold text-accent-foreground'
                      : 'text-secondary-foreground hover:bg-[#eef2f8]'
                  }`}
                  style={{ paddingLeft: `${8 + item.depth * 18}px` }}
                >
                  {isDirectory && (
                    <span className="text-muted-foreground" aria-hidden="true">
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                  )}
                  <span>{item.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 flex-col">
        <FileContentView preview={preview} copy={copy} />
      </div>
    </div>
  );
}

// Light syntax theme mirroring the GitHub-light tokens in plan/design-mockup.html
// (tok-kw #cf222e, tok-fn #8250df, tok-str #0a7d33, tok-cm #8b949e, tok-tag #116329,
// tok-num/attr #0550ae). Background stays transparent so the code surface shows through.
const CODE_THEME: PrismTheme = {
  plain: { color: '#24292f', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#8b949e', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: '#24292f' } },
    { types: ['keyword', 'operator', 'boolean', 'important', 'atrule'], style: { color: '#cf222e' } },
    { types: ['function', 'function-variable', 'method'], style: { color: '#8250df' } },
    { types: ['string', 'char', 'attr-value', 'template-string', 'regex', 'url'], style: { color: '#0a7d33' } },
    { types: ['number', 'unit'], style: { color: '#0550ae' } },
    { types: ['tag', 'selector'], style: { color: '#116329' } },
    { types: ['attr-name', 'constant', 'builtin', 'symbol'], style: { color: '#0550ae' } },
    { types: ['class-name', 'maybe-class-name'], style: { color: '#953800' } },
    { types: ['property', 'variable', 'parameter'], style: { color: '#24292f' } },
    { types: ['deleted'], style: { color: '#cf222e' } },
    { types: ['inserted'], style: { color: '#0a7d33' } },
  ],
};

// Map a file path to a Prism language. Unknown extensions fall back to plain text
// (Prism renders a single token, so the file still shows uncolored but intact).
function prismLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
    case 'vue':
      return 'markup';
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    default:
      return 'tsx';
  }
}

function FileContentView({ preview, copy }: { preview: FilePreviewState; copy: FileCopy }) {
  if (preview.status === 'idle') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center text-muted-foreground">
        {copy.selectFile}
      </div>
    );
  }
  if (preview.status === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-[#fafbfd] px-4 py-3 text-xs text-primary">
          <Spinner />
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {copy.loading(preview.path)}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }
  if (preview.status === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border bg-[#fafbfd] px-4 py-3">
          <p className="truncate font-mono text-[11px] text-muted-foreground">{preview.path}</p>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-destructive">
          {preview.error}
        </div>
      </div>
    );
  }

  const lines = preview.content.split('\n');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-[#fafbfd] px-4 py-3">
        <p className="min-w-0 truncate font-mono text-[11px] text-secondary-foreground">
          {preview.path}
        </p>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>{copy.lines(lines.length)}</span>
          <span>{formatFileSize(preview.size)}</span>
          {preview.truncated && (
            <span className="rounded-full bg-[color-mix(in_srgb,var(--gold)_15%,transparent)] px-2 py-0.5 text-[var(--gold)]">
              {copy.truncated}
            </span>
          )}
        </div>
      </div>
      <Highlight code={preview.content} language={prismLanguage(preview.path)} theme={CODE_THEME}>
        {({ tokens, getTokenProps }) => (
          <pre className="min-h-0 flex-1 overflow-auto bg-white py-3 font-mono text-[12px] leading-5 text-foreground">
            <code>
              {tokens.map((line, lineIndex) => (
                <span
                  key={lineIndex}
                  className="grid min-w-max grid-cols-[3.5rem_minmax(0,1fr)] gap-3 px-4"
                >
                  <span className="select-none text-right text-muted-foreground/60">
                    {lineIndex + 1}
                  </span>
                  <span className="whitespace-pre">
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function ArrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-8 text-[#31755c]"
      fill="currentColor"
    >
      <path d="M4 4.9 21 12 4 19.1l3.2-6.2L16 12l-8.8-.9L4 4.9Z" />
    </svg>
  );
}

function FigmaIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="currentColor">
      <path d="M8 24a4 4 0 0 0 4-4v-4H8a4 4 0 0 0 0 8Zm-4-8a4 4 0 0 1 4-4h4V4H8a4 4 0 0 0 0 8 4 4 0 0 0-4 4ZM8 0a4 4 0 0 0 0 8h4V0H8Zm4 0v8h4a4 4 0 0 0 0-8h-4Zm0 8v8h4a4 4 0 0 0 0-8h-4Z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6" fill="currentColor">
      <path d="M12 .5A11.5 11.5 0 0 0 8.4 22.9c.58.1.8-.25.8-.56v-2.1c-3.26.7-3.95-1.4-3.95-1.4-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.7.08-.7 1.18.08 1.8 1.2 1.8 1.2 1.04 1.79 2.74 1.27 3.42.97.1-.75.4-1.27.74-1.56-2.6-.3-5.34-1.3-5.34-5.76 0-1.27.46-2.32 1.2-3.14-.12-.3-.52-1.5.12-3.1 0 0 .98-.32 3.22 1.2a11.1 11.1 0 0 1 5.86 0c2.23-1.52 3.2-1.2 3.2-1.2.65 1.6.25 2.8.13 3.1.75.82 1.2 1.87 1.2 3.14 0 4.47-2.74 5.45-5.35 5.75.42.36.8 1.08.8 2.18v3.23c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}
