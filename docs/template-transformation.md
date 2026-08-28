# Vibe Coding Agent 模板改造总结

> 将通用 Web Dev Agent 模板改造为面向 EdgeOne Makers 平台的 Vibe Coding 模板，集成 Skills 知识体系、直连 CLI 链路和平台兼容性保障。

## 改造背景

原始模板基于 Claude Agent SDK，具备沙箱代码生成、预览和部署的基础能力，但存在以下核心问题：

1. **Makers Skills 不可达** — 内置了 `.claude/skills/` 下的 Makers 技能文档，但 76% 的深层参考文档（handler 签名、SSE 协议、存储 API 等）无法被 Agent 读取。
2. **提示词膨胀且与 Skills 重复** — `buildPrompt` 把 15 条平台规则硬编码在系统提示中，当 Skills 更新时两者产生漂移。
3. **间接预览/部署工具** — 使用 `publish_preview`、`deploy_to_makers`、`get_preview_link` 三套自定义工具封装 CLI，抽象过深且隐藏了真实 CLI 错误。
4. **缺乏生成代码质量闸** — 生成的项目写入后直接预览，无静态兼容性检查，平台约束违规只能在运行时暴露。
5. **文件面板语义缺失** — 文件树只显示名称和目录结构，不呈现 Makers 语义（能力类型、公开路由）。

---

## 完成的改造项

### 一、知识层

#### 1.1 Skill 深层参考文档可达

**问题：** `load_makers_skill` 工具只能返回顶层 `SKILL.md`，技能文档中引用的深层参考文档（如 `platform/sse-protocol.md`、`runtime/context-tools.md`）完全不可访问。

**方案：**
- 扩展 `load_makers_skill` 的输入 schema，增加可选 `ref` 参数
- 当传入 `ref` 时，直接读取对应技能目录下的参考文档并返回
- 顶层响应末尾追加该 skill 的 deeper references 索引，模型可在后续轮次按需加载

**影响文件：**
- `agents/tools/_makers-skills.ts` — 工具 handler 和 schema 扩展
- `tests/makers-skill-refs.test.ts` — 新增回归测试

---

#### 1.2 提示词瘦身与知识来源下放

**问题：** `buildPrompt` 包含 15 条平台规则（handler 签名格式、文件路由映射、runtime globals、存储 API 约束等），与 Skills 产生信息重复，总长度约 6000 tokens。

**方案：**
- 将 `buildPrompt` 提取到独立的 `agents/_prompt.ts`，仅保留 Skills 不可能知晓的沙箱特有规则
- 删除 15 条可由 Skills 提供的平台知识规则
- 新增"知识来源"章节，明确要求模型在写平台代码前先 `load_makers_skill`
- 编写反向测试 `tests/prompt-single-source.test.ts`，禁止关键平台术语在 prompt 中出现（防止回归）

**影响文件：**
- `agents/_prompt.ts` — 新增，系统提示单一来源
- `agents/_agent.ts` — 精简，改为引用 `_prompt.ts`
- `tests/prompt-single-source.test.ts` — 新增反向测试

**提示词精简效果：**
- 删除 15 条硬编码平台规则
- prompt 只包含：身份 → 知识来源策略 → 沙箱覆盖 → 工具合约 → 工作流 → 代码质量 → 回复规范
- 平台知识完全下放给 Skills（读即用，不在 prompt 中缓存）

**留下的沙箱规则要给做法，不只给约束。** 两条只有 host 知道、且模型每次都会重新发明的写法，直接写成可照抄的形式：
- 前端调用项目接口固定写成 `new URL('api/example', window.location.href)` 再补 `access_token`。同一份代码在预览里落到 `/preview/api/example`，部署后落到 `/api/example`；换成根绝对路径或自己拼前缀都会在浏览器里才暴露
- 依赖访客上下文（地域 / IP / 设备）的页面，切换控件必须用页面已有的数据重新渲染，不能再向服务端要一次。请求失败或命中缓存时页面停在默认分支，用户看到的就是「点了没反应」

---

### 二、生成管线

#### 2.1 直接 CLI 预览与部署

**问题：** 三套自定义工具（`publish_preview`、`deploy_to_makers`、`get_preview_link`）在 CLI 之上抽象了一层代理逻辑，导致：
- CLI 错误被包装成 `SANDBOX_UNKNOWN_ERROR`
- 预览和部署生命周期分散在多套工具中
- 模型无法直接观察和修复 CLI 报告的具体问题

