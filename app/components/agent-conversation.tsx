'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  FilePlus2,
  FolderSearch,
  Monitor,
  RefreshCw,
  Search,
  Square,
  SquareTerminal,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type AssistantActivity =
  | { kind: 'text'; content: string }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      status: ActivityStatus;
      inputSummary?: string;
      outputSummary?: string;
      startedAt?: number;
      endedAt?: number;
    };

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: 'running' | 'done' | 'error' | 'stopped';
};

type ConversationCopy = {
  agentName: string;
  you: string;
  running: string;
  completed: string;
  failed: string;
  stopped: string;
  input: string;
  output: string;
  placeholder: string;
  send: string;
  stop: string;
  workedFor: (duration: string) => string;
};

function shortToolName(name: string) {
  return name.replace(/^mcp__[^_]+__/, '').replaceAll('_', ' ');
}

type ToolPresentation = {
  action: 'Environment Preparing' | 'Glob' | 'Read file' | 'Write file' | 'Edit file' | 'Rebuild preview' | 'Run command';
  target?: string;
};

function cleanSummaryTarget(summary = '') {
  const firstLine = summary.trim().split('\n')[0] || '';
  return firstLine
    .replace(/^<project>\/?/, '')
    .replace(/\s+\([\d,.]+ chars\)$/, '')
    .trim();
}

function readStructuredTarget(summary = '') {
  const trimmed = summary.trim();
  if (!trimmed.startsWith('{')) return '';
  try {
    const input = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'pattern', 'glob', 'query']) {
      if (typeof input[key] === 'string') return cleanSummaryTarget(input[key]);
    }
  } catch {
    return '';
  }
  return '';
}

export function presentToolActivity(
  activity: Extract<AssistantActivity, { kind: 'tool' }>,
  previouslyReadPaths: ReadonlySet<string> = new Set(),
): ToolPresentation {
  const name = shortToolName(activity.name).toLowerCase();
  const structuredTarget = readStructuredTarget(activity.inputSummary);
  const target = structuredTarget || cleanSummaryTarget(activity.inputSummary);

  if (name.includes('ensure project scaffold') || name.includes('environment')) {
    return { action: 'Environment Preparing' };
  }
  if (name.includes('glob') || name.includes('files list') || name.includes('folder search')) {
    return { action: 'Glob', target: target || '**/*' };
  }
  if (name.includes('read')) {
    return { action: 'Read file', target };
  }
  if (name.includes('write project file') || name.includes('files write') || name.includes('write files')) {
    return { action: previouslyReadPaths.has(target) ? 'Edit file' : 'Write file', target };
  }
  if (name.includes('publish preview') || name.includes('preview link')) {
    return { action: 'Rebuild preview' };
  }
  if (name === 'commands' || name.includes('command')) {
    const isPreviewCommand = /(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|build)|\b(?:vite|next)\s+(?:dev|build)|preview/i.test(target);
    return isPreviewCommand
      ? { action: 'Rebuild preview' }
      : { action: 'Run command', target };
  }
  return { action: 'Run command', target: target || shortToolName(activity.name) };
}

function ActionIcon({ action }: { action: ToolPresentation['action'] }) {
  const props = { className: 'tool-activity-action-icon', 'aria-hidden': true } as const;
  if (action === 'Environment Preparing') return <Monitor {...props} />;
  if (action === 'Glob') return <FolderSearch {...props} />;
  if (action === 'Read file') return <Search {...props} />;
  if (action === 'Write file') return <FilePlus2 {...props} />;
  if (action === 'Edit file') return <FilePenLine {...props} />;
  if (action === 'Rebuild preview') return <RefreshCw {...props} />;
  return <SquareTerminal {...props} />;
}

function ActivityIcon({ status, action }: { status: ActivityStatus; action: ToolPresentation['action'] }) {
  if (status === 'running') {
    return <span className="tool-activity-spinner" />;
  }
  if (status === 'failed') return <X className="size-3.5" />;
  if (status === 'stopped') return <Square className="size-3" />;
  return <ActionIcon action={action} />;
}

