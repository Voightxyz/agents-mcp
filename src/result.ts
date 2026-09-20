/**
 * Shared shapes for tool results and the small helpers every tool module uses.
 */

import type { McpServer } from '@modelcontextprotocol/server'
import type { VoightApi } from './api.js'
import type { ChatTurns } from './chat.js'
import { MAX_RESULT_CHARS } from './format.js'

export type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

export function ok(structured: Record<string, unknown>, text?: string): ToolResult {
  return { content: [{ type: 'text', text: text ?? JSON.stringify(structured, null, 2) }], structuredContent: structured }
}

export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Drop list items from the end until the serialized result fits the cap. */
export function fitItems<T>(items: T[], max = MAX_RESULT_CHARS): T[] {
  let kept = items
  while (kept.length > 1 && JSON.stringify(kept).length > max) kept = kept.slice(0, Math.ceil(kept.length * 0.8) - 1 || 1)
  return kept
}

/** Seconds a tool may block, clamped under the 60 s that several clients allow a call. */
export function clampWait(seconds: number | undefined, fallback: number, max = 55): number {
  const s = seconds ?? fallback
  return Math.min(max, Math.max(1, s)) * 1000
}

/** What a tool module needs from the server it registers on. */
export interface ToolContext {
  server: McpServer
  api: VoightApi
  turns: ChatTurns
  /** Agent id -> name, learned from list/get calls, for readable fences. */
  names: Map<string, string>
  now: () => number
  /** Missing key and API failures become one clear sentence. */
  guarded: (run: () => Promise<ToolResult>) => Promise<ToolResult>
  readOnly: boolean
  sleep: (ms: number) => Promise<void>
}

export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
