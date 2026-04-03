/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import { MessageType } from '../types.js';
import { CommandKind, type SlashCommand } from './types.js';
import {
  KnowledgeService,
  GcsProvider,
  UserAccountManager,
  resolveUserIdentity,
  normalizeRecipient,
  getDefaultSharedBucket,
  debugLogger,
} from '@google/gemini-cli-core';

/**
 * `/ask @teammate <query>` — searches teammate's agent for solutions.
 */
export const askCommand: SlashCommand = {
  name: 'ask',
  description:
    "Ask a teammate's agent for a solution. Usage: /ask @<teammate> <query>",
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  takesArgs: true,

  completion: async (context, partialArg) => {
    try {
      const shareSettings =
        context.services.agentContext?.config.getShareSettings() ??
        context.services.settings.merged.share;

      const localTeammates = shareSettings?.teammates ?? [];
      const cachedOrgTeammates = shareSettings?.orgDirectoryCache ?? [];

      const allTeammates = Array.from(
        new Set([...localTeammates, ...cachedOrgTeammates]),
      );

      const tokens = partialArg.split(/\s+/);
      const lastToken = tokens[tokens.length - 1] ?? '';

      // Handle flag completions
      if (lastToken.startsWith('--')) {
        const flags = ['--list-requests', '--fulfill'];
        return flags.filter((f) => f.startsWith(lastToken));
      }

      // If they haven't typed @ yet, don't offer teammate suggestions
      if (!lastToken.startsWith('@')) {
        return [];
      }

      const partial = lastToken.slice(1).toLowerCase();

      return allTeammates
        .filter((t) => t.toLowerCase().startsWith(partial))
        .map((t) => `@${t}`);
    } catch (err) {
      debugLogger.warn('Ask completion error:', err);
      return [];
    }
  },

  action: async (context, args) => {
    const { ui, services } = context;
    const tokens = args.trim().split(/\s+/);
    const firstToken = tokens[0];

    const agentCtx = services.agentContext;
    if (!agentCtx) return;

    const mergedSettings = services.settings.merged;
    const myEmail = new UserAccountManager().getCachedGoogleAccount();

    const adminBucket = mergedSettings.admin?.share?.bucket;
    const userBucket = agentCtx.config.getShareSettings().bucket;
    const discoveredBucket = myEmail
      ? getDefaultSharedBucket(myEmail)
      : undefined;

    const bucket = adminBucket || userBucket || discoveredBucket;

    if (!bucket) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Team sharing bucket could not be resolved. Please configure it in /settings.',
        },
        Date.now(),
      );
      return;
    }

    if (!myEmail) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'You must be logged in to use /ask.',
        },
        Date.now(),
      );
      return;
    }

    const knowledgeService = new KnowledgeService(
      new GcsProvider(bucket),
      agentCtx.config.getBaseLlmClient(),
    );

    // --- Handle Management Flags ---
    if (firstToken === '--list-requests') {
      try {
        const requests = await knowledgeService.listPendingRequests(myEmail);
        if (requests.length === 0) {
          ui.addItem(
            { type: MessageType.GEMINI, text: 'No pending teammate requests.' },
            Date.now(),
          );
          return;
        }

        const lines = [
          'Pending Teammate Requests:',
          '',
          ...requests.map(
            (r, i) => `  ${i + 1}. From @${r.fromEmail}: "${r.query}"`,
          ),
          '',
          'To fulfill a request, run /ask --fulfill <number>',
        ];
        ui.addItem(
          { type: MessageType.GEMINI, text: lines.join('\n') },
          Date.now(),
        );
      } catch (err) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to list requests: ${String(err)}`,
          },
          Date.now(),
        );
      }
      return;
    }

    if (firstToken === '--fulfill') {
      const selection = tokens[1];
      if (!selection) {
        ui.addItem(
          { type: MessageType.ERROR, text: 'Usage: /ask --fulfill <number>' },
          Date.now(),
        );
        return;
      }

      try {
        const requests = await knowledgeService.listPendingRequests(myEmail);
        const index = parseInt(selection, 10) - 1;
        const targetRequest = requests[index];

        if (!targetRequest) {
          ui.addItem(
            {
              type: MessageType.ERROR,
              text: `Invalid request number: ${selection}. Run /ask --list-requests to see valid numbers.`,
            },
            Date.now(),
          );
          return;
        }

        ui.addItem(
          {
            type: MessageType.GEMINI,
            text: `Searching local history to fulfill request from @${targetRequest.fromEmail}: "${targetRequest.query}"...`,
          },
          Date.now(),
        );

        // Matching logic would go here (using targetRequest.id)
        ui.addItem(
          {
            type: MessageType.GEMINI,
            text: 'Fulfillment workflow initiated. (Matching local history...)',
          },
          Date.now(),
        );
      } catch (err) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to initiate fulfillment: ${String(err)}`,
          },
          Date.now(),
        );
      }
      return;
    }

    // --- Standard Ask Action ---
    const recipient = tokens[0];
    let query = tokens.slice(1).join(' ').trim();

    // Strip surrounding quotes if they exist
    if (
      (query.startsWith('"') && query.endsWith('"')) ||
      (query.startsWith("'") && query.endsWith("'"))
    ) {
      query = query.slice(1, -1).trim();
    }

    if (!recipient?.startsWith('@') || !query) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Usage: /ask @<teammate> <query>\nExample: /ask @alice "how to fix redis error"\nFlags: --list-requests, --fulfill <id>',
        },
        Date.now(),
      );
      return;
    }

    const fromName = resolveUserIdentity(
      mergedSettings.share ?? {},
      os.userInfo().username,
    );
    const targetEmail = normalizeRecipient(recipient, fromName);

    ui.addItem(
      {
        type: MessageType.GEMINI,
        text: `Querying @${targetEmail}'s agent for: "${query}"...`,
      },
      Date.now(),
    );

    try {
      // Step 1: Check published knowledge snippets
      const snippets = await knowledgeService.findSolutions(query, targetEmail);

      if (snippets.length > 0) {
        const lines = [
          `Found ${snippets.length} relevant solution(s) from @${targetEmail}:`,
          '',
          ...snippets.map((s) => `  * ${s.summary}`),
          '',
          'Would you like me to try applying these findings to our current task?',
        ];
        ui.addItem(
          { type: MessageType.GEMINI, text: lines.join('\n') },
          Date.now(),
        );
        return;
      }

      // Step 2: No public solution, send a private request
      ui.addItem(
        {
          type: MessageType.GEMINI,
          text: [
            `No public solution found in @${targetEmail}'s knowledge base.`,
            `Sending a private request to their agent...`,
          ].join('\n'),
        },
        Date.now(),
      );

      await knowledgeService.sendRequest({
        fromEmail: myEmail,
        toEmail: targetEmail,
        query,
      });

      ui.addItem(
        {
          type: MessageType.GEMINI,
          text: `Request sent! @${targetEmail}'s agent will notify them next time they use the CLI.`,
        },
        Date.now(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Failed to query teammate: ${message}`,
        },
        Date.now(),
      );
    }
  },
};
