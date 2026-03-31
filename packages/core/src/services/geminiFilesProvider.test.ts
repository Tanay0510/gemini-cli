/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiFilesProvider } from './geminiFilesProvider.js';

const { mockGoogleGenAI, mockUpload, mockList, mockDelete } = vi.hoisted(() => {
  const mockUpload = vi.fn();
  const mockList = vi.fn();
  const mockDelete = vi.fn();
  const mockGoogleGenAI = vi.fn().mockImplementation(() => ({
    files: { upload: mockUpload, list: mockList, delete: mockDelete },
    models: { generateContent: vi.fn() },
  }));
  return { mockGoogleGenAI, mockUpload, mockList, mockDelete };
});

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  return { ...actual, GoogleGenAI: mockGoogleGenAI };
});

const singleTurn = [{ role: 'user', parts: [{ text: 'hello' }] }];

function makeAsyncIterable<T>(items: T[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

describe('GeminiFilesProvider', () => {
  beforeEach(() => {
    mockUpload.mockResolvedValue({});
    mockDelete.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // upload()
  // --------------------------------------------------------------------------

  describe('upload()', () => {
    it('uploads with correct displayName fields when no label is given', async () => {
      const provider = new GeminiFilesProvider('test-key');
      await provider.upload({
        to: 'alice',
        from: 'bob',
        model: 'gemini-2.0-flash',
        history: singleTurn,
      });

      expect(mockUpload).toHaveBeenCalledOnce();
      const displayName: string =
        mockUpload.mock.calls[0][0].config.displayName;
      expect(displayName).toMatch(
        /^gemini-share::to:alice::from:bob::model:gemini-2\.0-flash::ts:\d+$/,
      );
    });

    it('appends an encoded label segment when label is provided', async () => {
      const provider = new GeminiFilesProvider('test-key');
      await provider.upload({
        to: 'alice',
        from: 'bob',
        model: 'gemini-2.0-flash',
        history: singleTurn,
        label: 'auth bug',
      });

      const displayName: string =
        mockUpload.mock.calls[0][0].config.displayName;
      expect(displayName).toContain('::label:auth%20bug');
    });

    it('URL-encodes special characters in the label', async () => {
      const provider = new GeminiFilesProvider('test-key');
      await provider.upload({
        to: 'alice',
        from: 'bob',
        model: 'gemini-2.0-flash',
        history: singleTurn,
        label: 'fix: auth/session',
      });

      const displayName: string =
        mockUpload.mock.calls[0][0].config.displayName;
      expect(displayName).toContain('::label:fix%3A%20auth%2Fsession');
    });

    it('omits the label segment when label is undefined', async () => {
      const provider = new GeminiFilesProvider('test-key');
      await provider.upload({
        to: 'alice',
        from: 'bob',
        model: 'gemini-2.0-flash',
        history: singleTurn,
        label: undefined,
      });

      const displayName: string =
        mockUpload.mock.calls[0][0].config.displayName;
      expect(displayName).not.toContain('::label:');
    });

    it('replaces "/" with "-" in model name', async () => {
      const provider = new GeminiFilesProvider('test-key');
      await provider.upload({
        to: 'alice',
        from: 'bob',
        model: 'models/gemini-2.0-flash',
        history: singleTurn,
      });

      const displayName: string =
        mockUpload.mock.calls[0][0].config.displayName;
      expect(displayName).toContain('::model:models-gemini-2.0-flash::');
    });
  });

  // --------------------------------------------------------------------------
  // list()
  // --------------------------------------------------------------------------

  describe('list()', () => {
    it('returns only entries addressed to the given recipient', async () => {
      const provider = new GeminiFilesProvider('test-key');
      mockList.mockResolvedValue(
        makeAsyncIterable([
          {
            name: 'files/aaa',
            displayName:
              'gemini-share::to:alice::from:bob::model:gemini-2.0-flash::ts:2000',
          },
          {
            name: 'files/bbb',
            displayName:
              'gemini-share::to:carol::from:bob::model:gemini-2.0-flash::ts:1000',
          },
        ]),
      );

      const inbox = await provider.list('alice');

      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.fileName).toBe('files/aaa');
      expect(inbox[0]?.from).toBe('bob');
    });

    it('parses label from displayName', async () => {
      const provider = new GeminiFilesProvider('test-key');
      mockList.mockResolvedValue(
        makeAsyncIterable([
          {
            name: 'files/aaa',
            displayName:
              'gemini-share::to:alice::from:bob::model:gemini-2.0-flash::ts:1000::label:auth%20bug',
          },
        ]),
      );

      const inbox = await provider.list('alice');

      expect(inbox[0]?.label).toBe('auth bug');
    });

    it('leaves label undefined for entries without a label', async () => {
      const provider = new GeminiFilesProvider('test-key');
      mockList.mockResolvedValue(
        makeAsyncIterable([
          {
            name: 'files/aaa',
            displayName:
              'gemini-share::to:alice::from:bob::model:gemini-2.0-flash::ts:1000',
          },
        ]),
      );

      const inbox = await provider.list('alice');

      expect(inbox[0]?.label).toBeUndefined();
    });

    it('sorts entries newest-first', async () => {
      const provider = new GeminiFilesProvider('test-key');
      mockList.mockResolvedValue(
        makeAsyncIterable([
          {
            name: 'files/older',
            displayName:
              'gemini-share::to:alice::from:bob::model:gemini-2.0-flash::ts:1000',
          },
          {
            name: 'files/newer',
            displayName:
              'gemini-share::to:alice::from:bob::model:gemini-2.0-flash::ts:2000',
          },
        ]),
      );

      const inbox = await provider.list('alice');

      expect(inbox[0]?.fileName).toBe('files/newer');
      expect(inbox[1]?.fileName).toBe('files/older');
    });

    it('ignores entries with malformed displayNames', async () => {
      const provider = new GeminiFilesProvider('test-key');
      mockList.mockResolvedValue(
        makeAsyncIterable([
          {
            name: 'files/bad1',
            displayName: 'gemini-share::to:alice::from:bob', // missing model + ts
          },
          { name: 'files/bad2', displayName: 'something-else' },
          {
            name: 'files/good',
            displayName:
              'gemini-share::to:alice::from:bob::model:gemini-2.0-flash::ts:1000',
          },
        ]),
      );

      const inbox = await provider.list('alice');

      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.fileName).toBe('files/good');
    });

    it('returns an empty array when inbox is empty', async () => {
      const provider = new GeminiFilesProvider('test-key');
      mockList.mockResolvedValue(makeAsyncIterable([]));

      const inbox = await provider.list('alice');

      expect(inbox).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // delete()
  // --------------------------------------------------------------------------

  describe('delete()', () => {
    it('calls files.delete with the given fileName', async () => {
      const provider = new GeminiFilesProvider('test-key');
      await provider.delete('files/abc123');

      expect(mockDelete).toHaveBeenCalledWith({ name: 'files/abc123' });
    });
  });
});
