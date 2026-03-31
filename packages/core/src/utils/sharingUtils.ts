/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { UserAccountManager } from './userAccountManager.js';
import type { ShareSettings } from '../config/config.js';

/**
 * Derives a default GCS bucket name from a user's email address.
 * Follows the convention: gemini-shared-<domain-with-hyphens>
 * e.g., "user@google.com" -> "gemini-shared-google-com"
 */
export function getDefaultSharedBucket(email: string): string {
  const parts = email.split('@');
  if (parts.length !== 2) {
    return '';
  }
  const domain = parts[1].toLowerCase().replace(/[^a-z0-9]/g, '-');
  return `gs://gemini-shared-${domain}`;
}

/**
 * Removes the initial environment context turn (the large <session_context> block)
 * from the history so that only the actual dialogue is shared.
 */
export function stripEnvironmentContext(
  history: readonly Content[],
): Content[] {
  return history.filter((turn: Content) => {
    const text = turn.parts?.[0]?.text || '';
    // Skip the turn if it looks like the initial session context or directory context
    return (
      !text.includes('<session_context>') &&
      !text.includes('Current Directory Structure:')
    );
  });
}

/**
 * Normalizes a recipient identity. If the recipient is just a handle (no @),
 * and the sender has a domain, it appends the domain to ensure consistency.
 */
export function normalizeRecipient(
  recipient: string,
  senderEmail?: string,
): string {
  const r = recipient.trim().toLowerCase().replace(/^@/, '');
  if (r.includes('@')) {
    return r;
  }
  if (senderEmail && senderEmail.includes('@')) {
    const domain = senderEmail.split('@')[1];
    return `${r}@${domain}`;
  }
  return r;
}

/**
 * Resolves the user's identity with a verified-first priority chain:
 *   1. Google OAuth email  — verified by Google, unfakeable
 *   2. myName setting      — explicit setting, trust-based fallback
 *   3. Default/Fallback    — e.g. OS username
 */
export function resolveUserIdentity(
  settings: ShareSettings,
  fallback?: string,
): string {
  const googleEmail = new UserAccountManager().getCachedGoogleAccount();
  return googleEmail ?? settings.myName?.trim() ?? fallback ?? 'unknown';
}
