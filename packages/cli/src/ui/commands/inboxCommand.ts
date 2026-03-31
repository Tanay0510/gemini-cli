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
} from '@google/gemini-cli-core';
import type { SharedContextEnvelope } from '@google/gemini-cli-core';

/** In-memory inbox cache so `load` and `dismiss` can reference by index. */
let cachedInbox: SharedContextEnvelope[] = [];

function formatAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  return `${Math.floor(diffHrs / 24)}d ago`;
}

/** A `from` value containing "@" was set by Google OAuth — treat it as verified. */
function isVerified(from: string): boolean {
  return from.includes('@');
}

function renderInbox(inbox: SharedContextEnvelope[]): string {
  if (inbox.length === 0) {
    return 'Your inbox is empty. Ask a teammate to run /share @<your-name>.';
  }
  const lines = [
    `  ${'#'.padEnd(3)} ${'From'.padEnd(26)} ${'Age'.padEnd(10)} ${'Verified'.padEnd(12)} ${'Label'.padEnd(20)} Model`,
    `  ${'─'.repeat(85)}`,
  ];
  inbox.forEach((item, i) => {
    const idx = String(i + 1).padEnd(3);
    const from = item.from.padEnd(26);
    const age = formatAge(item.timestamp).padEnd(10);
    const verified = isVerified(item.from)
      ? '✓ Google'.padEnd(12)
      : '⚠ unverified'.padEnd(12);
    const label = (item.label ?? '—').padEnd(20);
    const model = item.model.replace('models/', '');
    lines.push(`  ${idx} ${from} ${age} ${verified} ${label} ${model}`);
  });
  lines.push('');
  lines.push('  /inbox load <#>     — load context into current session');
  lines.push('  /inbox dismiss <#>  — delete without loading');
  return lines.join('\n');
}

/** Creates a ContextShareService from the current command context. */
function createShareService(
  context: CommandContext,
): ContextShareService | null {
  const agentCtx = context.services.agentContext;
  const contentGeneratorConfig = agentCtx?.config.getContentGeneratorConfig();
  if (!contentGeneratorConfig) return null;
  const bucket = agentCtx?.config.getShareSettings().bucket;
  return new ContextShareService({ config: contentGeneratorConfig, bucket });
}

const listSubCommand: SlashCommand = {
  name: 'list',
  description: 'List shared contexts in your inbox',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context) => {
    const { ui } = context;
    const shareService = createShareService(context);
    if (!shareService) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Could not retrieve API configuration.',
        },
        Date.now(),
      );
      return;
    }

    const shareSettings =
      context.services.agentContext?.config.getShareSettings();
    const myName = resolveUserIdentity(
      shareSettings ?? {},
      os.userInfo().username,
    );

    ui.addItem(
      { type: MessageType.INFO, text: `Checking inbox for @${myName}…` },
      Date.now(),
    );

    try {
      cachedInbox = await shareService.listInbox(myName);

      ui.addItem(
        { type: MessageType.INFO, text: renderInbox(cachedInbox) },
        Date.now(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ui.addItem(
        { type: MessageType.ERROR, text: `Failed to fetch inbox: ${message}` },
        Date.now(),
      );
    }
  },
};

const loadSubCommand: SlashCommand = {
  name: 'load',
  description:
    'Load a shared context into the current session. Usage: /inbox load <#>',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  takesArgs: true,
  action: async (context, args) => {
    const { ui } = context;
    const index = parseInt(args.trim(), 10) - 1;

    if (isNaN(index) || index < 0) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Usage: /inbox load <#>  (e.g. /inbox load 1)',
        },
        Date.now(),
      );
      return;
    }

    if (cachedInbox.length === 0) {
      ui.addItem(
        {
          type: MessageType.INFO,
          text: 'Run /inbox first to fetch your shared contexts.',
        },
        Date.now(),
      );
      return;
    }

    if (index >= cachedInbox.length) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: `No item #${index + 1}. Run /inbox to see available entries.`,
        },
        Date.now(),
      );
      return;
    }

    const entry = cachedInbox[index];
    const shareService = createShareService(context);
    if (!shareService) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Could not retrieve API configuration.',
        },
        Date.now(),
      );
      return;
    }

    ui.addItem(
      {
        type: MessageType.INFO,
        text: `Loading context from @${entry.from}…`,
      },
      Date.now(),
    );

    try {
      const history = await shareService.loadShared(entry.fileName);

      // Inject history into the current session
      context.services.agentContext?.geminiClient?.setHistory(history);

      // Remove from local cache so it doesn't show stale
      cachedInbox = cachedInbox.filter((_, i) => i !== index);

      ui.addItem(
        {
          type: MessageType.INFO,
          text: [
            `✓ Context from @${entry.from} loaded.`,
            `You now have their conversation history. Continue from where they left off.`,
          ].join('\n'),
        },
        Date.now(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ui.addItem(
        { type: MessageType.ERROR, text: `Failed to load context: ${message}` },
        Date.now(),
      );
    }
  },
};

const dismissSubCommand: SlashCommand = {
  name: 'dismiss',
  description:
    'Delete a shared context without loading it. Usage: /inbox dismiss <#>',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  takesArgs: true,
  action: async (context, args) => {
    const { ui } = context;
    const index = parseInt(args.trim(), 10) - 1;

    if (isNaN(index) || index < 0) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Usage: /inbox dismiss <#>  (e.g. /inbox dismiss 1)',
        },
        Date.now(),
      );
      return;
    }

    if (cachedInbox.length === 0 || index >= cachedInbox.length) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: `No item #${index + 1}. Run /inbox to refresh.`,
        },
        Date.now(),
      );
      return;
    }

    const entry = cachedInbox[index];
    const shareService = createShareService(context);
    if (!shareService) {
      ui.addItem(
        {
          type: MessageType.ERROR,
          text: 'Could not retrieve API configuration.',
        },
        Date.now(),
      );
      return;
    }

    try {
      await shareService.dismiss(entry.fileName);
      cachedInbox = cachedInbox.filter((_, i) => i !== index);

      ui.addItem(
        {
          type: MessageType.INFO,
          text: `Dismissed context from @${entry.from}.`,
        },
        Date.now(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ui.addItem(
        { type: MessageType.ERROR, text: `Failed to dismiss: ${message}` },
        Date.now(),
      );
    }
  },
};

/**
 * `/inbox` — lists, loads, or dismisses conversation contexts shared with you.
 *
 * Usage:
 *   /inbox              — list all shared contexts
 *   /inbox load 1       — load context #1 into the current session
 *   /inbox dismiss 2    — delete context #2 without loading
 */
export const inboxCommand: SlashCommand = {
  name: 'inbox',
  description:
    'View and load conversation contexts shared with you by teammates.',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  subCommands: [listSubCommand, loadSubCommand, dismissSubCommand],

  // Running `/inbox` with no sub-command defaults to listing.
  action: async (context, args) => {
    if (!args.trim()) {
      return listSubCommand.action?.(context, '');
    }
  },
};