**方案：**
- 移除三套自定义工具，模型直接调用 `commands` 工具执行 `edgeone makers dev` 和 `edgeone makers deploy --json`
- 增强 `commands` wrapper（`agents/tools/_commands-wrap.ts`）：
  - 拦截 Makers CLI 命令，自动注入 tenant token 环境变量
  - 在 8088 启动 Makers dev，并在 3000 启动剥离 `/preview/` 的轻量代理
  - 解析 dev 就绪信号，通过 `context.sandbox.getHost(9000) + /preview/` 获取公开 URL，写入预览通道
  - 解析 deploy JSON 输出，提取完整部署 URL、`projectId`、`deploymentId`、`consoleUrl`，写入独立部署通道（不覆盖 iframe 预览）
  - 修改 background script 始终以 exit 0 退出，改用 `MAKERS_DEV_EXIT:$status` / `MAKERS_DEPLOY_EXIT:$status` marker 传递真实退出码
- 生成项目仍按部署时的根路径编写；代理只在沙箱预览链路中剥离 `/preview/`
- 代理把 `/preview`（无尾斜杠）308 重定向到 `/preview/`，query 原样带走。少一个斜杠，浏览器就拿主机根目录当页面基准，样式、脚本、接口的相对地址全部解析到网关不发布的路径上，整页静默失效；access_token 在 query 里，所以重定向必须保留它
- 引入 `MAKERS_CLI_UNAVAILABLE` 终止型错误，当 sandbox 镜像未提供 CLI 时阻断重试和安装

**影响文件：**
- `agents/tools/_commands-wrap.ts` — 核心 wrapper 重构（+331 行）
- `agents/tools/_project-tools.ts` — 移除旧工具（-245 行）
- `agents/project/_preview.ts` — 简化预览逻辑
- `agents/project/_makers-deploy.ts` — 精简部署逻辑
- `agents/project/_makers-token.ts` — 新增 sub-token 签发
- `shared/makers-dev.ts` — dev 命令构建器重构
- `shared/makers-deploy.ts` — deploy 命令构建器重构
- `shared/tool-phase.ts` — 命令分类与安全规则
- `tests/commands-wrap.test.ts` — 新增 wrapper 行为测试（+284 行）

**安全机制：**
- `forbiddenSandboxCommandReason` 阻止 `npx edgeone`、token 传参、非法 CLI 子命令
- 允许唯一诊断命令 `edgeone --version`（限一次）
- `isEdgeoneCliUnavailable` 检测各种 shell "command not found" 变体
- tenant token 仅注入到 CLI 进程环境，不进入模型上下文

---

#### 2.2 Makers 兼容性 Lint

**问题：** 生成代码写入后直接预览/部署，不检查 Makers 平台约定。常见违规（如 Edge Function 中使用 Node.js API、缺少 `edgeone.json`、Agent 框架未声明等）只有到运行时才暴露。

**方案：** 构建一套从 vendored Skills 动态驱动的静态兼容性检查器。

**架构：**

```
vendored SKILL.md (frontmatter)
         │
         ▼
parseMakersSkillValidationRules()  ─→  MakersValidationRule[]
         │
         ▼
buildMakersCompatibilityScript()   ─→  生成 Node.js lint 脚本
         │
         ▼
runMakersCompatibilityCheck()      ─→  在沙箱中执行，解析退出码和诊断输出
```

**规则来源（7 份 Skills）：**
| Skill | 检查范围 |
|-------|---------|
| `makers-agents` | Agent handler 签名、框架 import |
| `makers-cloud-functions` | Cloud Function 结构、`process.env` 禁令 |
| `makers-edge-functions` | Edge Function V8 约束 |
| `makers-middleware` | Middleware export shape |
| `makers-deploy` | 部署配置与脚本 |
| `makers-env-adaption` | 沙箱环境适配 |
| `makers-storage` | KV/Blob 使用约束 |

**内置结构规则：**
- `edgeone.json` 存在性和 `agents.framework` 白名单校验
- `.env.example` 存在性和 AI Gateway 环境变量声明
- Agent 入口文件导出 `handler` 或 `default` 函数
- Function 文件必须有扩展名
- Edge Function 不能访问 `context.env.KV`
- Middleware 必须导出 `onRequest`
- 框架原生 middleware（Next.js/Nuxt）自动豁免

**集成点：**
1. `startPreviewServer` 前置调用 `assertMakersProjectCompatible`
2. `runVerification` 先执行兼容性检查，失败则进入 auto-fix
3. 恢复 workspace 后的预览链路同样触发

