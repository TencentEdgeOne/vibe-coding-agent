import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  buildMakersCompatibilityScript,
  loadMakersValidationRules,
} from '../agents/project/_makers-compat.ts';

const execFileAsync = promisify(execFile);

async function runLintFixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'makers-lint-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const rules = await loadMakersValidationRules();
    const scriptPath = path.join(root, '.makers-compat-check.cjs');
    await writeFile(scriptPath, buildMakersCompatibilityScript(rules));
    try {
      const result = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failed = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: typeof failed.code === 'number' ? failed.code : 1,
        stdout: failed.stdout || '',
        stderr: failed.stderr || '',
      };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('Makers lint loads validation patterns from the vendored skills', async () => {
  const rules = await loadMakersValidationRules();
  assert.ok(rules.length >= 13);
  assert.ok(rules.some((rule) => (
    rule.skill === 'makers-edge-functions'
    && rule.pattern.includes('Response')
    && rule.pathPatterns.includes('edge-functions/**')
  )));
  assert.ok(rules.some((rule) => (
    rule.skill === 'makers-agents'
    && rule.pattern.includes('process')
    && rule.pathPatterns.includes('agents/**')
  )));
  for (const skill of [
    'makers-deploy',
    'makers-env-adaption',
    'makers-storage',
  ]) {
    assert.ok(rules.some((rule) => rule.skill === skill), skill);
  }
});

test('Makers lint accepts valid agent, function, edge, and middleware shapes', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@edgeone/pages-blob":"latest"}}',
    'edgeone.json': '{"agents":{"framework":"claude-agent-sdk"}}',
    '.env.example': 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
    'agents/chat.ts': `
export async function onRequest(context: any) {
  const id = context.request.headers['makers-conversation-id'];
  return new Response(String(id || context.env.AI_GATEWAY_API_KEY));
}
`,
    'cloud-functions/api/messages.js': `
export async function onRequest({ request, env }) {
  return Response.json({ method: request.method, configured: Boolean(env.API_URL) });
}
`,
    'edge-functions/api/counter.js': `
export async function onRequest() {
  const count = await my_kv.get('count');
  return new Response(JSON.stringify({ count }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
`,
    'middleware.js': `
export function middleware(context) {
  return context.next();
}
`,
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Makers compatibility lint passed/);
});

test('Makers lint reports actionable platform convention violations', async () => {
  const result = await runLintFixture({
    'src/api.ts': `export const send = () => fetch('/chat');`,
    'edgeone.json': '{"agents":{"framework":"basic"}}',
    '.env.example': 'AI_GATEWAY_API_KEY=\n',
    'agents/chat.ts': `
export async function POST(context: any) {
  const token = process.env.AI_GATEWAY_API_KEY;
  return new Response(context.request.headers.get('x-id') || token);
}
`,
    'cloud-functions/api/raw': 'export const key = process.env.API_KEY;',
    'cloud-functions/api/config.js': 'export const key = process.env.API_KEY;',
    'edge-functions/api/counter.js': `
import fs from 'fs';
export function onRequest(context) {
  const headers = new Headers();
  fs.writeFile('/tmp/count', '1', () => {});
  return Response.json({ value: context.env.KV.get('count'), headers });
}
`,
    'middleware.js': 'export function onRequest(context) { return context.next(); }',
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /MKR004.*agents\.framework must be one of/);
  assert.match(output, /MKR006.*AI_GATEWAY_BASE_URL/);
  assert.match(output, /MKR008.*agents\/chat\.ts/);
  assert.match(output, /MKR010.*cloud-functions\/api\/raw/);
  assert.match(output, /MKR011.*root-absolute fetch bypasses the sandbox \/preview\//);
  assert.match(output, /context\.env.*makers-storage/);
  assert.match(output, /MKR012.*middleware\(context\)/);
  assert.match(output, /makers-agents/);
  assert.match(output, /makers-cloud-functions/);
  assert.match(output, /makers-edge-functions/);
});

test('Makers lint leaves framework-native middleware to the framework', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"next":"latest"}}',
    'middleware.ts': `
import { NextResponse, type NextRequest } from 'next/server';
export function middleware(request: NextRequest) {
  return NextResponse.next({ request });
}
`,
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

test('Makers lint applies sandbox and deploy rules to matching root files', async () => {
  const result = await runLintFixture({
    'package.json': '{"scripts":{"preview":"npx serve dist"}}',
    'deploy.sh': 'edgeone whoami -t secret\n',
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /self-hosted static servers.*makers-env-adaption/);
  assert.match(output, /whoami does not accept -t.*makers-deploy/);
});

test('Makers lint ignores prose files and comment-only examples', async () => {
  const result = await runLintFixture({
    'agents/README.md': 'Never use process.env in an agent.',
    'edge-functions/api/hello.js': `
// Response.json({ documented: 'bad' })
/* process.env.API_KEY */
export function onRequest() {
  return new Response('ok');
}
`,
  });

  assert.equal(result.exitCode, 0, result.stderr);
});
