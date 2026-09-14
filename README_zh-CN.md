# Vibe Coding 通用模板

[Vibe Coding 通用模板](https://github.com/TencentEdgeOne/vibe-coding-agent) 基于 Claude Agent SDK 与 TypeScript 实现，适用于根据自然语言快速生成 SPA、SSG 等 Web 范式的应用场景，在隔离沙箱中完成文件写入、依赖安装和实时预览，Agent 运行时通过 SDK 将生成项目部署到 Makers 平台。

## 快速开始

1. 创建并获取 [API Token](https://write.woa.com/document/177158578199498752)。

2. 使用下面的示例模板直接开始部署。

   [![部署到 EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)

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
