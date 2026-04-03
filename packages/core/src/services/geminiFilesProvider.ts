/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, type Content } from '@google/genai';
import type {
  ContextStorageProvider,
  SharedContextEnvelope,
} from './contextStorageProvider.js';

// --------------------------------------------------------------------------
// Display-name encoding
//
// We use the Files API displayName as a lightweight routing mechanism so that
// no external database is required.  Format (512-char limit on the field):
//
//   gemini-share::to:<name>::from:<name>::model:<model>::ts:<epoch>[::label:<encoded>]
//
// The model component replaces "/" with "-" to stay URL-safe.
// The label component is optional and URL-encoded via encodeURIComponent.
// --------------------------------------------------------------------------

const SHARE_PREFIX = 'gemini-share';
const SEP = '::';

function encodeDisplayName(
  to: string,
  from: string,
  model: string,
  timestamp: number,
  label?: string,
): string {
  const parts = [
    SHARE_PREFIX,
    `to:${to}`,
    `from:${from}`,
    `model:${model.replace(/\//g, '-')}`,
    `ts:${timestamp}`,
  ];
  if (label) {
    parts.push(`label:${encodeURIComponent(label)}`);
  }
  return parts.join(SEP);
}

function decodeDisplayName(
  displayName: string,
): Omit<SharedContextEnvelope, 'fileName'> | null {
  if (!displayName.startsWith(SHARE_PREFIX + SEP)) return null;
  try {
    const map: Record<string, string> = {};
    for (const part of displayName.split(SEP).slice(1)) {
      const idx = part.indexOf(':');
      if (idx === -1) return null;
      map[part.slice(0, idx)] = part.slice(idx + 1);
    }
    if (!map['to'] || !map['from'] || !map['model'] || !map['ts']) return null;
    return {
      to: map['to'],
      from: map['from'],
      model: map['model'].replace(/-/g, '/'),
      timestamp: parseInt(map['ts'], 10),
      ...(map['label'] !== undefined && {
        label: decodeURIComponent(map['label']),
      }),
    };
  } catch {
    return null;
  }
}

/**
 * ContextStorageProvider backed by the Gemini Files API.
 *
 * Suitable for API-key (USE_GEMINI) users.  Routing metadata is encoded
 * entirely in the displayName — no external database is required.
 * Files auto-expire after 48 hours.
 *
 * **Limitation:** The Files API does not support downloading user-uploaded
 * content.  `loadShared` asks the model to echo the JSON back, which
 * consumes model quota.
 */
export class GeminiFilesProvider implements ContextStorageProvider {
  private readonly genai: GoogleGenAI;

  constructor(apiKey: string) {
    this.genai = new GoogleGenAI({ apiKey });
  }

  async upload(params: {
    to: string;
    from: string;
    model: string;
    history: Content[];
    label?: string;
  }): Promise<void> {
    const { to, from, model, history, label } = params;
    const displayName = encodeDisplayName(to, from, model, Date.now(), label);
    const blob = new Blob([JSON.stringify(history)], {
      type: 'application/json',
    });

    await this.genai.files.upload({
      file: blob,
      config: { displayName, mimeType: 'application/json' },
    });
  }

  async list(me: string): Promise<SharedContextEnvelope[]> {
    const results: SharedContextEnvelope[] = [];

    const pager = await this.genai.files.list({
      config: { pageSize: 100 },
    });

    for await (const file of pager) {
      const parsed = decodeDisplayName(file.displayName ?? '');
      if (parsed && parsed.to === me) {
        results.push({ fileName: file.name!, ...parsed });
      }
    }

    return results.sort((a, b) => b.timestamp - a.timestamp);
  }

  async download(fileName: string): Promise<Content[]> {
    const file = await this.genai.files.get({ name: fileName });
    if (!file.uri) {
      throw new Error(
        'Could not retrieve file URI. The share may have expired (files expire after 48 hours).',
      );
    }

    const response = await this.genai.models.generateContent({
      model: 'gemini-2.5-flash-lite',
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: file.uri, mimeType: 'application/json' } },
            {
              text: 'Output the exact raw JSON content of the attached file. Output only the JSON with no commentary, markdown, or code blocks.',
            },
          ],
        },
      ],
    });

    const rawText = response.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const json = rawText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return JSON.parse(json) as Content[];
    } catch {
      throw new Error(
        'Failed to parse shared context. The content may be corrupted or too large to extract.',
      );
    }
  }

  async delete(fileName: string): Promise<void> {
    await this.genai.files.delete({ name: fileName });
  }

  async downloadOrgDirectory(): Promise<string[]> {
    return [];
  }
}
