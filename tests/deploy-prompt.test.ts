import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lastFinishedAssistant,
  resolveDeployOffer,
  type DeployOfferMessage,
} from '../app/lib/deploy-prompt.ts';

const writeTurn: DeployOfferMessage = {
  id: 'a1',
  role: 'assistant',
  status: 'done',
  activities: [
    { kind: 'tool', name: 'mcp__edgeone-sandbox__write_project_file', status: 'completed' },
  ],
};

test('a finished project turn offers the first deploy', () => {
  assert.equal(resolveDeployOffer([writeTurn], { canDownload: true, loading: false }), 'first');
});

test('the offer waits until the project exists and the agent is idle', () => {
  assert.equal(resolveDeployOffer([writeTurn], { canDownload: false, loading: false }), null);
  assert.equal(resolveDeployOffer([writeTurn], { canDownload: true, loading: true }), null);
  assert.equal(
    resolveDeployOffer([{ ...writeTurn, status: 'running' }], { canDownload: true, loading: false }),
    null,
  );
});

test('a later edit after a live site offers republish', () => {
  const messages: DeployOfferMessage[] = [
    {
      id: 'a0',
      role: 'assistant',
      status: 'done',
      activities: [{ kind: 'publish', status: 'completed', url: 'https://demo.edgeone.cool' }],
    },
    writeTurn,
  ];
  assert.equal(resolveDeployOffer(messages, { canDownload: true, loading: false }), 'again');
});

test('a successful deploy turn does not ask again', () => {
  assert.equal(
    resolveDeployOffer([{
      id: 'a2',
      role: 'assistant',
      status: 'done',
      activities: [
        { kind: 'tool', name: 'mcp__edgeone-deploy__publish_project', status: 'completed' },
        { kind: 'publish', status: 'completed', url: 'https://demo.edgeone.cool' },
      ],
    }], { canDownload: true, loading: false }),
    null,
  );
});

test('a failed deploy turn offers a retry', () => {
  assert.equal(
    resolveDeployOffer([{
      id: 'a3',
      role: 'assistant',
      status: 'done',
      activities: [{ kind: 'publish', status: 'failed' }],
    }], { canDownload: true, loading: false }),
    'retry',
  );
});

test('a finished Q&A turn does not nag after the project already has tools', () => {
  assert.equal(
    resolveDeployOffer([
      writeTurn,
      { id: 'a4', role: 'assistant', status: 'done', activities: [{ kind: 'text' }] },
    ], { canDownload: true, loading: false }),
    null,
  );
});

test('a restored workspace with no tool history still offers the first deploy', () => {
  assert.equal(
    resolveDeployOffer([
      { id: 'u1', role: 'user', status: 'done' },
      { id: 'a5', role: 'assistant', status: 'done', activities: [] },
    ], { canDownload: true, loading: false }),
    'first',
  );
});

test('lastFinishedAssistant skips a still-running turn', () => {
  const last = lastFinishedAssistant([
    writeTurn,
    { id: 'a6', role: 'assistant', status: 'running', activities: [] },
  ]);
  assert.equal(last?.id, 'a1');
});
