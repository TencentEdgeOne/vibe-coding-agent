import type { HomeExample, HomeFeature } from './types.ts';

export const zh = {
  languageToggleAria: 'Switch language to English',
  // Two editions of this template ship side by side and the UI is the same in
  // both. The one beside the wordmark drives the CLI inside the sandbox, so it
  // says so: everything below about preview and deploy only holds here.
  brandTag: '平台版',
  // Two deployments live in this UI and they are easy to confuse: the panel
  // icon publishes the project the user just generated, the top-bar button
  // takes a copy of this template itself.
  deployLabel: '部署项目',
  templateDeployLabel: '部署模板',
  templateSourceLabel: '模板源码',
  home: {
    titleBefore: '一句话，',
    titleAccent: '生成并上线',
    titleAfter: '你的应用',
    subtitle: '内置平台规范与命令行，在沙箱中生成、校验、预览，再部署到 EdgeOne 全球边缘网络。',
    placeholder: '请输入你想构建的内容',
    fastBuild: '极速生成',
    // Short enough that four chips share one row, and still the whole
    // request: label and prompt are held identical by test, because a chip
    // that summarised a longer prompt once sent someone a six-page
    // specification they had never read.
    examples: [
      {
        label: '做一个持久化留言板',
        prompt: '做一个持久化留言板',
      },
      {
        label: '做一个 Next.js SSR 应用',
        prompt: '做一个 Next.js SSR 应用',
      },
      // Names a framework other than the default one on purpose: asking for a
      // specific framework is a thing you can do here, and one example that
      // says Next.js reads as the only one on offer.
      {
        label: '做一个 Astro 博客站点',
        prompt: '做一个 Astro 博客站点',
      },
      {
        label: '做一个 AI 聊天助手',
        prompt: '做一个 AI 聊天助手',
      },
    ] as readonly HomeExample[],
    // Each card names a capability of the platform, then says what this
    // template does with it — because the platform having a capability and a
    // generated project using it correctly are two different claims, and only
    // the second one is this page's to make.
    features: [
      {
        icon: 'skills',
        title: '平台 Skills 集成',
        desc: '深度集成平台 Skills 能力，适用于根据自然语言快速生成 SSR、ISR、动态接口等全栈 Web 应用及 AI Agent。',
      },
      {
        icon: 'functions',
        title: '框架适配与校验',
        desc: '内置主流框架的平台适配，适配器、产物目录与构建命令自动就绪。部署前自动执行兼容性检查，失败时尝试自动修复。',
      },
    ] as readonly HomeFeature[],
  },
  response: {
    noDisplay: '已编写完成，请查看结果。',
    requestFailedPrefix: '请求失败：',
    unknownError: '未知错误',
    agentFlowEnded: 'Agent 流程已结束。',
    processingFailed: '请求处理失败。',
  },
  workspace: {
    changePlaceholder: '描述你想修改的内容',
    send: '发送',
    stop: '停止生成',
    stopping: '正在停止任务…',
    // Labels the picker for screen readers only; the control itself shows the
    // model's own name, which is the more useful thing to read sighted.
    modelLabel: '选择模型',
    activityPreparingAgent: '正在准备 Agent',
    activityPrepareAccepted: '正在接收需求…',
    activityPrepareWorkspace: '正在准备工作区…',
    activityPrepareAgent: '正在启动 AI…',
    activityAnalyzing: '正在分析',
    activityRunning: '正在执行',
    activityCompleted: '已完成',
    activityFailed: '失败',
    activityStopped: '已停止',
    activityInput: '输入',
    activityOutput: '输出',
    activityThinking: '思考',
    activityInfo: '系统',
    activityUsage: '用量',
    activityCompact: '上下文压缩',
    activityStatus: '状态',
    toolActions: {
      'Environment Preparing': '环境准备',
      Glob: '搜索文件',
      'Read file': '读取文件',
      'Write file': '写入文件',
      'Edit file': '编辑文件',
      'Create folder': '创建目录',
      'Delete file': '删除文件',
      'Create preview': '创建预览',
      'Deploy project': '部署项目',
      'Load skill': '查阅文档',
      'Search web': '搜索网页',
      'Run command': '运行命令',
    },
    // What each reference load is about. The tool is handed a document id, and
    // these are the words that stand in for it, so they have to read as a
    // subject the user recognises rather than as a filename.
    referenceTopics: {
      platform: '平台能力',
      structure: '项目结构',
      serverApi: '服务端 API',
      edgeApi: '边缘函数',
      aiEndpoint: 'AI 接口',
      storage: '数据存储',
      middleware: '请求中间件',
      migration: '项目迁移',
      cli: '命令行',
      deployment: '部署上线',
      environment: '环境适配',
      framework: '框架适配',
    },
    /** Marks the row where the agent goes past the overview of a topic. */
    referenceDetail: '详细用法',
    // Stands for a run of routine file work folded into one row. {count} is the
    // number of steps behind it.
    activitySteps: '{count} 步',
    // Development-only switch between the reading view and the raw projection
    // the stream arrives as.
    activityStyleLabel: '活动显示',
    activityStyleRefined: '精简',
    activityStyleClassic: '原始',
    copyMessage: '复制消息',
    messageCopied: '已复制',
    scrollToLatest: '回到最新',
    // An address the agent writes out in full — a live site, a preview — is
    // something the user takes elsewhere, so the reply offers to copy it.
    copyLink: '复制链接',
    linkCopied: '已复制',
    // The wording the deploy button sends as the user's turn. Keep tool names
    // and execution constraints in the tool description, not in the transcript.
    deployRequest: '把当前项目部署到线上',
    // What the user sees after submitting the card. {key} is already masked.
    // What the agent does with that line lives in the system prompt.
    gatewayRequest: 'API Key： {key}',
    deployNeedsProject: '生成项目后即可一键部署',
    deployNeedsIdle: '当前任务结束后即可部署',
    deployOffer: '要把当前项目部署上线吗？',
    deployOfferAgain: '项目有更新，要重新部署吗？',
    deployOfferAction: '部署',
    deployOfferDismiss: '暂不',
    gatewayPromptTitle: '集成 Models 调用大模型',
    gatewayPromptDeployHint: '上线后的站点也要这把 Key。',
    gatewayPromptDocs: '如何获取',
    gatewayPromptApiKey: 'API Key',
    gatewayPromptContinue: '继续',
    gatewayPromptSkip: '跳过',
    gatewayPromptChip: '配置 API Key',
    preview: '预览',
    code: '代码',
    // The Claude JSONL file is the only history this product keeps. The chat
    // column is a projection of it; this tab shows the file itself, and only
    // in local `next dev`.
    session: '会话',
    showPanel: '展开右侧面板',
    hidePanel: '折叠右侧面板',
    resizePanel: '拖动调节左右宽度',
    choosePanel: '选择预览或代码',
    refreshPreview: '刷新预览',
    openPreview: '在新窗口打开预览',
    previewBack: '后退',
    previewForward: '前进',
    previewRouteList: '项目路由',
    previewRouteEmpty: '当前项目未发现可跳转的路由。',
    previewNavigating: '正在加载路由',
    // The size toggle is icon-only, so these are the accessible name as well as
    // the tooltip — and each names where a click leads, not the current state.
    viewportDesktop: '切换到桌面宽度',
    viewportMobile: '切换到移动宽度',
    downloadSource: '下载源码',
    downloading: '打包中...',
    back: '返回首页',
    newProjectConfirmTitle: '返回首页？',
    newProjectConfirmDescription: '当前任务仍在运行，返回会停止本次生成。是否继续？',
    newProjectConfirmCancel: '取消',
    newProjectConfirmContinue: '停止并返回',
    restoringWorkspace: '正在还原代码与预览…',
    previewStarting: '预览启动中…',
    panelReady: '预览已就绪',
    downloadFailed: '下载失败，请重试。',
    loadingPreview: '正在加载实时预览...',
    previewUnavailable: '预览连接已失效，正在等待重新连接。',
    // Short on purpose: the conversation already narrates the publish, and
    // this only has to say why this one pane stopped answering.
    previewPausedForDeploy: '正在发布，预览暂停',
    retryPreview: '重新连接',
    previewEmpty: '首次构建完成后会在这里显示预览。',
    constructionDisclaimer: '当前仅为模板演示流程使用，模型效果可能较差，简易部署后替换自有模型',
    previewError: '预览错误：',
    downloadError: '下载错误：',
    buildFailedMessage: '构建失败。源码包仍保留当前文件，便于调试。',
    buildFailedAfter: (attempts: number) =>
      `自动修复 ${attempts} 次后构建仍失败。源码包仍保留当前文件，便于调试。`,
  },
  files: {
    empty: '暂无文件。',
    loadingTree: '正在读取项目文件…',
    projectFiles: '项目文件',
    selectFile: '从左侧选择一个文件以预览内容。',
    loading: (path: string) => `正在加载 ${path}...`,
    readFailed: '读取失败',
    requestFailed: '请求失败',
    lines: (count: number) => `${count} 行`,
    truncated: '已截断',
    capabilities: {
      agent: 'AI 接口',
      'cloud-function': '服务端 API',
      'edge-function': '边缘接口',
      middleware: '请求中间件',
      config: '运行配置',
    },
    route: (route: string) => `路由 ${route}`,
  },
  session: {
    empty: '还没有会话记录。',
    writing: '会话正在写入…',
    loading: '正在加载会话…',
    failed: '读取会话失败',
    source: 'session.jsonl',
    lines: (count: number) => `${count} 行`,
  },
} as const;
