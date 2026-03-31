/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleAuth } from 'google-auth-library';
import { createHash } from 'node:crypto';
import type { Content } from '@google/genai';
import type {
  ContextStorageProvider,
  SharedContextEnvelope,
} from './contextStorageProvider.js';

// --------------------------------------------------------------------------
// GCS path layout
//
// All shares live inside a single bucket configured via settings:
//
//   gs://<bucket>/inbox/<sha256(recipient)>/share--from--<sender>--<ts>.json
//
// Object custom metadata carries: from, model, label, timestamp.
// This avoids filename parsing and keeps queries simple.
// --------------------------------------------------------------------------

const GCS_API_BASE = 'https://storage.googleapis.com/storage/v1';
const GCS_UPLOAD_BASE = 'https://storage.googleapis.com/upload/storage/v1';
const SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function inboxPrefix(recipientEmail: string): string {
  return `inbox/${sha256(recipientEmail)}/`;
}

function objectName(
  recipientEmail: string,
  from: string,
  model: string,
  timestamp: number,
): string {
  const safeFrom = from.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const safeModel = model
    .replace(/models\//, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${inboxPrefix(recipientEmail)}share--from--${safeFrom}--model--${safeModel}--${timestamp}.json`;
}

interface GcsObjectMetadata {
  name: string;
  metadata?: Record<string, string>;
}

interface GcsListResponse {
  items?: GcsObjectMetadata[];
  nextPageToken?: string;
}

/**
 * ContextStorageProvider backed by Google Cloud Storage.
 *
 * Suitable for Vertex AI / OAuth / ADC users. Uses a shared GCS bucket
 * with prefix-based "virtual inboxes" keyed by SHA-256 of the recipient
 * email.  Metadata (from, model, label, ts) is stored in GCS object
 * custom metadata, making listing and filtering efficient without parsing
 * filenames.
 *
 * Authentication uses Application Default Credentials via `google-auth-library`.
 * The bucket must already exist and the user must have `storage.objects.*`
 * permissions on their inbox prefix.
 */
export class GcsProvider implements ContextStorageProvider {
  private readonly bucketName: string;
  private readonly auth: GoogleAuth;

  constructor(bucketUri: string) {
    // Accept "gs://bucket-name" or just "bucket-name"
    const cleaned = bucketUri.replace(/^gs:\/\//, '').replace(/\/$/, '');
    if (!cleaned) {
      throw new Error(
        'A GCS bucket URI is required for enterprise context sharing. ' +
          'Set share.bucket in settings.',
      );
    }
    this.bucketName = cleaned;
    this.auth = new GoogleAuth({ scopes: [SCOPE] });
  }

  private async getAccessToken(): Promise<string> {
    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    if (!tokenResponse.token) {
      throw new Error(
        'Could not obtain an access token. Ensure you are authenticated via ' +
          '`gcloud auth application-default login` or have valid ADC configured.',
      );
    }
    return tokenResponse.token;
  }

  async upload(params: {
    to: string;
    from: string;
    model: string;
    history: Content[];
    label?: string;
  }): Promise<void> {
    const { to, from, model, history, label } = params;
    const timestamp = Date.now();
    const name = objectName(to, from, model, timestamp);
    const token = await this.getAccessToken();
    const body = JSON.stringify(history);

    const customMetadata: Record<string, string> = {
      'x-goog-meta-share-from': from,
      'x-goog-meta-share-model': model,
      'x-goog-meta-share-ts': String(timestamp),
    };
    if (label) {
      customMetadata['x-goog-meta-share-label'] = label;
    }

    const url =
      `${GCS_UPLOAD_BASE}/b/${encodeURIComponent(this.bucketName)}/o` +
      `?uploadType=media&name=${encodeURIComponent(name)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...customMetadata,
      },
      body,
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Failed to upload shared context to GCS (HTTP ${response.status}): ${errorBody}`,
      );
    }
  }

  async list(recipientEmail: string): Promise<SharedContextEnvelope[]> {
    const token = await this.getAccessToken();
    const prefix = inboxPrefix(recipientEmail);
    const results: SharedContextEnvelope[] = [];

    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        prefix,
        maxResults: '100',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const url = `${GCS_API_BASE}/b/${encodeURIComponent(this.bucketName)}/o?${params.toString()}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(
          `Failed to list inbox from GCS (HTTP ${response.status}): ${errorBody}`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const data = (await response.json()) as GcsListResponse;
      for (const obj of data.items ?? []) {
        const meta = obj.metadata || {};
        const from = meta['share-from'] || meta['x-goog-meta-share-from'];
        const model = meta['share-model'] || meta['x-goog-meta-share-model'];
        const ts = meta['share-ts'] || meta['x-goog-meta-share-ts'];

        // Fallback: Parse from filename if metadata is missing (Enterprise-friendly)
        if (!from || !model || !ts) {
          const match =
            obj.name.match(/share--from--(.+)--model--(.+)--(\d+)\.json$/) ||
            obj.name.match(/share--from--(.+)--(\d+)\.json$/);
          if (match) {
            const isLegacy = match.length === 3;
            results.push({
              fileName: obj.name,
              from: match[1].replace(/_/g, ' '),
              to: recipientEmail,
              model: isLegacy ? 'unknown' : match[2],
              timestamp: parseInt(match[isLegacy ? 2 : 3], 10),
            });
          }
          continue;
        }

        results.push({
          fileName: obj.name,
          from,
          to: recipientEmail,
          model,
          timestamp: parseInt(ts, 10),
          label: meta['share-label'] || meta['x-goog-meta-share-label'],
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  async download(fileName: string): Promise<Content[]> {
    const token = await this.getAccessToken();
    const url =
      `${GCS_API_BASE}/b/${encodeURIComponent(this.bucketName)}/o/` +
      `${encodeURIComponent(fileName)}?alt=media`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Failed to download shared context from GCS (HTTP ${response.status}): ${errorBody}`,
      );
    }

    const json = await response.text();
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return JSON.parse(json) as Content[];
    } catch {
      throw new Error(
        'Failed to parse shared context from GCS. The content may be corrupted.',
      );
    }
  }

  async delete(fileName: string): Promise<void> {
    const token = await this.getAccessToken();
    const url =
      `${GCS_API_BASE}/b/${encodeURIComponent(this.bucketName)}/o/` +
      `${encodeURIComponent(fileName)}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok && response.status !== 404) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `Failed to delete shared context from GCS (HTTP ${response.status}): ${errorBody}`,
      );
    }
  }
}
