/**
 * Session Import — Continue Claude Code conversations in Mobile Claude
 *
 * Reads Claude Code session transcripts from ~/.claude/projects/
 * and converts them to Mobile Claude's conversation format.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Conversation, ConversationEntry, createConversation, addMessage, saveConversation } from './history';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

interface ClaudeCodeSession {
  sessionId: string;
  project: string;        // display name (decoded from dirname)
  projectPath: string;    // original cwd from first user message
  messageCount: number;
  firstMessage: string;   // preview
  timestamp: string;      // ISO date from first entry
  lines: number;
}

/**
 * Encode a project path to Claude Code's directory naming convention
 * C:\Users\foo\project → C--Users-foo-project
 */
function encodeProjectDir(projectPath: string): string {
  return projectPath.replace(/[:\\\/]/g, '-').replace(/^-+/, '');
}

/**
 * Decode a Claude Code project directory name back to a readable name
 * C--Users-foo-project → project (just the last segment)
 */
function decodeProjectDir(dirname: string): string {
  const parts = dirname.split('-').filter(Boolean);
  return parts[parts.length - 1] || dirname;
}

/**
 * List all available Claude Code sessions across all projects
 */
export function listClaudeCodeSessions(): ClaudeCodeSession[] {
  const sessions: ClaudeCodeSession[] = [];

  if (!fs.existsSync(PROJECTS_DIR)) {
    return sessions;
  }

  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.name.endsWith('.jsonl'));

    // Group JSONL files by project directory
    const projectFiles = new Map<string, string[]>();

    for (const entry of fs.readdirSync(PROJECTS_DIR)) {
      if (entry.endsWith('.jsonl')) {
        // Find the matching project directory
        const sessionId = entry.replace('.jsonl', '');
        // The file sits directly in PROJECTS_DIR/projectname/sessionId.jsonl
        // But we're listing from PROJECTS_DIR, so check parent structure
      }
    }

    // Scan each project directory for session files
    for (const projectDir of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!projectDir.isDirectory()) continue;

      const projectPath = path.join(PROJECTS_DIR, projectDir.name);
      const projectName = decodeProjectDir(projectDir.name);

      try {
        const files = fs.readdirSync(projectPath)
          .filter(f => f.endsWith('.jsonl'));

        for (const file of files) {
          const sessionId = file.replace('.jsonl', '');
          const filePath = path.join(projectPath, file);

          try {
            const stat = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim());

            // Parse first few lines to get metadata
            let firstUserMessage = '';
            let projectCwd = '';
            let timestamp = '';
            let userMessageCount = 0;

            for (const line of lines.slice(0, 50)) {
              try {
                const entry = JSON.parse(line);
                if (!timestamp && entry.timestamp) {
                  timestamp = entry.timestamp;
                }
                const msg = entry.message;
                if (msg?.role === 'user' && typeof msg.content === 'string') {
                  userMessageCount++;
                  if (!firstUserMessage) {
                    firstUserMessage = msg.content.slice(0, 150);
                  }
                }
                if (!projectCwd && entry.cwd) {
                  projectCwd = entry.cwd;
                }
              } catch {}
            }

            // Count total user messages in remaining lines
            for (const line of lines.slice(50)) {
              try {
                const entry = JSON.parse(line);
                if (entry.message?.role === 'user' && typeof entry.message.content === 'string') {
                  userMessageCount++;
                }
              } catch {}
            }

            if (userMessageCount > 0) {
              sessions.push({
                sessionId,
                project: projectName,
                projectPath: projectCwd || projectDir.name,
                messageCount: userMessageCount,
                firstMessage: firstUserMessage,
                timestamp: timestamp || stat.mtime.toISOString(),
                lines: lines.length,
              });
            }
          } catch {}
        }
      } catch {}
    }
  } catch (err) {
    console.error('[SessionImport] Error listing sessions:', err);
  }

  // Sort by timestamp descending (newest first)
  sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return sessions;
}

/**
 * Parse a Claude Code session transcript into user/assistant message pairs
 */
function parseSessionTranscript(filePath: string): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  // Accumulate assistant text across multiple content blocks
  let pendingAssistantText = '';
  let pendingTimestamp = '';

  function flushAssistant(): void {
    if (pendingAssistantText.trim()) {
      entries.push({
        role: 'assistant',
        content: pendingAssistantText.trim(),
        timestamp: pendingTimestamp || new Date().toISOString(),
      });
      pendingAssistantText = '';
      pendingTimestamp = '';
    }
  }

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const msg = entry.message;

      if (!msg?.role) continue;

      if (msg.role === 'user') {
        // Flush any pending assistant text before the next user message
        flushAssistant();

        if (typeof msg.content === 'string' && msg.content.trim()) {
          entries.push({
            role: 'user',
            content: msg.content,
            timestamp: entry.timestamp || new Date().toISOString(),
          });
        }
        // Skip tool_result user messages (they're just tool outputs)
      }

      if (msg.role === 'assistant') {
        if (!pendingTimestamp && entry.timestamp) {
          pendingTimestamp = entry.timestamp;
        }

        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              // If we already have text and this is a new assistant turn,
              // append it (multi-block responses)
              if (pendingAssistantText) {
                pendingAssistantText += '\n\n' + block.text;
              } else {
                pendingAssistantText = block.text;
              }
            }
            // Skip thinking blocks, tool_use blocks — they're internal
          }
        }
      }
    } catch {}
  }

  // Flush final assistant message
  flushAssistant();

  return entries;
}

/**
 * Import a Claude Code session into Mobile Claude's conversation history
 */
export function importSession(sessionId: string): Conversation | null {
  // Find the session file
  if (!fs.existsSync(PROJECTS_DIR)) return null;

  for (const projectDir of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;

    const filePath = path.join(PROJECTS_DIR, projectDir.name, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) {
      console.log(`[SessionImport] Importing session ${sessionId} from ${projectDir.name}`);

      const messages = parseSessionTranscript(filePath);
      if (messages.length === 0) {
        console.log(`[SessionImport] No messages found in session ${sessionId}`);
        return null;
      }

      // Detect the workspace from the first user entry's cwd
      let workspace = '';
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const firstLines = content.split('\n').slice(0, 20);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.cwd) {
            workspace = entry.cwd;
            break;
          }
        }
      } catch {}

      // Create a Mobile Claude conversation with the imported messages
      const conv = createConversation('bridge', workspace || 'imported');
      conv.id = `imported-${sessionId.slice(0, 8)}-${Date.now()}`;
      conv.created = messages[0].timestamp;
      conv.messages = messages;
      saveConversation(conv);

      console.log(`[SessionImport] Imported ${messages.length} messages as conversation ${conv.id}`);
      return conv;
    }
  }

  console.log(`[SessionImport] Session ${sessionId} not found`);
  return null;
}

/**
 * Get the current session ID (the one running right now in this Claude Code instance)
 */
export function getCurrentSessionId(): string | null {
  // Check session files for the current PID
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir)) return null;

  try {
    const files = fs.readdirSync(sessionsDir);
    for (const file of files) {
      const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
      const session = JSON.parse(content);
      // Return the most recent session for the mobile-claude project
      if (session.cwd && session.cwd.includes('mobile-claude')) {
        return session.sessionId;
      }
    }
  } catch {}

  return null;
}
