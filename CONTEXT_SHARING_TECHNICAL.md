# Technical Documentation: Team Context Sharing

This document provides a technical overview and in-depth code analysis of the
context sharing feature in Gemini CLI.

---

## 1. High-Level Overview

The sharing system is designed to be "Zero-Config" for enterprise users while
maintaining high security and privacy.

### The Workflow

1.  **Identity Resolution:** The CLI identifies the sender using their verified
    Google account (if logged in) or a configured handle.
2.  **Smart Summarization:** The CLI generates a professional TL;DR summary of
    the conversation and prepends it to the history.
3.  **Storage Routing:**
    - **Enterprise:** If the user is authenticated via Vertex AI or Google
      OAuth, the CLI automatically discovers a GCS bucket named
      `gs://gemini-shared-<domain>` and uploads the context.
    - **Individual:** If using an API key, it falls back to the Gemini Files
      API.
4.  **Hashed Inbox:** Recipients have a "Virtual Inbox" identified by the
    SHA-256 hash of their email address.
5.  **Retrieval:** Teammates run `/inbox` to see a list of shares and
    `/inbox load <#>` to inject that history into their current session.

---

## 2. In-Depth Technical Details

### A. The `/share` Command

**Location:** `packages/cli/src/ui/commands/shareTeamCommand.ts`

- **Argument Parsing:** Parses multiple recipients (`@alice @bob`) and labels.
- **Normalization:** Converts short handles into full emails based on domain.
- **Policy Enforcement:** Enforces `allowedDomains` and `requireVerification`
  settings before initiating any cloud requests.
- **Summarization:** Prepends an LLM-generated summary turn to the history.

### B. The `/inbox` Command

**Location:** `packages/cli/src/ui/commands/inboxCommand.ts`

- **Virtual View:** Lists entries via `ContextShareService` from the hashed
  prefix.
- **Provider Transparency:** Displays whether contexts are from GCS or Gemini
  API.

### C. ContextShareService & Providers

- **Hybrid Boot Sync:** The `AppContainer` triggers a background sync on
  startup. It uses a **Dual-Layer Cache** (local settings + cloud fetch) with a
  4-hour TTL.
- **GcsProvider (Multipart Upload):** Uses the `multipart/related` GCS JSON API
  to reliably store custom metadata (`share-label`, `share-from`, etc.)
  alongside the history JSON.

---

## 3. Configuration & Security

### Settings Schema

- `share.enabled`: Global kill-switch.
- `share.autoSyncDirectory`: Background teammate discovery.
- `share.autoSyncInbox`: Background new-share checking.
- `share.requireVerification`: Identity strictness.
- `share.allowedDomains`: Domain guardrails.

### Data Security

1.  **Hashed Virtual Inboxes:** Recipient email is never stored in plain text in
    storage paths.
2.  **Verified Signing:** Enterprise shares use the OAuth identity, making the
    `from` field unfakeable.
3.  **Environment Stripping:** Automatically removes `<session_context>` and
    local system rules before sharing.
