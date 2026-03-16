# Mobile Claude — Architecture & Technical Reference

> **Last updated**: 2026-03-15
> **Status**: Working v1.4 — API + CC bridge, streaming, memory, HTTPS, history UI, session import, desktop app
> **Author**: Tim (thersh1007) + Claude Code

## What Is This?

Mobile Claude is a self-hosted mobile web app that lets you chat with Claude AI from your phone while having full access to your dev environment on your PC. You can read files, edit code, run commands, switch between repos, upload files, and use voice input — all from your phone over your local network.

Think of it as a mobile-friendly Claude Code terminal.

## Architecture

```
┌──────────────┐     WebSocket      ┌─────────────────────┐
│  Phone PWA   │ ◄═══════════════► │   Node.js Server     │
│  (browser)   │   port 3456       │   (your PC)          │
│              │                    │                      │
│  - Chat UI   │                    │  ┌─── API Mode ────┐ │     ┌──────────┐
│  - Tool cards│                    │  │ Anthropic SDK    │─┼────►│ Claude   │
│  - Voice     │                    │  │ 6 tools          │ │     │ API      │
│  - Files     │                    │  └──────────────────┘ │     └──────────┘
│  - Settings  │                    │                      │
│              │                    │  ┌─── CC Mode ─────┐ │     ┌──────────┐
│              │                    │  │ Spawns `claude`  │─┼────►│ Claude   │
│              │                    │  │ CLI per message  │ │     │ Code CLI │
│              │                    │  └──────────────────┘ │     └──────────┘
│              │                    │         ↕             │
└──────────────┘                    │  Local Filesystem     │
                                    └─────────────────────┘
```

## Two Modes

### 1. Direct API Mode (button shows "API")
- Uses Anthropic SDK directly (claude-sonnet-4-6)
- 6 tools: `read_file`, `edit_file`, `write_file`, `list_directory`, `search_files`, `run_command`
- Each tool call shows as an approval card on your phone (approve/deny)
- Auto-approve rules: configure via `AUTO_APPROVE=reads` or `AUTO_APPROVE_TOOLS=read_file,list_directory` in `.env`
- Conversation history maintained in-memory (pruned at 40 messages) + persisted to disk
- Streaming responses
- Cost tracking per message
- Best for: quick questions, simple file reads, targeted edits

### 2. Claude Code Bridge Mode (button shows "CC" in purple)
- Spawns the `claude` CLI as a subprocess per message
- Full Claude Code toolset (Read, Edit, Write, Bash, Grep, Glob, Agent, 20+ tools)
- Uses CLAUDE.md project context and auto-memory
- `--dangerously-skip-permissions` — no approval needed (Claude Code handles execution)
- **Streaming**: Uses `--output-format stream-json` for real-time text output
- **Conversation memory**: Last 20 exchanges included in prompt wrapper for multi-turn context
- Conversations persisted to `data/conversations/`
- Best for: complex multi-step tasks, refactoring, debugging, multi-file changes

## File Structure

