# Mobile Claude — Roadmap

> **Last updated**: 2026-03-15
> **Goal**: Make Mobile Claude usable by any developer, not just the original author

## Priority 1 — Must-Fix for Any Developer

### ~~1.1 Remove Hardcoded Paths~~ ✅ Done (Mar 14)
All `thers`-specific paths removed. `GITHUB_ROOT` eliminated. Claude CLI auto-detected via `which`/`where`. `WORKSPACE_ROOT` is the sole path config. `start.bat` uses script-relative paths.

### ~~1.2 CC Bridge Conversation Memory~~ ✅ Done (Mar 15)
Implemented Option A: `bridgeHistory` array accumulates user/assistant exchanges. Last 20 exchanges are included in the prompt wrapper for context. Truncates long assistant responses to 2000 chars to save tokens. History resets on new chat or mode switch.

### ~~1.3 HTTPS Support~~ ✅ Done (Mar 15)
Self-signed certificate auto-generated on first run (tries OpenSSL, falls back to Node crypto). HTTPS + WSS served on PORT+1 (default 3457) alongside HTTP. QR code shows HTTPS URL when certs available. Voice input works over HTTPS.

### ~~1.4 Setup Wizard / First-Run Experience~~ ✅ Done (Mar 14)
`npm run setup` interactive wizard: prompts for API key, generates auth token, detects IP + Claude CLI, writes `.env`. QR code printed in terminal on server start via `qrcode-terminal`.

### ~~1.5 Update README~~ ✅ Done (Mar 14)
Full rewrite. References ARCHITECTURE.md for deep details. Covers both modes, setup, security, troubleshooting.

## Priority 2 — High-Value Upgrades

### ~~2.1 Streaming in CC Mode~~ ✅ Done (Mar 15)
Bridge mode now uses `--output-format stream-json`. NDJSON events parsed line-by-line from stdout. Text deltas forwarded to client as they arrive. Cost info extracted from final `result` event. No more 30-second blank screen.

### 2.2 Cross-Platform Support
**Problem**: Several Windows-specific assumptions: `claude.cmd`, bash path, `USERPROFILE`, path separators.
**Fix**:
- Detect platform at startup, set paths accordingly
- Use `process.platform` to choose `claude` vs `claude.cmd`
- Use `path.join` everywhere (already mostly done)
- Test on macOS and Linux
**Files**: `src/claude-bridge.ts`, `src/tools.ts`, `src/ws-handler.ts`
**Note**: Most Windows-specific code was already removed in 1.1. Remaining work is testing on other platforms.

### 2.3 Config File
**Problem**: Configuration split between `.env` (server) and `localStorage` (client). No way to set defaults for auto-approve, notifications, quick actions.
**Fix**:
- Add `config.json` for server-side config (workspace root, allowed workspaces, quick actions, default mode)
- Serve config to client on connect so defaults are consistent
- Keep `.env` for secrets only (API keys, auth token)
**Files**: New `config.json`, update `src/index.ts`, update client
**Note**: Auto-approve is now configurable via `AUTO_APPROVE` env var (partial solution — full config file still TODO).

### ~~2.4 Split index.html~~ ✅ Done (Mar 15)
CSS extracted to `public/styles.css` (~840 lines). JS extracted to `public/app.js` (~1020 lines). HTML shell is now ~280 lines. No logic changes — pure restructure.

### ~~2.5 Persistent Chat History (Server-Side)~~ ✅ Done (Mar 15)
New `src/history.ts` module. Conversations saved to `data/conversations/*.json`. New WebSocket message types: `list_conversations`, `load_conversation`, `conversation_list`, `conversation_loaded`. History persists across server restarts.

## New Features — Mar 15

### ~~Auto-Approve Rules~~ ✅ Done (Mar 15)
Server-side auto-approve for API mode tools. Configure via `.env`:
- `AUTO_APPROVE=reads` — auto-approve `read_file`, `list_directory`, `search_files`
- `AUTO_APPROVE=all` — auto-approve everything (like CC mode)
- `AUTO_APPROVE_TOOLS=read_file,list_directory` — granular per-tool control
Default: manual approval for all tools (no change from before).

