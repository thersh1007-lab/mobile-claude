// WebSocket message types

// Server -> Client
export type ServerMessage =
  | { type: 'text_delta'; content: string }
  | { type: 'text_done'; content: string }
  | { type: 'tool_request'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; output: string; error?: string }
  | { type: 'error'; message: string }
  | { type: 'status'; state: 'idle' | 'thinking' | 'awaiting_approval' }
  | { type: 'workspaces'; list: Array<{ name: string; path: string }>; current: string }
  | { type: 'workspace_changed'; path: string; name: string }
  | { type: 'upload_complete'; filename: string; path: string }
  | { type: 'voice_memo_result'; success: boolean; filename: string; title: string; cluster: string; error?: string }
  | { type: 'mode_changed'; mode: 'direct' | 'bridge' }
  | { type: 'transcription'; text: string }
  | { type: 'cost_update'; input_tokens: number; output_tokens: number; cost_usd: number }
  | { type: 'conversation_list'; conversations: Array<{ id: string; mode: string; workspace: string; created: string; updated: string; messageCount: number; preview: string }> }
  | { type: 'conversation_loaded'; conversation: { id: string; mode: string; messages: Array<{ role: string; content: string; timestamp: string }> } }
  | { type: 'cc_sessions'; sessions: Array<{ sessionId: string; project: string; projectPath: string; messageCount: number; firstMessage: string; timestamp: string }> }
  | { type: 'session_imported'; conversation: { id: string; mode: string; messageCount: number; created: string } };

// Client -> Server
export type ClientMessage =
  | { type: 'message'; content: string; token: string }
  | { type: 'tool_decision'; id: string; approved: boolean }
  | { type: 'set_workspace'; path: string; token: string }
  | { type: 'list_workspaces'; token: string }
  | { type: 'upload_file'; filename: string; data: string; token: string }
  | { type: 'voice_memo'; transcript: string; token: string }
  | { type: 'voice_audio'; data: string; format: string; token: string }
  | { type: 'set_mode'; mode: 'direct' | 'bridge'; token: string }
  | { type: 'new_chat'; token: string }
  | { type: 'list_conversations'; token: string }
  | { type: 'load_conversation'; id: string; token: string }
  | { type: 'list_cc_sessions'; token: string }
  | { type: 'import_cc_session'; sessionId: string; token: string };

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  error?: string;
}
