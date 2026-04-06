/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
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
  GitService,
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

        ui.setLoading(true);
        ui.setPendingItem({
          type: MessageType.GEMINI,
          text: `Searching local history to fulfill request from @${targetRequest.fromEmail}: "${targetRequest.query}"...`,
        });

        // 1. Identify the project to search
        const projectHash =
          targetRequest.projectOriginHash ??
          (await new GitService(
            agentCtx.config.getProjectRoot(),
            agentCtx.config.storage,
          ).getOriginHash());

        if (!projectHash) {
          throw new Error(
            'Could not determine project identity for fulfillment.',
          );
        }

        const chatsDir = path.join(
          agentCtx.config.storage.getProjectTempDir(),
          'chats',
        );

        // 2. Find the best matching local session
        const match = await knowledgeService.findBestSession(
          chatsDir,
          targetRequest.query,
        );

        if (!match) {
          ui.setPendingItem(null);
          ui.addItem(
            {
              type: MessageType.GEMINI,
              text: `I searched your local history for "${targetRequest.query}" but couldn't find a strong match to share.`,
            },
            Date.now(),
          );
          return;
        }

        // 3. Extract the recipe from the matched session
        const matchedHistory = await knowledgeService.loadSessionHistory(
          path.join(chatsDir, match.fileName),
        );

        // We'll re-use the publishSolution logic to extract the recipe but not upload yet
        const tempSnippet = await knowledgeService.publishSolution({
          userEmail: myEmail,
          history: matchedHistory,
          model: agentCtx.config.getModel(),
          projectOriginHash: projectHash,
        });

        if (!tempSnippet) {
          throw new Error(
            'Failed to generate a summary for the matched session.',
          );
        }

        ui.setPendingItem(null);
        const lines = [
          `I found a matching solution in your session: "${match.summary}"`,
          '',
          'Proposed Recipe to share:',
          `  * Summary: ${tempSnippet.summary}`,
        ];

        if (
          tempSnippet.provenCommands &&
          tempSnippet.provenCommands.length > 0
        ) {
          lines.push('  * Proven Commands:');
          tempSnippet.provenCommands.forEach((c) => lines.push(`    $ ${c}`));
        }

        lines.push(
          '',
          `Should I share this recipe with @${targetRequest.fromEmail}? (y/n)`,
        );

        ui.addItem(
          { type: MessageType.GEMINI, text: lines.join('\n') },
          Date.now(),
        );
      } catch (err) {
        ui.setPendingItem(null);
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to fulfill request: ${String(err)}`,
          },
          Date.now(),
        );
      } finally {
        ui.setLoading(false);
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

    ui.setLoading(true);
    ui.setPendingItem({
      type: MessageType.GEMINI,
      text: `Searching @${targetEmail}'s knowledge base for: "${query}"...`,
    });

    try {
      // Step 1: Check published knowledge snippets
      const snippets = await knowledgeService.findSolutions(query, targetEmail);

      if (snippets.length > 0) {
        const lines = [
          `Found ${snippets.length} relevant solution(s) from @${targetEmail}'s knowledge base:`,
          '',
        ];

        for (const s of snippets) {
          lines.push(`  * ${s.summary}`);

          // --- Translation Layer: Environment Check ---
          if (s.environment) {
            const myOs = os.platform();
            const myNode = process.version;
            const warnings: string[] = [];

            if (s.environment.os !== myOs) {
              warnings.push(
                `OS mismatch (Alice: ${s.environment.os}, You: ${myOs})`,
              );
            }
            if (
              s.environment.nodeVersion &&
              s.environment.nodeVersion !== myNode
            ) {
              warnings.push(
                `Node mismatch (Alice: ${s.environment.nodeVersion}, You: ${myNode})`,
              );
            }

            if (warnings.length > 0) {
              lines.push('    [Environment Note]:');
              warnings.forEach((w) => lines.push(`      ! ${w}`));
              lines.push(
                '      I will adapt the instructions for your machine.',
              );
            }
          }

          if (s.logicTrace && s.logicTrace.length > 0) {
            lines.push('    Reasoning:');
            s.logicTrace.forEach((t) => lines.push(`      - ${t}`));
          }
          if (s.provenCommands && s.provenCommands.length > 0) {
            lines.push('    Proven Commands:');
            s.provenCommands.forEach((c) => lines.push(`      $ ${c}`));
          }
          if (s.codeChanges && s.codeChanges.length > 0) {
            lines.push('    Files Modified:');
            s.codeChanges.forEach((c) => lines.push(`      + ${c.path}`));
          }
          lines.push('');
        }

        lines.push(
          'Would you like me to try applying these findings to our current task? (y/n)',
        );

        ui.setPendingItem(null);
        ui.addItem(
          { type: MessageType.GEMINI, text: lines.join('\n') },
          Date.now(),
        );

        // Inject the findings into the model's history with environment context
        const geminiClient = agentCtx.config.getGeminiClient();
        if (geminiClient) {
          const findingsContext = [
            `I found the following relevant solution(s) in @${targetEmail}'s knowledge base:`,
            ...snippets.map((s) => {
              let snippetText = `- ${s.summary}`;
              if (s.environment) {
                snippetText += ` (Proven on: ${s.environment.os}, Node ${s.environment.nodeVersion})`;
              }
              return snippetText;
            }),
            '',
            'IMPORTANT: If there are environment mismatches, please translate the commands and logic to be compatible with my current system.',
            'The user has been notified and might ask to apply them.',
          ].join('\n');

          await geminiClient.addHistory({
            role: 'user',
            parts: [{ text: findingsContext }],
          });
          await geminiClient.addHistory({
            role: 'model',
            parts: [{ text: lines.join('\n') }],
          });
        }
        return;
      }

      // Step 2: No public solution, send a private request
      ui.setPendingItem({
        type: MessageType.GEMINI,
        text: [
          `No public solution found in @${targetEmail}'s knowledge base.`,
          `Sending a private request to their agent...`,
        ].join('\n'),
      });

      const gitService = new GitService(
        agentCtx.config.getProjectRoot(),
        agentCtx.config.storage,
      );
      const projectOriginHash = (await gitService.getOriginHash()) ?? undefined;

      await knowledgeService.sendRequest({
        fromEmail: myEmail,
        toEmail: targetEmail,
        query,
        projectOriginHash,
      });

      ui.setPendingItem(null);
      ui.addItem(
        {
          type: MessageType.GEMINI,
          text: `Request sent! @${targetEmail}'s agent will notify them next time they use the CLI.`,
        },
        Date.now(),
      );
    } catch (err) {
      ui.setPendingItem(null);
      const message = err instanceof Error ? err.message : String(err);
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Failed to query teammate: ${message}`,
        },
        Date.now(),
      );
    } finally {
      ui.setLoading(false);
    }
  },
};
