/**
 * Test session import functionality
 * Run: npx ts-node src/tests/session-import.test.ts
 */

import { listClaudeCodeSessions, importSession } from '../session-import';
import { deleteConversation } from '../history';

console.log('=== Session Import Tests ===\n');

// Test 1: List sessions
console.log('--- List Claude Code Sessions ---');
const sessions = listClaudeCodeSessions();
console.log(`Found ${sessions.length} sessions\n`);

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

assert(sessions.length > 0, 'found at least one session');

if (sessions.length > 0) {
  const first = sessions[0];
  console.log(`\n  Most recent: ${first.sessionId.slice(0, 8)}... | ${first.project} | ${first.messageCount} msgs`);
  console.log(`  Preview: "${first.firstMessage.slice(0, 80)}"`);
  console.log(`  Timestamp: ${first.timestamp}\n`);

  assert(first.sessionId.length > 10, 'session ID is a UUID');
  assert(first.project.length > 0, 'project name exists');
  assert(first.messageCount > 0, 'has messages');
  assert(first.firstMessage.length > 0, 'has preview');

  // Test 2: Import a session
  console.log('\n--- Import Session ---');
  const conv = importSession(first.sessionId);
  assert(conv !== null, 'import returned a conversation');

  if (conv) {
    assert(conv.id.startsWith('imported-'), 'conversation ID has imported- prefix');
    assert(conv.messages.length > 0, 'has messages');

    const userMsgs = conv.messages.filter(m => m.role === 'user');
    const asstMsgs = conv.messages.filter(m => m.role === 'assistant');
    console.log(`\n  Imported: ${conv.messages.length} messages (${userMsgs.length} user, ${asstMsgs.length} assistant)`);

    assert(userMsgs.length > 0, 'has user messages');
    assert(asstMsgs.length > 0, 'has assistant messages');

    if (userMsgs.length > 0) {
      console.log(`  First user: "${userMsgs[0].content.slice(0, 80)}"`);
    }
    if (asstMsgs.length > 0) {
      console.log(`  First asst: "${asstMsgs[0].content.slice(0, 80)}"`);
    }

    // Clean up
    deleteConversation(conv.id);
    console.log('  Cleaned up test conversation');
  }
}

// Test 3: Import nonexistent session
console.log('\n--- Edge Cases ---');
const missing = importSession('nonexistent-session-id');
assert(missing === null, 'nonexistent session returns null');

console.log(`\n===========================`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) process.exit(1);
