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
- **One-click deploy** — a header button runs `edgeone makers deploy` for the finished project without going through the model, and streams the live URL into the same deployment status the model-driven publish uses
- **Makers-aware code view** — annotates `agents/`, Cloud/Edge Functions, middleware, and `edgeone.json` with capability badges and derived routes
- **Verification feedback** — runs skill-backed Makers compatibility lint plus build/Python checks, then attempts one automatic repair pass when verification fails

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | Yes | Model gateway API key. Use your Makers Models API Key, or any OpenAI-compatible provider key. |
| `AI_GATEWAY_BASE_URL` | Yes | Gateway base URL. For Makers Models, use `https://ai-gateway.edgeone.link/v1`. |
| `AI_GATEWAY_MODEL` | No | Model ID. Defaults to `@makers/deepseek-v4-flash` (a built-in Makers model). |
| `WEB_DEV_AGENT_DEBUG` | No | Set to `true` or `1` to enable redacted server-side debug logs. Defaults to off. |
| `EDGEONE_PAGES_API_TOKEN` | No | Main Makers API token. It stays in the Agent Runtime and mints a per-project temporary tenant token that is injected into direct sandbox CLI calls. Needed for live deploys and credentialed local backends such as Blob. Do not commit it. |
| `MAKERS_SUB_TOKEN_TTL_SECONDS` | No | Temporary tenant-token lifetime. Defaults to `3600`; accepted range is 900–86400 seconds. |
| `MAKERS_DEPLOY_PROJECT_NAME` | No | Pins every conversation to one Makers project. Leave unset: preview and deploy then use a project derived from the conversation, so later turns reach the same site and two users never collide over one name. |
| `MAKERS_API_ENV` | No | Makers deployment the token belongs to: `prod` (default), `pre`, or `test`. One switch drives both the token issuer and the sandbox CLI, so the credential is always verified by the environment that minted it. |
| `MAKERS_API_REGION` | No | Region of that deployment: `china` (default) or `global`. Production tokens resolve their own region, so this only matters for `pre` and `test`. |

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
│   ├── tools/              # Custom scaffold/write tools and direct CLI lifecycle observer
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
4. **Project editing** — generated source files are written incrementally through one `write_project_file` call per file, so progress reaches the UI continuously. Commands and dependency installation run inside the sandbox. The code panel derives Makers capability badges and public routes directly from file conventions.
5. **Direct CLI preview and deploy** — the model invokes the target sandbox image's `edgeone makers dev` / `edgeone makers deploy --json` through the generic `commands` tool. Makers dev runs on port 8088 behind a strip-prefix adapter on port 3000; the sandbox's fixed port 9000 gateway publishes it at `/preview/` in the right panel. Deploy JSON is parsed into a separate deployment status. A thin host observer injects a short-lived tenant token when configured, so the main token never enters the sandbox or model context. Until that image capability is available, the observer returns the terminal `MAKERS_CLI_UNAVAILABLE` error and prevents install, path-probing, `npx`, and retry fallbacks.
6. **Verification** — before preview/deploy and again in the deterministic verification phase, the runtime translates the vendored skills' `pathPatterns`/`validate` metadata plus structural Makers rules into a sandbox lint. It then runs `npm run build` when a Node project has a build script, or `python -m compileall .` when Python files are present. Any failure enters the existing one-pass auto-fix loop.
7. **Persistence, SSE, and reconnect** — source checkpoints use `context.sandbox.persist()` and are stored under the current project's reserved `__sandbox` Blob store, so archive bytes never pass through conversation metadata. `POST /chat` receives status, logs, tool calls, file updates, preview state, build status, and the final reply. After a refresh, `GET /chat?runId=...` reconnects to the same detached task; `GET /resume` restores the workspace and hydrates up to 48 text files / 2 MiB over the same SSE connection.

The file route is `/file?path=<relative-path>` and uses the same conversation context to read text files from the sandbox project. Sandbox credentials are provided by the runtime; no local sandbox credentials are required. Sandbox instances remain temporary and are controlled by `agents.sandbox.timeout`, while persisted source is charged to and retained with the user's project Blob storage.

## Resources

- [Makers Agents Documentation](https://pages.edgeone.ai/document/agents)
- [Quick Start: Agent Development](https://pages.edgeone.ai/document/agents-quick-start)
- [Makers Models](https://pages.edgeone.ai/document/models)

## License

MIT