```
mobile-claude/
├── ARCHITECTURE.md          ← This file
├── ROADMAP.md               ← What to build next (prioritized)
├── CLAUDE.md                ← Instructions for Claude Code agents working here
├── SOP.md                   ← User-facing guide (how to use every feature)
├── CHEAT-SHEET.txt          ← Quick reference card
├── README.md                ← Setup + overview
├── LICENSE                  ← MIT license
│
└── server/
    ├── .env                 ← API keys + auth token (gitignored)
    ├── .gitignore           ← node_modules, dist, .env, logs, secret.txt
    ├── package.json         ← Dependencies: @anthropic-ai/sdk, express, ws, openai, dotenv
    ├── tsconfig.json        ← TypeScript config (target ES2020, outDir: dist)
    ├── start.bat            ← Windows startup script (used by Task Scheduler)
    ├── install-service.ps1  ← PowerShell script to set up auto-start
    │
    ├── src/                 ← TypeScript source
    │   ├── index.ts         ← Express server entry point
    │   │                      - Static file serving (public/)
    │   │                      - /health endpoint
    │   │                      - /api/dashboard (git status, branch, uptime)
    │   │                      - /api/files (file browser with binary detection)
    │   │                      - WebSocket server setup + ping/pong keepalive
    │   │
    │   ├── anthropic.ts     ← Direct API mode
    │   │                      - Streaming with Anthropic SDK
    │   │                      - Tool execution loop (handles multi-turn tool use)
    │   │                      - Cost estimation (Sonnet pricing)
    │   │
    │   ├── claude-bridge.ts ← Claude Code Bridge mode
    │   │                      - Writes prompt to temp file (avoids shell escaping)
    │   │                      - Spawns: bash -c 'claude -p "$(cat tmpfile)" --output-format stream-json'
    │   │                      - NDJSON streaming — text deltas forwarded in real-time
    │   │                      - Conversation memory (last 20 exchanges in prompt)
    │   │                      - Wraps user message with system instructions
    │   │                      - Response buffering for phone reconnect
    │   │                      - Cost tracking from CLI output
    │   │
    │   ├── ws-handler.ts    ← WebSocket message handler
    │   │                      - Auth (token-based, rate-limited: 5 fails / 10 min)
    │   │                      - Message routing (API vs Bridge mode)
    │   │                      - Tool approval flow (approve/deny with 5 min timeout)
    │   │                      - Workspace switching
    │   │                      - File upload
    │   │                      - Voice memo + voice audio routing
    │   │                      - Mode switching (direct/bridge)
    │   │                      - New chat / session reset
    │   │
    │   ├── session-import.ts ← Claude Code session import
    │   │                      - Reads ~/.claude/projects/ transcripts
    │   │                      - Parses JSONL → user/assistant message pairs
    │   │                      - Converts to Mobile Claude conversation format
    │   │
    │   ├── history.ts       ← Persistent conversation storage
    │   │                      - CRUD for conversations in data/conversations/*.json
    │   │                      - List, load, delete conversations
    │   │                      - ID sanitization (path traversal prevention)
    │   │
    │   ├── tools.ts         ← Tool definitions + executors (API mode)
    │   │                      - 6 tool schemas (Anthropic format)
    │   │                      - Path sandboxing (must be within WORKSPACE_ROOT parent)
    │   │                      - Blocked command patterns (rm -rf, format, shutdown, etc.)
    │   │                      - Workspace root management
    │   │
    │   ├── types.ts         ← WebSocket message type definitions
    │   │                      - ServerMessage (12 types)
    │   │                      - ClientMessage (9 types)
    │   │                      - ToolDefinition, ToolResult
    │   │
    │   ├── audit.ts         ← Audit logging (JSONL to logs/audit.jsonl)
    │   │                      - Logs: auth, tool decisions, blocked commands
    │   │
    │   ├── voice-blog.ts    ← Voice memo → blog topic pipeline (ATJ-specific)
    │   │                      - Classifies into content clusters
    │   │                      - Generates topic brief with SEO keywords
    │   │                      - Writes .md file to topics/ folder
    │   │
    │   └── transcribe.ts    ← OpenAI Whisper transcription
    │                          - Base64 audio → temp file → Whisper API → text
    │
    ├── public/              ← Frontend (served as static files)
    │   ├── index.html       ← PWA HTML shell (~280 lines)
    │   │                      - Chat UI with markdown rendering
    │   │                      - Tool approval cards with diff viewer
    │   │                      - Voice input (SpeechRecognition API)
    │   │                      - Voice memo modal (blog topic pipeline)
    │   │                      - File browser drawer
    │   │                      - Workspace switcher dropdown
    │   │                      - Settings modal (connection, auto-approve, notifications)
    │   │                      - Features guide modal
    │   │                      - Zoom controls
    │   │                      - Audio notifications (Web Audio API tones)
    │   │                      - Haptic feedback (navigator.vibrate)
    │   │                      - Conversation persistence (localStorage)
    │   │                      - Push notifications
    │   │                      - Auto-reconnect (5s retry)
    │   │                      - Session cost tracker
    │   │                      - Quick action buttons bar
    │   │
    │   ├── styles.css       ← All CSS (~840 lines, extracted from index.html)
    │   ├── app.js           ← All JavaScript (~1020 lines, extracted from index.html)
    │   ├── manifest.json    ← PWA manifest (standalone, portrait)
    │   ├── sw.js            ← Service worker (network-first for HTML, cache-first for assets)
    │   ├── icon.svg         ← App icon
    │   └── generate-icons.html ← Browser-based icon export tool
    │
    ├── dist/                ← Compiled JS (gitignored, built with `npx tsc`)
    ├── data/                ← Persistent data (gitignored)
    │   └── conversations/   ← Saved conversation history (JSON files)
    ├── certs/               ← Self-signed HTTPS certs (gitignored, auto-generated)
    └── logs/                ← Audit logs (gitignored)
        └── audit.jsonl
```