**影响文件：**
- `agents/project/_makers-compat.ts` — 核心实现（+403 行）
- `agents/project/_scaffold.ts` — 验证链集成
- `agents/project/_preview.ts` — 预览前置检查
- `tests/makers-lint.test.ts` — 新增行为测试（+178 行）
- `tests/makers-compat.test.ts` — 重构

---

### 三、前端体验

#### 3.1 文件树语义标注

**问题：** 用户看到的文件面板只有文件名和目录结构，无法快速理解每个文件在 Makers 平台中的角色和暴露的路由。

**方案：** 从文件路径约定推导 Makers 语义，在文件树中展示能力徽标和公开路由。

**能力映射表：**
| 能力 | 徽标 | 触发路径 |
|------|------|---------|
| AI 接口 | `AI` | `agents/` 目录及其入口文件 |
| 服务端 API | `API` | `cloud-functions/` 目录及其函数文件 |
| 边缘接口 | `EDGE` | `edge-functions/` 目录及其函数文件 |
| 请求中间件 | `MW` | 根目录 `middleware.js` / `middleware.ts` |
| 运行配置 | `CONFIG` | `edgeone.json` |

**路由推导规则：**
- `agents/chat.ts` → `/chat`
- `cloud-functions/api/users/[id].js` → `/api/users/:id`
- `edge-functions/auth/[[default]].ts` → `/auth/*`
- `cloud-functions/api/index.py` → `/api/*`（Python 框架）
- `cloud-functions/api.go` → `/api/*`（Go 框架）
- `middleware.ts` → `/*`

**排除规则：**
- `_` 前缀文件（私有模块）
- 非函数扩展名文件（`.md`、`.txt`、`.json` 等）
- `_shared/`、`_tools/`、`requirements.txt` 等非路由资源

**影响文件：**
- `shared/makers-file-semantics.ts` — 新增语义推导逻辑（+141 行）
- `app/components/files-panel.tsx` — 渲染徽标和路由
- `app/i18n.ts` — 中英文能力说明
- `tests/makers-file-semantics.test.ts` — 新增行为测试（+69 行）

---

#### 3.2 首页去模板化

**问题：** 首页是「居中大标题 + 输入框 + 4 条纯文字示例」的通用 vibe coding 形态，看不出这是一个跑在 Makers 上的产品。

**方案：** 保留居中输入框和示例 prompt 这两个交互预期，补上平台信息。

- **流水线 ribbon** — 标题上方一行 `生成 → 兼容性检查 → 沙箱预览 → 边缘部署`，映射真实运行阶段，替代装饰性 eyebrow；末段取品牌蓝
- **示例 prompt 收敛到三条** — 输入框下方保留三条可点击示例，点击直接填入请求；同一批文案复用为占位符打字机，首页不再出现四条以上的文本 chip
- **平台特性卡** — 输入框下方 2×2 展示卡，四个标题统一为名词短语：AI Agent 运行时、云函数与边缘函数、KV 与 Blob 存储、零配置构建；部署已由流水线 ribbon 交代，卡片不重复。纯展示，无 hover 位移、无点击行为，避免和示例 prompt 抢交互
- **配色** — 首页只用品牌蓝，不引入渐变文字与渐变底纹；全站不再有第二主色

**影响文件：**
- `app/features/workspace/components/home-stage.tsx` — 重写落地页
- `app/i18n.ts` — `pipeline` / `examples` / `features` 结构化文案
- `app/styles/home.css` — 落地页样式
- `tests/tool-activity.test.ts` — 中英文示例与特性卡的一致性回归

---

#### 3.3 部署态独立成型

**问题：** `edgeone makers deploy` 与 `edgeone makers dev` 在界面上无法区分：
- 活动条把两条命令都标成「创建预览」
- 部署成功后把线上 URL 写进 `preview`，右侧 iframe 被换成线上站点，刷新预览按钮和沙箱 token 续期逻辑也跟着走错
- CLI 已返回 `projectId` / `deploymentId` / `consoleUrl`，前端丢弃不用，用户拿不到可复制、可分享的线上地址

**方案：** 把部署做成独立产品状态，预览继续只服务沙箱 `makers dev`。

**数据通道：**
| 通道 | 来源 | 用途 |
|------|------|------|
| `preview_ready` / `LinkInfo` | `makers dev` | 右侧 iframe 沙箱预览 |
| `deployment_status` / `DeploymentInfo` | `makers deploy --json` | 进行中 / 成功 / 失败，以及线上 URL |

