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

const GCS_BASE = 'https://www.googleapis.com/storage/v1';
const GCS_UPLOAD_BASE = 'https://www.googleapis.com/upload/storage/v1';

interface GcsObject {
  name: string;
  metadata?: Record<string, string>;
}

interface GcsListResponse {
  items?: GcsObject[];
  nextPageToken?: string;
}

interface GcsOrgDirectoryResponse {
  teammates?: string[];
}

/**
 * Enterprise sharing provider that stores context objects in a GCS bucket.
 * Bucket name is typically discovered from the user's email domain or
 * explicitly configured in settings.
 */
export class GcsProvider implements ContextStorageProvider {
  private auth: GoogleAuth | undefined;

  constructor(private readonly bucketName: string) {
    if (!bucketName) {
      throw new Error('GcsProvider requires a bucket name.');
    }
  }

  private async getAccessToken(): Promise<string> {
    if (!this.auth) {
      this.auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    }
    const client = await this.auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) {
      throw new Error('Failed to retrieve Google Cloud access token.');
    }
    return token.token;
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

    const boundary = `-------boundary_${Date.now()}`;
    const metadata = {
      name,
      metadata: {
        'share-from': from,
        'share-model': model,
        'share-ts': String(timestamp),
        ...(label && { 'share-label': label }),
      },
    };

    const part1 = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      '',
    ].join('\r\n');

    const part2 = [
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      body,
      '',
      `--${boundary}--`,
    ].join('\r\n');

    const url = `${GCS_UPLOAD_BASE}/b/${encodeURIComponent(this.bucketName)}/o?uploadType=multipart`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: part1 + part2,
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
    const results: SharedContextEnvelope[] = [];
    const prefix = `${createHash('sha256').update(recipientEmail).digest('hex')}/`;

    let pageToken: string | undefined;
    do {
      const url =
        `${GCS_BASE}/b/${encodeURIComponent(this.bucketName)}/o` +
        `?prefix=${encodeURIComponent(prefix)}&projection=full` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(
          `Failed to list GCS bucket (HTTP ${response.status}): ${errorBody}`,
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const data = (await response.json()) as GcsListResponse;
      for (const obj of data.items ?? []) {
        const meta = obj.metadata || {};

        const from = meta['share-from'];
        const model = meta['share-model'];
        const ts = meta['share-ts'];
        const label = meta['share-label'];

        // Fallback: Parse from filename if metadata is missing (Enterprise-friendly)
        if (!from || !model || !ts) {
          const match =
            obj.name.match(/share--from--(.+)--model--(.+)--(\d+)\.json$/) ||
            obj.name.match(/share--from--(.+)--(\d+)\.json$/);
          if (match) {
            results.push({
              fileName: obj.name,
              from: match[1] || 'unknown',
              to: recipientEmail,
              model: match[2] && isNaN(Number(match[2])) ? match[2] : 'unknown',
              timestamp: parseInt(match[3] || match[2] || '0', 10),
            });
          }
          continue;
        }

        results.push({
          fileName: obj.name,
          from: from || 'unknown',
          to: recipientEmail,
          model: model || 'unknown',
          timestamp: ts ? parseInt(ts, 10) : 0,
          label,
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken);

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  async download(fileName: string): Promise<Content[]> {
    const token = await this.getAccessToken();
    const url =
      `${GCS_BASE}/b/${encodeURIComponent(this.bucketName)}/o/` +
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

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return (await response.json()) as Content[];
    } catch {
      throw new Error(
        'Failed to parse shared context. The content may be corrupted or too large to extract.',
      );
    }
  }

  async delete(fileName: string): Promise<void> {
    const token = await this.getAccessToken();
    const url =
      `${GCS_BASE}/b/${encodeURIComponent(this.bucketName)}/o/` +
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

  async downloadOrgDirectory(): Promise<string[]> {
    const token = await this.getAccessToken();
    const url =
      `${GCS_BASE}/b/${encodeURIComponent(this.bucketName)}/o/` +
      `${encodeURIComponent('metadata/org-directory.json')}?alt=media`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      if (response.status === 404) return [];
      return []; // Silent fail for background fetch
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const data = (await response.json()) as GcsOrgDirectoryResponse;
      return data.teammates ?? [];
    } catch {
      return [];
    }
  }
}

function objectName(
  to: string,
  from: string,
  model: string,
  timestamp: number,
): string {
  const hash = createHash('sha256').update(to).digest('hex');
  const safeFrom = from.replace(/[^a-zA-Z0-9]/g, '_');
  const safeModel = model.replace(/[^a-zA-Z0-9]/g, '_');
  return `${hash}/share--from--${safeFrom}--model--${safeModel}--${timestamp}.json`;
}
