import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ClaudeMcpTool } from '../_types';

export const MAKERS_REFERENCE_SKILL_NAMES = [
  'makers-agents',
  'makers-deploy',
  'makers-edge-functions',
  'makers-cloud-functions',
  'makers-storage',
  'makers-middleware',
  'makers-cli',
  'makers-recipes',
  'makers-env-adaption',
  'makers-migration',
] as const;

const makersReferenceSkillSchema = z.enum(MAKERS_REFERENCE_SKILL_NAMES);

export function buildLoadMakersSkillTool() {
  return defineClaudeTool(
    'load_makers_skill',
    [
      'Load one specific official EdgeOne Makers reference skill verbatim.',
      'Choose only references required by the user request.',
      'Independent references may be loaded in parallel by issuing multiple tool calls in one assistant message.',
      'Use makers-agents for AI/LLM/SSE endpoints, makers-recipes for project layout, makers-cloud-functions for Node/Go/Python APIs, makers-edge-functions for V8 edge APIs, makers-storage for KV/Blob persistence, makers-middleware for middleware, makers-deploy only for live deployment, makers-cli for CLI commands, makers-env-adaption for restricted environments, and makers-migration for adapting an existing agent project.',
    ].join(' '),
    {
      skill: makersReferenceSkillSchema.describe('The specific Makers reference skill to load.'),
    },
    async (input) => {
      try {
        const skill = makersReferenceSkillSchema.parse(input.skill);
        const skillPath = path.join(
          process.cwd(),
          '.claude',
          'skills',
          'edgeone-makers-tools',
          'references',
          skill,
          'SKILL.md',
        );
        const content = await readFile(skillPath, 'utf8');
        return {
          content: [{ type: 'text' as const, text: content }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Unable to load Makers skill: ${message}` }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}
