# Vibe Coding 通用模板

[Vibe Coding 通用模板](https://github.com/TencentEdgeOne/vibe-coding-agent) 基于 Claude Agent SDK 与 TypeScript 实现，适用于根据自然语言快速生成 SPA、SSG 等 Web 范式的应用场景，在隔离沙箱中完成文件写入、依赖安装和实时预览，Agent 运行时通过 SDK 将生成项目部署到 Makers 平台。

## 快速开始

1. 创建并获取 [API Token](https://write.woa.com/document/177158578199498752)。

2. 使用下面的示例模板直接开始部署。

<style>
        /* 基础重置 */
        body, h2, p {
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            box-sizing: border-box; /* 确保 padding 和 border 不会增加元素的总宽度和高度 */
        }
        body {
            background-color: #f0f2f5;
            display: flex;
            justify-content: center;
            align-items: center; /* 垂直居中 */
            min-height: 100vh; /* 确保 body 至少和视口一样高 */
            padding: 20px;
        }

        .card {
            display: block; /* 使 a 标签表现为块级元素 */
            width: 100%;
            max-width: 280px; /* 最大宽度保持 280px */
            height: 270px; /* 固定卡片总高度 */
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 4px 8px rgba(0,0,0,0.1);
            background-color: #ffffff;
            border: 1px solid #e1e4e8; /* 默认边框 */
            transition: border-color 0.2s ease-in-out, box-shadow 0.2s ease-in-out; /* 添加过渡效果 */
            cursor: pointer; /* 提示可交互 */
            text-decoration: none; /* 移除链接的下划线 */
        }

        .card:hover {
            border-color: #0366d6; /* hover 时的边框颜色 */
            box-shadow: 0 4px 12px rgba(3, 102, 214, 0.2); /* hover 时的阴影效果 */
        }
        
        .card-image {
            width: 100%;
            height: 157px; 
            object-fit: cover; 
            display: block; 
        }
        
        .content-section {
            padding: 16px; 
            height: 113px; /* 固定内容区域高度 (270px - 157px) */
        }

        .content-section h2 {
            font-size: 16px; 
            color: #0d1117; 
            margin-bottom: 8px;
            
            /* -- 以下是单行文本截断的关键样式 -- */
            white-space: nowrap; /* 强制文本不换行 */
            overflow: hidden; /* 超出部分隐藏 */
            text-overflow: ellipsis; /* 超出部分显示省略号 */
        }

        .content-section p {
            color: #57606a; 
            line-height: 1.5;
            font-size: 13px; 
            
            /* -- 以下是多行文本截断的关键样式 -- */
            overflow: hidden; 
            text-overflow: ellipsis; 
            display: -webkit-box;
            -webkit-line-clamp: 2; /* 限制为最多显示 2 行 */
            -webkit-box-orient: vertical;
        }
    </style>

    <a href="https://edgeone.ai/makers/new?template=vibe-coding-agent&amp;from=within&amp;fromAgent=1&amp;agentLang=typescript" class="card" target="_blank">
        <img class="card-image" src="https://cdnstatic.tencentcs.com/edgeone/pages/docs/vibe-coding-template.png" />

        <div class="content-section">
            <h2>Vibe Coding Agent</h2>
            <p>
               一个可根据自然语言需求快速生成 SPA、SSG 等 Web 范式的应用的 Agent 模板。
            </p>
        </div>
    </a>

3. 在部署配置页面，填写`API_TOKEN`环境变量。

4. 点击部署，等待 Makers 完成构建并生成访问地址。

## 核心能力

### 启动沙箱预览

调用沙箱 `getHost(9000)` 取得公网 host，再把 `envdAccessToken` 作为 `access_token` 拼到链接上，得到沙箱预览地址。

```typescript
const workspace = createMakersWorkspacePort(context);
  const previewHost = await workspace.getHost?.(PREVIEW_PUBLIC_PORT);
  const accessToken = workspace.accessToken;
  const browserLiveUrl = workspace.browserLiveUrl;

  return {
    previewUrl: resolvePreviewUrl({
      previewHost,
      accessToken,
      browserLiveUrl,
      pathPrefix: PREVIEW_PATH_PREFIX,
    }),
  };
```

### 集成 Makers SDK 部署

Agent 运行时使用 `API_TOKEN` 调用 Makers SDK，上传部署包并触发构建与部署。

```typescript
const deployment = await makers.deployments.deploy({
   projectId,
   artifact: { archive: tmpZip },
   wait: true,
   onStatusChange: (event) => {
      options.onStage('deploying', event.deployment.status);
   },
});
```

部署的详细接入流程可参考 [Makers SDK](https://write.woa.com/document/220119083634003968)。

## 本地调试和部署

### 启动本地开发调试

1. 进入项目根目录，安装 [EdgeOne CLI](https://write.woa.com/document/162228053883678720)：

   ```bash
   npm install -g edgeone
   ```

2. 登录 EdgeOne，并关联需要调试的 Makers 项目：

   ```bash
   edgeone login
   edgeone makers link
   ```

   关联项目后会把控制台配置的 `API_TOKEN` 和调用 Models 所需的 API Key 自动同步到本地。

3. 启动 Makers 本地开发环境：

   ```bash
   edgeone makers dev
   ```

   启动成功后访问：

- Agent 应用：http://localhost:8088/

- 可观测链路追踪：http://localhost:8088/agent-metrics

### 部署项目

如果项目已关联 Git 仓库，推送代码即可触发 Makers 的 CI 构建与部署。也可以通过 CLI 直接部署：

```bash
# 部署至生产环境
edgeone makers deploy -n <项目名>
```

部署成功后点击 Console 的链接可以访问具体构建信息和部署后的 URL。
