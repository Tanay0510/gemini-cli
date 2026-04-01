/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';

interface ContextBriefingDisplayProps {
  from: string;
  model: string;
  summary: string;
}

/** Section header emojis produced by the briefing prompt. */
const SECTION_EMOJIS = ['🎯', '🔧', '✅', '📍', '🔜'];

/**
 * Returns true if a line is a section header (starts with a known emoji).
 */
function isSectionHeader(line: string): boolean {
  return SECTION_EMOJIS.some((emoji) => line.startsWith(emoji));
}

/**
 * Strips any stray markdown that slips through despite the prompt instruction:
 * - **bold** → bold text kept, asterisks removed
 * - *italic* → text kept, asterisks removed
 * - `code` → text kept, backticks removed
 * - Leading "* " list markers → "• "
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold**
    .replace(/\*(.+?)\*/g, '$1') // *italic*
    .replace(/`(.+?)`/g, '$1') // `code`
    .replace(/^\s*\*\s+/, '• '); // * list item → bullet
}

/**
 * Renders a distinct, boxed "Context Briefing" panel after a user loads a
 * shared conversation via `/inbox load`. It shows the sender's identity, the
 * model used, and an AI-generated structured briefing of the loaded context.
 *
 * The summary text is rendered with smart section detection:
 * - Lines starting with a known section emoji are rendered as bold headers.
 * - Bullet lines are indented and dimmed slightly.
 * - Consecutive blank lines are collapsed to a single spacer.
 * - Stray markdown syntax is stripped.
 */
export const ContextBriefingDisplay: React.FC<ContextBriefingDisplayProps> = ({
  from,
  model,
  summary,
}) => {
  const cleanModel = model.replace(/^models\//, '').replace(/^auto-/, '');
  const isVerified = from.includes('@');
  const verifiedLabel = isVerified ? '✓ verified' : '⚠ unverified';
  const verifiedColor = isVerified
    ? theme.status.success
    : theme.status.warning;

  // Collapse runs of blank lines to at most one, then clean each line.
  const lines = summary.split('\n').reduce<string[]>((acc, line) => {
    const trimmed = line.trim();
    if (trimmed === '') {
      // Only push a blank if the last element wasn't already blank
      if (acc.length > 0 && acc[acc.length - 1] !== '') {
        acc.push('');
      }
    } else {
      acc.push(stripMarkdown(trimmed));
    }
    return acc;
  }, []);

  // Drop leading / trailing blanks
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  return (
    <Box
      borderStyle="round"
      borderColor={theme.text.accent}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      marginY={1}
      width="100%"
    >
      {/* ── Header ── */}
      <Box marginBottom={1} flexDirection="row" gap={1}>
        <Text bold color={theme.text.accent}>
          📖 Context Briefing
        </Text>
        <Text color={theme.text.secondary}>·</Text>
        <Text bold color={theme.text.primary}>
          {from}
        </Text>
        <Text color={verifiedColor}>[{verifiedLabel}]</Text>
      </Box>

      {/* ── Meta row ── */}
      <Box marginBottom={1} flexDirection="row" gap={1}>
        <Text color={theme.text.secondary}>Model:</Text>
        <Text color={theme.text.primary}>{cleanModel}</Text>
      </Box>

      {/* ── Divider ── */}
      <Box marginBottom={1}>
        <Text color={theme.border.default}>{'─'.repeat(56)}</Text>
      </Box>

      {/* ── Briefing body ── */}
      {lines.map((line, index) => {
        if (line === '') {
          // Blank separator between sections — just a small gap
          return <Box key={index} marginBottom={0} />;
        }

        if (isSectionHeader(line)) {
          // Section header — bold, accent color, small gap above (unless first)
          return (
            <Box key={index} marginTop={index === 0 ? 0 : 1}>
              <Text bold color={theme.text.accent}>
                {line}
              </Text>
            </Box>
          );
        }

        if (line.startsWith('•')) {
          // Bullet point — indented
          return (
            <Box key={index} paddingLeft={2}>
              <Text color={theme.text.primary} wrap="wrap">
                {line}
              </Text>
            </Box>
          );
        }

        // Regular paragraph text
        return (
          <Text key={index} color={theme.text.primary} wrap="wrap">
            {line}
          </Text>
        );
      })}

      {/* ── Footer ── */}
      <Box marginTop={1}>
        <Text color={theme.text.secondary} dimColor>
          Context loaded — continue from where they left off.
        </Text>
      </Box>
    </Box>
  );
};
