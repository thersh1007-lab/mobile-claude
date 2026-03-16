import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'audit.jsonl');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function auditLog(
  action: string,
  decision: 'APPROVED' | 'DENIED' | 'BLOCKED' | 'EXECUTED' | 'AUTH_FAIL' | 'AUTH_OK',
  details: Record<string, unknown> = {},
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    decision,
    ...details,
  };
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // Don't crash the server if logging fails
    console.error('[Audit] Failed to write log entry');
  }
}
