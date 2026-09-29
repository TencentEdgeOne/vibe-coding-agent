import { readFile } from 'node:fs/promises';
import path from 'node:path';
export type MakersValidationRule = {
  skill: string;
  pathPatterns: string[];
  pattern: string;
  message: string;
};

/**
 * Where a framework's platform adapter goes and whether this project needs one.
 *
 * `serverOutput` is deliberately separate from `adapter`: the file that decides
 * whether the app renders on a server is often not the file the adapter is
 * wired into. React Router declares `ssr` in react-router.config.ts and takes
 * its adapter as a vite.config.ts plugin, so one field cannot serve both.
 */
export type MakersFrameworkProfile = {
  id: string;
  label: string;
  detect: string[];
  adapter: {
    package: string;
    /**
     * The range to declare when this agent adds the adapter itself. Optional
     * because it is the platform's to state, not this repo's: absent, the
     * declaration falls back to `latest`, which resolves but pins nothing.
     */
    version?: string;
    configFiles: string[];
    /**
     * A config file that, in a shape only it can be in, silences the others.
     *
     * SvelteKit is why this exists. It reads exactly one config and prefers the
     * Vite one, so a single option passed to `sveltekit()` discards the whole of
     * a sibling `svelte.config.js` — adapter included, with no warning from the
     * build. Checking the first config file that happens to exist calls that
     * project correct; checking `vite.config.ts` unconditionally calls a project
     * that legitimately keeps its config in `svelte.config.js` broken.
     */
    configOverride?: {
      files: string[];
      pattern: string;
      /** Appended to the error, because "wire it in here" is baffling on its own. */
      reason: string;
    };
    required: 'always' | 'server-output';
  } | null;
  serverOutput?: {
    files: string[];
    default: 'server' | 'static';
    serverPattern?: string;
    staticPattern?: string;
  };
  outputDirectory: string;
  unsupported: string[];
};

const FRAMEWORK_PROFILE_SKILL = 'makers-frameworks';

// The profiles live in a fenced block inside the vendored skill rather than in
// its frontmatter: they are nested objects, and the frontmatter reader here is a
// line-oriented approximation of YAML that cannot represent them.
const FRAMEWORK_PROFILE_BLOCK =
  /<!--\s*makers-framework-profiles:start\s*-->\s*```json\s*\r?\n([\s\S]*?)\r?\n```/;

export function parseMakersFrameworkProfiles(source: string): MakersFrameworkProfile[] {
  const block = source.match(FRAMEWORK_PROFILE_BLOCK)?.[1];
  if (!block) return [];
  const parsed = JSON.parse(block) as MakersFrameworkProfile[];
  if (!Array.isArray(parsed)) {
    throw new Error('makers-framework-profiles must be a JSON array');
  }
  for (const profile of parsed) {
    if (!profile.id || !Array.isArray(profile.detect) || profile.detect.length === 0) {
      throw new Error(`framework profile ${profile.id || '(unnamed)'} needs an id and a detect list`);
    }
    // Compile every pattern at load time so a malformed vendored profile fails
    // here, where the message names the profile, rather than inside the sandbox
    // script as a syntax error with no attribution.
    for (const pattern of [
      profile.serverOutput?.serverPattern,
      profile.serverOutput?.staticPattern,
      profile.adapter?.configOverride?.pattern,
    ]) {
      if (pattern) new RegExp(pattern);
    }
  }
  return parsed;
}

const VALIDATION_SKILLS = [
  'makers-agents',
  'makers-cloud-functions',
  'makers-deploy',
  'makers-edge-functions',
  'makers-env-adaption',
  'makers-frameworks',
  'makers-middleware',
  'makers-storage',
] as const;

export const SUPPORTED_MAKERS_AGENT_FRAMEWORKS = [
  'claude-agent-sdk',
  'openai-agents-sdk',
  'langgraph',
  'crewai',
  'deepagents',
] as const;

function parseFrontmatterScalar(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // A double-quoted YAML scalar is close enough to JSON to reuse the parser,
    // but not close enough to trust it: one stray backslash in a vendored skill
    // would otherwise take down every compatibility check with a SyntaxError.
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseMakersSkillValidationRules(
  skill: string,
  source: string,
): MakersValidationRule[] {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return [];

  const pathPatterns: string[] = [];
  const rules: Array<{ pattern: string; message: string }> = [];
  let section: 'paths' | 'validate' | null = null;
  let pendingPattern = '';

  for (const line of frontmatter.split(/\r?\n/)) {
    if (line === 'pathPatterns:') {
      section = 'paths';
      continue;
    }
    if (line === 'validate:') {
      section = 'validate';
      continue;
    }
    if (/^\S/.test(line)) {
      section = null;
      continue;
    }
    if (section === 'paths') {
      const match = line.match(/^\s{2}-\s+(.+)$/);
      if (match?.[1]) pathPatterns.push(parseFrontmatterScalar(match[1]));
      continue;
    }
    if (section === 'validate') {
      const patternMatch = line.match(/^\s{2}-\s+pattern:\s+(.+)$/);
      if (patternMatch?.[1]) {
        pendingPattern = parseFrontmatterScalar(patternMatch[1]);
        continue;
      }
      const messageMatch = line.match(/^\s{4}message:\s+(.+)$/);
      if (messageMatch?.[1] && pendingPattern) {
        rules.push({
          pattern: pendingPattern,
          message: parseFrontmatterScalar(messageMatch[1]),
        });
        pendingPattern = '';
      }
    }
  }

  return rules.map((rule) => ({
    skill,
    pathPatterns: [...pathPatterns],
    ...rule,
  }));
}

function readVendoredSkill(skill: string) {
  return readFile(
    path.join(
      process.cwd(),
      '.claude',
      'skills',
      'edgeone-makers-tools',
      'references',
      skill,
      'SKILL.md',
    ),
    'utf8',
  );
}

let frameworkProfilesPromise: Promise<readonly MakersFrameworkProfile[]> | undefined;

export function loadMakersFrameworkProfiles(): Promise<readonly MakersFrameworkProfile[]> {
  if (!frameworkProfilesPromise) {
    const pending = readVendoredSkill(FRAMEWORK_PROFILE_SKILL).then((source) => {
      const profiles = parseMakersFrameworkProfiles(source);
      if (profiles.length === 0) {
        throw new Error(
          `${FRAMEWORK_PROFILE_SKILL} carries no framework profiles; the adapter check cannot run without them`,
        );
      }
      return profiles;
    });
    frameworkProfilesPromise = pending.catch((error) => {
      frameworkProfilesPromise = undefined;
      throw error;
    });
  }
  return frameworkProfilesPromise;
}

let validationRulesPromise: Promise<readonly MakersValidationRule[]> | undefined;

export function loadMakersValidationRules(): Promise<readonly MakersValidationRule[]> {
  if (!validationRulesPromise) {
    const pending = Promise.all(VALIDATION_SKILLS.map(async (skill) => {
      const source = await readVendoredSkill(skill);
      return parseMakersSkillValidationRules(skill, source);
    })).then((groups) => {
      const rules = groups.flat();
      for (const rule of rules) {
        // Fail at the source if an official vendored rule is malformed instead
        // of silently dropping a compatibility check.
        new RegExp(rule.pattern);
      }
      return rules;
    });
    // Cache the success, not the attempt. Holding a rejected promise here would
    // turn one unlucky read into a permanently broken compatibility check for
    // every later turn on this warm instance.
    validationRulesPromise = pending.catch((error) => {
      validationRulesPromise = undefined;
      throw error;
    });
  }
  return validationRulesPromise;
}
