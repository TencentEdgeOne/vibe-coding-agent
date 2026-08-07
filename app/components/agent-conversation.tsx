'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, CircleAlert, Plus, Square, X } from 'lucide-react';
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
  newProject: string;
};

function shortToolName(name: string) {
  return name.replace(/^mcp__[^_]+__/, '').replaceAll('_', ' ');
}

function ActivityIcon({ status }: { status: ActivityStatus }) {
  if (status === 'running') {
    return <span className="size-3 animate-spin rounded-full border border-current border-t-transparent" />;
  }
  if (status === 'failed') return <X className="size-3.5" />;
  if (status === 'stopped') return <Square className="size-3" />;
  return <Check className="size-3.5" />;
}

function ToolActivityRow({ activity, copy }: {
  activity: Extract<AssistantActivity, { kind: 'tool' }>;
  copy: ConversationCopy;
}) {
  const [open, setOpen] = useState(false);
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
        <span className="tool-activity-status"><ActivityIcon status={activity.status} /></span>
        <span>{label}</span>
        <code>{shortToolName(activity.name)}</code>
        <ChevronRight className={`ml-1 size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
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
            <p>{label}</p>
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
  const normalizedFinal = message.content.replace(/\s+/g, ' ').trim();
  const isFinalTextDuplicate = (content: string) => {
    if (message.status === 'running' || !normalizedFinal) return false;
    const normalizedActivity = content.replace(/\s+/g, ' ').trim();
    return normalizedActivity.length > 24
      && (normalizedActivity.includes(normalizedFinal) || normalizedFinal.includes(normalizedActivity));
  };

  return (
    <section className="conversation-turn">
      <div className="conversation-author">
        <span className="agent-avatar">EO</span>
        <strong>{copy.agentName}</strong>
        {message.status === 'error' && <CircleAlert className="size-4 text-destructive" />}
      </div>
      <div className="conversation-body">
        {activities.map((activity, index) => activity.kind === 'text' ? (
          isFinalTextDuplicate(activity.content)
            ? null
            : <Markdown key={`text-${index}`} content={activity.content} />
        ) : (
          <ToolActivityRow key={activity.toolUseId || `tool-${index}`} activity={activity} copy={copy} />
        ))}
        {message.content && <Markdown content={message.content} />}
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
  title,
  messages,
  input,
  loading,
  canSend,
  compact,
  copy,
  onInputChange,
  onSubmit,
  onStop,
  onNewProject,
}: {
  title: string;
  messages: ConversationMessage[];
  input: string;
  loading: boolean;
  canSend: boolean;
  compact: boolean;
  copy: ConversationCopy;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onNewProject: () => void;
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
      <header className="conversation-header">
        <h1 title={title}>{title}</h1>
      </header>
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
            <section key={message.id} className="conversation-turn">
              <div className="conversation-author">
                <span className="user-avatar">U</span>
                <strong>{copy.you}</strong>
              </div>
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
        <button type="button" className="composer-icon" onClick={onNewProject} disabled={loading} title={copy.newProject} aria-label={copy.newProject}>
          <Plus className="size-4" />
        </button>
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