function ToolActivityRow({ activity, copy, previouslyReadPaths }: {
  activity: Extract<AssistantActivity, { kind: 'tool' }>;
  copy: ConversationCopy;
  previouslyReadPaths: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const presentation = presentToolActivity(activity, previouslyReadPaths);
  const label = activity.status === 'running'
    ? copy.running
    : activity.status === 'completed'
      ? copy.completed
      : activity.status === 'failed'
        ? copy.failed
        : copy.stopped;

  return (
    <div className="tool-activity-row">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={`tool-activity-trigger tool-activity-${activity.status}`}
      >
        <span className="tool-activity-status"><ActivityIcon status={activity.status} action={presentation.action} /></span>
        <span className="tool-activity-copy">
          <span>{presentation.action}{presentation.target ? ' ' : ''}</span>
          {presentation.target && <strong>{presentation.target}</strong>}
        </span>
        {(activity.inputSummary || activity.outputSummary) && (
          <ChevronRight className={`tool-activity-chevron ${open ? 'rotate-90' : ''}`} />
        )}
        <span className="sr-only">{label}</span>
      </button>
      {open && (
        <div className="tool-activity-detail">
          {activity.inputSummary && (
            <div>
              <span>{copy.input}</span>
              <pre>{activity.inputSummary}</pre>
            </div>
          )}
          {activity.outputSummary && (
            <div>
              <span>{copy.output}</span>
              <pre>{activity.outputSummary}</pre>
            </div>
          )}
          {!activity.inputSummary && !activity.outputSummary && (
            <p className="tool-activity-empty">{label}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Markdown({ content }: { content: string }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function AssistantTurn({ message, copy }: {
  message: ConversationMessage;
  copy: ConversationCopy;
}) {
  const activities = message.activities ?? [];
  const toolActivities = activities.filter(
    (activity): activity is Extract<AssistantActivity, { kind: 'tool' }> => activity.kind === 'tool',
  );
  const readPaths = new Set<string>();
  const previouslyReadPaths = toolActivities.map((activity) => {
    const snapshot = new Set(readPaths);
    const presentation = presentToolActivity(activity);
    if (presentation.action === 'Read file' && presentation.target) readPaths.add(presentation.target);
    return snapshot;
  });
  const [traceOpen, setTraceOpen] = useState(true);
  const normalizedFinal = message.content.replace(/\s+/g, ' ').trim();
  const isFinalTextDuplicate = (content: string) => {
    if (message.status === 'running' || !normalizedFinal) return false;
    const normalizedActivity = content.replace(/\s+/g, ' ').trim();
    return normalizedActivity.length > 24
      && (normalizedActivity.includes(normalizedFinal) || normalizedFinal.includes(normalizedActivity));
  };

  useEffect(() => {
    if (message.status === 'running') setTraceOpen(true);
  }, [message.status]);

  const startedAt = toolActivities.reduce(
    (earliest, activity) => activity.startedAt ? Math.min(earliest, activity.startedAt) : earliest,
    Number.POSITIVE_INFINITY,
  );
  const endedAt = toolActivities.reduce(
    (latest, activity) => activity.endedAt ? Math.max(latest, activity.endedAt) : latest,
    0,
  );
  const elapsedSeconds = Number.isFinite(startedAt)
    ? Math.max(1, Math.round(((endedAt || startedAt) - startedAt) / 1000))
    : 0;
  const duration = elapsedSeconds >= 60
    ? `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
    : `${elapsedSeconds}s`;

  return (
    <section className="conversation-turn conversation-assistant-turn">
      <div className="conversation-body">
        {activities.map((activity, index) => activity.kind === 'text' ? (
          isFinalTextDuplicate(activity.content)
            ? null
            : <Markdown key={`text-${index}`} content={activity.content} />
        ) : null)}
        {toolActivities.length > 0 && (
          <div className="assistant-trace">
            <button
              type="button"
              className="assistant-trace-trigger"
              aria-expanded={traceOpen}
              onClick={() => setTraceOpen((current) => !current)}
            >
              {message.status === 'running' ? (
                <span className="assistant-trace-spinner" aria-hidden="true" />
              ) : (
                <ChevronRight className="assistant-trace-chevron" aria-hidden="true" />
              )}
              <span>{message.status === 'running' ? copy.running : copy.workedFor(duration)}</span>
              {message.status === 'error' && <CircleAlert aria-hidden="true" />}
            </button>
            {traceOpen && (
              <div className="assistant-trace-list">
                {toolActivities.map((activity, index) => (
                  <ToolActivityRow
                    key={activity.toolUseId || `tool-${index}`}
                    activity={activity}
                    copy={copy}
                    previouslyReadPaths={previouslyReadPaths[index]}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {/* While running, streamed text activities are the source of truth. Showing
            message.content at the same time repeats the trailing sentence. */}
        {message.content && message.status !== 'running' && (
          message.status === 'error' ? (
            <div className="assistant-error-message" role="status">
              <CircleAlert aria-hidden="true" />
              <span>{message.content}</span>
            </div>
          ) : (
            <Markdown content={message.content} />
          )
        )}
        {message.status === 'running' && activities.length === 0 && (
          <div className="agent-waiting" aria-label={copy.running}>
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </section>
  );
}

export function AgentConversation({
  messages,
  input,
  loading,
  canSend,
  compact,
  copy,
  onInputChange,
  onSubmit,
  onStop,
}: {
  messages: ConversationMessage[];
  input: string;
  loading: boolean;
  canSend: boolean;
  compact: boolean;
  copy: ConversationCopy;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followOutputRef = useRef(true);
  const signature = messages.map((message) => [
    message.id,
    message.status,
    message.content,
    message.activities?.map((activity) => activity.kind === 'text'
      ? activity.content
      : `${activity.toolUseId}:${activity.status}:${activity.outputSummary || ''}`).join('|'),
  ].join(':')).join('\n');

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followOutputRef.current) node.scrollTop = node.scrollHeight;
  }, [signature]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <div className={`agent-conversation min-w-0 w-full overflow-hidden ${compact ? 'agent-conversation-compact' : ''}`}>
      <div
        ref={scrollRef}
        className="conversation-scroll"
        onScroll={(event) => {
          const node = event.currentTarget;
          followOutputRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
        }}
      >
        <div className="conversation-stream">
          {messages.map((message) => message.role === 'user' ? (
            <section key={message.id} className="conversation-turn conversation-user-turn">
              <div className="conversation-body whitespace-pre-wrap">{message.content}</div>
            </section>
          ) : (
            <AssistantTurn key={message.id} message={message} copy={copy} />
          ))}
        </div>
      </div>
      <form onSubmit={submit} className="conversation-composer">
        <textarea
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!loading && canSend) onSubmit();
            }
          }}
          placeholder={copy.placeholder}
          rows={1}
        />
        {loading ? (
          <button type="button" className="composer-stop" onClick={onStop} title={copy.stop} aria-label={copy.stop}>
            <Square className="size-3" fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="composer-send" disabled={!canSend} title={copy.send} aria-label={copy.send}>
            <ArrowUp className="size-4" />
          </button>
        )}
      </form>
    </div>
  );
}
