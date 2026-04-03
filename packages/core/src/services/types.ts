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
  summary: string;
  tags: string[];
  timestamp: number;
  model: string;
}

export interface KnowledgeRequest {
  id: string;
  fromEmail: string;
  fromEmailHash: string;
  query: string;
  timestamp: number;
  status: 'pending' | 'fulfilled' | 'denied';
}
