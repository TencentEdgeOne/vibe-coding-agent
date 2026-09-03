'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  AppWindow,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  FilePenLine,
  FilePlus2,
  FolderPlus,
  FolderSearch,
  Monitor,
  Search,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  presentToolActivity,
  type ToolAction,
} from '../lib/tool-activity';
import { ModelPicker } from './model-picker';
import type {
  ActivityStatus,
  AssistantActivity,
} from '../../shared/protocol';
import type { ModelOption } from '../../shared/models';

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: 'running' | 'done' | 'error' | 'stopped';
};

type ConversationCopy = {
  running: string;
  completed: string;
  failed: string;
  stopped: string;
  input: string;
  output: string;
  placeholder: string;
  send: string;
  stop: string;
  modelLabel: string;
  toolActions: Record<ToolAction, string>;
};

function actionLabel(action: ToolAction, copy: ConversationCopy) {
  return copy.toolActions[action];
}

function ActionIcon({ action }: { action: ToolAction }) {
  const props = { className: 'tool-activity-action-icon', 'aria-hidden': true } as const;
  if (action === 'Environment Preparing') return <Monitor {...props} />;
  if (action === 'Glob') return <FolderSearch {...props} />;
  if (action === 'Read file') return <Search {...props} />;
  if (action === 'Write file') return <FilePlus2 {...props} />;
  if (action === 'Edit file') return <FilePenLine {...props} />;
  if (action === 'Create folder') return <FolderPlus {...props} />;
  if (action === 'Delete file') return <Trash2 {...props} />;
  if (action === 'Create preview') return <AppWindow {...props} />;
  return <SquareTerminal {...props} />;
}

function ActivityIcon({ status, action }: { status: ActivityStatus; action: ToolAction }) {
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
          <span>{actionLabel(presentation.action, copy)}{presentation.target ? ' ' : ''}</span>
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
  const readPaths = new Set<string>();
  const previouslyReadByIndex = new Map<number, ReadonlySet<string>>();
  activities.forEach((activity, index) => {
    if (activity.kind !== 'tool') return;
    previouslyReadByIndex.set(index, new Set(readPaths));
    const presentation = presentToolActivity(activity);
    if (presentation.action === 'Read file' && presentation.target) {
      readPaths.add(presentation.target);
    }
  });
  // Compared without any whitespace so a narration whose spacing drifted from the
  // final text is still recognized as the same sentence.
  const normalizedFinal = message.content.replace(/\s+/g, '');
  const isFinalTextDuplicate = (content: string) => {
    if (message.status === 'running' || !normalizedFinal) return false;
    const normalizedActivity = content.replace(/\s+/g, '');
    return normalizedActivity.length > 24
      && (normalizedActivity.includes(normalizedFinal) || normalizedFinal.includes(normalizedActivity));
  };
  const hasRunningTool = activities.some(
    (activity) => activity.kind === 'tool' && activity.status === 'running',
  );
  const lastActivity = activities.at(-1);
  const showWaiting = message.status === 'running'
    && !hasRunningTool
    && lastActivity?.kind !== 'text';

  return (
    <section className="conversation-turn conversation-assistant-turn">
      <div className="conversation-body">
        {activities.map((activity, index) => {
          if (activity.kind === 'text') {
            return isFinalTextDuplicate(activity.content)
              ? null
              : <Markdown key={`text-${index}`} content={activity.content} />;
          }
          return (
            <ToolActivityRow
              key={activity.toolUseId || `tool-${index}`}
              activity={activity}
              copy={copy}
              previouslyReadPaths={previouslyReadByIndex.get(index) ?? new Set()}
            />
          );
        })}
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
        {showWaiting && (
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
  models,
  model,
  onModelChange,
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
  models: readonly ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
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
    <div className={`agent-conversation min-w-0 w-full ${compact ? 'agent-conversation-compact' : ''}`}>
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
        {/* Locked mid-run: the turn already went out on a model, and letting the
            control move would show one name while another was answering. */}
        <ModelPicker
          models={models}
          value={model}
          ariaLabel={copy.modelLabel}
          disabled={loading}
          onChange={onModelChange}
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
