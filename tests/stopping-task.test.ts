import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { TRANSLATIONS } from '../app/i18n.ts';
import { LIVE_TURN, WORKSPACE, surface } from './helpers/source.ts';

test('stop exposes an in-flight state separate from generation and abort teardown', async () => {
  const live = await surface(LIVE_TURN);
  const stopStart = live.indexOf('function stopCurrentTask(');
  const stopBody = live.slice(stopStart, live.indexOf('function resetStopping(', stopStart));
  const [stopHelper, stoppingHelper] = await Promise.all([
    readFile('app/features/workspace/hooks/live/stop.ts', 'utf8'),
    readFile('app/features/workspace/hooks/live/use-stopping.ts', 'utf8'),
  ]);

  assert.ok(stopStart >= 0 && stopBody.length > 0);
  assert.match(live, /useStoppingState\(\)/);
  assert.match(stoppingHelper, /const \[stopping, setStopping\] = useState\(false\)/);
  assert.match(stoppingHelper, /const stopInFlightRef = useRef\(false\)/);
  assert.match(live, /stopping \|\| stopInFlightRef\.current/);
  assert.match(stopBody, /stopInFlightRef\.current = true/);
  assert.match(stopBody, /setStopping\(true\)/);
  assert.match(stopBody, /beginStop\(\{/);
  assert.match(stopBody, /stopInFlightRef\.current = false/);
  assert.match(stopBody, /setStopping\(false\)/);
  assert.match(stopBody, /requestStop: stopChatTask/);
  assert.match(stopBody, /markLastTurnStopped\(current, ''\)/);
  // Only leaving the project closes the stream before the server answers.
  assert.match(stopBody, /if \(stopOptions\.discardProject\) stream\?\.abort\(\)/);
  assert.match(stopHelper, /finally \{\s*request\.onSettled\(\);/);
});

test('the composer reports stopping and refuses another send until the stop settles', async () => {
  const [composer, conversation, screen, canvas, home] = await Promise.all([
    surface('app/features/workspace/components/conversation/composer.tsx'),
    surface('app/features/workspace/components/conversation/index.tsx'),
    surface(WORKSPACE),
    readFile('app/features/workspace/components/workspace-canvas.tsx', 'utf8'),
    readFile('app/features/workspace/components/home-stage.tsx', 'utf8'),
  ]);

  assert.match(composer, /stopping: boolean/);
  assert.match(composer, /disabled=\{stopping\}/);
  assert.match(composer, /copy\.stopping/);
  assert.match(composer, /composer-stop-spinner/);
  assert.match(composer, /!loading && !stopping && canSend/);
  assert.match(conversation, /stopping=\{stopping\}/);
  assert.match(conversation, /stoppingTurnId/);
  assert.match(canvas, /stopping=\{live\.stopping\}/);
  assert.match(screen, /!live\.loading && !live\.stopping/);
  assert.match(home, /stopping: boolean/);
  assert.match(home, /disabled=\{stopping\}/);
  assert.match(home, /copy\.workspace\.stopping/);
});

test('stopping copy is available in both UI languages', () => {
  assert.equal(TRANSLATIONS.zh.workspace.stopping, '正在停止任务…');
  assert.equal(TRANSLATIONS.en.workspace.stopping, 'Stopping task…');
});