`DeploymentInfo` 字段：`status`、`url`、`projectId`、`deploymentId`、`consoleUrl`、`error`、时间戳。成功态必须保留完整 query（`?eo_token=...&eo_time=...`），截断会导致 401。

**UI：**
- 活动条：`makers dev` →「创建预览」，`makers deploy` →「部署项目」
- 右侧面板顶部独立部署条：进行中 / 成功 / 失败
- 成功后展示完整线上 URL，支持复制、新窗口打开、控制台深链
- 刷新 / resume 从 `projectState.deployment` 恢复，不把线上 URL 塞回 iframe

**项目名即站点身份：** `makers dev` 与 `makers deploy` 都是按名字 get-or-create，名字就是这次会话拥有的项目。
- 原先所有会话共用 `vibe-coding-playground`：后一个用户的部署要么覆盖前一个用户的站点，要么直接撞上「项目名已存在」
- 换成租户 token 后共享名更是必然失败：租户只看得见自己建的项目，查不到就去建，建的时候名字已被账号里的旧项目占用，预览在 `Failed to create pages project` 上直接起不来
- 统一改为按会话派生 `vibe-coding-<sessionDir 的 sha256 前 10 位>`：一个会话一个项目，预览和部署落在同一个项目、同一份 `.edgeone/project.json`，且是纯函数、不依赖持久化
- 会话 ID 会进入公开域名，所以取哈希而不是原值
- 只有 agent / Blob 项目才需要 link，纯静态站点不会因此占用项目配额
- `MAKERS_DEPLOY_PROJECT_NAME` 保留为运维显式指定，设了就是全局固定一个项目
- 模型写的 `-n` 一律被 host 覆盖，提示词也不再给它名字：它无从知道本会话对应哪个项目，撞名后自己换名只会把站点发到没人找得到的地方

**对话里的交付物：** 沙箱预览随会话消失，线上地址不会，它必须能从对话正文里复制走，不能只挂在部署条上。
- 提示词把「不要回预览链接」限定在沙箱预览，部署成功时要求单独一行写出完整 URL
- `compactUserFacingReply` 压缩前把 URL 换成占位符、压缩后还原：URL 里的点号不再被当作句号断句，长度也不占正文预算
- `withLiveDeploymentUrl` 兜底：本轮确实部署成功、且回复里还没有这个地址时，按回复语言补一行
- 叙述流的去重只按「长到不可能是巧合」的块判定：delta 是 token 粒度的，`endsWith` 一比，`...dbd1ca` 后面那个 `a` 就被当成重复吞掉，URL 少一个字符照样长得像 URL。运行时和前端两处都改成只对足够长的整块跳过（`resolveNarrationEmit` / `appendNarrationChunk`）
- `dropTrailingSummaryEcho` 去重：模型结尾那句叙述和最终总结本就是同一句话，前端在定稿与 resume 两处丢掉尾部叙述，只留带 URL 的总结。比较时同时忽略空白和链接——总结会把线上地址单独提行、有时还加「线上地址：」前缀，只有正文才可比

**兼容：** `separateLegacyMakersDeployment` 把历史上 `previewKind === 'makers'` 的 URL 迁出预览态，避免旧会话刷新后继续把部署页当沙箱预览。

**影响文件：**
- `shared/protocol.ts` — `DeploymentInfo`、`deployment_status` 事件
- `agents/tools/_commands-wrap.ts` — 部署成功/失败走 `onDeploymentStatus`，不再写 `previewUrl`
- `agents/pipelines/_chat.ts` / `_resume.ts` — 流式推送并持久化部署态
- `agents/project/_state.ts` — 旧会话迁移
- `agents/project/_makers-deploy.ts` — 项目名按会话派生，预览与部署共用
- `shared/user-facing-reply.ts` — URL 占位压缩、`withLiveDeploymentUrl`
- `agents/_prompt.ts` — 区分沙箱预览链接与线上地址，禁止模型自选项目名
- `app/features/workspace/components/deployment-status.tsx` — 部署条
- `agents/utils/_narration.ts` / `app/lib/tool-activity.ts` — 叙述分片拼接不再吞字符
- `app/features/workspace/workspace-screen.tsx` — 订阅事件、复制完整 URL、收敛尾部叙述
- `app/lib/tool-activity.ts` — 活动标签拆分、`dropTrailingSummaryEcho`
- `tests/commands-wrap.test.ts` / `tests/tool-activity.test.ts` / `tests/user-facing-reply.test.ts` — 回归

