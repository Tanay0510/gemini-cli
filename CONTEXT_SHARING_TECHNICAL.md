# Technical Documentation: Team Context Sharing

This document provides a technical overview and in-depth code analysis of the
context sharing feature in Gemini CLI. This feature allows users to share their
conversation history with teammates using either Google Cloud Storage (GCS) for
enterprise users or the Gemini Files API for individual users.

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
      `gs://gemini-shared-<domain>` and uploads the context there.
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

This command orchestrates the entire sharing process.

- **Argument Parsing:** It parses multiple recipients (e.g., `@alice @bob`) and
  an optional label.
- **Normalization:** It uses `normalizeRecipient(recipient, fromName)` to
  convert short handles like `@tnay1995` into full emails like
  `tnay1995@gmail.com` based on the sender's domain.
- **Environment Stripping:** It calls `stripEnvironmentContext(history)` to
  remove bulky system rules and directory structures from the shared JSON,
  keeping it focused on the conversation.
- **Summarization:**
  ```typescript
  const summary = await geminiClient.summarizeChat();
  const summaryTurn: Content = {
    role: 'user',
    parts: [{ text: `### CONVERSATION SUMMARY\n\n${summary}...` }],
  };
  // Prepend to history before upload
  const historyToShare = [summaryTurn, ...cleanHistory];
  ```

### B. The `/inbox` Command

**Location:** `packages/cli/src/ui/commands/inboxCommand.ts`

Provides a view into the user's "Virtual Inbox".

- **Identity Check:** It tells the user exactly which identity it is checking
  (e.g., `Checking inbox for @tnay1995@gmail.com...`).
- **Provider Transparency:** It fetches entries via `ContextShareService` and
  displays whether they came from GCS or the Gemini API.
- **Hashed Hiding:** It never exposes the recipient's email in GCS paths; it
  only lists files within the `inbox/<sha256(email)>/` prefix.

### C. ContextShareService (The Router)

**Location:** `packages/core/src/services/contextShareService.ts`

This service acts as a thin abstraction over different storage providers.

- **Zero-Config Discovery:**
  ```typescript
  if (isVertexOrOAuth(config.authType)) {
    if (!bucket) {
      const email = new UserAccountManager().getCachedGoogleAccount();
      if (email) bucket = getDefaultSharedBucket(email); // gs://gemini-shared-domain-com
    }
    this.provider = new GcsProvider(bucket);
  }
  ```

### D. GcsProvider (Enterprise Backend)

**Location:** `packages/core/src/services/gcsProvider.ts`

Handles the low-level GCS JSON API interactions.

- **Path Logic:**
  `inbox/<sha256(recipient)>/share--from--<sender>--model--<model>--<ts>.json`
- **Robust Retrieval:** Since GCS metadata indexing can sometimes lag, the
  `list()` method includes a fallback parser:
  ```typescript
  const match = obj.name.match(/share--from--(.+)--model--(.+)--(\d+)\.json$/);
  if (match) {
    // Manual parse of filename if metadata headers are missing
  }
  ```

### E. Sharing Utilities

**Location:** `packages/core/src/utils/sharingUtils.ts`

Contains the pure logic for identity and path management.

- **`getDefaultSharedBucket(email)`**: Converts `user@acme.com` into
  `gs://gemini-shared-acme-com`.
- **`resolveUserIdentity(settings, fallback)`**: Priorities: 1. Verified Google
  Email, 2. `share.myName` setting, 3. OS Username.
- **`stripEnvironmentContext(history)`**: Uses string matching to filter out
  turns containing `<session_context>` or `Current Directory Structure`.

---

## 3. Configuration Schema

**Location:** `packages/cli/src/config/settingsSchema.ts`

The settings were refactored for a professional "Enterprise" feel:

```yaml
share:
  myName: 'alice' # Optional: Manual identity override
  teammates: ['bob'] # Optional: For @ completion
  bucket: 'gs://my-bucket' # Optional: Manual GCS override
```

---

## 4. Key Security Considerations

1.  **Verified Identity:** Enterprise shares use the email from the OAuth token
    as the `from` field, making them unfakeable.
2.  **Private by Default:** Each user can only "see" files under their specific
    SHA-256 prefix in GCS if IAM conditions are applied.
3.  **Data Minimization:** By stripping the `session_context`, we avoid sharing
    local system paths, environment variables, and proprietary extension rules.
