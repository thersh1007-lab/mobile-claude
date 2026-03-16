import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { ClientMessage, ServerMessage } from './types';
import { handleConversation } from './anthropic';
import { setWorkspaceRoot, getWorkspaceRoot, isAllowedWorkspace } from './tools';
import { processVoiceMemo } from './voice-blog';
import { handleBridgeMessage, resetBridgeSession, deliverPendingResponse, isBridgeBusy } from './claude-bridge';
import { transcribeAudio } from './transcribe';
import { auditLog } from './audit';
import { createConversation, addMessage, listConversations, loadConversation, Conversation } from './history';
import { listClaudeCodeSessions, importSession } from './session-import';
import Anthropic from '@anthropic-ai/sdk';

type MessageParam = Anthropic.MessageParam;

const AUTH_TOKEN_INITIAL = process.env.AUTH_TOKEN || 'change-this';
// Support runtime override from first-run setup
function getAuthToken(): string {
  return (global as any).__AUTH_TOKEN_OVERRIDE || AUTH_TOKEN_INITIAL;
}

// Auto-approve configuration
// Tools in this list are automatically approved without user interaction
const AUTO_APPROVE_TOOLS: Set<string> = new Set(
  (process.env.AUTO_APPROVE_TOOLS || '').split(',').map(s => s.trim()).filter(Boolean)
);
// Shorthand presets
if (process.env.AUTO_APPROVE === 'reads') {
  AUTO_APPROVE_TOOLS.add('read_file');
  AUTO_APPROVE_TOOLS.add('list_directory');
  AUTO_APPROVE_TOOLS.add('search_files');
}
if (process.env.AUTO_APPROVE === 'all') {
  AUTO_APPROVE_TOOLS.add('read_file');
  AUTO_APPROVE_TOOLS.add('list_directory');
  AUTO_APPROVE_TOOLS.add('search_files');
  AUTO_APPROVE_TOOLS.add('edit_file');
  AUTO_APPROVE_TOOLS.add('write_file');
  AUTO_APPROVE_TOOLS.add('run_command');
}

console.log(`[Config] Auto-approve tools: ${AUTO_APPROVE_TOOLS.size > 0 ? [...AUTO_APPROVE_TOOLS].join(', ') : 'none (manual approval for all)'}`);

// Rate limiting for auth failures
const AUTH_FAIL_WINDOW = 10 * 60 * 1000; // 10 minutes
const MAX_AUTH_FAILURES = 5;
const authFailures: Array<number> = [];

function isRateLimited(): boolean {
  const now = Date.now();
  // Remove old entries
  while (authFailures.length > 0 && authFailures[0] < now - AUTH_FAIL_WINDOW) {
    authFailures.shift();
  }
  return authFailures.length >= MAX_AUTH_FAILURES;
}

function recordAuthFailure(): void {
  authFailures.push(Date.now());
}