---

#### 3.4 设计系统收敛与品牌标识

**问题：** 样式已经漂移到改不动的程度 —— `app/globals.css` 单文件 1733 行，`.workspace-shell`、`.workspace-tab` 各被定义 4 次（早期的 grid 布局与下划线 Tab 已被后续块整体覆盖，成为死代码），41 处 `!important`，147 处硬编码 hex（65 个不同色值）对比仅 59 处 `var(--token)`，10 种圆角、10 种动效时长，`--font-geist-mono` 被引用但从未定义。

**方案：**

- **拆分与去重** — 按 surface 拆成 `app/styles/{tokens,base,header,home,conversation,workspace,deployment,dialog}.css`，`globals.css` 只保留 `@import` 与 Tailwind 主题块；每个选择器只定义一次，删除被覆盖的死规则
- **去 `!important`** — Tailwind v4 把工具类放在 `@layer utilities`，而未分层 CSS 的层叠优先级高于任何 layer，因此手写 chrome 天然压过 shadcn 默认值；41 处 `!important` 全部移除，Tab 选中态改用同等特异性的 `[data-state='active']` 选择器
- **token 化** — 中性色阶（`--n-0` ~ `--n-900`）、状态色、三级阴影、四档圆角、三档动效时长与缓动曲线全部集中在 `tokens.css`；shadcn 契约变量映射到同一色阶，工具层与手写层不再各说各话
- **单一主题色** — 全站只有品牌蓝一个强调色，不引入第二主色；活动流按 `data-tier` 分级，Skills / 兼容性检查 / dev / deploy 这些平台节点取品牌蓝，普通文件操作保持中性灰
- **能力色相** — `agent` / `cloud-function` / `edge-function` / `middleware` / `config` 从三种共用一个蓝，拆成五个可区分的色相；色相围绕蓝—青—琥珀展开，作为分类标签而非第二套主题
- **CTA 权重** — 头部唯一的实心蓝按钮「联系我们」降级为描边，主按钮权重交还给输入框；左上角 wordmark `MAKERS VIBE CODING` 维持原样不动

**回归护栏：** `tests/app-shell.test.ts` 改为对全部样式分片做断言，并新增两条反向测试 —— 样式表不得出现 `!important`，surface 分片不得出现裸色值。

**影响文件：**
- `app/globals.css` — 收敛为入口文件
- `app/styles/*.css` — 新增 8 个 surface 分片
- `app/features/workspace/components/site-header.tsx` — CTA 权重
- `app/components/files-panel.tsx` / `app/components/agent-conversation.tsx` / `app/lib/tool-activity.ts` — 能力徽标与活动分级
- `tests/app-shell.test.ts` — 断言口径与反向测试

---

## 改造统计

| 维度 | 数值 |
|------|------|
| 变更文件数 | 62 |
| 新增代码行 | +5,982 |
| 删除代码行 | -2,626 |
| 净增代码行 | +3,356 |
| 新增测试文件 | 5 |
| 测试总数 | 153（全部通过） |
| 类型检查 | 通过 |

---

## 架构变更总览

```
改造前                                    改造后
──────────────────────────────────────    ──────────────────────────────────────
buildPrompt (含 15 条平台规则)             buildPrompt (仅沙箱+工具合约)
  ↓                                        ↓
load_makers_skill (仅顶层)                 load_makers_skill (顶层 + ref 深层)
  ↓                                        ↓
publish_preview / deploy_to_makers         commands wrapper (直接 CLI)
  ↓                                          ↓
代理预览 (/preview/ 前缀)                  makers dev :8088 → 代理 :3000 → :9000/preview/
部署结果丢进同一 iframe                    makers deploy → 独立部署条 (URL / 控制台)
  ↓                                          ↓
无兼容性检查                               Makers 兼容性 lint (Skills 驱动)
  ↓                                          ↓
纯文件名文件树                             语义标注文件树 (能力 + 路由)
  ↓                                          ↓
通用落地页 + 4 条示例文本                  流水线 ribbon + 3 条示例 + 特性展示卡
1733 行单文件 CSS / 41 处 !important       tokens + 8 个 surface 分片 / 0 处 !important
```

---

## 安全与防御设计

