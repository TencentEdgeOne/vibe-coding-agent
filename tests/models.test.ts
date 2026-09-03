import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BUILT_IN_MODELS,
  DEFAULT_MODEL,
  buildModelCatalog,
  parseExtraModels,
  resolveSelectedModel,
} from '../shared/models.ts';
import {
  resolveConfiguredModel,
  resolveModelCatalog,
  resolveRequestedModel,
} from '../agents/_models.ts';

// The picker renders labels, never ids. The ids are scoped with the platform
// tier, so a label falling back to its id would print the one word no
// user-facing string in this product says.
test('no model label names the platform tier', () => {
  for (const option of BUILT_IN_MODELS) {
    assert.ok(
      !/makers/i.test(option.label),
      `label "${option.label}" must speak of the model, not the tier serving it`,
    );
  }
});

test('the built-in default is one of the built-in models', () => {
  assert.ok(BUILT_IN_MODELS.some((option) => option.id === DEFAULT_MODEL));
});

test('extra models accept a label and fall back to the id without its scope', () => {
  assert.deepEqual(
    parseExtraModels('deepseek/deepseek-v4-pro|DeepSeek V4 Pro, openai/gpt-5'),
    [
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'openai/gpt-5', label: 'openai/gpt-5' },
    ],
  );
  // A scoped id would otherwise carry the tier into the picker.
  assert.deepEqual(parseExtraModels('@makers/hy3'), [{ id: '@makers/hy3', label: 'hy3' }]);
  for (const empty of ['', '   ', ',,', undefined, null, 42]) {
    assert.deepEqual(parseExtraModels(empty), []);
  }
});

// A deployment that configured a model the picker did not list could only ever
// be changed away from it, never back.
test('the configured model leads the catalogue even when it is not built in', () => {
  const catalog = buildModelCatalog({ configuredModel: 'deepseek/deepseek-v4-pro' });
  assert.equal(catalog[0].id, 'deepseek/deepseek-v4-pro');
  // A vendor prefix survives: it says who serves the model, and unlike the
  // `@scope` the built-ins carry, that is worth showing.
  assert.equal(catalog[0].label, 'deepseek/deepseek-v4-pro');
  assert.equal(catalog.length, BUILT_IN_MODELS.length + 1);
});

test('a configured built-in keeps its label and is not duplicated', () => {
  const catalog = buildModelCatalog({ configuredModel: '@makers/hy3' });
  assert.equal(catalog[0].label, 'Hunyuan 3');
  assert.equal(catalog.length, BUILT_IN_MODELS.length);
  assert.equal(new Set(catalog.map((option) => option.id)).size, catalog.length);
});

test('an extra model that repeats a built-in does not appear twice', () => {
  const catalog = buildModelCatalog({ extraModels: `${DEFAULT_MODEL}|Renamed` });
  assert.equal(catalog.length, BUILT_IN_MODELS.length);
  assert.equal(
    catalog.find((option) => option.id === DEFAULT_MODEL)?.label,
    'DeepSeek V4 Flash',
  );
});

// The gateway bills whatever id it is handed, so an id this deployment does not
// offer has to resolve to "no choice" rather than being passed through.
test('only a model this deployment offers survives validation', () => {
  const catalog = buildModelCatalog({ extraModels: 'openai/gpt-5|GPT-5' });
  assert.equal(resolveSelectedModel(catalog, 'openai/gpt-5'), 'openai/gpt-5');
  assert.equal(resolveSelectedModel(catalog, `  ${DEFAULT_MODEL}  `), DEFAULT_MODEL);
  for (const rejected of ['anthropic/claude-opus-4', '', '   ', undefined, null, {}, 7]) {
    assert.equal(resolveSelectedModel(catalog, rejected), '');
  }
});

// The picker's default and the agent's fallback read the same env chain through
// this one function; if they ever diverged the picker would name one model while
// another answered.
test('the configured model follows the gateway env chain', () => {
  assert.equal(resolveConfiguredModel({ env: {} }), DEFAULT_MODEL);
  assert.equal(resolveConfiguredModel({}), DEFAULT_MODEL);
  assert.equal(
    resolveConfiguredModel({ env: { ANTHROPIC_MODEL: '@makers/hy3' } }),
    '@makers/hy3',
  );
  assert.equal(
    resolveConfiguredModel({
      env: { AI_GATEWAY_MODEL: '@makers/kimi-k2.6', ANTHROPIC_MODEL: '@makers/hy3' },
    }),
    '@makers/kimi-k2.6',
  );
  // Whitespace-only config is not a configured model.
  assert.equal(resolveConfiguredModel({ env: { AI_GATEWAY_MODEL: '  ' } }), DEFAULT_MODEL);
});

test('a deployment extends its own picker without opening it to everything', () => {
  const context = {
    env: {
      AI_GATEWAY_MODEL: '@makers/hy3',
      AI_GATEWAY_EXTRA_MODELS: 'deepseek/deepseek-v4-pro|DeepSeek V4 Pro',
    },
  };
  const catalog = resolveModelCatalog(context);
  assert.equal(catalog[0].id, '@makers/hy3');
  assert.ok(catalog.some((option) => option.id === 'deepseek/deepseek-v4-pro'));

  assert.equal(resolveRequestedModel(context, 'deepseek/deepseek-v4-pro'), 'deepseek/deepseek-v4-pro');
  assert.equal(resolveRequestedModel(context, DEFAULT_MODEL), DEFAULT_MODEL);
  // Not offered here, so it never reaches the gateway as a billable choice.
  assert.equal(resolveRequestedModel(context, 'openai/gpt-5'), '');
});

// Replacing the native <select> moved keyboard support, the selected marker and
// dismissal from the platform into this component. A listbox that only answers
// the mouse is a downgrade from the control it replaced, so the parts the
// browser used to supply are asserted here.
test('the model picker keeps what the native select gave it for free', async () => {
  const picker = await readFile('app/components/model-picker.tsx', 'utf8');
  // The comments explain why the native control is gone, so they name it.
  const code = picker.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  assert.doesNotMatch(code, /<select|<option\b/);
  assert.match(picker, /role="listbox"/);
  assert.match(picker, /role="option"/);
  assert.match(picker, /aria-haspopup="listbox"/);
  assert.match(picker, /aria-expanded=\{open\}/);
  // Which row a screen reader announces as current, and which one is chosen.
  assert.match(picker, /aria-activedescendant=/);
  assert.match(picker, /aria-selected=\{index === selectedIndex\}/);
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', 'Escape', 'Tab']) {
    assert.match(picker, new RegExp(`case '${key}'`));
  }
  // A press outside is a dismissal, and focus goes back to the trigger rather
  // than to the top of the document.
  assert.match(picker, /addEventListener\('pointerdown', dismiss\)/);
  assert.match(picker, /triggerRef\.current\?\.focus\(\)/);

  // Inside a <form>: an unqualified button would submit the composer.
  assert.match(picker, /type="button"/);

  // Hooks run before the one-model early return, or the render that adds a
  // second model changes the hook count.
  const guard = picker.indexOf('if (models.length < 2)');
  assert.ok(guard > 0 && picker.lastIndexOf('useEffect(', guard) < guard);
  assert.equal(picker.slice(guard).includes('useEffect('), false);
});