### ~~Integration Tests~~ ✅ Done (Mar 15)
43 tests: 32 integration (path sandboxing, blocked commands, conversation history, ID sanitization) + 11 session import (listing, importing, edge cases). Run with `npm test`.

## Features Added — Mar 16

### ~~Conversation History UI~~ ✅ Done (Mar 16)
📋 button in action bar. Browse all saved conversations (auto-saved as you chat). Shows mode, workspace, message count, preview. Tap to load and continue.

### ~~Smart Reconnect~~ ✅ Done (Mar 16)
Exponential backoff: 2s → 3s → 4.5s → ... up to 30s max. Status bar shows countdown. No more rapid-fire reconnect loops.

### ~~Electron Desktop Fix~~ ✅ Done (Mar 16)
Fixed invisible window (removed `show:false` pattern), navy background, uses `electron.exe` binary directly, `launch.bat` + `start.bat` working, auto-start on login.

### ~~Session Import (Continue Claude Code Conversations)~~ ✅ Done (Mar 15)
Import any Claude Code session into Mobile Claude and continue the conversation on your phone. Reads `~/.claude/projects/` transcripts, extracts user/assistant message pairs, converts to Mobile Claude format. 209 sessions detected across all projects. Available via REST API (`GET /api/sessions`, `POST /api/sessions/import`) and WebSocket (`list_cc_sessions`, `import_cc_session`).

## Priority 3 — Nice to Have

### 3.1 Docker Setup
One-command deploy: `docker-compose up`. Includes Node.js, claude CLI, and HTTPS via Caddy reverse proxy.

### ~~3.2 QR Code on Server Start~~ ✅ Done (Mar 14)
QR code prints in terminal on startup via `qrcode-terminal`. Phone scans → opens the app.

### 3.3 Multi-User Support
Currently single WebSocket — last connection wins. Add session IDs so multiple people can connect simultaneously with isolated conversations.

### 3.4 Plugin/Extension System
Allow custom quick actions, custom tools, and project-specific commands without modifying core code.

### 3.5 Theme System
Currently dark-only. Add light theme option and theme customization.

### 3.6 File Editor in Browser
Upgrade file browser from read-only to a basic code editor (CodeMirror or Monaco) for quick edits without going through Claude.

### 3.7 Image/Screenshot Viewer
When Claude references or creates images, show them inline in the chat instead of just file paths.

## Bugs Fixed — 2026-03-14 Session

These are already implemented in the current code:

1. ✅ `anthropic.ts` stop_reason bug — tool calls now always execute
2. ✅ Bridge mode sends `cost_update` to client
3. ✅ Upload size capped at 10MB
4. ✅ File browser detects binary files
5. ✅ Conversation history pruned at 40 messages
6. ✅ voice-blog.ts model string normalized
7. ✅ Service worker icon path fixed
8. ✅ secret.txt added to gitignore
9. ✅ Bridge `--resume` removed (stale session fix)
10. ✅ Bridge response buffering fixed (reconnect replay)
11. ✅ Bridge prompt wrapping (no more "message got cut off")
12. ✅ Bridge temp file approach (Windows shell escaping fix)

## Implementation Notes

### For agents picking this up:
- **Always test bridge changes from the command line first** before deploying to the server. Use: `claude -p "your prompt" --output-format stream-json --dangerously-skip-permissions --max-turns 3`
- **The server runs in the background** — kill with `taskkill` by finding the PID on port 3456
- **Build before restart**: `npx tsc` in `server/`, then kill + restart `node dist/index.js`
- **Check server logs** at the temp file path printed when starting with `run_in_background`
- **Phone disconnects are normal** — screen lock, network switch, etc. The reconnect logic handles this.
- **Windows shell escaping is the #1 source of bridge bugs**. When in doubt, write to a temp file and `cat` it.
- **Run tests before committing**: `npm test` (32 integration tests)
