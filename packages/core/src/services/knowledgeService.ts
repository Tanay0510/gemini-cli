/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as process from 'node:process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Content } from '@google/genai';
import type { GcsProvider } from './gcsProvider.js';
import { SessionSummaryService } from './sessionSummaryService.js';
import type { BaseLlmClient } from '../core/baseLlmClient.js';
import { LlmRole } from '../telemetry/types.js';
import type { KnowledgeSnippet, KnowledgeRequest } from './types.js';
import type { MessageRecord } from './chatRecordingService.js';
import { debugLogger } from '../utils/debugLogger.js';

/** Shape of a message as stored in session JSON files. */
interface StoredMessage {
  type?: string;
  timestamp?: string;
  content?: unknown[];
}

interface StoredSession {
  messages?: StoredMessage[];
}

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
    projectOriginHash?: string;
    projectRoot?: string;
  }): Promise<KnowledgeSnippet | null> {
    const { userEmail, history, model, projectOriginHash, projectRoot } =
      params;

    // 1. Generate summary using SessionSummaryService
    const messages = history.map((c, i) => ({
      id: `msg-${i}`,
      timestamp: String(Date.now()),
      type: c.role === 'user' ? ('user' as const) : ('gemini' as const),
      content: c.parts ?? [],
    }));

    const summary = await this.summaryService.generateSummary({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      messages: messages as unknown as MessageRecord[],
    });
    if (!summary) return null;

    // 2. Extract the "Full Recipe" (Commands, Code, Logic)
    const provenCommands = this.extractProvenCommands(history);
    const codeChanges = this.extractCodeChanges(history);
    const logicTrace = this.extractLogicTrace(history);

    const emailHash = createHash('sha256').update(userEmail).digest('hex');
    const timestamp = Date.now();
    const id = `sol--${timestamp}`;

    const snippet: KnowledgeSnippet = {
      id,
      userEmailHash: emailHash,
      projectOriginHash,
      summary,
      tags: [],
      timestamp,
      model,
      provenCommands,
      codeChanges,
      logicTrace,
      environment: {
        os: os.platform(),
        nodeVersion: process.version,
        projectRoot,
      },
    };

    const fileName = `knowledge/${emailHash}/${id}.json`;
    await this.gcsProvider.uploadJson(fileName, snippet);

    debugLogger.debug(
      `[KnowledgeService] Published recipe solution: ${fileName}`,
    );
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
    projectOriginHash?: string;
  }): Promise<void> {
    const { fromEmail, toEmail, query, projectOriginHash } = params;
    const toHash = createHash('sha256').update(toEmail).digest('hex');
    const fromHash = createHash('sha256').update(fromEmail).digest('hex');
    const timestamp = Date.now();
    const id = `req--${fromHash}--${timestamp}`;

    const request: KnowledgeRequest = {
      id,
      fromEmail,
      fromEmailHash: fromHash,
      projectOriginHash,
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

    // Sort by timestamp descending (latest first)
    return requests.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
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

  /**
   * Extracts successful shell commands from history.
   */
  private extractProvenCommands(history: Content[]): string[] {
    const commands: string[] = [];
    for (let i = 0; i < history.length; i++) {
      const turn = history[i];
      if (turn.role === 'model' && turn.parts) {
        for (const part of turn.parts) {
          if (
            'functionCall' in part &&
            part.functionCall?.name === 'run_shell_command'
          ) {
            const args = part.functionCall.args;
            const command =
              typeof args?.['command'] === 'string'
                ? args['command']
                : undefined;

            // Look for the response in the next user turn
            const nextTurn = history[i + 1];
            if (nextTurn?.role === 'user' && nextTurn.parts) {
              const responsePart = nextTurn.parts.find(
                (p) =>
                  'functionResponse' in p &&
                  p.functionResponse?.name === 'run_shell_command',
              );
              const response = responsePart?.functionResponse?.response;

              // Only include if it was successful (not code 1)
              if (
                command &&
                typeof response?.['output'] === 'string' &&
                !response['output'].includes('Exit Code: 1')
              ) {
                commands.push(command);
              }
            }
          }
        }
      }
    }
    return commands;
  }

  /**
   * Extracts file creations and edits from history.
   */
  private extractCodeChanges(
    history: Content[],
  ): Array<{ path: string; content: string }> {
    const changes: Array<{ path: string; content: string }> = [];
    for (const turn of history) {
      if (turn.role === 'model' && turn.parts) {
        for (const part of turn.parts) {
          if ('functionCall' in part && part.functionCall) {
            const name = part.functionCall.name;
            const args = part.functionCall.args;
            if (
              (name === 'write_file' || name === 'edit') &&
              typeof args?.['file_path'] === 'string' &&
              typeof args?.['content'] === 'string'
            ) {
              changes.push({
                path: args['file_path'],
                content: args['content'],
              });
            }
          }
        }
      }
    }
    return changes;
  }

  /**
   * Extracts the agent's key reasoning steps.
   */
  private extractLogicTrace(history: Content[]): string[] {
    const trace: string[] = [];
    for (const turn of history) {
      if (turn.role === 'model' && turn.parts) {
        const textPart = turn.parts.find((p) => 'text' in p);
        if (textPart && 'text' in textPart && textPart.text) {
          // Simple heuristic: extract first sentence that sounds like reasoning
          const reasoning = textPart.text.split('\n')[0].trim();
          if (reasoning && reasoning.length > 10 && reasoning.length < 200) {
            trace.push(reasoning);
          }
        }
      }
    }
    return trace.slice(-5); // Keep last 5 reasoning steps
  }

  /**
   * Searches local history files for the best matching session.
   */
  async findBestSession(
    chatsDir: string,
    query: string,
  ): Promise<{ fileName: string; summary: string } | null> {
    try {
      const files = await fs.readdir(chatsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));

      if (jsonFiles.length === 0) return null;

      const candidates: Array<{ fileName: string; summary: string }> = [];

      // Scan most recent 10 sessions for efficiency
      const sortedFiles = jsonFiles.sort().reverse().slice(0, 10);

      for (const fileName of sortedFiles) {
        try {
          const content = await fs.readFile(
            path.join(chatsDir, fileName),
            'utf-8',
          );
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const data = JSON.parse(content) as unknown as StoredSession;

          // Generate a quick summary of this local file
          const messages = (data.messages ?? []).map((m, i) => ({
            id: `msg-${i}`,
            timestamp: m.timestamp ?? String(Date.now()),
            type: m.type === 'user' ? ('user' as const) : ('gemini' as const),
            content: m.content ?? [],
          }));

          const summary = await this.summaryService.generateSummary({
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            messages: messages as unknown as MessageRecord[],
          });
          if (summary) {
            candidates.push({ fileName, summary });
          }
        } catch {
          continue;
        }
      }

      if (candidates.length === 0) return null;

      // Use rankSnippets logic to find the best match
      const snippetWrappers = candidates.map((c, i) => ({
        id: i.toString(),
        userEmailHash: '',
        summary: c.summary,
        tags: [],
        timestamp: 0,
        model: '',
      }));

      const bestMatches = await this.rankSnippets(query, snippetWrappers);
      if (bestMatches.length > 0) {
        const index = parseInt(bestMatches[0].id, 10);
        return candidates[index];
      }

      return null;
    } catch (err) {
      debugLogger.warn('Failed to find best session:', err);
      return null;
    }
  }

  /**
   * Loads raw Content history from a session file.
   */
  async loadSessionHistory(filePath: string): Promise<Content[]> {
    const content = await fs.readFile(filePath, 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = JSON.parse(content) as unknown as StoredSession;
    // Convert session messages back to raw Content format
    return (data.messages ?? []).map(
      (m): Content => ({
        role: m.type === 'user' ? 'user' : 'model',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        parts: (m.content ?? []) as Content['parts'],
      }),
    );
  }
}
