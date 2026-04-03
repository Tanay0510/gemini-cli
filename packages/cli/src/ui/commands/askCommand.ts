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

  action: async (context, args) => {
    const { ui, services } = context;
    const tokens = args.trim().split(/\s+/);
    const firstToken = tokens[0];

    const agentCtx = services.agentContext;
    if (!agentCtx) return;

    const mergedSettings = services.settings.merged;
    const bucket =
      mergedSettings.admin?.share?.bucket ??
      agentCtx.config.getShareSettings().bucket;

    if (!bucket) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Team sharing must be configured to use /ask.',
        },
        Date.now(),
      );
      return;
    }

    const myEmail = new UserAccountManager().getCachedGoogleAccount();
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
            {
              type: MessageType.INFO,
              text: '📬 No pending teammate requests.',
            },
            Date.now(),
          );
          return;
        }

        const lines = [
          '📬 Pending Teammate Requests:',
          '',
          ...requests.map(
            (r) => `  • From @${r.fromEmail}: "${r.query}" (ID: ${r.id})`,
          ),
          '',
          'To fulfill a request, run /ask --fulfill <ID>',
        ];
        ui.addItem(
          { type: MessageType.INFO, text: lines.join('\n') },
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
      const requestId = tokens[1];
      if (!requestId) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: 'Usage: /ask --fulfill <request-id>',
          },
          Date.now(),
        );
        return;
      }

      ui.addItem(
        {
          type: MessageType.INFO,
          text: `🔍 Searching local history to fulfill request ${requestId}...`,
        },
        Date.now(),
      );

      // In a real implementation, we would:
      // 1. Download the request object to get the query
      // 2. Search local history for a match
      // 3. Prompt user for consent
      // 4. Publish solution and mark request as fulfilled
      // For the POC, we'll just show the intent.
      ui.addItem(
        {
          type: MessageType.INFO,
          text: 'Fulfillment workflow initiated. (Matching local history...)',
        },
        Date.now(),
      );
      return;
    }

    // --- Standard Ask Action ---
    const recipient = firstToken;
    const query = tokens.slice(1).join(' ');

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
        type: MessageType.INFO,
        text: `🔍 Querying @${targetEmail}'s agent for: "${query}"...`,
      },
      Date.now(),
    );

    try {
      // Step 1: Check published knowledge snippets
      const snippets = await knowledgeService.findSolutions(query, targetEmail);

      if (snippets.length > 0) {
        const lines = [
          `💡 Found ${snippets.length} relevant solution(s) from @${targetEmail}:`,
          '',
          ...snippets.map((s) => `  • ${s.summary}`),
          '',
          'Would you like me to try applying these findings to our current task?',
        ];
        ui.addItem(
          { type: MessageType.INFO, text: lines.join('\n') },
          Date.now(),
        );
        return;
      }

      // Step 2: No public solution, send a private request
      ui.addItem(
        {
          type: MessageType.INFO,
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
          type: MessageType.INFO,
          text: `✓ Request sent! @${targetEmail}'s agent will notify them next time they use the CLI.`,
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
