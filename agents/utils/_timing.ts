export const TIMING_LOG_PREFIX = '[timing]';

export type TimingFieldValue = string | number | boolean;
export type TimingFields = Record<string, TimingFieldValue | undefined>;

export type TimingMark = {
  stage: string;
  startedAt: number;
  endedAt: number;
  duration_ms: number;
  since_turn_ms: number;
  fields?: TimingFields;
};

export type TurnTimer = {
  originMs: number;
  marks: TimingMark[];
  mark: (stage: string, startedAt: number, fields?: TimingFields) => TimingMark;
  record: (stage: string, startedAt: number, endedAt: number, fields?: TimingFields) => TimingMark;
  formatSummary: () => string;
};

function formatField(value: TimingFieldValue) {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (/^[A-Za-z0-9_.:/-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function formatTimingLog(mark: TimingMark) {
  const parts = [
    TIMING_LOG_PREFIX,
    mark.stage,
    `duration_ms=${mark.duration_ms}`,
    `since_turn_ms=${mark.since_turn_ms}`,
  ];
  if (mark.fields) {
    for (const [key, value] of Object.entries(mark.fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${formatField(value)}`);
    }
  }
  return parts.join(' ');
}

export function isTimingLog(message: string) {
  return message.startsWith(`${TIMING_LOG_PREFIX} `);
}

export function parseTimingLog(message: string): {
  stage: string;
  fields: Record<string, TimingFieldValue>;
} | null {
  if (!isTimingLog(message)) {
    return null;
  }
  const tokens = message.slice(TIMING_LOG_PREFIX.length).trim().split(/\s+/);
  const stage = tokens.shift();
  if (!stage) {
    return null;
  }
  const fields: Record<string, TimingFieldValue> = {};
  for (const token of tokens) {
    const separator = token.indexOf('=');
    if (separator <= 0) continue;
    const key = token.slice(0, separator);
    const raw = token.slice(separator + 1);
    if (raw === 'true' || raw === 'false') {
      fields[key] = raw === 'true';
      continue;
    }
    if (/^-?\d+$/.test(raw)) {
      fields[key] = Number(raw);
      continue;
    }
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        fields[key] = JSON.parse(raw) as string;
        continue;
      } catch {
        fields[key] = raw;
        continue;
      }
    }
    fields[key] = raw;
  }
  return { stage, fields };
}

export function createTurnTimer(originMs = Date.now()): TurnTimer {
  const marks: TimingMark[] = [];

  const record = (stage: string, startedAt: number, endedAt: number, fields?: TimingFields): TimingMark => {
    const item: TimingMark = {
      stage,
      startedAt,
      endedAt,
      duration_ms: Math.max(0, endedAt - startedAt),
      since_turn_ms: Math.max(0, endedAt - originMs),
      ...(fields ? { fields } : {}),
    };
    marks.push(item);
    return item;
  };

  const mark = (stage: string, startedAt: number, fields?: TimingFields): TimingMark => {
    return record(stage, startedAt, Date.now(), fields);
  };

  return {
    originMs,
    marks,
    mark,
    record,
    formatSummary() {
      const endedAt = Date.now();
      const since_turn_ms = Math.max(0, endedAt - originMs);
      return formatTimingLog({
        stage: 'summary',
        startedAt: originMs,
        endedAt,
        duration_ms: since_turn_ms,
        since_turn_ms,
        fields: {
          stages: marks.map((item) => `${item.stage}:${item.duration_ms}`).join(',') || 'none',
        },
      });
    },
  };
}
