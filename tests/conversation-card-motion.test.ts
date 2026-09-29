import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('conversation action cards animate in and out from under the composer', async () => {
  const [presence, deploy, gateway, conversation, css] = await Promise.all([
    readFile('app/hooks/use-presence.ts', 'utf8'),
    readFile('app/features/workspace/components/conversation/deploy-offer.tsx', 'utf8'),
    readFile('app/features/workspace/components/conversation/gateway-prompt.tsx', 'utf8'),
    readFile('app/features/workspace/components/conversation/index.tsx', 'utf8'),
    readFile('app/styles/conversation.css', 'utf8'),
  ]);

  assert.match(presence, /latestValueRef/);
  assert.match(presence, /finishExit/);
  assert.match(presence, /prefers-reduced-motion/);
  assert.match(deploy, /usePresence\(deployOffer\)/);
  assert.match(deploy, /data-presence=\{presence\.exiting \? 'exiting' : 'entering'\}/);
  assert.match(deploy, /onAnimationEnd=\{presence\.finishExit\}/);
  assert.match(gateway, /const cardPresence = usePresence\(cardVisible \? true : null\)/);
  assert.match(gateway, /onAnimationEnd=\{cardPresence\.finishExit\}/);
  assert.match(gateway, /className="gateway-prompt-status"/);
  assert.match(gateway, /is-status/);
  assert.match(conversation, /className="conversation-card-stack"/);

  assert.match(css, /\.conversation-card-stack \{[\s\S]*?z-index: 1;/);
  assert.match(css, /\.conversation-card-stack \{[\s\S]*?width: 100%;[\s\S]*?align-self: stretch;/);
  assert.match(css, /\.conversation-card-stack > \* \+ \* \{[\s\S]*?margin-top: -8px;/);
  assert.match(css, /\.deploy-offer,\n\.gateway-prompt \{[\s\S]*?border-radius: var\(--r-lg\) var\(--r-lg\) 0 0;/);
  assert.match(css, /\.conversation-composer \{[\s\S]*?z-index: 2;/);
  assert.match(css, /@keyframes conversation-card-enter/);
  assert.match(css, /@keyframes conversation-card-exit/);
  assert.match(css, /data-presence='exiting'/);
});

test('the API key card stays compact and keeps its actions in the same row', async () => {
  const [gateway, css] = await Promise.all([
    readFile('app/features/workspace/components/conversation/gateway-prompt.tsx', 'utf8'),
    readFile('app/styles/conversation.css', 'utf8'),
  ]);

  assert.match(gateway, /placeholder=\{cardCopy\.apiKey\}/);
  assert.doesNotMatch(gateway, /<span>\{cardCopy\.apiKey\}<\/span>/);

  const card = css.slice(css.indexOf('.gateway-prompt {'), css.indexOf('.gateway-prompt-saved'));
  assert.match(card, /\.gateway-prompt-state-inner \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) auto auto/);
  assert.match(card, /padding: 9px 11px 17px/);
  assert.match(card, /\.gateway-prompt\.is-collapsed/);
  assert.match(card, /\.gateway-prompt-expand/);
  assert.match(card, /\.gateway-prompt-field \{[\s\S]*?grid-column: 1/);
  assert.match(card, /\.gateway-prompt \.deploy-offer-dismiss,[\s\S]*?padding: 5px 7px/);
});
