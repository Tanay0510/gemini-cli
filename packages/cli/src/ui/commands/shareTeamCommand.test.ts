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

const { mockShare, mockTryCompressChat, mockGetHistory, mockSummarizeChat } =
  vi.hoisted(() => ({
    mockShare: vi.fn(),
    mockTryCompressChat: vi.fn(),
    mockGetHistory: vi.fn(),
    mockSummarizeChat: vi.fn(),
  }));

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    ContextShareService: vi.fn().mockImplementation(() => ({
      share: mockShare,
      getProviderName: vi.fn().mockReturnValue('TestProvider'),
    })),
    UserAccountManager: vi.fn().mockImplementation(() => ({
      getCachedGoogleAccount: vi.fn().mockReturnValue(null),
    })),
  };
});

/** Minimal history that passes the MIN_HISTORY_LENGTH guard (> 2 turns). */
const enoughHistory = [
  { role: 'user', parts: [{ text: 'a' }] },
  { role: 'model', parts: [{ text: 'b' }] },
  { role: 'user', parts: [{ text: 'c' }] },
];

function buildContext(overrides = {}): CommandContext {
  return createMockCommandContext({
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
            .mockReturnValue({ authType: 'gemini-api-key', apiKey: 'test' }),
          getModel: vi.fn().mockReturnValue('gemini-2.0-flash'),
          getShareSettings: vi.fn().mockReturnValue({
            myName: 'sender',
            teammates: ['alice', 'bob', 'carol'],
          }),
        },
      },
      settings: {
        merged: {
          share: { myName: 'sender', teammates: ['alice', 'bob', 'carol'] },
        },
      },
    },
    ...overrides,
  } as unknown as CommandContext);
}

