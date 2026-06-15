# Web Dev Agent

> 一个基于 Claude Agent SDK 和 EdgeOne Makers 的沙箱 Web 开发 Agent。

**框架：** Claude Agent SDK · **分类：** Coding · **语言：** TypeScript

[![部署到 EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)

## 概览

Web Dev Agent 可以把自然语言需求转换为可运行的 Web 项目。每个会话会准备一个隔离的临时沙箱工作区，在其中创建或修改项目文件、安装依赖、发布实时预览，并把验证结果反馈回 Agent 循环。它适合需要生成应用、查看预览、浏览文件的一体化 Coding 类 Makers 模板。

- **临时沙箱工作区** — 在当前会话对应的临时沙箱中创建和修改项目代码
- **多技术栈生成** — 创建或更新 Next.js、Vite/React、静态页面、Node 服务、Flask/FastAPI 等轻量 Web 应用
- **Claude Agent SDK 循环** — 使用 EdgeOne 沙箱 MCP 工具和受限工具集运行模型
- **实时预览** — 在临时沙箱内启动应用，并返回运行时生成的预览 URL
- **验证反馈** — 执行构建或 Python 编译检查，验证失败时尝试一轮自动修复

## 环境变量

| 变量 | 是否必填 | 说明 |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | 是 | 模型网关 API Key。使用 Makers Models API Key，或任意 OpenAI 兼容供应商的 Key。 |
| `AI_GATEWAY_BASE_URL` | 是 | 网关 Base URL。使用 Makers Models 时填写 `https://ai-gateway.edgeone.link/v1`。 |
| `AI_GATEWAY_MODEL` | 否 | 模型 ID。默认值为 `@makers/minimax-m2.7`（Makers 内置模型）。 |
| `WEB_DEV_AGENT_DEBUG` | 否 | 设置为 `true` 或 `1` 时启用脱敏的服务端调试日志。默认关闭。 |

本模板遵循 OpenAI 兼容标准，可以将这些变量指向 Makers Models 或任意兼容供应商。

### 如何获取 `AI_GATEWAY_API_KEY`

1. 打开 [Makers Console](https://edgeone.ai/makers/new?s_url=https://console.tencentcloud.com/edgeone/makers)。
2. 登录并启用 Makers。
3. 进入 **Makers → Models → API Key** 并创建 Key。
4. 将它填写到 `AI_GATEWAY_API_KEY`。

内置模型免费但有额度限制，适合验证使用。生产环境请在控制台绑定自己的模型供应商 Key（BYOK）。

### 供应商兜底变量

Agent 会优先使用 `AI_GATEWAY_*` 变量。需要时也可以使用 Anthropic 兼容或 DeepSeek 兼容变量作为兜底：

| 变量 | 是否必填 | 说明 |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | 否 | Anthropic 兼容 API Key 兜底。 |
| `ANTHROPIC_AUTH_TOKEN` | 否 | Anthropic 兼容认证 Token 兜底。 |
| `ANTHROPIC_MODEL` | 否 | Anthropic 兼容模型兜底。 |
| `ANTHROPIC_BASE_URL` | 否 | Anthropic 兼容 Base URL 兜底。 |
| `ANTHROPIC_CUSTOM_HEADERS` | 否 | 传给 Anthropic SDK 的额外请求头。 |
| `DEEPSEEK_API_KEY` | 否 | DeepSeek 兼容 API Key 兜底。 |
| `DEEPSEEK_MODEL` | 否 | DeepSeek 兼容模型兜底。 |
| `DEEPSEEK_BASE_URL` | 否 | DeepSeek 兼容 Base URL 兜底。 |
| `CLAUDE_CODE_EXECUTABLE_PATH` | 否 | 可选的 Claude Code 可执行文件路径。 |

## 本地开发

**前置依赖：** Node.js、npm

```bash
npm install
cp .env.example .env
edgeone makers dev
```

打开 `http://localhost:8088/agent-metrics` 查看本地可观测面板。

## 项目结构

```text
web-dev-agent/
├── app/                    # Next.js 前端界面
│   ├── layout.tsx          # 应用元数据和根布局
│   ├── page.tsx            # 对话、进度、预览和文件浏览界面
│   └── globals.css         # 全局样式
├── agents/                 # EdgeOne Makers Agent 路由和流水线
│   ├── chat.ts             # /chat 路由
│   ├── file.ts             # /file 路由
│   ├── _agent.ts           # Claude Agent SDK 集成
│   ├── _constants.ts       # 运行时常量
│   ├── _memory.ts          # 对话历史和项目状态
│   ├── _pipelines.ts       # 对话和文件读取流水线
│   ├── _project.ts         # 沙箱项目、预览和验证辅助逻辑
│   ├── _types.ts           # 共享 TypeScript 类型
│   ├── tools/              # 自定义沙箱 MCP 工具
│   └── utils/              # 路径、文本和构建错误辅助逻辑
├── edgeone.json            # Agent 运行时配置
├── next.config.ts          # 模板应用的 Next.js 配置
├── package.json            # 脚本和依赖
└── tsconfig.json           # TypeScript 配置
```

以 `_` 开头的文件是私有模块，不会作为 EdgeOne 公开路由暴露。

## 工作原理

Agent 在 `agents/` 下以会话模式运行。带有相同 `conversation_id` 的请求会路由到同一个运行时实例，并在沙箱生命周期内复用同一个临时项目工作区。

1. **请求入口** — 前端携带消息和 `Makers-Conversation-Id` 请求头调用 `/chat`。从首页发起的新请求也可以设置 `resetProject: true` 来重建项目工作区。
2. **状态恢复** — Chat pipeline 从 `context.store` 读取对话历史，并加载当前临时沙箱项目的元数据。
3. **LLM 与工具循环** — Claude Agent SDK 使用 `edgeone-sandbox` MCP 服务、`permissionMode: 'dontAsk'` 和仅限沙箱的工具运行。Agent 必须先调用 `ensure_project_scaffold`，再读取或写入项目文件。
4. **项目编辑** — 生成的源码通过 `write_project_files` 或沙箱文件工具写入。命令执行和依赖安装都在沙箱内完成。
5. **发布预览** — `publish_preview` 在内部 `3000` 端口启动应用，等待预览入口就绪，并返回仅在当前临时沙箱生命周期内可用的预览 URL。
6. **验证检查** — Node 项目包含 build 脚本时运行 `npm run build`；存在 Python 文件时运行 `python -m compileall .`。如果 Agent 成功运行后验证失败，流水线会尝试一轮自动修复。
7. **流式返回** — 前端以 NDJSON 接收状态事件、日志、工具调用、工具结果、文件树更新、预览 URL、构建状态和最终回复。

文件路由为 `/file?path=<relative-path>`，并使用同一会话上下文从临时沙箱项目读取文本文件。沙箱凭证由运行时提供，本地无需配置沙箱凭证。沙箱和其中生成的代码都是临时的，生命周期由 `edgeone.json` 中的 `agents.sandbox.timeout` 控制，当前为 `1800` 秒。

## 资源

- [Makers Agents 文档](https://cloud.tencent.com/document/product/1552/132759)
- [Agent 开发快速开始](https://cloud.tencent.com/document/product/1552/132786)
- [Makers Models](https://cloud.tencent.com/document/product/1552/132748)

## 许可证

MIT
