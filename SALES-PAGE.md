# Mobile Claude

## Your Dev Environment, in Your Pocket

A self-hosted mobile terminal for Claude AI. Chat with Claude, approve file edits, run commands, and switch between repos — all from your phone over your local network.

**Built for developers and agency owners who use Claude Code and refuse to be chained to their desk.**

[View on GitHub](#) | [Setup in 5 Minutes](#getting-started)

---

## The Problem

You use Claude Code at your desk. It's powerful. But then you leave your desk.

- **You're on the couch and remember a fix.** You could walk back to your office, or you could just... not. The fix waits until tomorrow and you forget half the context.
- **Claude is mid-task and needs approval.** It wants to edit a file or run a command. You're not at your computer. It sits there waiting. You sit there wondering.
- **You want to keep a conversation going.** You had a productive Claude Code session at your desk. Now you're on a walk and want to continue it. There's no way to pick it up from your phone.
- **You have an idea and no keyboard.** You'd dictate it if you could, but Claude Code is a terminal tool. Voice input doesn't exist.

Every other Claude interface is either desktop-only or cloud-hosted. You shouldn't have to give up your local dev environment to get mobile access.

---

## What It Does

Mobile Claude runs a Node.js server on your PC and serves a PWA to your phone over your local network. Your phone becomes a remote terminal for Claude with full access to your filesystem, your repos, and your Claude Code sessions.

Two AI modes. One interface. Everything stays on your machine.

---

## Features

### 1. Two AI Modes — Pick the Right Tool

**API Mode** connects directly to the Anthropic API with streaming responses and 6 built-in tools: `read_file`, `edit_file`, `write_file`, `list_directory`, `search_files`, `run_command`. Every tool call shows as an approval card on your phone — tap Approve or Deny. Best for quick questions, targeted edits, and file reads.

**Claude Code Bridge** spawns the actual `claude` CLI per message, giving you access to 20+ tools (Read, Edit, Write, Bash, Grep, Glob, Agent, and more). It reads your CLAUDE.md project context and has conversation memory across messages. Best for complex multi-step tasks, refactoring, and debugging. Streaming output so you see text as it's generated.

Toggle between modes with one tap. The button shows "API" or "CC" (purple) so you always know which mode you're in.

---

### 2. Session Import — Continue Where You Left Off

Pull any Claude Code conversation from your desktop into your phone.

Mobile Claude reads your `~/.claude/projects/` transcripts, parses the JSONL into user/assistant message pairs, and converts them into its own conversation format. Pick a session from the list, import it, and keep going — with full context of what was discussed.

No copy-pasting. No starting over. Just pick up the thread.

---

### 3. Tool Approval From Your Phone

In API mode, every tool call appears as a card showing exactly what Claude wants to do:

- **File edits** show a diff — additions in green, deletions in red
- **Commands** show the exact shell command before execution
- **File reads** show the path being accessed

Tap Approve or Deny. If you don't respond within 5 minutes, the tool times out. Configure auto-approve rules for low-risk tools (file reads, directory listings) so you only get prompted for writes and commands.

Audio chime + haptic vibration when approval is needed. You won't miss it even if the phone is in your pocket.

---

### 4. Voice Input

Two ways to use your voice:

**Dictation** — Tap the mic and talk. Your speech is transcribed and sent as a message to Claude. Uses the browser's SpeechRecognition API (no extra cost) or OpenAI Whisper for audio recordings (higher accuracy, requires OpenAI key).

**Voice-to-Blog Pipeline** — Record a voice memo, and Mobile Claude transcribes it, classifies it into a content cluster, generates a topic brief with SEO keywords, and writes a `.md` file to your topics folder. Turn a 30-second thought into a blog pipeline input.

---

### 5. File Browser

Browse your entire codebase from your phone. Navigate directories, read files with syntax highlighting, see file sizes. Binary files are detected automatically and shown as metadata instead of garbled text.

Useful for reviewing code while discussing it with Claude, or just checking on something without opening your laptop.

---

### 6. Workspace Switching

Jump between repos without restarting the server. A dropdown lists all directories under your `WORKSPACE_ROOT`. Select one and Claude's working directory changes immediately.

Working on your main product and need to check something in a side project? Switch, ask, switch back. The conversation context updates to match.

---

### 7. Desktop App

Electron wrapper with system tray icon and `Ctrl+Shift+C` global toggle. Launches at startup. Lives in your tray until you need it.

The desktop app is optional — the server runs independently and the phone connects via the browser. But if you want a quick-access window on your PC alongside the mobile interface, it's there.

---

### 8. Self-Hosted — Your Data, Your Machine

No cloud. No third-party servers. No accounts.

The server runs on your PC. Your API key stays in a local `.env` file. Conversations are stored in local JSON files. The phone connects over your WiFi or via Tailscale for remote access.

Token-based auth on every WebSocket message. Rate-limited login (5 failures = blocked). Path sandboxing prevents access outside your workspace. Dangerous commands (`rm -rf`, `format`, `shutdown`) are blocked at the server level. Every tool call is audit-logged.

---

### 9. Persistent Conversations

Conversations are saved to disk and survive server restarts. Browse your history, reload a past conversation, or start fresh.

In Bridge mode, the last 20 exchanges are included in each prompt for multi-turn context. In API mode, the full conversation history is maintained in-memory (pruned at 40 messages to control costs) and persisted to disk.

Cost tracking shows input tokens, output tokens, and USD spend per message and per session.

---

### 10. PWA — Install It Like a Native App

Add to your home screen and it runs in standalone mode — no browser chrome, no URL bar. Looks and feels like a native app.

Service worker caches assets for offline shell loading. Auto-reconnects when the server becomes available. Push notifications when Claude needs your attention.

Navy and gold theme. Dark mode. Matches the ATJ Business Manager for a consistent look if you use both.

---

## How It Works

### Step 1: Install and Configure

```bash
cd mobile-claude/server
npm install
npm run setup
```

The setup wizard checks prerequisites, prompts for your API key, generates a secure auth token, detects your local IP, and writes the `.env` config.

### Step 2: Start the Server

```bash
npm run build
npm start
```

A QR code appears in the terminal.

### Step 3: Scan and Connect

Scan the QR code with your phone (same WiFi network). Enter the auth token in settings. Start chatting.

For remote access outside your network, install [Tailscale](https://tailscale.com/) on both devices and use the Tailscale IP. No port forwarding, no dynamic DNS, no exposed ports.

---

## Technical Specs

| Spec | Detail |
|------|--------|
| **Runtime** | Node.js 18+ (TypeScript, Express, WebSocket) |
| **Port** | 3456 (HTTP) + 3457 (HTTPS, self-signed) |
| **API Model** | claude-sonnet-4-6 (configurable) |
| **API Tools** | 6 (read_file, edit_file, write_file, list_directory, search_files, run_command) |
| **CC Tools** | 20+ (full Claude Code CLI toolset) |
| **Auth** | Token-based, rate-limited (5 fails / 10 min block) |
| **Security** | Path sandboxing, command blocking, audit logging |
| **Storage** | Local JSON files (conversations, history) |
| **Voice** | Browser SpeechRecognition + OpenAI Whisper |
| **Frontend** | PWA (HTML + CSS + JS, ~2100 lines split across 3 files) |
| **Protocols** | WebSocket (13 client message types, 15 server message types) |
| **Platforms** | Windows (fully supported), macOS, Linux |
| **Tests** | 43 integration tests |
| **Dependencies** | @anthropic-ai/sdk, express, ws, openai, dotenv |
| **License** | MIT |

---

## Who This Is For

**Solo developers** who use Claude Code daily and want to keep working when they leave their desk. You're already paying for the API. This gives you mobile access to it without routing through a cloud service.

**Agency owners** running client projects across multiple repos. Switch workspaces from your phone, check on builds, approve file changes while you're in a meeting or on a call.

**Claude Code power users** who want to continue CLI sessions from their phone. Session import means you don't lose context when you step away.

**Anyone who values self-hosting.** If you chose Claude Code over the web app because you want local execution and no cloud dependency, Mobile Claude extends that philosophy to your phone.

This is not for people who want a consumer chat app. There's no signup, no onboarding flow, no cloud sync. You install it on your machine, you run the server, you connect your phone. If that sounds like work, the Anthropic web app is fine. If that sounds like control, this is your tool.

---

## Getting Started

```bash
git clone <repo-url>
cd mobile-claude/server
npm install
npm run setup    # interactive wizard
npm run build
npm start        # scan QR code with your phone
```

Prerequisites: Node.js 18+, an Anthropic API key, and optionally Claude Code CLI for Bridge mode.

Full docs: [README.md](README.md) | Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) | Roadmap: [ROADMAP.md](ROADMAP.md)
