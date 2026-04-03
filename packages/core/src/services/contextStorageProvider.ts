/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

/**
 * Metadata surfaced in the inbox for a shared context entry.
 */
export interface SharedContextEnvelope {
  /** Backend-specific resource identifier (e.g. "files/abc123" or a GCS path). */
  fileName: string;
  from: string;
  to: string;
  model: string;
  timestamp: number;
  /** Optional human-readable label set by the sender. */
  label?: string;
}

/**
 * Abstraction over the storage backend used by ContextShareService.
 *
 * Two implementations exist:
 *   - GeminiFilesProvider — uses the Gemini Files API (API key users)
 *   - GcsProvider — uses Google Cloud Storage (Vertex / OAuth users)
 */
export interface ContextStorageProvider {
  /**
   * Uploads conversation history for a given recipient.
   */
  upload(params: {
    to: string;
    from: string;
    model: string;
    history: Content[];
    label?: string;
  }): Promise<void>;

  /**
   * Lists all shared-context entries addressed to `recipientEmail`,
   * sorted newest-first.
   */
  list(recipientEmail: string): Promise<SharedContextEnvelope[]>;

  /**
   * Downloads and deserialises the conversation history for a given entry.
   */
  download(fileName: string): Promise<Content[]>;

  /**
   * Deletes a shared context entry.
   */
  delete(fileName: string): Promise<void>;

  /**
   * Downloads the organizational directory (list of teammate emails).
   */
  downloadOrgDirectory(): Promise<string[]>;
}
