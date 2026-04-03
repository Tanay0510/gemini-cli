/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { Content } from '@google/genai';
import type { GcsProvider } from './gcsProvider.js';
import { SessionSummaryService } from './sessionSummaryService.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import { LlmRole } from '../telemetry/types.js';
import type { KnowledgeSnippet, KnowledgeRequest } from './types.js';
import { debugLogger } from '../utils/debugLogger.js';

/**
 * Service for managing the team knowledge base and agent-to-agent requests.
 */
export class KnowledgeService {
  private readonly summaryService: SessionSummaryService;

  constructor(
    private readonly gcsProvider: GcsProvider,
    private readonly llmClient: BaseLlmClient,
  ) {
    this.summaryService = new SessionSummaryService(llmClient);
  }

  /**
   * Generates a summary of the provided history and publishes it to the team knowledge folder.
   */
  async publishSolution(params: {
    userEmail: string;
    history: Content[];
    model: string;
  }): Promise<KnowledgeSnippet | null> {
    const { userEmail, history, model } = params;

    // 1. Generate summary using SessionSummaryService
    // Note: SessionSummaryService expects MessageRecord[], but we have Content[].
    // We'll do a simple conversion for the summarizer.
    // We'll do a simple conversion for the summarizer.
    const messages = history.map((c, i) => ({
      id: `msg-${i}`,
      timestamp: String(Date.now()),
      type: c.role === 'user' ? ('user' as const) : ('gemini' as const),
      content: c.parts ?? [],
    }));

    const summary = await this.summaryService.generateSummary({ messages });
    if (!summary) return null;

    const emailHash = createHash('sha256').update(userEmail).digest('hex');
    const timestamp = Date.now();
    const id = `sol--${timestamp}`;

    const snippet: KnowledgeSnippet = {
      id,
      userEmailHash: emailHash,
      summary,
      tags: [], // Could be extracted by LLM in future
      timestamp,
      model,
    };

    const fileName = `knowledge/${emailHash}/${id}.json`;
    await this.gcsProvider.uploadJson(fileName, snippet);

    debugLogger.debug(`[KnowledgeService] Published solution: ${fileName}`);
    return snippet;
  }

  /**
   * Scans a teammate's knowledge directory and finds snippets matching the query.
   */
  async findSolutions(
    query: string,
    teammateEmail: string,
  ): Promise<KnowledgeSnippet[]> {
    const emailHash = createHash('sha256').update(teammateEmail).digest('hex');
    const prefix = `knowledge/${emailHash}/`;

    const objects = await this.gcsProvider.listWithPrefix(prefix);
    if (objects.length === 0) return [];

    const snippets: KnowledgeSnippet[] = [];
    for (const obj of objects) {
      try {
        const snippet = await this.gcsProvider.downloadJson<KnowledgeSnippet>(
          obj.name,
        );
        snippets.push(snippet);
      } catch (err) {
        debugLogger.warn(`Failed to download snippet ${obj.name}:`, err);
      }
    }

    if (snippets.length === 0) return [];

    // Semantic matching using LLM
    return this.rankSnippets(query, snippets);
  }

  /**
   * Sends a private knowledge request to a teammate's agent.
   */
  async sendRequest(params: {
    fromEmail: string;
    toEmail: string;
    query: string;
  }): Promise<void> {
    const { fromEmail, toEmail, query } = params;
    const toHash = createHash('sha256').update(toEmail).digest('hex');
    const fromHash = createHash('sha256').update(fromEmail).digest('hex');
    const timestamp = Date.now();
    const id = `req--${fromHash}--${timestamp}`;

    const request: KnowledgeRequest = {
      id,
      fromEmail,
      fromEmailHash: fromHash,
      query,
      timestamp,
      status: 'pending',
    };

    const fileName = `requests/${toHash}/${id}.json`;
    await this.gcsProvider.uploadJson(fileName, request);
    debugLogger.debug(`[KnowledgeService] Sent request: ${fileName}`);
  }

  /**
   * Lists pending requests for the current user.
   */
  async listPendingRequests(myEmail: string): Promise<KnowledgeRequest[]> {
    const myHash = createHash('sha256').update(myEmail).digest('hex');
    const prefix = `requests/${myHash}/`;

    const objects = await this.gcsProvider.listWithPrefix(prefix);
    const requests: KnowledgeRequest[] = [];

    for (const obj of objects) {
      try {
        const req = await this.gcsProvider.downloadJson<KnowledgeRequest>(
          obj.name,
        );
        if (req.status === 'pending') {
          requests.push(req);
        }
      } catch (err) {
        debugLogger.warn(`Failed to download request ${obj.name}:`, err);
      }
    }

    return requests;
  }

  /**
   * Simple LLM-based ranking of snippets against a query.
   */
  private async rankSnippets(
    query: string,
    snippets: KnowledgeSnippet[],
  ): Promise<KnowledgeSnippet[]> {
    if (snippets.length === 0) return [];

    const prompt = `Given the user query: "${query}"
Which of the following solution summaries are relevant? 
Return a comma-separated list of IDs, or "none" if none are relevant.

Solutions:
${snippets.map((s) => `[${s.id}] ${s.summary}`).join('\n')}

Relevant IDs:`;

    try {
      const response = await this.llmClient.generateContent({
        modelConfigKey: { model: 'summarizer-default' },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        abortSignal: new AbortController().signal,
        promptId: 'knowledge-ranking',
        role: LlmRole.UTILITY_SUMMARIZER,
      });

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text.toLowerCase().includes('none')) return [];

      const relevantIds = text
        .split(',')
        .map((id) => id.trim())
        .filter((id) => !!id);
      return snippets.filter((s) => relevantIds.includes(s.id));
    } catch (err) {
      debugLogger.warn('Failed to rank snippets:', err);
      return [];
    }
  }
}
