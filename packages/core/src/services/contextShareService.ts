/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  AuthType,
  type ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type {
  ContextStorageProvider,
  SharedContextEnvelope,
} from './contextStorageProvider.js';
import { GeminiFilesProvider } from './geminiFilesProvider.js';
import { GcsProvider } from './gcsProvider.js';
import { UserAccountManager } from '../utils/userAccountManager.js';
import { getDefaultSharedBucket } from '../utils/sharingUtils.js';
import { ChatCompressionService } from './chatCompressionService.js';
import type { Config } from '../config/config.js';

// Re-export for consumers that import from this file.
export type { SharedContextEnvelope } from './contextStorageProvider.js';

// --------------------------------------------------------------------------
// ContextShareService
//
// Thin orchestration layer that delegates to a ContextStorageProvider.
//
// Provider selection:
//   • If `sharedBucketUri` is set AND auth is Vertex/OAuth/ADC → GcsProvider
//   • If `sharedBucketUri` is MISSING but auth is Vertex/OAuth/ADC →
//     Try to discover a default bucket from user's domain.
//   • If auth is USE_GEMINI with an API key → GeminiFilesProvider
//   • Otherwise → error
// --------------------------------------------------------------------------

export interface ContextShareServiceOptions {
  config: ContentGeneratorConfig;
  /** GCS bucket URI for enterprise sharing (e.g. "gs://my-bucket"). */
  bucket?: string;
}

export class ContextShareService {
  private readonly provider: ContextStorageProvider;

  constructor(opts: ContextShareServiceOptions) {
    const { config } = opts;
    let { bucket } = opts;

    if (isVertexOrOAuth(config.authType)) {
      if (!bucket) {
        // Zero-config discovery
        const email = new UserAccountManager().getCachedGoogleAccount();
        if (email) {
          bucket = getDefaultSharedBucket(email);
        }
      }

      if (bucket) {
        this.provider = new GcsProvider(bucket);
      } else {
        throw new Error(
          'Enterprise context sharing requires a GCS bucket.\n' +
            'Either configure "share.bucket" in your settings, ' +
            'or login via /login to enable automatic bucket discovery.',
        );
      }
    } else if (config.authType === AuthType.USE_GEMINI && config.apiKey) {
      this.provider = new GeminiFilesProvider(config.apiKey);
    } else {
      throw new Error(
        'Context sharing requires either:\n' +
          '  • Gemini API key authentication (GEMINI_API_KEY), or\n' +
          '  • Vertex AI / OAuth authentication (optionally with share.bucket configured).',
      );
    }
  }

  getProviderName(): string {
    return this.provider instanceof GcsProvider
      ? 'GCS (Enterprise)'
      : 'Gemini API';
  }

  /**
   * Serialises and uploads conversation history for a teammate.
   */
  async share(params: {
    to: string;
    from: string;
    model: string;
    history: Content[];
    label?: string;
  }): Promise<void> {
    if (params.history.length === 0) {
      throw new Error('No conversation history to share.');
    }
    await this.provider.upload(params);
  }

  /**
   * Returns all shared-context entries addressed to `me`, newest-first.
   */
  async listInbox(me: string): Promise<SharedContextEnvelope[]> {
    return this.provider.list(me);
  }

  /**
   * Downloads and deserialises the conversation history for a shared entry.
   */
  async loadShared(fileName: string): Promise<Content[]> {
    return this.provider.download(fileName);
  }

  /**
   * Deletes a shared context entry (e.g. after loading or dismissing).
   */
  async dismiss(fileName: string): Promise<void> {
    return this.provider.delete(fileName);
  }

  /**
   * Generates a detailed recipient-oriented briefing from a loaded conversation
   * history. Produces a structured summary covering objective, work done, key
   * decisions, current status, and next steps.
   */
  async summarizeShared(
    history: Content[],
    config: Config,
    model: string,
  ): Promise<string> {
    const compressionService = new ChatCompressionService();
    return compressionService.summarizeForRecipient(history, config, model);
  }
}

function isVertexOrOAuth(authType: AuthType | undefined): boolean {
  return (
    authType === AuthType.USE_VERTEX_AI ||
    authType === AuthType.LOGIN_WITH_GOOGLE ||
    authType === AuthType.COMPUTE_ADC
  );
}
