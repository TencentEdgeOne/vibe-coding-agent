import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveNarrationEmit,
  type NarrationEmitState,
} from '../agents/utils/_narration.ts';

function emptyState(): NarrationEmitState {
  return { currentTextBlock: '', emittedNarration: '' };
}

function apply(
  state: NarrationEmitState,
  text: string,
  complete = false,
) {
  return resolveNarrationEmit(state, text, complete);
}

test('stream deltas concatenate without duplication', () => {
  let state = emptyState();
  let out = apply(state, '项目环境已准备好。现在开始构建简洁好');
  assert.equal(out.text, '项目环境已准备好。现在开始构建简洁好');
  state = out.state;

  out = apply(state, '用的 Todolist 应用。\n');
  assert.equal(out.text, '用的 Todolist 应用。\n');
  assert.equal(
    out.state.emittedNarration,
    '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。\n',
  );
});

test('complete snapshot after stream only emits the missing suffix', () => {
  let state = emptyState();
  state = apply(state, '项目环境已准备好。现在开始构建简洁好').state;

  const out = apply(
    state,
    '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。',
    true,
  );
  assert.equal(out.text, '用的 Todolist 应用。');
  assert.equal(
    out.state.emittedNarration,
    '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。',
  );
});

test('complete snapshot already fully streamed is skipped', () => {
  let state = emptyState();
  state = apply(state, '项目环境已准备好。现在开始构建简洁好').state;
  state = apply(state, '用的 Todolist 应用。\n').state;

  const out = apply(
    state,
    '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。',
    true,
  );
  assert.equal(out.text, null);
  assert.equal(
    out.state.emittedNarration,
    '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。\n',
  );
});

test('earlier narration cannot swallow a later shared substring after tool reset', () => {
  let state = emptyState();
  state = apply(
    state,
    '我来为你创建一个简洁好用的 Todolist 应用。先准备项目环境。\n',
  ).state;
  // Tool call clears the per-block window.
  state = { ...state, currentTextBlock: '' };

  const out = apply(
    state,
    '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。',
    true,
  );
  assert.equal(
    out.text,
    '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。',
  );
});

test('assistant replay after tool reset does not re-emit the same trailing block', () => {
  let state = emptyState();
  state = apply(state, '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。\n').state;
  state = { ...state, currentTextBlock: '' };

  const out = apply(
    state,
    '项目环境已准备好。现在开始构建简洁好用的 Todolist 应用。',
    true,
  );
  assert.equal(out.text, null);
});

test('cumulative stream deltas only forward the remainder', () => {
  let state = emptyState();
  state = apply(state, '项目环境已准备好。').state;

  const out = apply(state, '项目环境已准备好。现在开始构建');
  assert.equal(out.text, '现在开始构建');
  assert.equal(out.state.emittedNarration, '项目环境已准备好。现在开始构建');
});