## WebSocket Protocol

### Client → Server Messages

| Type | Fields | Description |
|------|--------|-------------|
| `message` | content, token | Send a chat message |
| `tool_decision` | id, approved | Approve/deny a tool call |
| `set_workspace` | path, token | Switch working directory |
| `list_workspaces` | token | Request workspace list |
| `upload_file` | filename, data (base64), token | Upload a file |
| `voice_memo` | transcript, token | Process voice memo → blog topic |
| `voice_audio` | data (base64), format, token | Transcribe audio + send as message |
| `set_mode` | mode (direct/bridge), token | Switch API/CC mode |
| `new_chat` | token | Reset conversation |
| `list_conversations` | token | Request saved conversation list |
| `load_conversation` | id, token | Load a saved conversation |
| `list_cc_sessions` | token | List Claude Code sessions available for import |
| `import_cc_session` | sessionId, token | Import a Claude Code session |

### Server → Client Messages

| Type | Fields | Description |
|------|--------|-------------|
| `text_delta` | content | Streaming text chunk |
| `text_done` | content | Full response text (triggers markdown render) |
| `tool_request` | id, name, input | Tool needs approval |
| `tool_result` | id, output, error? | Tool execution result |
| `error` | message | Error message |
| `status` | state (idle/thinking/awaiting_approval) | Agent state change |
| `workspaces` | list, current | Available workspaces |
| `workspace_changed` | path, name | Workspace switch confirmed |
| `upload_complete` | filename, path | File upload done |
| `voice_memo_result` | success, filename, title, cluster, error? | Blog topic created |
| `mode_changed` | mode | Mode switch confirmed |
| `cost_update` | input_tokens, output_tokens, cost_usd | API cost for this turn |
| `conversation_list` | conversations[] | Saved conversation summaries |
| `conversation_loaded` | conversation | Full conversation with messages |
| `cc_sessions` | sessions[] | Claude Code sessions available for import |
| `session_imported` | conversation | Confirmation + metadata after import |
| `transcription` | text | Whisper transcription result |

## Security Model

- **Auth token**: Every WebSocket message includes a token. Mismatch = connection closed.
- **Rate limiting**: 5 auth failures in 10 minutes = blocked.
- **Path sandboxing**: All file operations restricted to within `WORKSPACE_ROOT` parent.
- **Blocked commands**: Regex patterns block `rm -rf`, `format`, `shutdown`, `dd`, etc.
- **Audit log**: Every tool call, auth event, and block is logged to `logs/audit.jsonl`.
- **No internet exposure**: Server binds to `0.0.0.0` (LAN only). Never port-forward this.
- **API keys server-side only**: Keys stay in `.env`, never sent to the client.

## REST API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Server health check |
| GET | `/api/dashboard` | Bearer | Git status, branch, workspace info |
| GET | `/api/files?path=...` | Bearer | File browser (read files + list dirs) |
| GET | `/api/sessions` | Bearer | List Claude Code sessions available for import |
| POST | `/api/sessions/import` | Bearer | Import a Claude Code session (`{ sessionId }`) |
| GET | `/api/conversations` | Bearer | List saved Mobile Claude conversations |

