# Mobile Claude — Agent Instructions

## What is this project?

Mobile Claude is a self-hosted mobile web app for chatting with Claude AI from your phone with full dev environment access. It runs a Node.js server on the user's PC that serves a PWA and proxies messages to either the Anthropic API directly or the Claude Code CLI.

**Read `ARCHITECTURE.md` first** for the full technical reference.
**Read `ROADMAP.md`** for what to build next.

## Quick Reference

- **Server**: `mobile-claude/server/` — TypeScript, Express + WebSocket, port 3456
- **Client**: `server/public/index.html` — single-file PWA (2163 lines)
- **Build**: `cd server && npx tsc`
- **Run**: `cd server && node dist/index.js`
- **Test**: `curl http://localhost:3456/health` or `cd server && npm test`
- **Kill**: Find PID with `netstat -ano | grep :3456` then `taskkill //PID <pid> //F`

## Critical Rules

1. **Never commit `.env` or `secret.txt`** — they contain API keys
2. **Always build (`npx tsc`) before testing changes** — the server runs from `dist/`
3. **Test bridge changes from CLI first**: `claude -p "test prompt" --output-format json --dangerously-skip-permissions --max-turns 3`
4. **Never put the prompt on the command line** — Windows shell escaping breaks bridge mode. The bridge spawns `claude -p` and feeds the prompt via **stdin** (then `stdin.end()`), so the prompt never touches the command line. `shell: true` is used only to run the `claude.cmd` shim; the binary path is quoted for spaces, and the flags carry no special chars. Do NOT reintroduce a `bash`/`cat` wrapper — Git Bash's bin dir usually isn't on the server's PATH, which caused `spawn bash ENOENT`.
5. **stdin pipe is correct in `-p` (print) mode** — pipe the prompt and call `stdin.end()` so claude reads EOF and runs. (The old "stdin must be ignore / pipe blocks forever" rule applied to interactive mode, not `-p`.)
6. **Strip CLAUDECODE env var** from child processes — prevents nested session detection

## Architecture at a Glance

Two AI modes:
- **API mode**: Anthropic SDK → streaming → tool approval cards on phone
- **CC mode**: Spawns `claude` CLI per message → temp file prompt → bash → JSON result

Key files: `index.ts` (server + HTTPS), `anthropic.ts` (API mode), `claude-bridge.ts` (CC mode + streaming + memory), `ws-handler.ts` (routing + auto-approve), `tools.ts` (tool definitions), `history.ts` (persistent conversations), `public/index.html` (HTML shell), `public/styles.css` (CSS), `public/app.js` (frontend JS)

## Current State (as of 2026-03-16)

Both modes fully functional. v1.3 — all Priority 1 and most Priority 2 items complete.

- **API mode**: Streaming, tool approval (with auto-approve option), persistent history
- **CC mode**: Streaming (NDJSON), conversation memory (20 exchanges), persistent history
- **HTTPS**: Self-signed cert on PORT+1, voice works from phone
- **Setup**: `npm run setup` wizard, QR code on startup
- **Tests**: 43 tests (`npm test`)
- **Frontend**: Split into 3 files (HTML shell + CSS + JS), navy+gold theme
- **History UI**: 📋 browse past conversations, 💬 import Claude Code sessions
- **Desktop**: Electron app with tray icon, Ctrl+Shift+C, auto-start
- **Smart reconnect**: Exponential backoff, countdown in status bar

See ROADMAP.md for remaining items (cross-platform testing, config file, multi-user).
