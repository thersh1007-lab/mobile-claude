import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ServerMessage } from './types';

// Auto-detect claude CLI path at module load
function findClaudePath(): string {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
  } catch {
    return 'claude';
  }
}

const CLAUDE_BIN = findClaudePath();

type SendFn = (msg: ServerMessage) => boolean | void;

let bridgeBusy = false;
let pendingResponse: ServerMessage[] | null = null;

// Conversation memory for multi-turn CC mode
interface BridgeExchange {
  role: 'user' | 'assistant';
  content: string;
}

let bridgeHistory: BridgeExchange[] = [];
const MAX_BRIDGE_HISTORY = 20; // max exchanges to include in prompt

export function resetBridgeSession(): void {
  bridgeBusy = false;
  pendingResponse = null;
  bridgeHistory = [];
}

export function isBridgeBusy(): boolean {
  return bridgeBusy;
}

export function deliverPendingResponse(send: SendFn): void {
  if (pendingResponse) {
    console.log(`[Bridge] Delivering buffered response (${pendingResponse.length} messages)`);
    for (const msg of pendingResponse) {
      send(msg);
    }
    pendingResponse = null;
    bridgeBusy = false;
  } else if (bridgeBusy) {
    send({ type: 'status', state: 'thinking' });
  }
}

function buildPrompt(userMessage: string, cwd: string): string {
  const parts: string[] = [];

  parts.push(`You are helping the user via mobile chat in ${cwd}.`);
  parts.push(`Use your tools to fulfill the request.`);
  parts.push(`Do NOT ask clarifying questions or say the message was cut off — just do the work.`);
  parts.push(`Keep responses concise.`);

  // Include conversation history for context
  if (bridgeHistory.length > 0) {
    parts.push('');
    parts.push('--- Conversation history (for context) ---');
    // Take last N exchanges
    const recent = bridgeHistory.slice(-MAX_BRIDGE_HISTORY);
    for (const exchange of recent) {
      const label = exchange.role === 'user' ? 'User' : 'Assistant';
      // Truncate long assistant responses to save tokens
      const content = exchange.role === 'assistant' && exchange.content.length > 2000
        ? exchange.content.slice(0, 2000) + '...(truncated)'
        : exchange.content;
      parts.push(`${label}: ${content}`);
    }
    parts.push('--- End of history ---');
    parts.push('');
  }

  parts.push(`User request: ${userMessage}`);

  return parts.join('\n');
}

