import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '..', 'data', 'conversations');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface Conversation {
  id: string;
  mode: 'direct' | 'bridge';
  workspace: string;
  created: string;
  updated: string;
  messages: ConversationEntry[];
}

function conversationPath(id: string): string {
  // Sanitize ID to prevent path traversal
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DATA_DIR, `${safe}.json`);
}

export function createConversation(mode: 'direct' | 'bridge', workspace: string): Conversation {
  const id = `${mode}-${Date.now()}`;
  const now = new Date().toISOString();
  const conv: Conversation = {
    id,
    mode,
    workspace,
    created: now,
    updated: now,
    messages: [],
  };
  saveConversation(conv);
  return conv;
}

export function saveConversation(conv: Conversation): void {
  try {
    conv.updated = new Date().toISOString();
    fs.writeFileSync(conversationPath(conv.id), JSON.stringify(conv, null, 2));
  } catch (err) {
    console.error(`[History] Failed to save conversation ${conv.id}:`, err);
  }
}

export function loadConversation(id: string): Conversation | null {
  try {
    const filePath = conversationPath(id);
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function addMessage(conv: Conversation, role: 'user' | 'assistant', content: string): void {
  conv.messages.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  });
  saveConversation(conv);
}

export function listConversations(limit = 20): Array<{
  id: string;
  mode: string;
  workspace: string;
  created: string;
  updated: string;
  messageCount: number;
  preview: string;
}> {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filePath = path.join(DATA_DIR, f);
        const stat = fs.statSync(filePath);
        return { file: f, mtime: stat.mtimeMs, path: filePath };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    return files.map(f => {
      try {
        const conv: Conversation = JSON.parse(fs.readFileSync(f.path, 'utf-8'));
        const lastUserMsg = [...conv.messages].reverse().find(m => m.role === 'user');
        return {
          id: conv.id,
          mode: conv.mode,
          workspace: conv.workspace,
          created: conv.created,
          updated: conv.updated,
          messageCount: conv.messages.length,
          preview: lastUserMsg ? lastUserMsg.content.slice(0, 100) : '(empty)',
        };
      } catch {
        return null;
      }
    }).filter((x): x is NonNullable<typeof x> => x !== null);
  } catch {
    return [];
  }
}

export function deleteConversation(id: string): boolean {
  try {
    const filePath = conversationPath(id);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
