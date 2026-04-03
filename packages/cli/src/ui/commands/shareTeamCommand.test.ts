/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shareTeamCommand } from './shareTeamCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import type { CommandContext } from './types.js';
import {
  ContextShareService,
  type ShareSettings,
} from '@google/gemini-cli-core';

const {
  mockShare,
  mockTryCompressChat,
  mockGetHistory,
  mockSummarizeChat,
  mockGetOrgDirectory,
  mockSyncOrgDirectory,
} = vi.hoisted(() => ({
  mockShare: vi.fn(),
  mockTryCompressChat: vi.fn(),
  mockGetHistory: vi.fn(),
  mockSummarizeChat: vi.fn(),
  mockGetOrgDirectory: vi.fn(),
  mockSyncOrgDirectory: vi.fn(),
}));

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    ContextShareService: vi.fn().mockImplementation(() => ({
      share: mockShare,
      getProviderName: vi.fn().mockReturnValue('TestProvider'),
      getOrgDirectory: mockGetOrgDirectory,
      syncOrgDirectory: mockSyncOrgDirectory,
    })),
    UserAccountManager: vi.fn().mockImplementation(() => ({
      getCachedGoogleAccount: vi.fn().mockReturnValue('sender@google.com'),
    })),
    resolveUserIdentity: (settings: ShareSettings, fallback: string) =>
      settings.myName || fallback,
    normalizeRecipient: (r: string, from: string) => {
      // Manual normalization for the test to ensure predicatable results
      const recipient = r.replace(/^@/, '');
      if (recipient.includes('@')) return recipient;
      const domain = from.includes('@') ? from.split('@')[1] : null;
      return domain ? `${recipient}@${domain}` : recipient;
    },
  };
});

const enoughHistory = [
  { role: 'user', parts: [{ text: 'a' }] },
  { role: 'model', parts: [{ text: 'b' }] },
  { role: 'user', parts: [{ text: 'c' }] },
];

function buildContext(overrides = {}): CommandContext {
  const mockConfig = {
    getContentGeneratorConfig: vi
      .fn()
      .mockReturnValue({ authType: 'google-oauth', apiKey: 'test' }),
    getModel: vi.fn().mockReturnValue('gemini-2.0-flash'),
    getShareSettings: vi.fn().mockReturnValue({
      enabled: true,
      myName: 'sender@google.com',
      teammates: ['alice@google.com'],
      allowedDomains: [],
      requireVerification: false,
    }),
  };

  return createMockCommandContext({
    services: {
      agentContext: {
        geminiClient: {
          getChat: vi.fn().mockReturnValue({ getHistory: mockGetHistory }),
          tryCompressChat: mockTryCompressChat,
          summarizeChat: mockSummarizeChat,
        },
        config: mockConfig,
      },
      settings: {
        merged: {
          share: {
            enabled: true,
            teammates: ['alice@google.com'],
            allowedDomains: [],
            requireVerification: false,
          },
        },
        setValue: vi.fn(),
      },
    },
    ...overrides,
  } as unknown as CommandContext);
}

