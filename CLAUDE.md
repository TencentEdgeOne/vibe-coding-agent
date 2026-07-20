@AGENTS.md

# UI 组件与样式约定

- **优先使用 shadcn/ui**：需要 UI 组件（按钮、输入框、卡片、Tabs、Badge、ScrollArea 等）时，先用 `@/components/ui/*` 里的 shadcn 组件，不要从零手搓样式。
- 缺少组件时用 `npx shadcn@latest add <name>` 添加（本项目已配置 `components.json`、`@/*` 别名、`@/lib/utils` 的 `cn()`）。仅当没有合适组件时才用 Tailwind 手写。
- **配色遵循设计稿**：视觉以 `plan/design-mockup.html` 为准 —— 浅色白底、蓝色品牌（`#2f6bff` / `#0052d9`）。颜色统一走 `app/globals.css` 里定义的主题变量（`bg-background`、`text-foreground`、`border-border`、`bg-card`、`bg-primary`、`text-muted-foreground`、`bg-accent` 等），品牌渐变复用 `.btn-brand` 工具类，不要再写死深色/绿色。
