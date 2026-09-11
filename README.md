# Vibe Coding General Template

English · [简体中文](./README_zh-CN.md)

Built with the Claude Agent SDK and TypeScript. It turns natural-language requests into lightweight SPA or SSG web apps such as campaign pages, marketing sites, and portfolios. File writes, dependency installation, and live preview run in an isolated sandbox. Agent Runtime then deploys the generated project to the Makers platform through the Makers SDK.

**Framework:** Claude Agent SDK · **Category:** Coding · **Language:** TypeScript

[![Deploy to EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)

## Quick start

1. Create an [API Token](https://pages.edgeone.ai/document/api-token).
2. Start from the template below.

**[Web Coding Agent](https://edgeone.ai/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)** — A sandbox-based general Agent template for writing, previewing, verifying, and iterating on modern web apps.

3. On the deploy configuration page, set the `API_TOKEN` environment variable.
4. Click deploy and wait for Makers to finish the build and return a URL.

## Core capabilities

This template covers the building blocks of a Vibe Coding platform: Agent runtime, sandbox tools, model access, and tenant isolation. See [Vibe Coding](https://pages.edgeone.ai/document/vibe-coding) for the overall approach. The sections below highlight what this template itself implements.

### Deploy with the Makers SDK

Agent Runtime owns the publish path:

1. After the user confirms publish, the runtime reads the current conversation's project source.
2. The runtime calls the Makers SDK with `API_TOKEN`, uploads the artifact, and triggers build and deploy.
3. When deploy finishes, the runtime saves project state and returns a public HTTPS URL.

See [Makers SDK](https://www.npmjs.com/package/@edgeone/makers-sdk) for the integration details.

### Security boundary

- `API_TOKEN` stays in Agent Runtime. It is used only to call the SDK for deploy, and never enters the model context or the isolated sandbox.
- Each conversation gets its own sandbox. Code, dependencies, and the execution environment stay isolated.

## Local debug and deploy

### Start local development

1. From the project root, install the [EdgeOne CLI](https://pages.edgeone.ai/document/edgeone-cli):

   ```bash
   npm install -g edgeone
   ```

2. Sign in to EdgeOne and link the Makers project you want to debug:

   ```bash
   edgeone login
   edgeone makers link
   ```

   Linking syncs the console `API_TOKEN` and the Models API key to your local environment.

3. Start the Makers local development environment:

   ```bash
   edgeone makers dev
   ```

   After it starts, open:

   - Agent app: http://localhost:8088/
   - Observability traces: http://localhost:8088/agent-metrics

If the project is not linked yet, copy `.env.example` to `.env` and fill in the variables manually.

### Deploy the project

If the project is connected to a Git repository, pushing code triggers a Makers CI build and deploy. You can also deploy with the CLI:

```bash
# Deploy to production
edgeone makers deploy -n <project-name>
```

After a successful deploy, use the Console link to open the build details and the live URL.

## Resources

- [Vibe Coding](https://pages.edgeone.ai/document/vibe-coding)
- [Makers Agents Documentation](https://pages.edgeone.ai/document/agents)
- [Quick Start: Agent Development](https://pages.edgeone.ai/document/agents-quick-start)
- [Makers Models](https://pages.edgeone.ai/document/models)
- [API Token](https://pages.edgeone.ai/document/api-token)
- [EdgeOne CLI](https://pages.edgeone.ai/document/edgeone-cli)
- [Makers SDK](https://www.npmjs.com/package/@edgeone/makers-sdk)

## License

MIT
