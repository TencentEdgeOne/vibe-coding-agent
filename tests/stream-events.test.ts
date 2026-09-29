import assert from 'node:assert/strict';
import test from 'node:test';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  describeSdkMessage,
  extractVisibleThinkingDelta,
  formatResultUsage,
} from '../agents/_lib/session/stream-projector.ts';
import { applyStreamEvent } from '../shared/timeline.ts';
import type { PersistedActivityTurn } from '../shared/protocol.ts';

test('thinking_delta text is extracted from a stream_event', () => {
  const event = {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'Need a form first.' },
    },
  } as unknown as SDKMessage;
  assert.equal(extractVisibleThinkingDelta(event), 'Need a form first.');
});

test('thinking_tokens pings are not surfaced as system_info', () => {
  assert.equal(describeSdkMessage({
    type: 'system',
    subtype: 'thinking_tokens',
    uuid: 'u-tokens',
    session_id: 's1',
  } as unknown as SDKMessage), null);

  assert.equal(describeSdkMessage({
    type: 'thinking_tokens',
    uuid: 'u-tokens-2',
    session_id: 's1',
  } as unknown as SDKMessage), null);
});

test('unmapped SDK events stay off the conversation', () => {
  assert.equal(describeSdkMessage({
    type: 'system',
    subtype: 'some_future_meter',
    uuid: 'u-unknown',
    session_id: 's1',
  } as unknown as SDKMessage), null);
});

test('compact_boundary and session init become system_info payloads', () => {
  const compact = describeSdkMessage({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 80_000, post_tokens: 12_000 },
    uuid: 'u1',
    session_id: 's1',
  } as unknown as SDKMessage);
  assert.equal(compact?.infoType, 'compact');
  assert.match(compact?.content || '', /pre_tokens=80000/);

  const init = describeSdkMessage({
    type: 'system',
    subtype: 'init',
    model: 'claude-sonnet',
    tools: ['Skill', 'Read'],
    mcp_servers: [{ name: 'sandbox', status: 'connected' }],
    skills: ['edgeone-makers-tools'],
    uuid: 'u2',
    session_id: 's1',
  } as unknown as SDKMessage);
  assert.equal(init?.infoType, 'system');
  assert.match(init?.content || '', /model=claude-sonnet/);
  assert.match(init?.content || '', /mcp=sandbox:connected/);
});

test('result usage is a readable info block', () => {
  const result = {
    type: 'result',
    subtype: 'success',
    duration_ms: 12_400,
    duration_api_ms: 11_000,
    is_error: false,
    num_turns: 3,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 50,
    },
    modelUsage: {
      'claude-sonnet': {
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 50,
        webSearchRequests: 0,
        costUSD: 0.0123,
        contextWindow: 200000,
        maxOutputTokens: 16000,
      },
    },
    permission_denials: [],
    uuid: 'u3',
    session_id: 's1',
  } as unknown as SDKResultMessage;
  const text = formatResultUsage(result);
  assert.match(text, /turns=3/);
  assert.match(text, /cost=\$0\.0123/);
  assert.match(text, /cacheRead=800/);
});

test('tool_use patches keep a growing outputSummary on the same row', () => {
  let turn: PersistedActivityTurn = {
    id: 'turn-1',
    user: 'Build',
    assistant: '',
    status: 'completed',
    createdAt: 1,
    activities: [],
  };
  turn = applyStreamEvent(turn, {
    type: 'tool_use',
    data: { id: 't1', name: 'commands', inputSummary: 'npm install' },
  });
  turn = applyStreamEvent(turn, {
    type: 'tool_use',
    data: { id: 't1', name: 'commands', outputSummary: '12s' },
  });
  const tool = turn.activities[0];
  assert.equal(tool.kind, 'tool');
  if (tool.kind === 'tool') {
    assert.equal(tool.inputSummary, 'npm install');
    assert.equal(tool.outputSummary, '12s');
  }
});

test('tool_use keeps command and phase fields on the same row', () => {
  let turn: PersistedActivityTurn = {
    id: 'turn-1',
    user: 'Build',
    assistant: '',
    status: 'completed',
    createdAt: 1,
    activities: [],
  };
  turn = applyStreamEvent(turn, {
    type: 'tool_use',
    data: {
      id: 't1',
      name: 'Glob',
      phaseHint: 'code',
      fileCount: 4,
      inputSummary: JSON.stringify({ pattern: '**/*', path: 'src' }, null, 2),
    },
  });
  const tool = turn.activities[0];
  assert.equal(tool.kind, 'tool');
  if (tool.kind === 'tool') {
    assert.equal(tool.name, 'Glob');
    assert.equal(tool.phaseHint, 'code');
    assert.equal(tool.fileCount, 4);
    assert.match(tool.inputSummary || '', /pattern/);
    assert.match(tool.inputSummary || '', /\*\*\/\*/);
  }
});

test('a settled preview result shows nothing, even when the raw result is still attached', () => {
  let turn: PersistedActivityTurn = {
    id: 'turn-1',
    user: 'Build',
    assistant: '',
    status: 'completed',
    createdAt: 1,
    activities: [],
  };
  turn = applyStreamEvent(turn, {
    type: 'tool_use',
    data: { id: 't1', name: 'mcp__edgeone-sandbox__start_preview', outputSummary: '12s' },
  });
  turn = applyStreamEvent(turn, {
    type: 'tool_result',
    data: {
      id: 't1',
      ok: true,
      outputSummary: '',
      preview: '{"status":"success","note":"Do not put it in your reply."}',
      status: 'completed',
    },
  });
  const tool = turn.activities[0];
  assert.equal(tool.kind, 'tool');
  if (tool.kind === 'tool') {
    assert.equal(tool.outputSummary, '');
    assert.equal(tool.status, 'completed');
  }
});
