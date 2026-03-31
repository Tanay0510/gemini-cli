# Plan: Enterprise-Scale Context Sharing

## Objective

Enable seamless, private, and organization-wide conversation sharing for users
on Vertex AI (OAuth/ADC). This implementation moves away from the "Security by
Obscurity" of the Files API and scales to 1,000+ users using GCS and a local
identity directory.

---

## 1. Identity & Authentication

Currently, identity is self-reported in `teamContext.myName`. For Enterprise, we
must use **Verified Identity**.

- **Goal:** Resolve the user's verified email from their active Google OAuth/ADC
  session.
- **Implementation:**
  - Update `UserAccountManager` (or create `IdentityService`) to expose
    `getVerifiedEmail()`.
  - For Vertex AI (`AuthType.USE_VERTEX_AI`), use the `UserInfo` endpoint or
    `gcloud auth list` output.
  - Automatically populate `teamContext.myName` with this email on the first
    successful OAuth login.
  - **Logic:** `share--from--<sender_email>` becomes the immutable proof of
    origin.

## 2. Storage Abstraction (`StorageProvider`)

We need to support two backends: **Gemini Files API** (for API Key users) and
**GCS** (for Vertex users).

- **Task:** Refactor `ContextShareService` to use a `ContextStorageProvider`
  interface.
- **Interface Methods:**
  - `upload(fileName: string, history: Content[], metadata: Record<string, string>): Promise<void>`
  - `list(recipientEmail: string): Promise<SharedContextEnvelope[]>`
  - `download(fileName: string): Promise<Content[]>`
  - `delete(fileName: string): Promise<void>`

### GCS Implementation (`GcsProvider`)

- **Bucket Structure:** Use a flat bucket with prefix-based "Virtual Inboxes."
  - Path:
    `gs://<bucket>/inbox/<sha256(recipient_email)>/share--from--<sender>--<ts>.json`
- **Metadata:** Store `from`, `model`, and `label` as GCS Object Metadata
  (custom headers) to avoid parsing filenames.
- **Auth:** Use the user's active `AccessToken` in the `Authorization: Bearer`
  header for all GCS JSON API calls.

## 3. Org-Wide Discovery (The Directory)

Enable `@` autocomplete for 1,000+ users without a central database or expensive
Admin API calls.

- **Central Source:** A `directory.json` file hosted at
  `gs://<bucket>/meta/directory.json`.
- **Format:** `Array<{ name: string, email: string }>`
- **DirectorySyncService (CLI Side):**
  - **Check:** On CLI startup (or first `/share`), check if
    `~/.gemini/directory.json` exists.
  - **Sync:** If missing or >24 hours old, perform a background download from
    GCS.
  - **Persistence:** Save to the user's local profile directory.
- **External Dependency (Out of Scope):** A scheduled Cloud Function that
  populates this `directory.json` from the Workspace Directory API.

## 4. UI/UX Enhancements

Professionalize the sharing experience to feel like a modern collaboration tool.

### `/share` Command

- **Autocomplete:** Integrate the local `directory.json` into the Slash Command
  parser.
- **Trigger:** Typing `/share @` should trigger a fuzzy-search list of
  names/emails.
- **Direct Email:** Support raw email addresses for people not yet in the
  directory: `/share user@company.com`.

### `/inbox` Command

- **Multi-Source:** The inbox should check the GCS "Virtual Inbox" prefix for
  the current user's email hash.
- **Model Parsing:** Keep the existing logic where the LLM (Gemini/Vertex) reads
  the JSON from the storage URI (`gs://...`) to ensure large histories don't
  bloat CLI memory.

## 5. Security & Infrastructure

- **IAM Condition:** (Documentation for the Admin) Provide the specific IAM
  policy that restricts users to listing _only_ their own prefix:
  - `resource.name.startsWith("projects/_/buckets/<bucket>/objects/inbox/<my_hash>/")`
- **Lifecycle Policy:** Set a bucket-wide rule to delete files with prefix
  `inbox/` after 48 hours.
- **Encryption:** (Optional Phase 2) Encrypt JSON payloads with a team-wide
  secret before upload to GCS.

## 6. Configuration (Settings)

Add a new field to `settings.json`:

- `contextSharing.sharedBucketUri`: The `gs://...` URI for the enterprise
  sharing bucket.
- If this field is present AND the user is on Vertex AI, the CLI switches to
  `GcsProvider`.

---

## Success Criteria

1. User A (Vertex) runs `/share @UserB`.
2. User B (Vertex) runs `/inbox` and sees a context from User A.
3. User B runs `/inbox load 1` and continues the conversation.
4. Autocomplete for `@UserB` works instantly using the local directory cache.
