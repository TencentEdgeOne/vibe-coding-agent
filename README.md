# Web Dev Agent

> A sandbox-based web development agent built with the Claude Agent SDK on EdgeOne Makers.

**Framework:** Claude Agent SDK · **Category:** Coding · **Language:** TypeScript

[![Deploy to EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)

## Overview

Web Dev Agent turns natural-language requests into runnable web projects. For each conversation, it prepares an isolated temporary sandbox workspace where it creates or edits project files, installs dependencies, publishes a live preview, and feeds verification results back into the agent loop. Use it for coding-style Makers templates where users need a generated app, a visible preview, and a file browser in one workflow.

- **Temporary sandbox workspace** — creates and edits project code inside the current conversation's temporary sandbox
- **Makers-compatible generation** — static sites, Cloud Functions, Edge Functions, AI agent endpoints under `agents/`, and similar layouts that Makers can preview locally
- **Claude Agent SDK loop** — runs the model with EdgeOne sandbox MCP tools, vendored Makers skills, and a restricted tool set
- **Live preview** — starts `edgeone makers dev` in the sandbox and shows that URL in the right panel (not a cloud `makers deploy`)
- **Verification feedback** — runs build or Python compile checks and attempts one automatic repair pass when verification fails

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes | Model gateway API key. Use your Makers Models API Key, or any OpenAI-compatible provider key. |
| `AI_GATEWAY_BASE_URL` | Yes | Gateway base URL. For Makers Models, use `https://ai-gateway.edgeone.link/v1`. |
| `AI_GATEWAY_MODEL` | No | Model ID. Defaults to `@makers/deepseek-v4-flash` (a built-in Makers model). |
| `WEB_DEV_AGENT_DEBUG` | No | Set to `true` or `1` to enable redacted server-side debug logs. Defaults to off. |
| `EDGEONE_PAGES_API_TOKEN` | No | Optional. Used only if the user asks to live-deploy via `deploy_to_makers`. Preview does not need it. Do not commit it. |
| `MAKERS_DEPLOY_PROJECT_NAME` | No | Shared mock project name. Defaults to `vibe-coding-playground`. |

This template follows the OpenAI-compatible standard — point these at Makers Models or any compatible provider.

### How to get `AI_GATEWAY_API_KEY`

1. Open the [Makers Console](https://edgeone.ai/makers/new?s_url=https://console.tencentcloud.com/edgeone/makers).
2. Sign in and enable Makers.
3. Go to **Makers → Models → API Key** and create a key.
4. Copy it into `AI_GATEWAY_API_KEY`.

Built-in models are free and rate-limited, which makes them suitable for validation. For production, bind your own provider key (BYOK) in the console.

### Provider fallbacks

The agent prefers `AI_GATEWAY_*` variables. It also accepts Anthropic-compatible and DeepSeek-compatible fallback variables when needed:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | No | Anthropic-compatible API key fallback. |
| `ANTHROPIC_AUTH_TOKEN` | No | Anthropic-compatible auth token fallback. |
| `ANTHROPIC_MODEL` | No | Anthropic-compatible model fallback. |
| `ANTHROPIC_BASE_URL` | No | Anthropic-compatible base URL fallback. |
| `ANTHROPIC_CUSTOM_HEADERS` | No | Extra headers passed to the Anthropic SDK. |
| `DEEPSEEK_API_KEY` | No | DeepSeek-compatible API key fallback. |
| `DEEPSEEK_MODEL` | No | DeepSeek-compatible model fallback. |
| `DEEPSEEK_BASE_URL` | No | DeepSeek-compatible base URL fallback. |
| `CLAUDE_CODE_EXECUTABLE_PATH` | No | Optional path to a custom Claude Code executable. |

## Local Development

**Prerequisites:** Node.js, npm

```bash
npm install
cp .env.example .env
edgeone makers dev
```

Open `http://localhost:8088/agent-metrics` for the local observability panel.

## Project Structure

```text
web-dev-agent/
├── app/                    # Next.js frontend UI
│   ├── layout.tsx          # App metadata and root layout
│   ├── page.tsx            # Chat, progress, preview, and file browser UI
│   └── globals.css         # Global styles
├── agents/                 # EdgeOne Makers agent routes and pipeline
│   ├── chat.ts             # POST /chat: create + stream; GET /chat: reconnect
│   ├── file.ts             # /file route
│   ├── _agent.ts           # Claude Agent SDK integration
│   ├── _constants.ts       # Runtime constants
│   ├── _memory.ts          # Conversation history and project state
│   ├── _pipelines.ts       # Chat and file-read pipelines
│   ├── _project.ts         # Sandbox project, preview, and verification helpers
│   ├── _types.ts           # Shared TypeScript types
│   ├── tools/              # Custom sandbox MCP tools (scaffold, write, preview, deploy)
│   └── utils/              # Path, text, and build-error helpers
├── .claude/skills/         # Vendored, sandbox-adapted Makers skills
├── edgeone.json            # Agent runtime configuration
├── next.config.ts          # Next.js configuration for the template app
├── package.json            # Scripts and dependencies
└── tsconfig.json           # TypeScript configuration
```

Files prefixed with `_` are private modules — not exposed as public routes by EdgeOne.

## How It Works

The agent runs in session mode under `agents/`. Requests with the same `conversation_id` are routed to the same runtime instance and reuse the same temporary project workspace for the sandbox lifetime.

1. **Submit and stream** — the frontend calls `POST /chat` with a message and the `Makers-Conversation-Id` header. The endpoint persists the task and streams it over the same SSE response, so a normal turn uses one Agent request. A new request from the home view can also set `resetProject: true` to recreate the project workspace.
2. **State restore** — the chat pipeline reads conversation history from `context.store` and restores generated source from project Blob storage through `context.sandbox.restore()` when the sandbox is cold.
3. **LLM and tool loop** — the Claude Agent SDK runs with the `edgeone-sandbox` MCP server, `permissionMode: 'dontAsk'`, and sandbox-only tools. The agent must call `ensure_project_scaffold` before reading or writing project files.
4. **Project editing** — generated source files are written incrementally through one `write_project_file` call per file, so progress reaches the UI continuously. Commands and dependency installation run inside the sandbox.
5. **Preview publish** — `publish_preview` runs `edgeone makers dev` inside the sandbox, proxies it under `/preview/`, and shows that URL in the right panel. `deploy_to_makers` remains available only when the user explicitly asks to publish a live Makers URL.
6. **Verification** — the runtime runs `npm run build` when a Node project has a build script, or `python -m compileall .` when Python files are present. If verification fails after a successful agent run, the pipeline attempts one auto-fix pass.
7. **Persistence, SSE, and reconnect** — source checkpoints use `context.sandbox.persist()` and are stored under the current project's reserved `__sandbox` Blob store, so archive bytes never pass through conversation metadata. `POST /chat` receives status, logs, tool calls, file updates, preview state, build status, and the final reply. After a refresh, `GET /chat?runId=...` reconnects to the same detached task; `GET /resume` restores the workspace and hydrates up to 48 text files / 2 MiB over the same SSE connection.

The file route is `/file?path=<relative-path>` and uses the same conversation context to read text files from the sandbox project. Sandbox credentials are provided by the runtime; no local sandbox credentials are required. Sandbox instances remain temporary and are controlled by `agents.sandbox.timeout`, while persisted source is charged to and retained with the user's project Blob storage.

## Resources

- [Makers Agents Documentation](https://pages.edgeone.ai/document/agents)
- [Quick Start: Agent Development](https://pages.edgeone.ai/document/agents-quick-start)
- [Makers Models](https://pages.edgeone.ai/document/models)

## License

MIT
