/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AgentHistoryProviderConfig {
  maxTokens: number;
  retainedTokens: number;
  normalMessageTokens: number;
  maximumMessageTokens: number;
  normalizationHeadRatio: number;
  isSummarizationEnabled: boolean;
  isTruncationEnabled: boolean;
}

export interface KnowledgeSnippet {
  id: string;
  userEmailHash: string;
  projectOriginHash?: string;
  summary: string;
  tags: string[];
  timestamp: number;
  model: string;
  /** The specific shell commands that were successful. */
  provenCommands?: string[];
  /** The actual file changes (path and content/diff). */
  codeChanges?: Array<{ path: string; content: string }>;
  /** The agent's reasoning for these steps. */
  logicTrace?: string[];
  /** Environment metadata where the solution was proven. */
  environment?: {
    os: string;
    nodeVersion?: string;
    projectRoot?: string;
  };
}

export interface KnowledgeRequest {
  id: string;
  fromEmail: string;
  fromEmailHash: string;
  projectOriginHash?: string;
  query: string;
  timestamp: number;
  status: 'pending' | 'fulfilled' | 'denied';
}