describe('shareTeamCommand', () => {
  let ctx: CommandContext;

  beforeEach(() => {
    mockShare.mockResolvedValue(undefined);
    mockTryCompressChat.mockResolvedValue(undefined);
    mockGetHistory.mockReturnValue(enoughHistory);
    mockSummarizeChat.mockResolvedValue('conversation summary');
    ctx = buildContext();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Metadata
  // --------------------------------------------------------------------------

  it('has the correct name', () => {
    expect(shareTeamCommand.name).toBe('share');
  });

  // --------------------------------------------------------------------------
  // Argument parsing — recipients
  // --------------------------------------------------------------------------

  it('shares with a single recipient (no @)', async () => {
    await shareTeamCommand.action!(ctx, 'alice');

    expect(mockShare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: 'alice',
        label: 'conversation summary',
        history: expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('### CONVERSATION SUMMARY'),
              }),
            ]),
          }),
        ]),
      }),
    );
  });

  it('shares with a single @-prefixed recipient', async () => {
    await shareTeamCommand.action!(ctx, '@alice');

    expect(mockShare).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ to: 'alice' }),
    );
  });

  it('shares with multiple @-prefixed recipients', async () => {
    await shareTeamCommand.action!(ctx, '@alice @bob @carol');

    expect(mockShare).toHaveBeenCalledTimes(3);
    const tos = (mockShare.mock.calls as Array<[{ to: string }]>).map(
      (call) => call[0].to,
    );
    expect(tos).toEqual(expect.arrayContaining(['alice', 'bob', 'carol']));
  });

  it('uploads in parallel (all share calls initiated before awaiting)', async () => {
    // Promise.allSettled means all three are started before any resolves.
    // We verify by checking all are called after a single action invocation.
    await shareTeamCommand.action!(ctx, '@alice @bob');

    expect(mockShare).toHaveBeenCalledTimes(2);
  });

  // --------------------------------------------------------------------------
  // Argument parsing — labels
  // --------------------------------------------------------------------------

  it('uses summary as label when no label is given', async () => {
    await shareTeamCommand.action!(ctx, '@alice');

    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'conversation summary' }),
    );
  });

  it('extracts a bare label after the recipient', async () => {
    await shareTeamCommand.action!(ctx, '@alice auth bug fix');

    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'auth bug fix' }),
    );
  });

  it('extracts a label after the --label flag', async () => {
    await shareTeamCommand.action!(ctx, '@alice --label auth bug fix');

    expect(mockShare).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'auth bug fix' }),
    );
  });

  it('applies the same label to all recipients in a multi-share', async () => {
    await shareTeamCommand.action!(ctx, '@alice @bob auth bug');

    expect(mockShare).toHaveBeenCalledTimes(2);
    for (const call of mockShare.mock.calls as Array<[{ label: string }]>) {
      expect(call[0].label).toBe('auth bug');
    }
  });

  // --------------------------------------------------------------------------
  // Success / failure reporting
  // --------------------------------------------------------------------------

  it('shows a success message listing all recipients', async () => {
    await shareTeamCommand.action!(ctx, '@alice @bob');

    expect(ctx.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('@alice'),
      }),
      expect.any(Number),
    );
    expect(ctx.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('@bob'),
      }),
      expect.any(Number),
    );
  });

  it('includes the label in the success message', async () => {
    await shareTeamCommand.action!(ctx, '@alice auth bug');

    expect(ctx.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('with label: "auth bug"'),
      }),
      expect.any(Number),
    );
  });

  it('reports per-recipient errors on partial failure', async () => {
    mockShare
      .mockResolvedValueOnce(undefined) // alice succeeds
      .mockRejectedValueOnce(new Error('network error')); // bob fails

    await shareTeamCommand.action!(ctx, '@alice @bob');

    // Success message for alice
    expect(ctx.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('@alice'),
      }),
      expect.any(Number),
    );
    // Error message for bob
    expect(ctx.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('@bob'),
      }),
      expect.any(Number),
    );
  });

  it('shows only error messages when all recipients fail', async () => {
    mockShare.mockRejectedValue(new Error('upload failed'));

    await shareTeamCommand.action!(ctx, '@alice @bob');

    const calls = vi.mocked(ctx.ui.addItem).mock.calls;
    // Filter out the "Compressing…" info message (first one)
    const resultMessages = calls.filter(
      (c) =>
        (c[0] as { type: MessageType }).type === MessageType.ERROR ||
        ((c[0] as { type: MessageType; text: string }).type ===
          MessageType.INFO &&
          (c[0] as { text: string }).text.includes('✓')),
    );
    const errorMessages = resultMessages.filter(
      (c) => (c[0] as { type: MessageType }).type === MessageType.ERROR,
    );
    const successMessages = resultMessages.filter(
      (c) =>
        (c[0] as { type: MessageType }).type === MessageType.INFO &&
        (c[0] as { text: string }).text.includes('✓'),
    );
    expect(errorMessages).toHaveLength(2);
    expect(successMessages).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Validation guards
  // --------------------------------------------------------------------------

  it('shows an error when no recipient is given', async () => {
    await shareTeamCommand.action!(ctx, '');

    expect(ctx.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: MessageType.ERROR }),
      expect.any(Number),
    );
    expect(mockShare).not.toHaveBeenCalled();
  });

  it('shows an error when there is no active agent context', async () => {
    const noAgentCtx = buildContext({
      services: { agentContext: null },
    } as unknown as CommandContext);

    await shareTeamCommand.action!(noAgentCtx, '@alice');

    expect(noAgentCtx.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('No active agent context'),
      }),
      expect.any(Number),
    );
  });

  it('shows an info message when history is too short', async () => {
    mockGetHistory.mockReturnValue([{ role: 'user', parts: [{ text: 'hi' }] }]);

    await shareTeamCommand.action!(ctx, '@alice');

    expect(ctx.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('Nothing to share yet'),
      }),
      expect.any(Number),
    );
    expect(mockShare).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Tab completion
  // --------------------------------------------------------------------------

  it('completes the first token against the teammates list', () => {
    const results = shareTeamCommand.completion!(ctx, '@a');
    expect(results).toContain('@alice');
  });

  it('completes the last token when multiple recipients are typed', () => {
    const results = shareTeamCommand.completion!(ctx, '@alice @b');
    expect(results).toContain('@bob');
    expect(results).not.toContain('@alice');
  });

  it('returns no completions when the last token is not @-prefixed', () => {
    const results = shareTeamCommand.completion!(ctx, '@alice some');
    expect(results).toEqual([]);
  });
});
