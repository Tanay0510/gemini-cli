/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import { MessageType } from '../types.js';
import {
  CommandKind,
  type SlashCommand,
  type CommandContext,
} from './types.js';
import {
  ContextShareService,
  resolveUserIdentity,
  normalizeRecipient,
  stripEnvironmentContext,
  type Content,
} from '@google/gemini-cli-core';

/** Minimum history turns (beyond the initial system setup) to allow sharing. */
const MIN_HISTORY_LENGTH = 2;

/** A `to` value containing "@" was set by Google OAuth — treat it as verified. */
function isVerified(to: string): boolean {
  return to.includes('@');
}

/** Check if a recipient email domain is in the allowed list. */
function isDomainAllowed(email: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;

  return allowedDomains.some((pattern) => {
    const p = pattern.toLowerCase();
    if (p.startsWith('*.')) {
      return domain.endsWith(p.slice(2));
    }
    return domain === p;
  });
}

/** Creates a ContextShareService from the current command context. */
function createShareService(
  context: CommandContext,
): ContextShareService | null {
  const agentCtx = context.services.agentContext;
  const contentGeneratorConfig = agentCtx?.config.getContentGeneratorConfig();
  if (!contentGeneratorConfig) return null;

  const mergedSettings = context.services.settings.merged;
  const bucket =
    mergedSettings.admin?.share?.bucket ??
    agentCtx?.config.getShareSettings().bucket;

  return new ContextShareService({ config: contentGeneratorConfig, bucket });
}

/**
 * `/share @alice @bob` — compresses the current chat and shares it with one or
 * more teammates. Uses GCS when enterprise sharing is configured, otherwise
 * falls back to the Gemini Files API.
 */
