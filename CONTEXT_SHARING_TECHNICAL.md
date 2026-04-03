# Technical Documentation: Team Knowledge & Context Sharing

This document provides a technical overview of the collaborative features in
Gemini CLI, including Context Sharing and the Agent-to-Agent (A2A) Knowledge
Pulse.

---

## 1. High-Level Architecture

The collaboration system uses **Google Cloud Storage (GCS)** as a serverless
message bus and knowledge repository. It is designed for "Zero-Config"
enterprise use.

### The Two Pillars of Collaboration:

1.  **Context Sharing (`/share` & `/inbox`):** Explicitly sending a full
    conversation history to a specific teammate.
2.  **A2A Knowledge Pulse (`/ask` & Auto-indexing):** Implicitly sharing
    "learned solutions" across the team without interrupting humans.

---

## 2. Agent-to-Agent (A2A) Knowledge Pulse

### A. Automated Indexing

When an agent successfully completes a task (detected via the `complete_task`
tool), the system performs an automatic "Post-Mortem":

1.  **Summarization:** Uses `SessionSummaryService` to generate a one-sentence
    summary of the solution.
2.  **Privacy Scrubbing:** Redacts local paths, secrets, and PII from the
    summary.
3.  **GCS Upload:** Stores a `KnowledgeSnippet` JSON at:
    `gs://<bucket>/knowledge/<sha256(user_email)>/sol--<ts>.json`

### B. Discovery via `/ask`

The `/ask @teammate <query>` command allows a user to query their team's
collective brain:

1.  **Semantic Search:** Scans the teammate's (or team's) knowledge folder and
    uses an LLM to rank snippets by relevance to the user's query.
2.  **Passive Request:** If no public solution is found, the agent drops a
    `KnowledgeRequest` ticket at:
    `gs://<bucket>/requests/<sha256(teammate_email)>/req--<id>.json`

### C. Fulfillment Workflow

The recipient's CLI periodically polls for requests in their `requests/` prefix.

- **Notification:** The user is alerted: "You have pending teammate knowledge
  requests."
- **Fulfillment:** `/ask --fulfill <#>` initiates a local search of the user's
  private history to find a match.

---

## 3. Context Sharing Implementation

### Storage Routing

- **Enterprise (OAuth/Vertex):** Uses `GcsProvider`. Automatically discovers
  bucket `gs://gemini-shared-<domain>`.
- **Individual (API Key):** Uses `GeminiFilesProvider` (Gemini Files API).

### Path Structure (GCS)

- **Inboxes:** `inbox/<sha256(recipient)>/share--from--<sender>--<ts>.json`
- **Org Directory:** `metadata/org-directory.json`

---

## 4. Admin Governance & Security

### Admin Policies

Administrators can "lock" settings via the `admin.share` schema:

- `admin.share.enabled`: Force-disable sharing for the whole org.
- `admin.share.bucket`: Force-set a specific GCS bucket, ignoring user config.

### Privacy Guardrails

1.  **Hashed Identities:** Recipient emails are always hashed in cloud storage
    paths.
2.  **No Full History:** A2A Knowledge Pulse only shares **summaries**. Full
    history/code never leaves the machine without explicit user consent
    (`[y/n]`).
3.  **Domain Whitelisting:** Users can restrict sharing to specific corporate
    domains via `allowedDomains`.