| 机制 | 说明 |
|------|------|
| Sub-token 隔离 | 主 Token 只留在 Agent Runtime；沙箱 CLI 拿到的一律是按会话隔离的临时 tenant token，`resolveSandboxMakersToken` 是唯一出口，没有回退到主 Token 的分支（约束见「待完成项 → 租户 Token 的已知约束」）|
| 环境同源 | `MAKERS_API_ENV` + `MAKERS_API_REGION` 同时决定 SDK 签发端点与注入沙箱的 `API_ENV` / `EDGEONE_PAGES_API_REGION`，令牌永远由签发它的环境校验 |
| 命令白名单 | `forbiddenSandboxCommandReason` 只允许 `makers dev`、`makers deploy`、`--version` |
| 终止型错误 | `MAKERS_CLI_UNAVAILABLE` 禁止模型重试、安装、npx、路径探测 |
| Exit code 保护 | 后台脚本总以 0 退出，真实退出码通过 marker 传递，避免 sandbox 吞错 |
| Token 脱敏 | CLI 输出中的 token 在返回给模型前被 redact |
| 反向测试 | 禁止 prompt 重新引入已删除的平台规则 |

---

## 待完成项

| 优先级 | 内容 | 规模 |
|--------|------|------|
| 1 | 归属与认领方案 — 解决部署产物到用户 Makers 项目的绑定流程 | 大 |
| 2 | 补齐 tenant token 权限 — 下表接口尚未放开，且沙箱镜像需带上改用 `DescribePagesProjects` 校验的 CLI | 中 |

沙箱注入 tenant token 后，对 `eo-test.qcloud.com` 逐个实测 CLI 在 dev / deploy 链路上用到的 16 个接口，未授权的返回顶层 `Code=107 "Action has not found."`：

| 接口 | 缺失后果 |
|------|----------|
| `DescribeUserInfo` | 硬阻塞。`checkLoginValid()` 唯一的校验手段，dev 每条命令开头都调，失败即 exit 1。CLI 已改为用 tenant token 已放开的 `DescribePagesProjects` 校验，避免放开账号级接口；该版本进入沙箱镜像后此项即解除 |
| `CreateDebugFunction` / `ModifyDebugFunction` | 生成项目含 `edge-functions/` 时预览起不来 |
| `DescribePagesProjectEnvs` / `ModifyPagesProjectEnvs` / `DeletePagesProjectEnvs` | 静默降级，构建拿不到项目环境变量 |

其余 10 个（`DescribePagesProjects`、`CreatePagesProject`、`DescribeProjectKVBindings`、`DescribePagesZones`、AI Gateway 凭证读写、`DescribePagesCosTempToken`、`CreatePagesDeployment`、`DescribePagesDeployments`、`DescribePagesEncipherToken`）对 tenant token 均已放开。deploy 不走 `loginIfNot()`，因此权限到位前它本就能用 tenant token 跑通。

### 租户 Token 的已知约束

签发实现在 `ef-api-server` 的 `CreateTenantToken`。沙箱现在固定跑在 tenant token 上，有三件事要清楚。

**空 TenantId 是静默的 fail-open。** 服务端 DTO 只有 `@IsString() @MaxLength(64)`，不拦空串；而网关注入写的是 `if (TenantId) data.TenantId = TenantId`，空串是 falsy，不会被注入。两者叠加会产出一个 `Type='tenant'`、能过租户 Action 白名单、但下游全部按主 Token 处理的凭证 —— 项目列表不过滤、项目归属校验直接放行，而且不报任何错。当前拦住它的只有 SDK 的 `tenantId.length === 0` 校验和 `ensureMakersTenantId` 的真值判断，服务端自身没有下限，绕过 SDK 直调 API 即可塞入。

**配额只增不减，每个 AppId 上限 50000。** 计数用的是 `count({ AppId, Type: 'tenant' })`，不排除已过期的记录；`DescribeTokens` 明确排除 `Type='tenant'`，控制台列表里看不到；`DeleteTokens` 只能按 TokenId 删，而那个 ID 从不返回给调用方。当前 tenantId 是每个 project state 一个新 UUID，等于每个新会话永久占一个名额，且没有自助清理路径。

**子 Token 是幂等复用，不是每次新签。** `{AppId, Uin, TenantId, Type}` 命中已有记录就返回同一个 token 字符串，只把 `Expired` 往后推。所以 `MAKERS_SUB_TOKEN_TTL_SECONDS` 的真实语义是「最后一次使用后 N 秒失效」的滑动过期，同一项目拿到的凭证值在整个生命周期内是稳定的。好处是反复预览不会增加记录，只有新项目才增。

---

## 本地验证

```bash
npm install
npm test          # 153 tests passed
npm run typecheck # 通过
```

---

*文档更新日期：2026-08-28*