export const shareTeamCommand: SlashCommand = {
  name: 'share',
  description:
    'Share context with teammates. Usage: /share @<teammate> [label]',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  takesArgs: true,

  completion: async (context, partialArg) => {
    const shareSettings =
      context.services.agentContext?.config.getShareSettings() ??
      context.services.settings.merged.share;

    const localTeammates = shareSettings?.teammates ?? [];

    // Background fetch org directory if possible
    const shareService = createShareService(context);
    const orgTeammates = shareService
      ? await shareService.getOrgDirectory()
      : [];

    const allTeammates = Array.from(
      new Set([...localTeammates, ...orgTeammates]),
    );

    const tokens = partialArg.split(/\s+/);
    const lastToken = tokens[tokens.length - 1] ?? '';

    // Handle flag completions
    if (lastToken.startsWith('--')) {
      const flags = ['--sync', '--list'];
      return flags.filter((f) => f.startsWith(lastToken));
    }

    const partial = lastToken.startsWith('@') ? lastToken.slice(1) : lastToken;
    // Only offer completions when the last token looks like a recipient.
    if (!lastToken.startsWith('@') && tokens.length > 1) return [];

    return allTeammates
      .filter((t) => t.toLowerCase().startsWith(partial.toLowerCase()))
      .map((t) => `@${t}`);
  },

  action: async (context, args) => {
    const { ui, services } = context;
    const agentCtx = services.agentContext;
    const tokens = args.trim().split(/\s+/);
    const cmd = tokens[0];

    const mergedSettings = services.settings.merged;
    const adminShare = mergedSettings.admin?.share;
    const userShare =
      agentCtx?.config.getShareSettings() ?? mergedSettings.share;

    // Admin-level disable takes precedence
    if (adminShare?.enabled === false) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Team sharing has been disabled by your administrator.',
        },
        Date.now(),
      );
      return;
    }

    if (userShare?.enabled === false) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Team sharing is currently disabled. Enable it in /settings (Team Sharing > Enable Sharing).',
        },
        Date.now(),
      );
      return;
    }

    const shareService = createShareService(context);

    // --- Handle Management Flags ---

    // 1. Directory Sync: /share --sync
    if (cmd === '--sync') {
      if (!shareService) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: 'Context sharing service not available.',
          },
          Date.now(),
        );
        return;
      }
      ui.addItem(
        {
          type: MessageType.INFO,
          text: '⌛ Syncing organizational directory from cloud...',
        },
        Date.now(),
      );
      const orgTeammates = await shareService.syncOrgDirectory();
      ui.addItem(
        {
          type: MessageType.INFO,
          text: `✓ Success! Synced ${orgTeammates.length} teammates from your organization directory.`,
        },
        Date.now(),
      );
      return;
    }

    // 2. Status Report: /share --list
    if (cmd === '--list') {
      const settings = services.settings.merged.share;
      const localTeammates = settings?.teammates ?? [];
      const domains = settings?.allowedDomains ?? [];
      const verify = settings?.requireVerification
        ? 'REQUIRED 🔒'
        : 'OPTIONAL 🔓';

      const orgTeammates = shareService
        ? await shareService.getOrgDirectory()
        : [];

      const lines = [
        'Team Sharing Configuration:',
        `  Verification:    ${verify}`,
        `  Allowed Domains: ${domains.length > 0 ? domains.join(', ') : 'ANY (unrestricted)'}`,
        '',
        `Organization Directory: (${orgTeammates.length} users cached)`,
        'Frequent Teammates (Local):',
        ...(localTeammates.length > 0
          ? localTeammates.map((t) => `  • @${t}`)
          : [
              '  (No local teammates added yet. Manage teammates in /settings)',
            ]),
      ];

      ui.addItem(
        { type: MessageType.INFO, text: lines.join('\n') },
        Date.now(),
      );
      return;
    }

    // --- Standard Share Action ---
    if (!tokens[0] || tokens[0].startsWith('--')) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Usage: /share @<teammate> [label]\nConfigure sharing policies and teammates in /settings (Team Sharing).',
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

    const fromName = resolveUserIdentity(
      userShare ?? {},
      os.userInfo().username,
    );

    // --- Validate Settings (Domains & Verification) ---
    const allowedDomains = userShare?.allowedDomains ?? [];
    const requireVerification = userShare?.requireVerification ?? false;

    const normalizedRecipients = recipients.map((r) =>
      normalizeRecipient(r, fromName),
    );

    const validRecipients: string[] = [];
    for (const recipient of normalizedRecipients) {
      if (requireVerification && !isVerified(recipient)) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Rejected: @${recipient} is not a verified identity. Identity verification is currently REQUIRED.`,
          },
          Date.now(),
        );
        continue;
      }

      if (
        isVerified(recipient) &&
        !isDomainAllowed(recipient, allowedDomains)
      ) {
        ui.addItem(
          {
            type: MessageType.ERROR,
            text: `Rejected: Domain of @${recipient} is not in the allowed list: [${allowedDomains.join(', ')}].`,
          },
          Date.now(),
        );
        continue;
      }
      validRecipients.push(recipient);
    }

    if (validRecipients.length === 0) return;

    const recipientList = validRecipients.map((r) => `@${r}`).join(', ');
    ui.addItem(
      {
        type: MessageType.INFO,
        text: `Compressing and sharing context with ${recipientList}…`,
      },
      Date.now(),
    );

    try {
      const promptId = `share-compress-${Date.now()}`;
      await geminiClient.tryCompressChat(promptId, true);
      const cleanHistory: Content[] = stripEnvironmentContext(
        chat.getHistory(),
      );

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

      const finalLabel =
        label || (summary.length > 50 ? summary.slice(0, 47) + '...' : summary);

      if (!shareService) throw new Error('Share service not available.');
      const model = agentCtx.config.getModel() ?? 'gemini-2.0-flash';

      const results = await Promise.allSettled(
        validRecipients.map((recipient) =>
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
          succeeded.push(`@${validRecipients[i]}`);
        } else {
          failed.push({
            recipient: `@${validRecipients[i]}`,
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
