import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { ToolResult } from './types';
import { auditLog } from './audit';

// Auto-detect workspace: WORKSPACE_ROOT env > git repo root > cwd
function detectWorkspace(): string {
  if (process.env.WORKSPACE_ROOT) return process.env.WORKSPACE_ROOT;
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (gitRoot) return path.dirname(gitRoot); // Parent of the git repo (so siblings are accessible)
  } catch {}
  return process.cwd();
}

let WORKSPACE_ROOT = detectWorkspace();

// Commands that are never allowed
const BLOCKED_COMMANDS = [
  /\brm\s+(-\w*r\w*f|--force)\b/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\bcurl\b.*\|\s*(bash|sh|zsh|powershell|cmd)/i,
  /\bwget\b.*\|\s*(bash|sh|zsh|powershell|cmd)/i,
  /\b(shutdown|reboot|halt|init\s+[06])\b/i,
  /\bdel\s+\/[sfq]/i,
  /\brd\s+\/s/i,
  /\bnet\s+(user|localgroup)/i,
  /\breg\s+(delete|add)/i,
  /\bchmod\s+777\b/i,
  />\s*\/dev\/sda/,
  /\bsfc\s+\/scannow/i,
];

export function setWorkspaceRoot(newRoot: string): void {
  WORKSPACE_ROOT = newRoot;
}

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

export function isAllowedWorkspace(requestedPath: string): boolean {
  const resolved = path.resolve(requestedPath);
  const parentDir = path.resolve(path.dirname(WORKSPACE_ROOT));
  return resolved.startsWith(parentDir + path.sep) || resolved === parentDir;
}

function isCommandBlocked(command: string): string | null {
  for (const pattern of BLOCKED_COMMANDS) {
    if (pattern.test(command)) {
      return `Blocked: command matches dangerous pattern ${pattern.source}`;
    }
  }
  return null;
}

function resolveSafePath(filePath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, filePath);
  if (!resolved.startsWith(path.resolve(WORKSPACE_ROOT))) {
    throw new Error('Path outside workspace root is not allowed');
  }
  return resolved;
}

// Tool schemas for Anthropic API
export const toolSchemas = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns numbered lines.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path (relative to workspace or absolute)' },
        offset: { type: 'number', description: 'Line number to start from (1-based). Optional.' },
        limit: { type: 'number', description: 'Max lines to read. Default 500.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace a string in a file. The old_text must appear exactly once.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        old_text: { type: 'string', description: 'Exact text to find and replace' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path. Default: workspace root.' },
      },
      required: [],
    },
  },
  {
    name: 'search_files',
    description: 'Search file contents using ripgrep. Returns matching lines with file paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex search pattern' },
        path: { type: 'string', description: 'Directory to search in. Default: workspace root.' },
        glob: { type: 'string', description: 'File glob filter, e.g. "*.ts"' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command and return output. Use bash syntax. Timeout: 30s.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
      },
      required: ['command'],
    },
  },
];

// Tool execution functions
export async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_file':
        return readFile(input);
      case 'edit_file':
        return editFile(input);
      case 'write_file':
        return writeFile(input);
      case 'list_directory':
        return listDirectory(input);
      case 'search_files':
        return searchFiles(input);
      case 'run_command':
        return runCommand(input);
      default:
        return { output: '', error: `Unknown tool: ${name}` };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: '', error: message };
  }
}

function readFile(input: Record<string, unknown>): ToolResult {
  const filePath = resolveSafePath(input.path as string);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const offset = ((input.offset as number) || 1) - 1;
  const limit = (input.limit as number) || 500;
  const slice = lines.slice(offset, offset + limit);
  const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join('\n');
  return { output: numbered };
}

function editFile(input: Record<string, unknown>): ToolResult {
  const filePath = resolveSafePath(input.path as string);
  const content = fs.readFileSync(filePath, 'utf-8');
  const oldText = input.old_text as string;
  const newText = input.new_text as string;

  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    return { output: '', error: 'old_text not found in file' };
  }
  if (occurrences > 1) {
    return { output: '', error: `old_text found ${occurrences} times — must be unique` };
  }

  const updated = content.replace(oldText, newText);
  fs.writeFileSync(filePath, updated, 'utf-8');
  return { output: `File updated: ${input.path}` };
}

function writeFile(input: Record<string, unknown>): ToolResult {
  const filePath = resolveSafePath(input.path as string);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, input.content as string, 'utf-8');
  return { output: `File written: ${input.path}` };
}

function listDirectory(input: Record<string, unknown>): ToolResult {
  const dirPath = resolveSafePath((input.path as string) || '.');
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const lines = entries.map((e) => {
    const suffix = e.isDirectory() ? '/' : '';
    return `${e.name}${suffix}`;
  });
  return { output: lines.join('\n') };
}

function searchFiles(input: Record<string, unknown>): ToolResult {
  const searchPath = resolveSafePath((input.path as string) || '.');
  const pattern = input.pattern as string;
  const glob = input.glob as string | undefined;

  const args = ['--no-heading', '--line-number', '--max-count', '50'];
  if (glob) {
    args.push('--glob', glob);
  }
  args.push(pattern, searchPath);

  const result = spawnSync('rg', args, {
    timeout: 15000,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status === 1) {
    return { output: 'No matches found.' };
  }
  if (result.status !== 0 && result.status !== null) {
    return { output: '', error: result.stderr || `rg exited with code ${result.status}` };
  }
  return { output: result.stdout || 'No matches found.' };
}

function runCommand(input: Record<string, unknown>): ToolResult {
  const command = input.command as string;
  const blocked = isCommandBlocked(command);
  if (blocked) {
    auditLog('run_command', 'BLOCKED', { command, reason: blocked });
    return { output: '', error: blocked };
  }
  try {
    const result = execSync(command, {
      timeout: 30000,
      encoding: 'utf-8',
      cwd: WORKSPACE_ROOT,
      maxBuffer: 1024 * 1024,
      shell: 'bash',
    });
    return { output: result };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    return {
      output: execErr.stdout || '',
      error: execErr.stderr || execErr.message || 'Command failed',
    };
  }
}
