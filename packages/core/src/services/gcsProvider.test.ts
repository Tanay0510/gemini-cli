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

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GcsProvider', () => {
  beforeEach(() => {
    mockGetAccessToken.mockResolvedValue({ token: 'test-access-token' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('strips gs:// prefix and trailing slashes from the bucket name', () => {
      const provider1 = new GcsProvider('gs://my-bucket');
      expect(provider1['bucketName']).toBe('my-bucket');

      const provider2 = new GcsProvider('my-other-bucket/');
      expect(provider2['bucketName']).toBe('my-other-bucket');

      const provider3 = new GcsProvider('gs://complex-bucket/nested/');
      expect(provider3['bucketName']).toBe('complex-bucket/nested');
    });

    it('throws if the bucket name is empty after stripping', () => {
      expect(() => new GcsProvider('gs://')).toThrow(
        'GcsProvider requires a bucket name.',
      );
      expect(() => new GcsProvider('')).toThrow(
        'GcsProvider requires a bucket name.',
      );
    });
  });

  describe('upload()', () => {
    it('generates a valid RFC 2387 multipart/related request body', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      const provider = new GcsProvider('gs://test-bucket');

      await provider.upload({
        to: 'alice@company.com',
        from: 'bob@company.com',
        model: 'gemini-2.0-flash',
        history: [{ role: 'user', parts: [{ text: 'payload content' }] }],
        label: 'test label',
      });

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = options.body as string;

      // 1. Verify Multi-part structure
      const contentType = options.headers
        ? (options.headers as Record<string, string>)['Content-Type']
        : '';
      const boundaryMatch = contentType?.match(/boundary=(.+)$/);
      const boundary = boundaryMatch ? boundaryMatch[1] : '';
      expect(body.split(`--${boundary}`).length).toBe(4); // Start, Middle, End, and whitespace

      // 2. Verify Metadata Part (Part 1)
      expect(body).toContain('Content-Type: application/json; charset=UTF-8');
      expect(body).toContain('"share-label":"test label"');
      expect(body).toContain('"share-from":"bob@company.com"');

      // 3. Verify Content Part (Part 2)
      expect(body).toContain('"text":"payload content"');
    });
  });

  describe('list()', () => {
    it('implements a robust fallback when GCS metadata headers are missing', async () => {
      // Simulate a response where 'metadata' is missing from the JSON item
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          items: [
            {
              name: 'inbox/abc123/share--from--expert_coder--model--gemini_3--1711929600000.json',
              // metadata is missing!
            },
          ],
        }),
      });

      const provider = new GcsProvider('gs://test-bucket');
      const results = await provider.list('recipient@co.com');

      // Verify the regex fallback logic actually works
      expect(results).toHaveLength(1);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toContain('prefix=inbox%2F');
      expect(results[0]?.from).toBe('expert_coder');
      expect(results[0]?.model).toBe('gemini_3');
      expect(results[0]?.timestamp).toBe(1711929600000);
    });

    it('correctly handles URL-safe encoded filenames in fallback logic', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          items: [
            {
              name: 'inbox/hash/share--from--user_with_spaces--12345.json',
            },
          ],
        }),
      });

      const provider = new GcsProvider('gs://test-bucket');
      const results = await provider.list('me@co.com');

      expect(results[0]?.from).toBe('user_with_spaces');
    });
  });

  describe('downloadOrgDirectory()', () => {
    it('returns teammates array on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          teammates: ['user1@co.com', 'user2@co.com'],
        }),
      });

      const provider = new GcsProvider('gs://test-bucket');
      const teammates = await provider.downloadOrgDirectory();

      expect(teammates).toEqual(['user1@co.com', 'user2@co.com']);
    });
  });
});
