# Web Dev Agent

> 一个基于 Claude Agent SDK 和 EdgeOne Makers 的沙箱 Web 开发 Agent。

**框架：** Claude Agent SDK · **分类：** Coding · **语言：** TypeScript

[![部署到 EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)

## 概览

Web Dev Agent 可以把自然语言需求转换为可运行的 Web 项目。每个会话会准备一个隔离的临时沙箱工作区，在其中创建或修改项目文件、安装依赖、发布实时预览，并把验证结果反馈回 Agent 循环。它适合需要生成应用、查看预览、浏览文件的一体化 Coding 类 Makers 模板。

- **临时沙箱工作区** — 在当前会话对应的临时沙箱中创建和修改项目代码
- **适配 Makers 的生成** — 静态站、Cloud Functions、Edge Functions、`agents/` AI 接口等可在 Makers 本地预览的布局
- **Claude Agent SDK 循环** — 使用 EdgeOne 沙箱 MCP 工具、内置 Makers skills 和受限工具集运行模型
- **实时预览** — 在沙箱内启动 `edgeone makers dev`，并把该 URL 展示在右侧面板（不是云端 `makers deploy`）
- **一键部署** — 项目生成完成后，右上角按钮不经过模型直接执行 `edgeone makers deploy`，线上地址进入与模型部署同一条部署状态
- **Makers 语义代码视图** — 为 `agents/`、Cloud/Edge Functions、中间件和 `edgeone.json` 标注能力徽标与推导路由
- **验证反馈** — 执行 skills 驱动的 Makers 兼容性 lint、构建或 Python 编译检查，失败时尝试一轮自动修复

## 环境变量

| 变量 | 是否必填 | 说明 |
|----------|----------|-------------|
| `AI_GATEWAY_API_KEY` | 是 | 模型网关 API Key。使用 Makers Models API Key，或任意 OpenAI 兼容供应商的 Key。 |
| `AI_GATEWAY_BASE_URL` | 是 | 网关 Base URL。使用 Makers Models 时填写 `https://ai-gateway.edgeone.link/v1`。 |
| `AI_GATEWAY_MODEL` | 否 | 模型 ID。默认值为 `@makers/deepseek-v4-flash`（Makers 内置模型）。 |
| `WEB_DEV_AGENT_DEBUG` | 否 | 设置为 `true` 或 `1` 时启用脱敏的服务端调试日志。默认关闭。 |
| `EDGEONE_PAGES_API_TOKEN` | 否 | Makers 主 API Token。它只保留在 Agent Runtime 中，为直接沙箱 CLI 调用签发并注入按项目隔离的临时 tenant token。线上部署以及 Blob 等带凭证的本地后端需要配置。不要提交到仓库。 |
| `MAKERS_SUB_TOKEN_TTL_SECONDS` | 否 | 临时 tenant token 有效期，默认 `3600`，取值范围为 900–86400 秒。 |
| `MAKERS_DEPLOY_PROJECT_NAME` | 否 | 把所有会话固定到同一个 Makers 项目。建议留空：留空时预览与部署都按会话派生出独立项目名，后续轮次落在同一个站点，不同用户也不会撞名。 |
| `MAKERS_API_ENV` | 否 | Token 所属的 Makers 环境：`prod`（默认）、`pre`、`test`。同一个开关同时驱动令牌签发方与沙箱 CLI，保证凭证由签发它的环境校验。 |
| `MAKERS_API_REGION` | 否 | 该环境的地域：`china`（默认）或 `global`。生产 Token 能自行识别地域，因此该项只在 `pre` 与 `test` 下生效。 |

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
│   ├── chat.ts             # POST /chat：创建并流式返回；GET /chat：重连
│   ├── file.ts             # /file 路由
│   ├── _agent.ts           # Claude Agent SDK 集成
│   ├── _constants.ts       # 运行时常量
│   ├── _memory.ts          # 对话历史和项目状态
│   ├── _pipelines.ts       # 对话和文件读取流水线
│   ├── _project.ts         # 沙箱项目、预览和验证辅助逻辑
│   ├── _types.ts           # 共享 TypeScript 类型
│   ├── tools/              # 自定义 scaffold/write 工具及直接 CLI 生命周期观察器
│   └── utils/              # 路径、文本和构建错误辅助逻辑
├── .claude/skills/         # 适配沙箱后的 Makers skills
├── edgeone.json            # Agent 运行时配置
├── next.config.ts          # 模板应用的 Next.js 配置
├── package.json            # 脚本和依赖
└── tsconfig.json           # TypeScript 配置
```

以 `_` 开头的文件是私有模块，不会作为 EdgeOne 公开路由暴露。

## 工作原理

Agent 在 `agents/` 下以会话模式运行。带有相同 `conversation_id` 的请求会路由到同一个运行时实例，并在沙箱生命周期内复用同一个临时项目工作区。

1. **提交并流式返回** — 前端携带消息和 `Makers-Conversation-Id` 请求头调用 `POST /chat`。接口持久化任务后在同一个 SSE 响应中持续返回事件，因此正常一轮只调用一次 Agent 路由；从首页发起的新请求也可以设置 `resetProject: true` 来重建项目工作区。
2. **状态恢复** — Chat pipeline 从 `context.store` 读取对话历史；沙箱已回收时，通过 `context.sandbox.restore()` 从项目 Blob 恢复生成源码。
3. **LLM 与工具循环** — Claude Agent SDK 使用 `edgeone-sandbox` MCP 服务、`permissionMode: 'dontAsk'` 和仅限沙箱的工具运行。Agent 必须先调用 `ensure_project_scaffold`，再读取或写入项目文件。
4. **项目编辑** — 生成的源码通过 `write_project_file` 按文件逐个写入，让进度持续反馈到界面。命令执行和依赖安装都在沙箱内完成；代码面板会依据目录约定直接推导 Makers 能力徽标和公开路由。
5. **直接 CLI 预览与部署** — 模型通过通用 `commands` 工具直接调用目标沙箱镜像提供的 `edgeone makers dev` / `edgeone makers deploy --json`。Makers dev 监听 8088，3000 端口的轻量代理剥离路径前缀，再由沙箱固定的 9000 网关通过 `/preview/` 发布到右侧面板；部署 JSON 则进入独立部署状态。宿主只保留一层薄观察器，在配置后注入短期 tenant token，主 token 不会进入沙箱或模型上下文。镜像能力尚未上线时，观察器会返回终止型 `MAKERS_CLI_UNAVAILABLE` 错误，并禁止安装、路径探测、`npx` 和重试兜底。
6. **验证检查** — 预览/部署前以及确定性验证阶段，运行时会把 vendored skills 的 `pathPatterns`/`validate` 元数据与结构性 Makers 规则转换为沙箱 lint；随后在 Node 项目包含 build 脚本时运行 `npm run build`，存在 Python 文件时运行 `python -m compileall .`。任一检查失败都会进入现有的一轮自动修复链路。
7. **持久化、SSE 与重连** — 源码检查点通过 `context.sandbox.persist()` 写入当前项目保留的 `__sandbox` Blob Store，归档字节不再经过对话元数据。正常生成通过 `POST /chat` 的 SSE 接收状态、日志、工具、文件、预览、构建状态和最终回复；页面刷新后使用 `GET /chat?runId=...` 重连任务，`GET /resume` 在同一 SSE 连接中恢复工作区并预热最多 48 个、总计 2 MiB 的文本文件。

文件路由为 `/file?path=<relative-path>`，并使用同一会话上下文从沙箱项目读取文本文件。沙箱凭证由运行时提供，本地无需配置。沙箱实例仍是临时资源，生命周期由 `agents.sandbox.timeout` 控制；持久化源码计入用户当前项目的 Blob 存储和配额。

## 资源

- [Makers Agents 文档](https://cloud.tencent.com/document/product/1552/132759)
- [Agent 开发快速开始](https://cloud.tencent.com/document/product/1552/132786)
- [Makers Models](https://cloud.tencent.com/document/product/1552/132748)

## 许可证

MIT