export async function handleBridgeMessage(
  userMessage: string,
  cwd: string,
  send: SendFn,
): Promise<void> {
  bridgeBusy = true;
  send({ type: 'status', state: 'thinking' });

  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k === 'CLAUDE_CODE_ENTRYPOINT') continue;
    if (v !== undefined) cleanEnv[k] = v;
  }

  const wrappedMessage = buildPrompt(userMessage, cwd);

  // Write prompt to temp file to avoid shell escaping issues
  const tmpFile = path.join(os.tmpdir(), `mc-prompt-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, wrappedMessage, 'utf-8');
  const tmpUnix = tmpFile.replace(/\\/g, '/');

  console.log(`[Bridge] Spawning in ${cwd} | prompt: ${userMessage.slice(0, 80)} | history: ${bridgeHistory.length} exchanges`);

  // Record the user message in history
  bridgeHistory.push({ role: 'user', content: userMessage });

  return new Promise<void>((resolve) => {
    // Use bash to cat the prompt from temp file — avoids shell escaping on all platforms
    const claudeBin = CLAUDE_BIN.replace(/\\/g, '/');
    const proc = spawn('bash', [
      '-c',
      `"${claudeBin}" -p "$(cat "${tmpUnix}")" --output-format stream-json --verbose --dangerously-skip-permissions --max-turns 10`,
    ], {
      cwd,
      env: cleanEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });

    let stderr = '';
    let fullText = '';
    let lineBuffer = '';
    let costInfo: { input_tokens: number; output_tokens: number; cost_usd: number } | null = null;
    const buffer: ServerMessage[] = [];

    function sendAndBuffer(msg: ServerMessage): void {
      send(msg);
      buffer.push(msg);
    }

    // Parse NDJSON stream line by line
    proc.stdout.on('data', (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      // Keep the last (possibly incomplete) line in the buffer
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line.trim());
          processStreamEvent(event);
        } catch {
          // Not valid JSON — ignore (could be partial line or debug output)
        }
      }
    });

    function processStreamEvent(event: Record<string, unknown>): void {
      const type = event.type as string;

      if (type === 'assistant') {
        // Extract text from assistant message content blocks
        const message = event.message as Record<string, unknown> | undefined;
        if (message && Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              // Send only the new text (delta)
              const newText = block.text;
              if (newText.length > fullText.length && newText.startsWith(fullText)) {
                // Progressive text — send only the new part
                const delta = newText.slice(fullText.length);
                if (delta) {
                  sendAndBuffer({ type: 'text_delta', content: delta });
                }
              } else if (newText !== fullText) {
                // Different text block (e.g., new turn) — send the whole thing
                sendAndBuffer({ type: 'text_delta', content: newText });
              }
              fullText = newText;
            }
          }
        }
      }

      if (type === 'content_block_delta') {
        // Streaming content delta events
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
          fullText += delta.text;
          sendAndBuffer({ type: 'text_delta', content: delta.text });
        }
      }

      if (type === 'result') {
        // Final result — extract cost and any remaining text
        const resultText = event.result as string || '';
        if (resultText && !fullText) {
          // No streaming happened — send the full result
          fullText = resultText;
          sendAndBuffer({ type: 'text_delta', content: resultText });
        }

        const totalCost = (event.total_cost_usd as number) || (event.cost_usd as number) || 0;
        if (totalCost) {
          costInfo = {
            input_tokens: (event.input_tokens as number) || 0,
            output_tokens: (event.output_tokens as number) || 0,
            cost_usd: totalCost,
          };
          console.log(`[Bridge] Cost: $${totalCost.toFixed(4)} | Duration: ${event.duration_ms}ms | Turns: ${event.num_turns}`);
        }

        if (event.is_error) {
          sendAndBuffer({ type: 'error', message: `Claude Code: ${resultText}` });
        }
      }
    }

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      try { fs.unlinkSync(tmpFile); } catch {}
      console.error(`[Bridge] Spawn error: ${err.message}`);
      sendAndBuffer({ type: 'error', message: `Failed to start Claude Code: ${err.message}` });
      sendAndBuffer({ type: 'status', state: 'idle' });
      pendingResponse = buffer;
      bridgeBusy = false;
      resolve();
    });

    proc.on('close', (code) => {
      try { fs.unlinkSync(tmpFile); } catch {}

      // Process any remaining data in the line buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer.trim());
          processStreamEvent(event);
        } catch {
          // If it's not JSON and we got no text, treat it as raw output
          if (!fullText && lineBuffer.trim()) {
            fullText = lineBuffer.trim();
            sendAndBuffer({ type: 'text_delta', content: fullText });
          }
        }
      }

      if (stderr.trim()) {
        console.error(`[Bridge] stderr: ${stderr.trim().slice(0, 500)}`);
      }

      if (code !== 0 && !fullText) {
        console.error(`[Bridge] Exit code ${code}`);
        sendAndBuffer({ type: 'error', message: `Claude Code exited with code ${code}. ${stderr.trim().slice(0, 200)}` });
      }

      // Send text_done with full accumulated text
      if (fullText) {
        sendAndBuffer({ type: 'text_done', content: fullText });
        // Record assistant response in history
        bridgeHistory.push({ role: 'assistant', content: fullText });
        // Prune history if too long
        while (bridgeHistory.length > MAX_BRIDGE_HISTORY * 2) {
          bridgeHistory.shift();
        }
        console.log(`[Bridge] Response (${fullText.length} chars): ${fullText.slice(0, 200)}`);
      }

      // Send cost update
      if (costInfo) {
        sendAndBuffer({ type: 'cost_update', ...costInfo });
      }

      const idleMsg: ServerMessage = { type: 'status', state: 'idle' };
      const delivered = send(idleMsg) !== false;
      buffer.push(idleMsg);

      if (delivered) {
        pendingResponse = null;
        console.log(`[Bridge] Complete (delivered live)`);
      } else {
        pendingResponse = buffer;
        console.log(`[Bridge] Complete (buffered ${buffer.length} messages for reconnect)`);
      }
      bridgeBusy = false;
      resolve();
    });
  });
}
