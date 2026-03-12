/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared WebSocket protocol types antara frontend (browser) dan backend (Node.js server).
 * File ini diimport oleh keduanya — jangan tambahkan runtime imports yang browser-only atau Node-only.
 */

// ─── Client → Server ────────────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'start_session'; mealLogs: string }
  | { type: 'audio_chunk'; data: string }
  | { type: 'video_frame'; data: string }
  | { type: 'tool_response'; responses: ToolResponseItem[] }
  | { type: 'stop_session' };

// ─── Server → Client ────────────────────────────────────────────────────────

export type ServerMessage =
  | { type: 'session_ready' }
  | { type: 'ai_audio'; data: string }
  | { type: 'tool_call'; calls: ToolCallItem[] }
  | { type: 'interrupted' }
  | { type: 'status'; status: AgentStatus; text: string }
  | { type: 'error'; message: string };

// ─── Shared Types ────────────────────────────────────────────────────────────

export type AgentStatus = 'CONNECTING' | 'LISTENING' | 'SPEAKING' | 'DISCONNECTED' | 'ERROR';

export interface ToolCallItem {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResponseItem {
  id: string;
  name: string;
  response: Record<string, unknown>;
}