describe('shareTeamCommand - Logic Validation', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    mockShare.mockResolvedValue(undefined);
    mockTryCompressChat.mockResolvedValue(undefined);
    mockGetHistory.mockReturnValue(enoughHistory);
    mockSummarizeChat.mockResolvedValue('conversation summary');
    mockGetOrgDirectory.mockResolvedValue([]);
    ctx = buildContext();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Recipient Normalization Logic', () => {
    it('correctly expands aliases to full emails based on sender domain', async () => {
      await shareTeamCommand.action!(ctx, '@alice');

      // Logic Check: sender is @google.com. @alice -> alice@google.com
      expect(mockShare).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'alice@google.com' }),
      );
    });

    it('preserves full email addresses as-is', async () => {
      await shareTeamCommand.action!(ctx, 'bob@external.com');

      expect(mockShare).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'bob@external.com' }),
      );
    });
  });

  describe('Policy Enforcement Logic', () => {
    it('blocks sharing when domain guardrails are violated', async () => {
      const restrictedCtx = buildContext({
        services: {
          agentContext: {
            geminiClient: {
              getChat: vi.fn().mockReturnValue({ getHistory: mockGetHistory }),
              tryCompressChat: mockTryCompressChat,
              summarizeChat: mockSummarizeChat,
            },
            config: {
              getContentGeneratorConfig: vi
                .fn()
                .mockReturnValue({ authType: 'google-oauth' }),
              getModel: vi.fn().mockReturnValue('m'),
              getShareSettings: () => ({
                enabled: true,
                allowedDomains: ['google.com'],
                myName: 'me@google.com',
              }),
            },
          },
        },
      } as unknown as CommandContext);

      await shareTeamCommand.action!(restrictedCtx, 'hacker@bad-domain.com');

      expect(mockShare).not.toHaveBeenCalled();
      expect(restrictedCtx.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('not in the allowed list'),
        }),
        expect.any(Number),
      );
    });

    it('blocks unverified identities when strict verification is ON', async () => {
      const strictCtx = buildContext({
        services: {
          agentContext: {
            geminiClient: {
              getChat: vi.fn().mockReturnValue({ getHistory: mockGetHistory }),
              tryCompressChat: mockTryCompressChat,
              summarizeChat: mockSummarizeChat,
            },
            config: {
              getContentGeneratorConfig: vi
                .fn()
                .mockReturnValue({ authType: 'google-oauth' }),
              getModel: vi.fn().mockReturnValue('m'),
              getShareSettings: () => ({
                enabled: true,
                requireVerification: true,
                myName: 'unverified_user', // Sender has no domain
              }),
            },
          },
        },
      } as unknown as CommandContext);

      // In the implementation, if requireVerification is true, we call isVerified(recipient)
      // If we pass "@alice" and the sender is "unverified_user", the normalized recipient is just "alice"
      // isVerified("alice") will be false. Rejection happens.
      await shareTeamCommand.action!(strictCtx, '@alice');

      expect(mockShare).not.toHaveBeenCalled();
      expect(strictCtx.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('not a verified identity'),
        }),
        expect.any(Number),
      );
    });
  });

  describe('Management Flags Logic', () => {
    it('--verify on shows redirection error', async () => {
      await shareTeamCommand.action!(ctx, '--verify on');

      expect(ctx.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(
            'Configure sharing policies and teammates in /settings',
          ),
        }),
        expect.any(Number),
      );
    });

    it('--add shows redirection error', async () => {
      await shareTeamCommand.action!(ctx, '--add @alice');

      expect(ctx.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining(
            'Configure sharing policies and teammates in /settings',
          ),
        }),
        expect.any(Number),
      );
    });

    it('--sync calls the share service to sync organizational directory', async () => {
      const mockSync = vi.fn().mockResolvedValue(['user1@co.com']);

      // Use createMockCommandContext with overrides to avoid spreading class instances
      const syncCtx = createMockCommandContext({
        services: {
          agentContext: {
            config: {
              getContentGeneratorConfig: vi
                .fn()
                .mockReturnValue({ authType: 'google-oauth' }),
              getShareSettings: vi.fn().mockReturnValue({ enabled: true }),
              getGeminiClient: vi.fn().mockReturnValue({}),
            },
          },
        },
      });

      // Mock createShareService indirectly by providing necessary fields
      vi.mocked(ContextShareService).mockImplementation(
        () =>
          ({
            syncOrgDirectory: mockSync,
            getOrgDirectory: vi.fn(),
            getProviderName: vi.fn(),
            share: vi.fn(),
          }) as unknown as ContextShareService,
      );

      await shareTeamCommand.action!(syncCtx, '--sync');

      expect(mockSync).toHaveBeenCalled();
      expect(syncCtx.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Synced 1 teammates'),
        }),
        expect.any(Number),
      );
    });
  });
});
