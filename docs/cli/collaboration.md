# Team Collaboration

Gemini CLI is built for teams. The collaboration suite allows you to share your
active conversation context, including chat history and AI-agent state, with
teammates for seamless hand-offs and collective debugging.

## Core Commands

### `/share` — Sending Context

The `/share` command compresses your current chat history and uploads it to a
secure location for your teammates to access.

**Usage:**

- `/share @teammate` — Shares the current context.
- `/share @alice @bob "fix for auth bug"` — Shares with multiple people and adds
  a label.
- `/share --add @email` — Adds a teammate to your frequent collaborators list.
- `/share --list` — Shows your current sharing configuration and teammates.
- `/share --sync` — Manually refreshes the organization directory from the
  cloud.

### `/inbox` — Receiving Context

The `/inbox` command is your gateway to work shared by others.

**Usage:**

- `/inbox` — Lists all shared contexts addressed to you.
- `/inbox load <#>` — Downloads a shared context and injects it into your
  current session.
- `/inbox dismiss <#>` — Removes an item from your inbox without loading it.

---

## How it Works

Gemini CLI uses a **multi-tier storage architecture** to handle sharing:

1.  **Enterprise Sharing (GCS):** For users logged in via Google OAuth or Vertex
    AI, the CLI automatically discovers a Google Cloud Storage bucket (e.g.,
    `gs://gemini-shared-<domain>`). It uses **Multipart Uploads** to reliably
    save context data and metadata (labels, timestamps).
2.  **Individual Sharing (Gemini API):** For users with a standard Gemini API
    key, the CLI utilizes the Gemini Files API for secure storage.

### Security & Privacy

- **Hashed Virtual Inboxes:** Recipient identities are protected using SHA-256
  hashing in cloud storage paths.
- **Identity Verification:** Enterprise shares are signed with your verified
  Google identity, ensuring teammates know exactly who sent the context.
- **Data Minimization:** Bulk system information (local paths, environment
  variables) is automatically stripped before sharing.

---

## Organization Features

For large teams (1000+ users), Gemini CLI supports a global **Organization
Directory**.

### Hybrid Boot Sync

The CLI uses a "Hybrid Boot" strategy for performance:

- **Instant Autocomplete:** It loads your teammate list from a local cache on
  startup.
- **Background Refresh:** Every 4 hours, it silently syncs with your
  organization's master directory in GCS to ensure you have the latest teammate
  emails.

---

## Configuration

You can customize your collaboration experience in `/settings` under the **Team
Sharing** category:

- **Enable Sharing:** Master toggle for all collaboration features.
- **Auto-Sync Directory:** Enable/disable background teammate discovery.
- **Auto-Sync Inbox:** Automatically check for new shares on startup.
- **Require Verification:** (Enterprise only) Force all recipients to have a
  verified full email address.
- **Allowed Domains:** Restrict sharing to specific corporate domains (e.g.,
  `["my-company.com"]`).
