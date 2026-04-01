/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope, getSettingsSchema } from '../../config/settings.js';
import type { SettingsSchema } from '../../config/settingsSchema.js';
import { MessageType } from '../types.js';
import {
  CommandKind,
  type SlashCommand,
  type CommandContext,
  type SlashCommandActionReturn,
} from './types.js';

function getNestedProperty(
  obj: Record<string, unknown>,
  path: string,
): unknown {
  let current: Record<string, unknown> = obj;
  const keys = path.split('.');
  const lastKey = keys.pop();

  if (!lastKey) {
    return undefined;
  }

  for (const key of keys) {
    const next = current[key];
    if (next && typeof next === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      current = next as Record<string, unknown>;
    } else {
      return undefined;
    }
  }

  return current[lastKey];
}

function getAllSettingKeys(schema: SettingsSchema, prefix = ''): string[] {
  let keys: string[] = [];
  for (const key in schema) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const def = schema[key];
    if (def.type === 'object' && def.properties) {
      keys = keys.concat(getAllSettingKeys(def.properties, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

const listSubCommand: SlashCommand = {
  name: 'list',
  description: 'List current settings. Usage: /settings list [filter]',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context: CommandContext, args: string) => {
    const { ui, services } = context;
    const filter = args.trim().toLowerCase();
    const merged = services.settings.merged as Record<string, unknown>;

    const lines: string[] = [];
    const schema = getSettingsSchema();
    const allKeys = getAllSettingKeys(schema);

    for (const key of allKeys) {
      if (filter && !key.toLowerCase().includes(filter)) continue;
      const value = getNestedProperty(merged, key);
      lines.push(`  ${key.padEnd(40)}: ${JSON.stringify(value)}`);
    }

    if (lines.length === 0) {
      ui.addItem({
        type: MessageType.INFO,
        text: filter
          ? `No settings matching "${filter}" found.`
          : 'No settings found.',
      });
    } else {
      ui.addItem({
        type: MessageType.INFO,
        text: `Current Settings${filter ? ` (filtered by "${filter}")` : ''}:\n${lines.join('\n')}`,
      });
    }
  },
};

const setSubCommand: SlashCommand = {
  name: 'set',
  description: 'Set a setting value. Usage: /settings set <key> <value>',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  takesArgs: true,
  completion: (context, partialArg) => {
    const schema = getSettingsSchema();
    const allKeys = getAllSettingKeys(schema);
    const tokens = partialArg.trim().split(/\s+/);
    if (tokens.length <= 1) {
      const partialKey = tokens[0] || '';
      return allKeys.filter((k) => k.startsWith(partialKey));
    }
    return [];
  },
  action: async (context: CommandContext, args: string) => {
    const { ui, services } = context;
    const parts = args.trim().match(/^([^\s]+)\s*(.*)$/);

    if (!parts) {
      ui.addItem({
        type: MessageType.ERROR,
        text: 'Usage: /settings set <key> <value>',
      });
      return;
    }

    const key = parts[1];
    const rawValue = parts[2].trim();

    // Handle empty string or explicit "null"/"undefined" as unsetting
    let value: unknown = rawValue;
    if (rawValue === '""' || rawValue === "''" || rawValue === '') {
      value = undefined;
    } else if (rawValue === 'true') {
      value = true;
    } else if (rawValue === 'false') {
      value = false;
    } else if (!isNaN(Number(rawValue)) && rawValue !== '') {
      value = Number(rawValue);
    } else if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
      try {
        value = JSON.parse(rawValue);
      } catch {
        // stay as string
      }
    }

    try {
      services.settings.setValue(SettingScope.User, key, value);
      ui.addItem({
        type: MessageType.INFO,
        text: `✓ Set ${key} to ${JSON.stringify(value)} (User scope)`,
      });
    } catch (err) {
      ui.addItem({
        type: MessageType.ERROR,
        text: `Failed to set ${key}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  },
};

export const settingsCommand: SlashCommand = {
  name: 'settings',
  description: 'View and edit Gemini CLI settings',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  subCommands: [listSubCommand, setSubCommand],
  action: (context, args): SlashCommandActionReturn | void => {
    if (!args.trim()) {
      return {
        type: 'dialog',
        dialog: 'settings',
      };
    }
  },
};