## Key Technical Decisions & Gotchas

### Bridge Mode — Temp File for Prompt
Windows `cmd.exe` mangles quotes and special characters when passing long strings via `spawn()` with `shell: true`. The bridge writes the prompt to a temp file and uses `bash -c 'claude -p "$(cat /tmp/file)"'` to pass it cleanly. This is the ONLY reliable way on Windows.

### Bridge Mode — NDJSON Streaming
The bridge uses `--output-format stream-json` to get NDJSON events from the CLI. stdout is split on newlines and each line parsed as JSON. Key event types: `assistant` (contains message content blocks), `content_block_delta` (streaming text deltas), `result` (final cost/status). Text is forwarded to the client as `text_delta` messages as it arrives. A line buffer handles partial lines from chunked stdout reads.

### Bridge Mode — Conversation Memory
Each user message and assistant response is stored in `bridgeHistory`. The last 20 exchanges are injected into the prompt wrapper between `--- Conversation history ---` markers. Long assistant responses are truncated to 2000 chars to save tokens. History resets on new chat or mode switch.

### Bridge Mode — No Session Resume
Each CC mode message is standalone (`-p` mode). We tried `--resume` with session IDs but stale sessions caused confused responses ("your message got cut off"). Removed entirely.

### Bridge Mode — Response Buffering
Phone connections drop frequently (screen lock, network switch). When the bridge response arrives and the phone is disconnected, messages are buffered in `pendingResponse` and replayed on reconnect via `deliverPendingResponse()`. Buffer is cleared after successful delivery to avoid stale replays.

### stdin Must Be 'ignore'
When spawning `claude`, stdin MUST be `'ignore'`. If it's `'pipe'` (Node.js default), Claude Code blocks forever waiting for interactive input.

### CLAUDECODE Env Var Stripping
If the server runs inside a Claude Code session, `CLAUDECODE=1` is inherited. The bridge strips `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` from the child env to prevent nested session detection.

### Conversation History Pruning
Direct API mode prunes conversation history at 40 messages to prevent unbounded context growth and cost escalation.

### Binary File Detection
The file browser API checks file extensions against a known binary set before reading. Binary files show `[Binary file: .png, 12.3KB]` instead of garbled UTF-8.

## Environment Variables (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (for Direct API mode) |
| `AUTH_TOKEN` | Yes | Secret token for WebSocket auth |
| `PORT` | No | Server port (default: 3456) |
| `WORKSPACE_ROOT` | No | Parent folder containing repos (default: cwd) |
| `OPENAI_API_KEY` | No | OpenAI key (for Whisper voice transcription) |
| `CLAUDE_PATH` | No | Path to claude executable (default: system PATH) |
| `AUTO_APPROVE` | No | Auto-approve preset: `reads` (read-only tools) or `all` (everything) |
| `AUTO_APPROVE_TOOLS` | No | Comma-separated list of tool names to auto-approve |

## Build & Run

```bash
# Install dependencies
cd mobile-claude/server
npm install

# Build TypeScript
npx tsc

# Start server
node dist/index.js

# Or dev mode (ts-node, no build step)
npm run dev

# Verify
curl http://localhost:3456/health
```

## Current Limitations (v1.3)

1. ~~**CC bridge has no conversation memory**~~ — ✅ Fixed Mar 15 (last 20 exchanges in prompt)
2. ~~**No HTTPS**~~ — ✅ Fixed Mar 15 (self-signed cert, HTTPS on PORT+1)
3. ~~**Hardcoded Windows paths**~~ — ✅ Fixed Mar 14
4. **Single-user** — one WebSocket connection at a time
5. ~~**No streaming in CC mode**~~ — ✅ Fixed Mar 15 (NDJSON stream-json)
6. ~~**2163-line monolithic index.html**~~ — ✅ Fixed Mar 15 (split into 3 files)
7. ~~**Manual setup**~~ — ✅ Fixed Mar 14 (`npm run setup` wizard + QR code)
8. ~~**README is outdated**~~ — ✅ Fixed Mar 14
