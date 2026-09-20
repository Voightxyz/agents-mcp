/**
 * Chat turns that outlive a single tool call.
 *
 * A Voight agent can work on one turn for up to ~10 minutes (it browses,
 * runs tools, writes files). MCP clients give a tool call far less: Codex 60 s,
 * most SDK clients 60 s, Claude Desktop 240 s. So a turn is started once, its
 * stream is consumed inside this process, and tool calls only WAIT on it for a
 * bounded time: `chat_with_agent` returns the reply if it lands in time, or a
 * `turn_ref` that `get_reply` polls. A message is never sent twice.
 *
 * State lives in memory: if the MCP client restarts this process, turns in
 * flight are lost (the agent still finishes them on its side).
 */

import { randomBytes } from 'node:crypto'
import { STREAM_TIMEOUT_MS, VoightApiError, explainError, toApiError, type VoightApi } from './api.js'

export type TurnStatus = 'running' | 'done' | 'error'

export interface Turn {
  ref: string
  agentId: string
  status: TurnStatus
  /** Reply text accumulated so far (complete once status is `done`). */
  text: string
  /** Latest tool-progress label from the agent runtime ("Searching the web"). */
  activity: string | null
  /** The runtime hit its time budget: `text` may be partial. */
  timedOut: boolean
  tokens: { prompt: number; completion: number } | null
  /** Actionable sentence when status is `error`. */
  error: string | null
  errorCode: string | null
  startedAt: number
  finishedAt: number | null
  /** A tool result already carried the finished turn to the client. */
  collected: boolean
}

type Message = { role: 'user' | 'assistant'; content: string }

/** Same rolling window the web dashboard resends each turn. */
const HISTORY_WINDOW = 16
const KEEP_TURNS = 200
/** A finished turn nobody collected is kept at least this long. */
const KEEP_UNCOLLECTED_MS = 30 * 60_000

export class ChatTurns {
  private readonly turns = new Map<string, Turn>()
  private readonly waiters = new Map<string, (() => void)[]>()
  private readonly history = new Map<string, Message[]>()
  private readonly sessions = new Map<string, string>()

  constructor(
    private readonly api: VoightApi,
    private readonly now: () => number = Date.now,
  ) {}

  get(ref: string): Turn | undefined {
    return this.turns.get(ref)
  }

  /** The turn still streaming for this agent, if any. */
  running(agentId: string): Turn | undefined {
    for (const t of this.turns.values()) if (t.agentId === agentId && t.status === 'running') return t
    return undefined
  }

  /** Forget the local conversation so the next message starts a new one. */
  reset(agentId: string): void {
    this.history.delete(agentId)
    this.sessions.delete(agentId)
  }

  /** Start a turn and return immediately. The stream is consumed in the background. */
  start(agentId: string, message: string): Turn {
    const turn: Turn = {
      ref: `turn_${randomBytes(5).toString('hex')}`,
      agentId,
      status: 'running',
      text: '',
      activity: null,
      timedOut: false,
      tokens: null,
      error: null,
      errorCode: null,
      startedAt: this.now(),
      finishedAt: null,
      collected: false,
    }
    this.turns.set(turn.ref, turn)
    this.prune()
    void this.run(turn, message)
    return turn
  }

