/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { settingsCommand } from './settingsCommand.js';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import type { LoadedSettings } from '../../config/settings.js';

describe('settingsCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext();
  });

  it('should return a dialog action to open the settings dialog', () => {
    if (!settingsCommand.action) {
      throw new Error('The settings command must have an action.');
    }
    const result = settingsCommand.action(mockContext, '');
    expect(result).toEqual({
      type: 'dialog',
      dialog: 'settings',
    });
  });

  it('should have the correct name and description', () => {
    expect(settingsCommand.name).toBe('settings');
    expect(settingsCommand.description).toBe(
      'View and edit Gemini CLI settings',
    );
  });

  describe('subcommands', () => {
    it('should have list and set subcommands', () => {
      expect(settingsCommand.subCommands).toHaveLength(2);
      expect(settingsCommand.subCommands?.map((s) => s.name)).toContain('list');
      expect(settingsCommand.subCommands?.map((s) => s.name)).toContain('set');
    });

    describe('list', () => {
      it('should list settings', async () => {
        const listCmd = settingsCommand.subCommands?.find(
          (s) => s.name === 'list',
        );
        expect(listCmd).toBeDefined();

        const mockContext = createMockCommandContext({
          services: {
            settings: {
              merged: {
                model: { name: 'gemini-1.5-flash' },
                ui: { theme: 'dark' },
              },
            } as unknown as LoadedSettings,
          },
        });

        await listCmd!.action!(mockContext, '');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining('model.name'),
          }),
        );
        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining('gemini-1.5-flash'),
          }),
        );
      });

      it('should filter settings by argument', async () => {
        const listCmd = settingsCommand.subCommands?.find(
          (s) => s.name === 'list',
        );
        const mockContext = createMockCommandContext({
          services: {
            settings: {
              merged: {
                model: { name: 'gemini-1.5-flash' },
                ui: { theme: 'dark' },
              },
            } as unknown as LoadedSettings,
          },
        });

        await listCmd!.action!(mockContext, 'model');

        const call = vi.mocked(mockContext.ui.addItem).mock.calls[0][0];
        expect(call.text).toContain('model.name');
        expect(call.text).not.toContain('ui.theme');
      });
    });

    describe('set', () => {
      it('should set a value correctly', async () => {
        const setCmd = settingsCommand.subCommands?.find(
          (s) => s.name === 'set',
        );
        const mockContext = createMockCommandContext();

        await setCmd!.action!(mockContext, 'model.name gemini-pro');

        expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
          expect.anything(), // SettingScope.User
          'model.name',
          'gemini-pro',
        );
        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining('Set model.name to "gemini-pro"'),
          }),
        );
      });

      it('should handle boolean values', async () => {
        const setCmd = settingsCommand.subCommands?.find(
          (s) => s.name === 'set',
        );
        const mockContext = createMockCommandContext();

        await setCmd!.action!(mockContext, 'general.enableAutoUpdate true');

        expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
          expect.anything(),
          'general.enableAutoUpdate',
          true,
        );
      });

      it('should handle numeric values', async () => {
        const setCmd = settingsCommand.subCommands?.find(
          (s) => s.name === 'set',
        );
        const mockContext = createMockCommandContext();

        await setCmd!.action!(mockContext, 'summarize.tokenBudget 1000');

        expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
          expect.anything(),
          'summarize.tokenBudget',
          1000,
        );
      });

      it('should show error message on invalid input', async () => {
        const setCmd = settingsCommand.subCommands?.find(
          (s) => s.name === 'set',
        );
        const mockContext = createMockCommandContext();

        await setCmd!.action!(mockContext, '');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: expect.stringContaining('error'),
            text: expect.stringContaining('Usage: /settings set <key> <value>'),
          }),
        );
      });
    });
  });
});
