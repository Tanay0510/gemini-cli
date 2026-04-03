/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { Type } from '@google/genai';
import type { LocalAgentDefinition } from './types.js';
import { TEAM_INTELLIGENCE_TOOL_NAME } from '../tools/tool-names.js';
import { TASK_COMPLETE_TOOL_NAME } from '../agents/local-executor.js';
import type { Config } from '../config/config.js';

const outputSchema = z.object({
  found: z.boolean(),
  summary: z
    .string()
    .describe('Summary of what was found or the status of the request.'),
});

/**
 * Team Intelligence Agent — query the collective knowledge of your team.
 */
export const TeamIntelligenceAgent = (
  config: Config,
): LocalAgentDefinition<typeof outputSchema> => ({
  kind: 'local',
  name: TEAM_INTELLIGENCE_TOOL_NAME,
  displayName: 'Team Intelligence',
  description:
    'Query the collective knowledge of your team. Searches through solved problems, ' +
    'reproduced bugs, and setup fixes indexed by your teammates agents.',

  inputConfig: {
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The question or problem to search for in team knowledge.',
        },
        teammate: {
          type: 'string',
          description: 'Optional teammate email to target specifically.',
        },
      },
      required: ['query'],
    },
  },

  outputConfig: {
    outputName: 'result',
    description: 'The found solution or request status',
    schema: outputSchema,
  },

  modelConfig: {
    model: 'inherit',
    generateContentConfig: {
      temperature: 0,
    },
  },

  promptConfig: {
    systemPrompt: `You are the Team Intelligence Agent for Gemini CLI.
Your goal is to help the user find solutions that their teammates have already discovered.

You have access to:
1. Published Knowledge: One-sentence summaries of tasks successfully completed by teammates.
2. Passive Pings: The ability to send a private request to a teammate's agent if no public solution is found.

When a user asks a question:
- If a teammate is specified, search their knowledge first.
- If no teammate is specified, you should search the general team directory (conceptually).
- If you find a match, summarize it and ask if they want to apply it.
- If no match is found, offer to send a private request to the relevant teammate(s).

Be professional, concise, and focus on connecting the user with existing team knowledge.`,
    query: 'Search for: ${query}' + (config ? '' : ''), // dummy use of config to avoid unused warning if needed
  },

  runConfig: {
    maxTurns: 5,
  },

  toolConfig: {
    tools: [
      {
        name: 'ask_teammate',
        description: "Queries a specific teammate's agent or sends a request.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            teammateEmail: { type: Type.STRING },
            query: { type: Type.STRING },
          },
          required: ['teammateEmail', 'query'],
        },
      },
      TASK_COMPLETE_TOOL_NAME,
    ],
  },
});