  /** Resolve when the turn finishes or `ms` elapses, whichever comes first. */
  async wait(ref: string, ms: number): Promise<Turn | undefined> {
    const turn = this.turns.get(ref)
    if (!turn || turn.status !== 'running') return turn
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      const list = this.waiters.get(ref) ?? []
      list.push(() => {
        clearTimeout(timer)
        resolve()
      })
      this.waiters.set(ref, list)
    })
    return turn
  }

  private async run(turn: Turn, message: string): Promise<void> {
    const prior = (this.history.get(turn.agentId) ?? []).slice(-HISTORY_WINDOW)
    let sessionId = this.sessions.get(turn.agentId)
    if (!sessionId) {
      sessionId = `mcp-${randomBytes(8).toString('hex')}`
      this.sessions.set(turn.agentId, sessionId)
    }
    const user: Message = { role: 'user', content: message }
    // Mirrors the dashboard: with local history, resend it and let the runtime
    // rebuild context from the request; on a first message, name a session.
    const body = prior.length ? { messages: [...prior, user] } : { messages: [user], sessionId }

    try {
      const res = await this.api.chatStream(turn.agentId, body, AbortSignal.timeout(STREAM_TIMEOUT_MS))
      if (res.status < 200 || res.status >= 300) {
        let raw = ''
        for await (const chunk of res.body) raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        let data: unknown = null
        try {
          data = JSON.parse(raw)
        } catch {
          /* non-JSON error body */
        }
        throw toApiError(res.status, data, raw)
      }
      await this.consume(turn, res.body)
      if (turn.timedOut && !turn.text) {
        turn.status = 'error'
        turn.errorCode = 'AGENT_TIMEOUT'
        turn.error = 'The agent ran out of time on this turn before replying. It may still be finishing in the background: do not resend the same message right away.'
      } else if (!turn.text.trim()) {
        // A clean stream with no text at all (and usually 0 tokens) means the
        // agent's own model call failed quietly. Reporting it as a finished
        // reply would send an orchestrator on with nothing.
        turn.status = 'error'
        turn.errorCode = 'EMPTY_REPLY'
        turn.error = 'The agent ended the turn without writing anything, which usually means its model call failed. Try once more; if it happens again, tell the user to check this agent in the dashboard.'
      } else {
        turn.status = 'done'
        if (turn.text.trim()) {
          const next = [...(this.history.get(turn.agentId) ?? []), user, { role: 'assistant' as const, content: turn.text }]
          this.history.set(turn.agentId, next.slice(-HISTORY_WINDOW))
        }
      }
    } catch (err) {
      turn.status = 'error'
      turn.errorCode = err instanceof VoightApiError ? (err.code ?? `HTTP_${err.status}`) : 'NETWORK'
      turn.error = turn.text
        ? `The connection to the agent dropped mid-reply (${explainError(err)}). The partial reply is included. Do not resend the same message right away.`
        : explainError(err)
    } finally {
      turn.finishedAt = this.now()
      for (const wake of this.waiters.get(turn.ref) ?? []) wake()
      this.waiters.delete(turn.ref)
    }
  }

  /** Parse the OpenAI-compatible SSE stream into the turn. */
  private async consume(turn: Turn, body: AsyncIterable<Uint8Array | string>): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    const handleLine = (rawLine: string) => {
      const line = rawLine.replace(/\r$/, '')
      if (!line) {
        event = ''
        return
      }
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
        if (event === 'hermes.timeout') turn.timedOut = true
        return
      }
      if (!line.startsWith('data:')) return
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') return
      let frame: unknown
      try {
        frame = JSON.parse(data)
      } catch {
        return
      }
      if (!frame || typeof frame !== 'object') return
      if (event === 'hermes.tool.progress') {
        const p = frame as { label?: unknown; status?: unknown }
        if (p.status === 'running' && typeof p.label === 'string' && p.label.trim()) turn.activity = p.label.trim().slice(0, 120)
        return
      }
      const f = frame as {
        choices?: { delta?: { content?: unknown } }[]
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null
      }
      const delta = f.choices?.[0]?.delta?.content
      if (typeof delta === 'string') turn.text += delta
      if (f.usage && typeof f.usage.prompt_tokens === 'number' && typeof f.usage.completion_tokens === 'number') {
        turn.tokens = { prompt: f.usage.prompt_tokens, completion: f.usage.completion_tokens }
      }
    }
    for await (const chunk of body) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    }
    if (buffer) handleLine(buffer)
  }

  /** The finished turn reached the client: it may be forgotten when space is needed. */
  markCollected(ref: string): void {
    const t = this.turns.get(ref)
    if (t && t.status !== 'running') t.collected = true
  }

  /**
   * Oldest first, and never a running turn nor a reply nobody has read yet
   * (a fan-out to ten agents must not evict the answers of the previous one).
   */
  private prune(): void {
    if (this.turns.size <= KEEP_TURNS) return
    const now = this.now()
    for (const [ref, t] of this.turns) {
      if (this.turns.size <= KEEP_TURNS) break
      if (t.status === 'running') continue
      const stale = t.finishedAt !== null && now - t.finishedAt > KEEP_UNCOLLECTED_MS
      if (t.collected || stale) this.turns.delete(ref)
    }
  }
}
