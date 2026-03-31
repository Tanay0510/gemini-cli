/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GcsProvider } from './gcsProvider.js';

const mockGetAccessToken = vi.fn();

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({
      getAccessToken: mockGetAccessToken,
    }),
  })),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GcsProvider', () => {
  beforeEach(() => {
    mockGetAccessToken.mockResolvedValue({ token: 'test-access-token' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Constructor
  // --------------------------------------------------------------------------

  describe('constructor', () => {
    it('strips gs:// prefix from bucket URI', () => {
      // Should not throw
      const _provider = new GcsProvider('gs://my-bucket');
      expect(_provider).toBeDefined();
    });

    it('accepts plain bucket name', () => {
      const _provider = new GcsProvider('my-bucket');
      expect(_provider).toBeDefined();
    });

    it('throws on empty bucket URI', () => {
      expect(() => new GcsProvider('')).toThrow('A GCS bucket URI is required');
    });
  });

  // --------------------------------------------------------------------------
  // upload()
  // --------------------------------------------------------------------------

  describe('upload()', () => {
    it('sends POST to GCS upload endpoint with correct headers', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const provider = new GcsProvider('gs://test-bucket');

      await provider.upload({
        to: 'alice@company.com',
        from: 'bob@company.com',
        model: 'gemini-2.0-flash',
        history: [{ role: 'user', parts: [{ text: 'hello' }] }],
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('upload/storage/v1/b/test-bucket/o');
      expect(url).toContain('uploadType=media');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual(
        expect.objectContaining({
          Authorization: 'Bearer test-access-token',
          'Content-Type': 'application/json',
          'x-goog-meta-share-from': 'bob@company.com',
          'x-goog-meta-share-model': 'gemini-2.0-flash',
        }),
      );
    });

    it('includes label in metadata when provided', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const provider = new GcsProvider('gs://test-bucket');

      await provider.upload({
        to: 'alice@company.com',
        from: 'bob@company.com',
        model: 'gemini-2.0-flash',
        history: [{ role: 'user', parts: [{ text: 'hello' }] }],
        label: 'auth bug',
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(
        (options.headers as Record<string, string>)['x-goog-meta-share-label'],
      ).toBe('auth bug');
    });

    it('throws on upload failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: vi.fn().mockResolvedValue('Forbidden'),
      });
      const provider = new GcsProvider('gs://test-bucket');

      await expect(
        provider.upload({
          to: 'alice@company.com',
          from: 'bob@company.com',
          model: 'gemini-2.0-flash',
          history: [{ role: 'user', parts: [{ text: 'hello' }] }],
        }),
      ).rejects.toThrow('Failed to upload shared context to GCS (HTTP 403)');
    });
  });

  // --------------------------------------------------------------------------
  // list()
  // --------------------------------------------------------------------------

  describe('list()', () => {
    it('returns parsed entries from GCS list response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          items: [
            {
              name: 'inbox/abc123/share--from--bob@co.com--1000.json',
              metadata: {
                'share-from': 'bob@co.com',
                'share-model': 'gemini-2.0-flash',
                'share-ts': '1000',
                'share-label': 'auth bug',
              },
            },
          ],
        }),
      });

      const provider = new GcsProvider('gs://test-bucket');
      const results = await provider.list('alice@co.com');

      expect(results).toHaveLength(1);
      expect(results[0]?.from).toBe('bob@co.com');
      expect(results[0]?.label).toBe('auth bug');
      expect(results[0]?.timestamp).toBe(1000);
    });

    it('returns empty array when no items exist', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });

      const provider = new GcsProvider('gs://test-bucket');
      const results = await provider.list('alice@co.com');

      expect(results).toEqual([]);
    });

    it('sorts results newest-first', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          items: [
            {
              name: 'older',
              metadata: {
                'share-from': 'bob',
                'share-model': 'm',
                'share-ts': '1000',
              },
            },
            {
              name: 'newer',
              metadata: {
                'share-from': 'bob',
                'share-model': 'm',
                'share-ts': '2000',
              },
            },
          ],
        }),
      });

      const provider = new GcsProvider('gs://test-bucket');
      const results = await provider.list('alice@co.com');

      expect(results[0]?.fileName).toBe('newer');
      expect(results[1]?.fileName).toBe('older');
    });
  });

  // --------------------------------------------------------------------------
  // download()
  // --------------------------------------------------------------------------

  describe('download()', () => {
    it('fetches file content and parses JSON', async () => {
      const history = [{ role: 'user', parts: [{ text: 'hello' }] }];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(history)),
      });

      const provider = new GcsProvider('gs://test-bucket');
      const result = await provider.download('inbox/abc/share.json');

      expect(result).toEqual(history);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain('alt=media');
    });

    it('throws on download failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: vi.fn().mockResolvedValue('Not Found'),
      });

      const provider = new GcsProvider('gs://test-bucket');

      await expect(provider.download('inbox/abc/share.json')).rejects.toThrow(
        'Failed to download shared context from GCS (HTTP 404)',
      );
    });
  });

  // --------------------------------------------------------------------------
  // delete()
  // --------------------------------------------------------------------------

  describe('delete()', () => {
    it('sends DELETE request to GCS', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const provider = new GcsProvider('gs://test-bucket');
      await provider.delete('inbox/abc/share.json');

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain(encodeURIComponent('inbox/abc/share.json'));
      expect(options.method).toBe('DELETE');
    });

    it('does not throw on 404 (already deleted)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const provider = new GcsProvider('gs://test-bucket');
      // Should not throw
      await provider.delete('inbox/abc/share.json');
    });
  });
});
