/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ContextShareService } from './contextShareService.js';
import {
  AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';

// We don't need the actual Gemini SDK for constructor/routing tests — mock it.
vi.mock('./geminiFilesProvider.js', () => ({
  GeminiFilesProvider: vi.fn().mockImplementation(() => ({
    upload: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    download: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./gcsProvider.js', () => ({
  GcsProvider: vi.fn().mockImplementation(() => ({
    upload: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    download: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../utils/userAccountManager.js', () => ({
  UserAccountManager: vi.fn().mockImplementation(() => ({
    getCachedGoogleAccount: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../utils/sharingUtils.js', () => ({
  getDefaultSharedBucket: vi
    .fn()
    .mockReturnValue('gs://gemini-shared-discovered'),
}));

const geminiConfig: ContentGeneratorConfig = {
  authType: AuthType.USE_GEMINI,
  apiKey: 'test-api-key',
} as ContentGeneratorConfig;

const vertexConfig: ContentGeneratorConfig = {
  authType: AuthType.USE_VERTEX_AI,
} as ContentGeneratorConfig;

const oauthConfig: ContentGeneratorConfig = {
  authType: AuthType.LOGIN_WITH_GOOGLE,
} as ContentGeneratorConfig;

describe('ContextShareService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Provider routing
  // --------------------------------------------------------------------------

  describe('provider selection', () => {
    it('uses GeminiFilesProvider for USE_GEMINI with API key', async () => {
      const { GeminiFilesProvider } = await import('./geminiFilesProvider.js');
      new ContextShareService({ config: geminiConfig });
      expect(GeminiFilesProvider).toHaveBeenCalledWith('test-api-key');
    });

    it('uses GcsProvider for USE_VERTEX_AI with bucket', async () => {
      const { GcsProvider } = await import('./gcsProvider.js');
      new ContextShareService({
        config: vertexConfig,
        bucket: 'gs://my-bucket',
      });
      expect(GcsProvider).toHaveBeenCalledWith('gs://my-bucket');
    });

    it('uses GcsProvider for LOGIN_WITH_GOOGLE with bucket', async () => {
      const { GcsProvider } = await import('./gcsProvider.js');
      new ContextShareService({
        config: oauthConfig,
        bucket: 'gs://my-bucket',
      });
      expect(GcsProvider).toHaveBeenCalledWith('gs://my-bucket');
    });

    it('performs zero-config discovery for Vertex when bucket is missing but email exists', async () => {
      const { GcsProvider } = await import('./gcsProvider.js');
      const { UserAccountManager } = await import(
        '../utils/userAccountManager.js'
      );
      vi.mocked(UserAccountManager).mockImplementation(
        () =>
          ({
            getCachedGoogleAccount: vi.fn().mockReturnValue('user@google.com'),
          }) as unknown as UserAccountManager,
      );

      new ContextShareService({ config: vertexConfig });

      expect(GcsProvider).toHaveBeenCalledWith('gs://gemini-shared-discovered');
    });

    it('throws for Vertex when bucket is missing and no email exists', async () => {
      const { UserAccountManager } = await import(
        '../utils/userAccountManager.js'
      );
      vi.mocked(UserAccountManager).mockImplementation(
        () =>
          ({
            getCachedGoogleAccount: vi.fn().mockReturnValue(null),
          }) as unknown as UserAccountManager,
      );

      expect(
        () =>
          new ContextShareService({
            config: vertexConfig,
          }),
      ).toThrow('Enterprise context sharing requires a GCS bucket');
    });

    it('throws when auth is unsupported and no bucket is set', () => {
      expect(
        () =>
          new ContextShareService({
            config: { authType: AuthType.GATEWAY } as ContentGeneratorConfig,
          }),
      ).toThrow('Context sharing requires either');
    });

    it('throws when USE_GEMINI has no API key', () => {
      expect(
        () =>
          new ContextShareService({
            config: {
              authType: AuthType.USE_GEMINI,
            } as ContentGeneratorConfig,
          }),
      ).toThrow('Context sharing requires either');
    });
  });

  // --------------------------------------------------------------------------
  // Delegation
  // --------------------------------------------------------------------------

  describe('share()', () => {
    it('throws when history is empty', async () => {
      const service = new ContextShareService({ config: geminiConfig });
      await expect(
        service.share({
          to: 'alice',
          from: 'bob',
          model: 'gemini-2.0-flash',
          history: [],
        }),
      ).rejects.toThrow('No conversation history to share.');
    });

    it('delegates to provider.upload when history is non-empty', async () => {
      const service = new ContextShareService({ config: geminiConfig });
      // This should not throw — the mocked provider resolves
      await service.share({
        to: 'alice',
        from: 'bob',
        model: 'gemini-2.0-flash',
        history: [{ role: 'user', parts: [{ text: 'hello' }] }],
      });
    });
  });
});
