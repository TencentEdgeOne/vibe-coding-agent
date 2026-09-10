/**
 * Classify a tool call into a domain kind.
 *
 * Replaces inferToolProgress, which returned `phaseHint: 'code' | 'install' |
 * 'preview' | 'link'` — progress-bar vocabulary chosen for one specific UI. A
 * ToolKind says what the tool *does*; each host decides what to call it and
 * whether to show it at all.
 */

import type { ToolKind } from './_events.ts';

/** Strip the `mcp__<server>__` prefix the SDK adds to MCP tool names. */
export function shortenToolName(name: string) {
  return name.replace(/^mcp__[^_]+__/, '');
}

export function extractCommandFromInput(input: unknown): string {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return command.trim();
}

export function classifyTool(
  name: string,
  input: unknown,
  helpers: {
    isInstallCommand: (command: string) => boolean;
    isPreviewCommand: (command: string) => boolean;
  },
): ToolKind {
  const shortName = shortenToolName(name);

  if (shortName === 'publish_project') {
    return 'project.deploy';
  }
  if (shortName === 'publish_preview' || shortName === 'get_preview_link') {
    return 'preview.publish';
  }
  if (shortName === 'ensure_project_scaffold') {
    return 'scaffold';
  }
  if (
    shortName === 'write_project_file'
    || shortName === 'write_project_files'
    || shortName === 'files_write'
    || shortName === 'write_files'
  ) {
    return 'file.write';
  }
  if (shortName === 'files_read') {
    return 'file.read';
  }
  if (shortName === 'files_remove') {
    return 'file.remove';
  }
  if (shortName === 'files_make_dir') {
    return 'dir.create';
  }
  if (shortName === 'commands') {
    const command = extractCommandFromInput(input);
    // An install is worth distinguishing because it is the slow step a host
    // usually wants to surface differently.
    if (helpers.isInstallCommand(command)) return 'dependency.install';
    if (helpers.isPreviewCommand(command)) return 'preview.publish';
    return 'command.run';
  }
  return 'other';
}
