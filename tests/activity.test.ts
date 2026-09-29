import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeToolInput, summarizeToolOutput, toolPaintsOwnProgress } from '../shared/timeline.ts';

test('tool summaries redact secrets and project paths', () => {
  const summary = summarizeToolInput('mcp__edgeone__commands', {
    command: 'curl -H "Authorization: Bearer top-secret" /tmp/project/api?token=abc',
    apiKey: 'secret-key',
  }, '/tmp/project');

  assert.doesNotMatch(summary, /top-secret|secret-key|token=abc/);
  assert.match(summary, /\[REDACTED\]/);
  assert.match(summary, /<project>/);
});

test('file writes expose paths and sizes without source contents', () => {
  for (const name of ['files_write', 'mcp__edgeone-sandbox__files_write', 'write_project_file']) {
    const summary = summarizeToolInput(name, {
      path: 'src/app.tsx',
      content: 'const privateValue = 42;',
    });

    assert.match(summary, /src\/app\.tsx/);
    assert.match(summary, /24 chars/);
    assert.doesNotMatch(summary, /privateValue/);
  }
});

test('a streamed single-file call stays blank until its path arrives', () => {
  assert.equal(summarizeToolInput('files_write', {}), '');
  assert.equal(summarizeToolInput('write_project_file', {}), '');
});

test('directory tools keep the path in the dumped input', () => {
  assert.match(summarizeToolInput('mcp__edgeone-sandbox__files_make_dir', { path: 'src/lib' }), /src\/lib/);
});

test('Skill activity keeps the skill name and the tool output', () => {
  assert.match(summarizeToolInput('Skill', { skill: 'edgeone-makers-tools' }), /edgeone-makers-tools/);
  assert.match(summarizeToolOutput('Launching skill: edgeone-makers-tools', '', 'Skill'), /Launching skill/);
  assert.match(summarizeToolOutput('Skill not found: nope', '', 'Skill'), /Skill not found/);
});

test('specific Makers skill activity keeps the document body', () => {
  const name = 'mcp__edgeone-sandbox__load_makers_skill';
  assert.match(summarizeToolInput(name, { skill: 'makers-agents' }), /makers-agents/);
  assert.match(summarizeToolOutput('---\nname: edgeone-makers-agents\n---\nGuide', '', name), /makers-agents/);
  assert.match(summarizeToolOutput('Unable to load Makers skill: missing', '', name), /Unable to load/);
});

test('glob and skill inputs keep every field instead of a short label', () => {
  const glob = summarizeToolInput('Glob', { pattern: '**/*', path: 'src' });
  assert.match(glob, /pattern/);
  assert.match(glob, /\*\*\/\*/);
  assert.match(glob, /"path": "src"/);

  const skill = summarizeToolInput('mcp__edgeone-sandbox__load_makers_skill', {
    skill: 'makers-agents',
    ref: 'platform/sse-protocol.md',
  });
  assert.match(skill, /makers-agents/);
  assert.match(skill, /platform\/sse-protocol\.md/);
});

test('deploy and preview rows hide empty arguments and model-facing results', () => {
  assert.equal(summarizeToolInput('mcp__edgeone-sandbox__deploy_project', {}), '');
  assert.equal(summarizeToolInput('mcp__edgeone-sandbox__start_preview', { restart: true }), '');
  assert.equal(toolPaintsOwnProgress('mcp__edgeone-sandbox__deploy_project'), true);
  assert.equal(toolPaintsOwnProgress('mcp__edgeone-sandbox__start_preview'), true);
  assert.equal(toolPaintsOwnProgress('commands'), false);

  const published = summarizeToolOutput(JSON.stringify({
    status: 'published',
    url: 'https://demo.edgeone.app',
    note: 'Tell the user in their language and write this complete URL.',
  }), '', 'mcp__edgeone-sandbox__deploy_project');
  assert.equal(published, 'https://demo.edgeone.app');

  const deployError = summarizeToolOutput(JSON.stringify({
    status: 'error',
    error: 'The sandbox image does not provide the CLI yet.',
    instruction: 'Stop. Do not inspect PATH.',
  }), '', 'deploy_project');
  assert.equal(deployError, 'The sandbox image does not provide the CLI yet.');

  const preview = summarizeToolOutput(JSON.stringify({
    status: 'success',
    preview: { url: 'https://sandbox.example/?access_token=secret-token' },
    note: 'The preview panel is already showing this URL. Do not put it in your reply.',
  }), '', 'mcp__edgeone-sandbox__start_preview');
  assert.equal(preview, '');
  assert.doesNotMatch(preview, /access_token|Do not put it/);
});

test('a plain failure from either tool stays readable', () => {
  const error = 'Failed to start edgeone makers dev.';
  assert.equal(summarizeToolOutput(error, '', 'start_preview'), error);
  assert.equal(summarizeToolOutput(error, '', 'deploy_project'), error);
});

test('tool output is capped at eight kilobytes', () => {
  const summary = summarizeToolOutput('x'.repeat(10_000));
  assert.ok(summary.length < 8_200);
  assert.match(summary, /truncated$/);
});
