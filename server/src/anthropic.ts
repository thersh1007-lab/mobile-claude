import Anthropic from '@anthropic-ai/sdk';
import { toolSchemas, executeTool, getWorkspaceRoot } from './tools';
import { ServerMessage } from './types';
import { auditLog } from './audit';

const client = new Anthropic();

// Pricing per million tokens (Sonnet 4.6)
const INPUT_COST_PER_M = 3.0;
const OUTPUT_COST_PER_M = 15.0;

function estimateCost(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_COST_PER_M + (outputTokens / 1_000_000) * OUTPUT_COST_PER_M;
}

function getSystemPrompt(): string {
  return `You are Claude, an AI assistant running on a remote server connected to the user's workspace at ${getWorkspaceRoot()}. You have tools to read files, edit files, write files, list directories, search code, and run shell commands. Use these tools to help the user with their tasks. Be concise and direct. The user is chatting from a mobile phone so keep responses short when possible.`;
}

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

export async function handleConversation(
  messages: MessageParam[],
  sendToClient: (msg: ServerMessage) => void,
  waitForApproval: (id: string, name: string, input: Record<string, unknown>) => Promise<boolean>,
): Promise<void> {
  let continueLoop = true;
  let turnCount = 0;
  const MAX_TURNS = 20; // safety limit

  while (continueLoop && turnCount < MAX_TURNS) {
    turnCount++;
    sendToClient({ type: 'status', state: 'thinking' });

    let stream;
    try {
      stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: getSystemPrompt(),
        messages,
        tools: toolSchemas,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[API] Failed to create stream: ${message}`);
      sendToClient({ type: 'error', message: `API error: ${message}` });
      sendToClient({ type: 'status', state: 'idle' });
      return;
    }

    let fullText = '';
    const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    stream.on('text', (text) => {
      fullText += text;
      sendToClient({ type: 'text_delta', content: text });
    });

    let finalMessage;
    try {
      finalMessage = await stream.finalMessage();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[API] Stream error: ${message}`);
      sendToClient({ type: 'error', message: `Claude error: ${message}` });
      sendToClient({ type: 'status', state: 'idle' });
      return;
    }

    // Collect tool use blocks
    for (const block of finalMessage.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        });
      }
    }

    // Send cost update
    const usage = finalMessage.usage;
    if (usage) {
      const cost = estimateCost(usage.input_tokens, usage.output_tokens);
      sendToClient({
        type: 'cost_update',
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: cost,
      });
    }

    if (fullText) {
      sendToClient({ type: 'text_done', content: fullText });
    }

    if (toolCalls.length === 0) {
      continueLoop = false;
      sendToClient({ type: 'status', state: 'idle' });

      // Add assistant response to history
      if (finalMessage.content.length > 0) {
        messages.push({ role: 'assistant', content: finalMessage.content });
      }
      break;
    }

    // Add assistant message with all content blocks
    messages.push({ role: 'assistant', content: finalMessage.content });

    // Process tool calls one at a time
    const toolResults: ContentBlockParam[] = [];

    for (const tc of toolCalls) {
      sendToClient({ type: 'status', state: 'awaiting_approval' });
      const approved = await waitForApproval(tc.id, tc.name, tc.input);

      if (approved) {
        auditLog(tc.name, 'EXECUTED', { input: tc.input });
        try {
          const result = await executeTool(tc.name, tc.input);
          sendToClient({
            type: 'tool_result',
            id: tc.id,
            output: result.output,
            error: result.error,
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: result.error ? `Error: ${result.error}\n${result.output}` : result.output,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[API] Tool execution error (${tc.name}): ${message}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: `Error executing tool: ${message}`,
            is_error: true,
          });
        }
      } else {
        auditLog(tc.name, 'DENIED', { input: tc.input });
        sendToClient({
          type: 'tool_result',
          id: tc.id,
          output: '',
          error: 'User denied this tool call',
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: 'User denied this tool call.',
          is_error: true,
        });
      }
    }

    // Add tool results as user message
    messages.push({ role: 'user', content: toolResults });
  }

  if (turnCount >= MAX_TURNS) {
    console.warn(`[API] Hit max turns limit (${MAX_TURNS})`);
    sendToClient({ type: 'error', message: 'Reached maximum tool call turns. Start a new message.' });
    sendToClient({ type: 'status', state: 'idle' });
  }
}
