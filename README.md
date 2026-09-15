# Vibe Coding General Template

[Vibe Coding General Template](https://github.com/TencentEdgeOne/vibe-coding-agent) is built with the Claude Agent SDK and TypeScript. Use it to generate SPA, SSG, and similar web apps from natural language. File writes, dependency installation, and live preview run in an isolated sandbox. Agent Runtime then deploys the generated project to the Makers platform through the SDK.

## Quick start

1. Create an [API Token](https://pages.edgeone.ai/document/api-token).

2. Start from the example template below.

   [![Deploy to EdgeOne Makers](https://cdnstatic.tencentcs.com/edgeone/pages/deploy.svg)](https://edgeone.ai/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript)

3. On the deploy configuration page, set the `API_TOKEN` environment variable.

4. Click deploy and wait for Makers to finish the build and return a URL.

## Core capabilities

### Sandbox preview

Call sandbox `getHost(9000)` for the public host, then append `envdAccessToken` as `access_token` to build the preview URL.

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

### Deploy with the Makers SDK

Agent Runtime uses `API_TOKEN` to call the Makers SDK, upload the artifact, and trigger build and deploy.

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

See [Makers SDK](https://pages.edgeone.ai/document/sdk-overview) for the integration details.

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

### Deploy the project

If the project is connected to a Git repository, pushing code triggers a Makers CI build and deploy. You can also deploy with the CLI:

```bash
# Deploy to production
edgeone makers deploy -n <project-name>
```

After a successful deploy, use the Console link to open the build details and the live URL.
