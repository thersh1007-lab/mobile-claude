# Mobile Claude — User SOP

> How to use every feature. For the full technical reference, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. Getting Started

### Prerequisites

- Node.js 18+
- Anthropic API key from [console.anthropic.com](https://console.anthropic.com)
- (Optional) Claude Code CLI for Bridge mode: `npm install -g @anthropic-ai/claude-code`
- (Optional) OpenAI API key for voice transcription (Whisper)

### First-Time Setup

```bash
cd mobile-claude/server
npm install
npm run setup
```

The setup wizard walks you through:
1. Checks prerequisites (Node, Claude CLI, bash)
2. Prompts for your Anthropic API key
3. Generates a secure auth token
4. Detects your local IP address
5. Writes the `.env` config file

### Build and Start

```bash
npm run build
npm start
```

A QR code prints in the terminal.

### Connecting Your Phone

1. Phone must be on the **same WiFi** as your computer
2. Scan the QR code or type the URL from the terminal into your phone browser
3. Tap the **gear icon** (top-right)
4. Paste the auth token from the setup wizard
5. Tap **Save & Connect**
6. The status dot turns green when connected

**Add to Home Screen**: In your browser menu, tap "Add to Home Screen" for a native app experience (standalone PWA, no browser chrome).

---

## 2. Two Modes

Tap the **API / CC** button in the top bar to switch.

| | API Mode | CC Mode (Claude Code Bridge) |
|---|---|---|
| **Button label** | `API` (default) | `CC` (purple) |
| **How it works** | Calls Anthropic API directly | Spawns `claude` CLI per message |
| **Tools available** | 6: read_file, edit_file, write_file, list_directory, search_files, run_command | 20+: Read, Edit, Write, Bash, Grep, Glob, Agent, etc. |
| **Tool approval** | Cards on phone -- you approve/deny each one | No approval needed -- Claude Code handles execution |
| **Streaming** | Yes | Yes (NDJSON) |
| **Conversation memory** | Full history (pruned at 40 messages) | Last 20 exchanges included in prompt |
| **Project context** | None (raw API) | Reads CLAUDE.md, auto-memory, project files |
| **Best for** | Quick questions, simple reads, targeted edits | Complex multi-step tasks, refactoring, multi-file changes |
| **Cost** | Anthropic API credits | Claude Code subscription |

**When to use API mode**: You want control over every file read/write/command. Good for reviewing what Claude does step by step.

**When to use CC mode**: You want Claude to just get the job done -- multi-file refactors, debugging sessions, running tests, anything that would take 10+ tool calls.

---

## 3. Sending Messages

### Typing
Type in the text field at the bottom. Tap the **up arrow** to send. The textarea auto-expands for longer messages. Shift+Enter adds a new line without sending.

### Voice Input
Tap the **microphone button** (left of the text field). It turns red while recording. Speak your message -- the text field fills in as you talk. Tap the mic again to stop. Review the text, then tap send.

Voice requires HTTPS or localhost. See Section 12.

### Quick Action Buttons
A horizontally scrollable row of buttons sits below the status bar:

| Button | What it sends |
|--------|---------------|
| git status | `git status` |
| git diff | `git diff --stat` |
| git log | `git log --oneline -10` |
| ls | `list the files in this directory` |
| branch info | `what branch am I on and what are the recent changes?` |
| run tests | `run npm test` |
| build | `run npm run build` |
| check errors | `show me any errors or warnings in the last build output` |
| summarize | `summarize this project - what does it do, what are the key files?` |

Tap any button to send immediately -- no typing needed.

---

## 4. Tool Approval (API Mode Only)

When Claude wants to read a file, edit code, or run a command, a **tool approval card** appears in the chat:

- **Card shows**: Tool name, the input (file path, command, edit diff)
- **Approve** (green): Executes the tool, Claude continues with the result
- **Deny** (red): Tool is blocked, Claude is told it was denied
- **Timeout**: If you don't respond in 5 minutes, the tool is auto-denied

Sounds and vibration alert you when approval is needed (configurable in Settings).

### Auto-Approve (Client-Side)

The **Auto** checkbox in the status bar toggles auto-approval for read-only tools. When on, `read_file`, `list_directory`, and `search_files` run without asking.

Write, edit, and command tools **always** require manual approval unless you configure server-side auto-approve (see Section 16).

You can also toggle individual tools in Settings under "Tool Approval."

In CC mode, there are no approval cards -- Claude Code runs with `--dangerously-skip-permissions`.

---

## 5. Chat History (📋 Button)

Tap the **📋 button** in the status bar to browse your past conversations.

- Conversations are **auto-saved** as you chat — no manual save needed
- Each entry shows the mode (API/CC), workspace, message count, and a preview of the last message
- Tap a conversation to **load it and continue chatting** from where you left off
- History **persists across server restarts** — saved to `data/conversations/` on disk

---

## 6. Session Import (💬 Button)

Tap the **💬 button** in the status bar to import a Claude Code CLI conversation and continue it on your phone.

### How It Works
1. Mobile Claude reads `~/.claude/projects/` transcripts from your computer
2. It parses the JSONL files into user/assistant message pairs
3. Shows all sessions across all projects (209+)
4. You pick a session and the full conversation loads into your chat

### Filters

| Filter | What it shows |
|--------|---------------|
| Recent (today) | Sessions from today only |
| Current workspace | Sessions matching your current workspace path |
| All projects | Every session across all projects |

### Continuing a Conversation
After importing, send new messages to continue where the CLI session left off. In CC mode, the imported context is included in the prompt wrapper for continuity.

**It's a fork** — the original CLI session stays untouched. You're working on a copy.

---

## 7. Workspace Switching

The **dropdown** in the top status bar lists all folders inside your `WORKSPACE_ROOT` (set in `.env`, defaults to the server's current directory).

- Select a workspace to switch Claude's working directory
- **Conversation resets** when you switch (new context = new chat)
- Your last selected workspace is remembered across visits (stored in localStorage)
- All file operations (read, write, browse) are scoped to the selected workspace

---

## 8. File Browser

Tap the **folder icon** in the status bar to open the file browser drawer.

- Navigate folders by tapping directory names
- Tap a file to read its contents (shown in a preview pane)
- Binary files show type and size instead of garbled text
- Use the **back arrow** to go up a directory
- Tap **"Ask Claude about this file"** to send the file contents as context in your next message

Files are read-only in the browser. To edit, ask Claude.

---

## 9. Voice Memo (Blog Topic Pipeline)

Tap the green **Voice Memo** button in the quick actions row.

This is an ATJ-specific feature that turns a voice recording into a blog topic brief for the SEO pipeline.

### Flow
1. Tap **Record** -- describe your blog topic idea (angle, audience, keywords)
2. Tap **Stop** when done
3. Review and edit the transcript (the text box is editable)
4. Tap **Create Topic**
5. AI classifies the idea against the cluster registry and generates a full topic brief
6. A `.md` file is written to your `topics/` folder with YAML frontmatter

The result card shows the filename, title, and cluster assignment. The topic file sits in `topics/` until the next SEO pipeline run picks it up automatically.

**Requires**: `OPENAI_API_KEY` in `.env` for Whisper transcription.

---

## 10. Settings

Tap the **gear icon** to open Settings.

### Connection

| Field | What to enter |
|-------|---------------|
| Server URL | `ws://YOUR_IP:3456` (or `wss://YOUR_IP:3457` for HTTPS) |
| Auth Token | The token from setup (must match `AUTH_TOKEN` in `.env`) |

### Tool Approval Toggles

| Toggle | Default | Effect |
|--------|---------|--------|
| Auto-approve read_file | On | Reads run without asking |
| Auto-approve list_directory | On | Directory listings run without asking |
| Auto-approve search_files | On | File searches run without asking |

Write, edit, and command tools are not listed here -- they always require approval (unless overridden server-side via `.env`).

### Notification Toggles

| Toggle | Default | Effect |
|--------|---------|--------|
| Sound on approval needed | On | Two-tone rising chime |
| Sound on response complete | On | Descending chime |
| Vibrate on events | On | Haptic feedback on approvals, buttons, events |

Tap **Save & Connect** to apply and reconnect. Tap **Back to Chat** to cancel.

**Note**: Browsers require a user interaction (tap) before playing audio. If you don't hear sounds, tap anywhere on the page first.

---

## 11. Desktop App

### Quick Launch
- **Double-click** the "Mobile Claude" shortcut on your desktop
- Or press **Ctrl+Shift+C** anywhere to toggle the window open/closed

### Window Behavior
- Closing the window **minimizes to the system tray** (keeps running)
- Click the tray icon to reopen
- Auto-starts the server if it's not already running
- **Auto-starts on login** (minimized to tray)

### Batch Files
- `launch.bat` — opens a **visible** terminal window (useful for debugging)
- `start.bat` — runs **hidden** in the background / tray (normal usage)

### Auto-Start on Login
Run `server/install-service.ps1` in an admin PowerShell to create a Windows Task Scheduler task that starts the server on login.

To verify: Open Task Scheduler and look for the `MobileClaudeServer` task.

### Stopping the Server
Find the process and kill it:
```bash
netstat -ano | grep :3456
taskkill /PID <pid> /F
```

Or find `node.exe` in Task Manager.

---

## 12. HTTPS and Voice

### Why HTTPS Matters
Browsers block the microphone API on non-HTTPS connections (except localhost). Without HTTPS, voice input will not work from your phone.

### Self-Signed Certificate
On first run, the server auto-generates a self-signed certificate:
- Tries OpenSSL first, falls back to Node.js crypto
- Certs stored in `server/certs/` (gitignored)
- HTTPS served on **PORT+1** (default: **3457**)
- HTTP continues on PORT (default: 3456)

### Trusting the Cert on Your Phone
1. Open `https://YOUR_IP:3457` in your phone browser
2. You will see a "connection not private" warning
3. Tap **Advanced** then **Proceed** (Chrome) or **Continue** (Safari)
4. The browser remembers this for future visits
5. Update your Settings server URL to `wss://YOUR_IP:3457`

### Alternative: Chrome Flag
If HTTPS is not working, allow mic on HTTP in Chrome:
1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Add `http://YOUR_IP:3456`
3. Restart Chrome

---

## 13. Remote Access (Tailscale)

To use Mobile Claude outside your home network:

1. Install [Tailscale](https://tailscale.com/) on your computer
2. Install Tailscale on your phone
3. Sign in with the same account on both
4. Find your computer's Tailscale IP (e.g., `100.x.x.x`)
5. In Mobile Claude settings, use `wss://100.x.x.x:3457` as the server URL

No port forwarding needed. Tailscale creates a secure mesh VPN. Works from anywhere with internet.

---

## 14. Theme

The UI uses a **navy + gold** color scheme matching the ATJ Business Manager. Dark navy background with gold accents for active elements, buttons, and highlights.

---

## 15. Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| **Red status dot** | Not connected | Check same WiFi. Verify server: `curl http://localhost:3456/health` |
| **"Invalid auth token"** | Token mismatch | Token in Settings must exactly match `AUTH_TOKEN` in `.env` |
| **WebSocket 1006** | Connection dropped | Auto-reconnects with backoff (see Smart Reconnect below). No action needed. |
| **CC mode: no response** | CLI not found | Run `claude --version`. Check `CLAUDE_PATH` in `.env`. |
| **CC mode: hangs** | Spawned process stuck | Kill server (see Section 11), restart |
| **Voice button does nothing** | No HTTPS | Use port 3457 (HTTPS) or set Chrome flag (Section 12) |
| **Mic permission denied** | Browser blocked mic | Check browser site permissions, grant microphone |
| **Port in use** | Stale process | `netstat -ano | grep :3456`, then `taskkill /PID <pid> /F` |
| **No approval cards** | Auto-approve on | Uncheck Auto checkbox or check per-tool toggles in Settings |
| **Blank screen** | Stale PWA cache | Use Clear Cache (see below), or hard refresh (Ctrl+Shift+R) |
| **Buttons don't respond** | Stale UI after update | Settings gear → scroll down → "Clear Cache & Reload" |
| **File browser empty** | No workspace set | Select a workspace from the dropdown first |
| **Voice memo fails** | No OpenAI key | Add `OPENAI_API_KEY` to `.env` |
| **No sounds** | Browser audio blocked | Tap anywhere on the page first, then sounds will play |
| **API errors** | Bad key or no credits | Verify `ANTHROPIC_API_KEY` in `.env`, check account balance |

### Smart Reconnect
When the connection drops, Mobile Claude auto-reconnects with exponential backoff: 2s, 3s, 4.5s, up to a max of 30s between attempts. The status bar shows a **countdown timer** so you know when the next retry happens. No action needed — just keep the app open and it will reconnect when the server is available.

### Clear Cache
If the UI feels stale after an update (buttons not responding, layout broken):
1. Tap the **Settings gear** → scroll to the bottom → tap **"Clear Cache & Reload"**
2. Or visit `http://YOUR_IP:3456/clear-cache` directly in your browser

This clears the service worker cache and reloads the latest version of the app.

### Server Logs
Auth failures, blocked commands, and tool execution history are logged to `server/logs/audit.jsonl`.

### Health Check
```bash
curl http://localhost:3456/health
```

---

## 16. Auto-Approve ENV Config

Server-side auto-approve rules are set in `server/.env`. These apply to **API mode only** (CC mode always skips approval).

| `.env` Variable | Value | Effect |
|-----------------|-------|--------|
| `AUTO_APPROVE` | `reads` | Auto-approve read_file, list_directory, search_files |
| `AUTO_APPROVE` | `all` | Auto-approve **every** tool including writes and commands |
| `AUTO_APPROVE_TOOLS` | comma-separated list | Granular per-tool control |
| *(not set)* | -- | All tools require manual approval (default) |

### Examples

```env
# Read-only tools auto-approved
AUTO_APPROVE=reads

# Everything auto-approved (use with caution)
AUTO_APPROVE=all

# Specific tools only
AUTO_APPROVE_TOOLS=read_file,list_directory,search_files,run_command
```

### Server-Side vs Client-Side
The `.env` settings are the server's policy. The client-side toggles in Settings are an additional layer. A tool must pass **both** to auto-approve. If the server says manual and the client says auto, the server wins.

---

## 17. Cost Tracking

A **cost counter** appears in the status bar after your first message (e.g., `$0.0023`).

- Updates after each message with the incremental API cost
- **Tap the cost display** to see a summary: total session cost + elapsed time
- Resets when you start a new chat (+ button)
- Tracks both API mode and CC mode costs
- Cost is per-session only, not persisted across server restarts

Pricing is based on Anthropic's Sonnet rates (input + output tokens). CC mode costs come from the Claude CLI's own cost reporting.
