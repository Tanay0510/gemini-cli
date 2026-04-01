/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getDefaultSharedBucket,
  resolveUserIdentity,
  normalizeRecipient,
  stripEnvironmentContext,
} from './sharingUtils.js';
import { UserAccountManager } from './userAccountManager.js';

vi.mock('./userAccountManager.js', () => ({
  UserAccountManager: vi.fn().mockImplementation(() => ({
    getCachedGoogleAccount: vi.fn(),
  })),
}));

describe('sharingUtils', () => {
  describe('getDefaultSharedBucket', () => {
    it('derives a bucket name from a standard email', () => {
      expect(getDefaultSharedBucket('alice@google.com')).toBe(
        'gs://gemini-shared-google-com',
      );
    });

    it('handles domains with multiple dots', () => {
      expect(getDefaultSharedBucket('bob@mail.corp.acme.co')).toBe(
        'gs://gemini-shared-mail-corp-acme-co',
      );
    });

    it('returns an empty string for invalid emails', () => {
      expect(getDefaultSharedBucket('not-an-email')).toBe('');
    });
  });

  describe('normalizeRecipient', () => {
    it('does nothing to a full email', () => {
      expect(normalizeRecipient('alice@google.com', 'bob@google.com')).toBe(
        'alice@google.com',
      );
    });

    it('appends the sender domain to a handle', () => {
      expect(normalizeRecipient('alice', 'bob@google.com')).toBe(
        'alice@google.com',
      );
    });

    it('returns the handle as-is if the sender has no domain', () => {
      expect(normalizeRecipient('alice', 'bob')).toBe('alice');
    });

    it('returns the handle as-is if no sender email provided', () => {
      expect(normalizeRecipient('alice')).toBe('alice');
    });
  });

  describe('stripEnvironmentContext', () => {
    it('removes turns containing session_context', () => {
      const history = [
        { role: 'user', parts: [{ text: '<session_context>\nstuff' }] },
        { role: 'user', parts: [{ text: 'hello' }] },
      ];
      const result = stripEnvironmentContext(history);
      expect(result).toHaveLength(1);
      expect(result[0].parts![0].text).toBe('hello');
    });

    it('removes turns containing Directory Structure', () => {
      const history = [
        {
          role: 'user',
          parts: [{ text: 'Current Directory Structure:\n- a' }],
        },
        { role: 'user', parts: [{ text: 'actual question' }] },
      ];
      const result = stripEnvironmentContext(history);
      expect(result).toHaveLength(1);
      expect(result[0].parts![0].text).toBe('actual question');
    });

    it('keeps normal turns', () => {
      const history = [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
      ];
      const result = stripEnvironmentContext(history);
      expect(result).toEqual(history);
    });
  });

  describe('resolveUserIdentity', () => {
    let mockGetCachedGoogleAccount: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockGetCachedGoogleAccount = vi.fn();
      vi.mocked(UserAccountManager).mockImplementation(
        () =>
          ({
            getCachedGoogleAccount: mockGetCachedGoogleAccount,
          }) as unknown as UserAccountManager,
      );
    });

    it('prioritizes Google OAuth email', () => {
      mockGetCachedGoogleAccount.mockReturnValue('alice@google.com');
      const identity = resolveUserIdentity(
        { myName: 'AliceSetting' },
        'osUser',
      );
      expect(identity).toBe('alice@google.com');
    });

    it('falls back to myName setting if no Google account', () => {
      mockGetCachedGoogleAccount.mockReturnValue(null);
      const identity = resolveUserIdentity(
        { myName: 'AliceSetting' },
        'osUser',
      );
      expect(identity).toBe('AliceSetting');
    });

    it('falls back to the provided fallback (e.g. OS user)', () => {
      mockGetCachedGoogleAccount.mockReturnValue(null);
      const identity = resolveUserIdentity({}, 'osUser');
      expect(identity).toBe('osUser');
    });

    it('returns "unknown" if everything is missing', () => {
      mockGetCachedGoogleAccount.mockReturnValue(null);
      const identity = resolveUserIdentity({});
      expect(identity).toBe('unknown');
    });
  });
});
