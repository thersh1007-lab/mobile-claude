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
4. **Windows shell escaping breaks bridge mode** — the bridge writes prompts to temp files and uses `bash -c 'cat file'` to avoid this. Do NOT try to pass long strings via `spawn()` args with `shell: true` on Windows.
5. **stdin must be 'ignore' when spawning claude** — `'pipe'` causes Claude Code to block forever
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