function getWorkspaces(): Array<{ name: string; path: string }> {
  try {
    // List sibling directories of the current workspace root
    const parentDir = path.dirname(getWorkspaceRoot());
    const entries = fs.readdirSync(parentDir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => ({ name: e.name, path: path.join(parentDir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [{ name: path.basename(getWorkspaceRoot()), path: getWorkspaceRoot() }];
  }
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timeout: NodeJS.Timeout;
}

// Module-level state — persists across reconnections
let currentMode: 'direct' | 'bridge' = 'direct';
let activeWs: WebSocket | null = null;
let currentConversation: Conversation | null = null;

// Module-level send — always uses the latest WebSocket connection
// Returns true if the message was actually sent
function sendToActive(msg: ServerMessage): boolean {
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

export function handleConnection(ws: WebSocket): void {
  activeWs = ws; // Update to latest connection
  let authenticated = false;
  const conversationHistory: MessageParam[] = [];
  const MAX_HISTORY_MESSAGES = 40;
  const pendingApprovals = new Map<string, PendingApproval>();
  let processing = false;

  function send(msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function waitForApproval(id: string, name: string, input: Record<string, unknown>): Promise<boolean> {
    // Check auto-approve first
    if (AUTO_APPROVE_TOOLS.has(name)) {
      auditLog(name, 'APPROVED', { input, auto: true });
      send({ type: 'tool_result', id, output: `[auto-approved: ${name}]` });
      return Promise.resolve(true);
    }

    send({ type: 'tool_request', id, name, input });
    send({ type: 'status', state: 'awaiting_approval' });

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        pendingApprovals.delete(id);
        resolve(false);
      }, 5 * 60 * 1000); // 5 min timeout

      pendingApprovals.set(id, { resolve, timeout });
    });
  }

  ws.on('message', async (raw: WebSocket.Data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send({ type: 'error', message: 'Invalid JSON' });
      return;
    }

    console.log(`[MSG] type=${msg.type} authenticated=${authenticated} processing=${processing} mode=${currentMode}`);

    if (msg.type === 'message') {
      // Auth check
      if (!authenticated) {
        if (isRateLimited()) {
          auditLog('auth', 'AUTH_FAIL', { reason: 'rate_limited' });
          send({ type: 'error', message: 'Too many failed attempts. Try again later.' });
          ws.close(4003, 'Rate limited');
          return;
        }
        if (msg.token !== getAuthToken()) {
          recordAuthFailure();
          auditLog('auth', 'AUTH_FAIL', { reason: 'invalid_token' });
          send({ type: 'error', message: 'Invalid auth token' });
          ws.close(4001, 'Unauthorized');
          return;
        }
        authenticated = true;
        auditLog('auth', 'AUTH_OK');
      }

      if (processing) {
        send({ type: 'error', message: 'Already processing a request. Please wait.' });
        return;
      }

      processing = true;

      // Create conversation if none exists
      if (!currentConversation) {
        currentConversation = createConversation(currentMode, getWorkspaceRoot());
      }

      // Save user message to persistent history
      addMessage(currentConversation, 'user', msg.content);

      try {
        if (currentMode === 'bridge') {
          if (isBridgeBusy()) {
            send({ type: 'error', message: 'Claude Code is still processing. Please wait.' });
            send({ type: 'status', state: 'thinking' });
            processing = false;
            return;
          }
          // Claude Code Bridge — use module-level send so reconnects don't lose output
          await handleBridgeMessage(msg.content, getWorkspaceRoot(), sendToActive);
        } else {
          // Direct API mode — use sendToActive so responses survive reconnects
          conversationHistory.push({ role: 'user', content: msg.content });
          // Prune old messages to avoid unbounded context growth
          while (conversationHistory.length > MAX_HISTORY_MESSAGES) {
            conversationHistory.shift();
          }
          await handleConversation(conversationHistory, sendToActive, waitForApproval);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message: `Claude error: ${message}` });
        send({ type: 'status', state: 'idle' });
      }

      // Save assistant response to persistent history (grab last assistant message)
      if (conversationHistory.length > 0 && currentConversation) {
        const lastMsg = conversationHistory[conversationHistory.length - 1];
        if (lastMsg.role === 'assistant' && typeof lastMsg.content === 'string') {
          addMessage(currentConversation, 'assistant', lastMsg.content);
        }
      }

      processing = false;
    }

    if (msg.type === 'tool_decision') {
      const pending = pendingApprovals.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingApprovals.delete(msg.id);
        auditLog('tool_decision', msg.approved ? 'APPROVED' : 'DENIED', { toolId: msg.id });
        pending.resolve(msg.approved);
      }
    }

    if (msg.type === 'list_workspaces') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      send({ type: 'workspaces', list: getWorkspaces(), current: getWorkspaceRoot() });
      // Deliver any buffered bridge response from before the reconnect
      if (currentMode === 'bridge') {
        deliverPendingResponse(send);
      }
    }

    if (msg.type === 'set_workspace') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      const newPath = msg.path;
      if (!isAllowedWorkspace(newPath)) {
        auditLog('set_workspace', 'BLOCKED', { path: newPath, reason: 'outside_workspace_root' });
        send({ type: 'error', message: 'Workspace must be inside your workspace root directory' });
        return;
      }
      if (fs.existsSync(newPath)) {
        setWorkspaceRoot(newPath);
        conversationHistory.length = 0;
        currentConversation = null; // New conversation on workspace switch
        const name = path.basename(newPath);
        auditLog('set_workspace', 'EXECUTED', { path: newPath });
        send({ type: 'workspace_changed', path: newPath, name });
        console.log(`Workspace changed to: ${newPath}`);
      } else {
        send({ type: 'error', message: `Path not found: ${newPath}` });
      }
    }

    if (msg.type === 'upload_file') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      try {
        const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB
        const rawSize = Math.ceil((msg.data.length * 3) / 4); // estimate decoded size
        if (rawSize > MAX_UPLOAD_SIZE) {
          send({ type: 'error', message: `File too large (${(rawSize / 1024 / 1024).toFixed(1)}MB). Max 10MB.` });
          return;
        }
        const uploadsDir = path.join(getWorkspaceRoot(), 'uploads');
        if (!fs.existsSync(uploadsDir)) {
          fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const safeName = msg.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const dest = path.join(uploadsDir, safeName);
        const buffer = Buffer.from(msg.data, 'base64');
        fs.writeFileSync(dest, buffer);
        send({ type: 'upload_complete', filename: safeName, path: dest });
        console.log(`File uploaded: ${dest} (${buffer.length} bytes)`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message: `Upload failed: ${message}` });
      }
    }

    if (msg.type === 'voice_memo') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      send({ type: 'status', state: 'thinking' });
      try {
        const result = await processVoiceMemo(msg.transcript);
        send({ type: 'voice_memo_result', ...result });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'voice_memo_result', success: false, filename: '', title: '', cluster: '', error: message });
      }
      send({ type: 'status', state: 'idle' });
    }

    if (msg.type === 'voice_audio') {
      if (!authenticated) {
        if (msg.token !== getAuthToken()) {
          send({ type: 'error', message: 'Invalid auth token' });
          return;
        }
        authenticated = true;
      }

      if (processing) {
        send({ type: 'error', message: 'Already processing a request. Please wait.' });
        return;
      }

      processing = true;
      send({ type: 'status', state: 'thinking' });

      try {
        // Transcribe audio with Whisper
        const text = await transcribeAudio(msg.data, msg.format);

        if (!text.trim()) {
          send({ type: 'error', message: 'Could not understand audio. Try again.' });
          send({ type: 'status', state: 'idle' });
          processing = false;
          return;
        }

        // Send transcription back so client shows it as a user message
        send({ type: 'transcription', text });

        // Process through Claude as a normal message
        console.log(`[VOICE] Transcribed: "${text}"`);

        // Save to persistent history
        if (!currentConversation) {
          currentConversation = createConversation(currentMode, getWorkspaceRoot());
        }
        addMessage(currentConversation, 'user', text);

        if (currentMode === 'bridge') {
          if (isBridgeBusy()) {
            send({ type: 'error', message: 'Claude Code is still processing. Please wait.' });
            send({ type: 'status', state: 'thinking' });
            processing = false;
            return;
          }
          await handleBridgeMessage(text, getWorkspaceRoot(), sendToActive);
        } else {
          conversationHistory.push({ role: 'user', content: text });
          await handleConversation(conversationHistory, sendToActive, waitForApproval);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', message: `Voice error: ${message}` });
        send({ type: 'status', state: 'idle' });
      }

      processing = false;
    }

    if (msg.type === 'set_mode') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      const newMode = msg.mode;
      if (newMode === 'direct' || newMode === 'bridge') {
        const changed = currentMode !== newMode;
        currentMode = newMode;
        if (changed) {
          // Only reset on actual mode change, not reconnect restore
          conversationHistory.length = 0;
          resetBridgeSession();
          currentConversation = null; // New conversation on mode switch
          send({ type: 'mode_changed', mode: currentMode });
          console.log(`Mode changed to: ${currentMode}`);
        } else {
          console.log(`Mode restored: ${currentMode}`);
        }
      }
    }

    if (msg.type === 'new_chat') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      conversationHistory.length = 0;
      resetBridgeSession();
      currentConversation = null; // Will be created on next message
      console.log(`Chat reset (mode: ${currentMode})`);
    }

    // List previous conversations
    if (msg.type === 'list_conversations') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      const conversations = listConversations();
      send({ type: 'conversation_list', conversations });
    }

    // List Claude Code sessions available for import
    if (msg.type === 'list_cc_sessions') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      const sessions = listClaudeCodeSessions();
      send({ type: 'cc_sessions', sessions });
    }

    // Import a Claude Code session
    if (msg.type === 'import_cc_session') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      const conv = importSession(msg.sessionId);
      if (conv) {
        currentConversation = conv;
        // Load into API conversation history
        conversationHistory.length = 0;
        for (const entry of conv.messages) {
          conversationHistory.push({ role: entry.role, content: entry.content });
        }
        // Prune to fit context limits
        while (conversationHistory.length > MAX_HISTORY_MESSAGES) {
          conversationHistory.shift();
        }
        send({
          type: 'session_imported',
          conversation: {
            id: conv.id,
            mode: conv.mode,
            messageCount: conv.messages.length,
            created: conv.created,
          },
        });
        // Also send the full conversation for display
        send({ type: 'conversation_loaded', conversation: conv });
      } else {
        send({ type: 'error', message: 'Session not found or empty' });
      }
    }

    // Load a specific conversation
    if (msg.type === 'load_conversation') {
      if (!authenticated && msg.token !== getAuthToken()) {
        send({ type: 'error', message: 'Invalid auth token' });
        return;
      }
      authenticated = true;
      const conv = loadConversation(msg.id);
      if (conv) {
        currentConversation = conv;
        // Restore API conversation history from persistent storage
        conversationHistory.length = 0;
        for (const entry of conv.messages) {
          conversationHistory.push({ role: entry.role, content: entry.content });
        }
        send({ type: 'conversation_loaded', conversation: conv });
      } else {
        send({ type: 'error', message: 'Conversation not found' });
      }
    }
  });

  ws.on('close', () => {
    // Clean up pending approvals
    for (const [, pending] of pendingApprovals) {
      clearTimeout(pending.timeout);
      pending.resolve(false);
    }
    pendingApprovals.clear();
    // Don't reset bridge session on disconnect — preserve session ID for resume
    // Just reset the processing flag so reconnected client can send new messages
    processing = false;
    console.log('Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  console.log('Client connected');
  send({ type: 'status', state: 'idle' });
}
