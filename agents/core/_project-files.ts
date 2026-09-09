/**
 * Project file operations, scoped to a project directory.
 *
 * Almost every `context.sandbox.files.*` call in the template was really
 * "does this file exist inside appDir" or "write this file inside appDir",
 * with the appDir prefix spliced in by hand at each call site. That hand-built
 * prefixing is what made the operations look host-specific when they are not.
 *
 * Binding a workspace port to a project directory once turns them into plain
 * project questions, and keeps path construction in a single place.
 */

import { runCommand } from './_commands.ts';
import type { FileReadValue, WorkspacePort } from './_ports.ts';

export type ProjectFiles = {
  /** Absolute-in-workspace path for a project-relative path. */
  resolve(relativePath: string): string;
  exists(relativePath: string): Promise<boolean>;
  read(relativePath: string): Promise<FileReadValue>;
  write(relativePath: string, content: string | Uint8Array): Promise<void>;
  makeDir(relativePath: string): Promise<void>;
  /** First name that exists, or '' when none do. */
  findFirst(candidates: string[]): Promise<string>;
  hasPackageJson(): Promise<boolean>;
  hasNodeModules(): Promise<boolean>;
  /** Write a file, creating its parent directory first. */
  writeFile(relativePath: string, content: string): Promise<void>;
  /** Whether the project directory itself exists. */
  projectExists(): Promise<boolean>;
};

/** An empty relative path addresses the project directory itself. */
function join(projectDir: string, relativePath: string) {
  return relativePath ? `${projectDir}/${relativePath}` : projectDir;
}

export function createProjectFiles(
  workspace: WorkspacePort,
  projectDir: string,
): ProjectFiles {
  const resolve = (relativePath: string) => join(projectDir, relativePath);

  const exists = (relativePath: string) => workspace.files.exists(resolve(relativePath));

  return {
    resolve,
    exists,
    read: (relativePath) => workspace.files.read(resolve(relativePath)),
    async write(relativePath, content) {
      await workspace.files.write(resolve(relativePath), content);
    },
    async makeDir(relativePath) {
      await workspace.files.makeDir(resolve(relativePath));
    },
    async findFirst(candidates) {
      for (const candidate of candidates) {
        if (await exists(candidate)) return candidate;
      }
      return '';
    },
    hasPackageJson: () => exists('package.json'),
    hasNodeModules: () => exists('node_modules'),
    async writeFile(relativePath, content) {
      const parent = relativePath.split('/').slice(0, -1).join('/');
      if (parent) {
        await workspace.files.makeDir(resolve(parent));
      }
      await workspace.files.write(resolve(relativePath), content);
    },
    projectExists: () => exists(''),
  };
}

/**
 * Install dependencies when the project needs them.
 *
 * Returns false when there is nothing to install or node_modules is already
 * present, so a restored workspace does not pay for a redundant install.
 */
export async function installProjectDependencies(
  workspace: WorkspacePort,
  projectDir: string,
  options: { timeout?: number } = {},
): Promise<boolean> {
  const files = createProjectFiles(workspace, projectDir);
  if (!(await files.hasPackageJson())) return false;
  if (await files.hasNodeModules()) return false;

  await runCommand(workspace, 'npm install --no-audit --no-fund', {
    cwd: projectDir,
    timeout: options.timeout ?? 300,
  });
  return true;
}
