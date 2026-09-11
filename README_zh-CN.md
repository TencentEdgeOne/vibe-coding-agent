# Vibe Coding 通用模板

[English](./README.md) · 简体中文

基于 Claude Agent SDK 与 TypeScript 实现，可根据自然语言需求快速生成活动页、官网、作品集等 SPA、SSG 轻量 Web 应用，在隔离沙箱中完成文件写入、依赖安装和实时预览，并由 Agent 运行时通过 Makers SDK 将生成项目部署到 Makers 平台。

**框架：** Claude Agent SDK · **分类：** Coding · **语言：** TypeScript

[![部署到 EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)

## 整体流程

本模板将需求理解、代码生成、沙箱预览和一键部署串联为完整流程：

![](https://mediastatic-hk-1258344699.cos-internal.ap-hongkong.tencentcos.cn/tRpcWrite/100027539259/5a2843edad8811f18d3852540008be5a.png)

## 快速开始

1. 创建并获取 [API Token](https://cloud.tencent.com/document/product/1552/127422)。
2. 使用下面的示例模板直接开始部署。

**[Web Coding Agent](https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)** — 一个基于沙箱环境的 Agent 通用模板，用于编写、预览、验证和迭代现代 Web 应用。

3. 在部署配置页面，填写 `API_TOKEN` 环境变量。
4. 点击部署，等待 Makers 完成构建并生成访问地址。

## 核心能力

本模板提供构建 Vibe Coding 平台所需的完整能力，包括 Agent 运行、沙箱工具、模型调用与多租户隔离等；整体方案详见 [Vibe Coding](https://pages.edgeone.ai/zh/document/vibe-coding)，以下重点介绍本模板的部分核心能力。

### 集成 Makers SDK 部署

部署由 Agent Runtime 统一控制，关键流程如下：

1. 用户确认发布后，Runtime 读取当前会话的项目源码。
2. Runtime 使用 `API_TOKEN` 调用 Makers SDK，上传部署包并触发构建与部署。
3. 部署完成后，系统保存项目状态并向用户返回可访问的 HTTPS 地址。

部署的详细接入流程可参考 [Makers SDK](https://www.npmjs.com/package/@edgeone/makers-sdk)。

### 安全边界

- `API_TOKEN` 只留在 Agent Runtime，用于调用 SDK 部署，不会进入模型上下文、隔离沙箱。
- 每个会话使用独立沙箱，代码、依赖与执行环境相互隔离。

## 本地调试和部署

### 启动本地开发调试

1. 进入项目根目录，安装 [EdgeOne CLI](https://cloud.tencent.com/document/product/1552/127423)：

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

尚未关联项目时，也可以复制 `.env.example` 为 `.env` 后手动填写环境变量。

### 部署项目

如果项目已关联 Git 仓库，推送代码即可触发 Makers 的 CI 构建与部署。也可以通过 CLI 直接部署：

```bash
# 部署至生产环境
edgeone makers deploy -n <项目名>
```

部署成功后点击 Console 的链接可以访问具体构建信息和部署后的 URL。

## 资源

- [Vibe Coding](https://pages.edgeone.ai/zh/document/vibe-coding)
- [Makers Agents 文档](https://cloud.tencent.com/document/product/1552/132759)
- [Agent 开发快速开始](https://cloud.tencent.com/document/product/1552/132786)
- [Makers Models](https://cloud.tencent.com/document/product/1552/132748)
- [API Token](https://cloud.tencent.com/document/product/1552/127422)
- [EdgeOne CLI](https://cloud.tencent.com/document/product/1552/127423)
- [Makers SDK](https://www.npmjs.com/package/@edgeone/makers-sdk)

## 许可证

MIT
