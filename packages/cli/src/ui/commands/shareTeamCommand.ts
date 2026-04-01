/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import { MessageType } from '../types.js';
import { CommandKind, type SlashCommand } from './types.js';
import {
  ContextShareService,
  resolveUserIdentity,
  normalizeRecipient,
  stripEnvironmentContext,
  type Content,
} from '@google/gemini-cli-core';

/** Minimum history turns (beyond the initial system setup) to allow sharing. */
const MIN_HISTORY_LENGTH = 2;

/**
 * `/share @alice @bob` — compresses the current chat and shares it with one or
 * more teammates. Uses GCS when enterprise sharing is configured, otherwise
 * falls back to the Gemini Files API.
 *
 * Usage:
 *   /share @alice
 *   /share @alice @bob @carol
 *   /share alice                      (@ is optional on the first recipient)
 *   /share @alice @bob auth bug fix   (optional label applies to all recipients)
 *   /share @alice @bob --label auth bug fix
 */
export const shareTeamCommand: SlashCommand = {
  name: 'share',
  description:
    'Share the current conversation context with one or more teammates. Usage: /share @<teammate> [label]',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  takesArgs: true,

  completion: (context, partialArg) => {
    const shareSettings =
      context.services.agentContext?.config.getShareSettings();
    const teammates = shareSettings?.teammates ?? [];
    // Complete on the last whitespace-separated token so multi-recipient
    // completion works: "/share @alice @b<tab>" completes "@bob".
    const tokens = partialArg.split(/\s+/);
    const lastToken = tokens[tokens.length - 1] ?? '';
    const partial = lastToken.startsWith('@') ? lastToken.slice(1) : lastToken;
    // Only offer completions when the last token looks like a recipient.
    if (!lastToken.startsWith('@') && tokens.length > 1) return [];
    return teammates
      .filter((t) => t.toLowerCase().startsWith(partial.toLowerCase()))
      .map((t) => `@${t}`);
  },

  action: async (context, args) => {
    const { ui } = context;
    const agentCtx = context.services.agentContext;

    // --- Parse recipients and optional label ---
    const tokens = args.trim().split(/\s+/);
    if (!tokens[0]) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Usage: /share @<teammate> [@<teammate2> …] [label]  (e.g. /share @alice @bob auth bug)',
        },
        Date.now(),
      );
      return;
    }

    const recipients: string[] = [];
    let labelStartIdx = tokens.length;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (i === 0) {
        recipients.push(tok.replace(/^@/, ''));
      } else if (tok.startsWith('@')) {
        recipients.push(tok.slice(1));
      } else {
        labelStartIdx = i;
        break;
      }
    }

    const labelTokens = tokens.slice(labelStartIdx);
    const label =
      (labelTokens[0] === '--label' ? labelTokens.slice(1) : labelTokens)
        .join(' ')
        .trim() || undefined;

    // --- Validate we have a chat session ---
    if (!agentCtx) {
      ui.addItem(
        { type: MessageType.ERROR, text: 'No active agent context.' },
        Date.now(),
      );
      return;
    }
    const geminiClient = agentCtx.geminiClient;
    const chat = geminiClient?.getChat();
    if (!chat || !geminiClient) {
      ui.addItem(
        { type: MessageType.ERROR, text: 'No active chat session to share.' },
        Date.now(),
      );
      return;
    }

    // --- Validate history has meaningful content ---
    const history = chat.getHistory();
    if (history.length <= MIN_HISTORY_LENGTH) {
      ui.addItem(
        {
          type: MessageType.INFO,
          text: 'Nothing to share yet — start a conversation first.',
        },
        Date.now(),
      );
      return;
    }

    // --- Validate auth supports context sharing ---
    const contentGeneratorConfig = agentCtx.config.getContentGeneratorConfig();
    if (!contentGeneratorConfig) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Could not retrieve API configuration.',
        },
        Date.now(),
      );
      return;
    }

    // --- Resolve sender name ---
    const shareSettings = agentCtx.config.getShareSettings();
    const fromName = resolveUserIdentity(shareSettings, os.userInfo().username);

    const normalizedRecipients = recipients.map((r) =>
      normalizeRecipient(r, fromName),
    );
    const recipientList = normalizedRecipients.map((r) => `@${r}`).join(', ');
    ui.addItem(
      {
        type: MessageType.INFO,
        text: `Compressing and sharing context with ${recipientList}…`,
      },
      Date.now(),
    );

    try {
      // --- Compress once to reduce token cost, then fan out ---
      const promptId = `share-compress-${Date.now()}`;
      await geminiClient.tryCompressChat(promptId, true);
      const cleanHistory: Content[] = stripEnvironmentContext(
        chat.getHistory(),
      );

      // --- Generate smart summary turn ---
      ui.addItem(
        {
          type: MessageType.INFO,
          text: 'Summarizing conversation for recipient…',
        },
        Date.now(),
      );
      const summary = await geminiClient.summarizeChat();
      const summaryTurn: Content = {
        role: 'user',
        parts: [
          {
            text: `### CONVERSATION SUMMARY\n\n${summary}\n\n---\n*The conversation history below was shared with you.*`,
          },
        ],
      };

      // Use summary as label if not provided
      const finalLabel =
        label || (summary.length > 50 ? summary.slice(0, 47) + '...' : summary);

      // --- Resolve enterprise GCS bucket (if configured) ---
      const bucket = shareSettings.bucket;

      const shareService = new ContextShareService({
        config: contentGeneratorConfig,
        bucket,
      });
      const model = agentCtx.config.getModel() ?? 'gemini-2.0-flash';

      // Upload in parallel — one file per recipient
      const results = await Promise.allSettled(
        normalizedRecipients.map((recipient) =>
          shareService.share({
            to: recipient,
            from: fromName,
            model,
            history: [summaryTurn, ...cleanHistory],
            label: finalLabel,
          }),
        ),
      );

      const succeeded: string[] = [];
      const failed: Array<{ recipient: string; reason: string }> = [];
      results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
          succeeded.push(`@${recipients[i]}`);
        } else {
          failed.push({
            recipient: `@${recipients[i]}`,
            reason:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
        }
      });

      const labelNote = finalLabel ? ` with label: "${finalLabel}"` : '';
      if (succeeded.length > 0) {
        const providerName = shareService.getProviderName();
        ui.addItem(
          {
            type: MessageType.INFO,
            text: [
              `✓ Context shared with ${succeeded.join(', ')}${labelNote} via ${providerName}.`,
              `They can load it by running: /inbox`,
            ].join('\n'),
          },
          Date.now(),
        );
      }
      for (const { recipient, reason } of failed) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to share context with ${recipient}: ${reason}`,
          },
          Date.now(),
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Failed to share context: ${message}`,
        },
        Date.now(),
      );
    }
  },
};
