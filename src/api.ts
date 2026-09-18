/**
 * Thin client for the Voight API surface that accepts scoped API keys
 * (`/v1/mcp/*` plus the agent chat route). No business state lives here.
 */

import http from 'node:http'
import https from 'node:https'
import { AGENTS_URL, SETTINGS_URL, type Config } from './config.js'
import { VERSION } from './version.js'

const JSON_TIMEOUT_MS = 30_000
/** The server gives a chat turn up to 585 s. Leave it room to say so itself. */
export const STREAM_TIMEOUT_MS = 610_000

export class VoightApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'VoightApiError'
  }
}

/** Turn an API failure into one sentence the model (and its user) can act on. */
export function explainError(err: unknown): string {
  if (err instanceof VoightApiError) {
    switch (err.code) {
      case 'KEY_UNKNOWN':
        return `Voight did not recognize this API key. Create a new one with "Agents: operate" access at ${SETTINGS_URL}.`
      case 'KEY_REVOKED':
        return `This API key was revoked. Create a new one with "Agents: operate" access at ${SETTINGS_URL}.`
      case 'KEY_SCOPE_MISSING':
        return `${err.message} Keys are created at ${SETTINGS_URL}.`
      case 'INSUFFICIENT_CREDITS':
        return `Not enough credits for this action. Top up at ${AGENTS_URL} and try again.`
      case 'AGENT_EXPIRED':
        return `This agent's hosting period ended. Renew it at ${AGENTS_URL} to use it again.`
      case 'AGENT_WAKING':
        return 'The GPU for this agent is starting, which takes a few minutes. The message was NOT delivered. Check get_agent until it is ready, then send it once.'
      case 'AGENT_GPU_STOPPED':
        return 'The GPU session for this agent ended and it could not be restarted from here. The message was NOT delivered. Try wake_agent, or open the dashboard.'
      case 'AGENT_BUSY':
        return 'The agent is still working on its previous turn. Do not resend the message: wait and try again in a minute.'
    }
    if (err.status === 401) return `Voight rejected the API key (${err.message}). Check VOIGHT_API_KEY, or create a new key at ${SETTINGS_URL}.`
    if (err.status === 404) return 'Agent not found on this account. Use list_agents to see the ids you can use.'
    if (err.status === 429) return 'Rate limit reached for this API key. Wait before calling again; do not retry in a loop.'
    if (err.status === 409) return `The agent cannot do that right now (${err.message}). Check get_agent for its current status.`
    if (err.status === 504) return 'The agent ran out of time on this turn. It may still be finishing in the background: do not resend the same message right away.'
    if (err.status >= 500) return `Voight had a problem serving this request (${err.status} ${err.message}). Try again in a moment.`
    return `Voight refused the request (${err.status} ${err.message}).`
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'The request to Voight timed out. Try again in a moment.'
    return `Could not reach Voight: ${err.message}`
  }
  return 'Could not reach Voight.'
}

export interface StreamResponse {
  status: number
  /** Raw body chunks (SSE on success, a JSON error otherwise). */
  body: AsyncIterable<Uint8Array | string>
}
export type StreamOpener = (
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<StreamResponse>

/**
 * POST and hand back the live response stream. Uses node:http(s) rather than
 * fetch on purpose: fetch (undici) aborts a body that stays quiet for 300 s,
 * and an agent running tools can legitimately be silent for longer.
 */
export const openNodeStream: StreamOpener = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url)
    const lib = target.protocol === 'http:' ? http : https
    const req = lib.request(
      target,
      {
        method: 'POST',
        headers: { ...init.headers, 'content-length': String(Buffer.byteLength(init.body)) },
        signal: init.signal,
      },
      (res) => resolve({ status: res.statusCode ?? 0, body: res }),
    )
    req.on('error', reject)
    req.end(init.body)
  })

export interface ApiDeps {
  fetch?: typeof fetch
  openStream?: StreamOpener
}

export class VoightApi {
  private readonly fetchImpl: typeof fetch
  private readonly openStream: StreamOpener

  constructor(
    private readonly config: Config,
    deps: ApiDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? fetch
    this.openStream = deps.openStream ?? openNodeStream
  }

  private headers(): Record<string, string> {
    if (!this.config.apiKey) throw new Error(this.config.apiKeyProblem ?? 'VOIGHT_API_KEY is not set.')
    return {
      authorization: `Bearer ${this.config.apiKey}`,
      'user-agent': `voight-agents-mcp/${VERSION}`,
      accept: 'application/json',
    }
  }

  private async json<T>(method: 'GET' | 'POST', path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.config.endpoint}/v1${path}`, {
      method,
      headers: this.headers(),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) throw toApiError(res.status, data, text)
    return data as T
  }

  whoami() {
    return this.json<{ ok: boolean; via: string; userId: string; plan: string }>('GET', '/mcp/whoami')
  }
  listAgents() {
    return this.json<{ agents: ApiAgent[]; priceUsd: number }>('GET', '/mcp/agents')
  }
  getAgent(id: string) {
    return this.json<{ agent: ApiAgent }>('GET', `/mcp/agents/${encodeURIComponent(id)}`)
  }
  agentUsage(id: string) {
    return this.json<ApiAgentUsage>('GET', `/mcp/agents/${encodeURIComponent(id)}/usage`)
  }
  fleetUsage() {
    return this.json<{ turns: number; totalTokens: number; costUsd: number; agents: number }>('GET', '/mcp/agents/usage')
  }
  listTasks(id: string) {
    return this.json<{ tasks: ApiTask[] }>('GET', `/mcp/agents/${encodeURIComponent(id)}/tasks`)
  }
  credits() {
    return this.json<{ balanceUsd: number; plan: string; agentPriceUsd: number }>('GET', '/mcp/credits')
  }
  wake(id: string) {
    return this.json<{ agent: ApiAgent; waking: boolean }>('POST', `/mcp/agents/${encodeURIComponent(id)}/wake`)
  }

  /** Open a chat turn. Resolves once response headers arrive. */
  async chatStream(
    id: string,
    body: { messages: { role: 'user' | 'assistant'; content: string }[]; sessionId?: string },
    signal: AbortSignal,
  ): Promise<StreamResponse> {
    return this.openStream(`${this.config.endpoint}/v1/agents/${encodeURIComponent(id)}/chat`, {
      headers: { ...this.headers(), accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }
}

export function toApiError(status: number, data: unknown, rawText = ''): VoightApiError {
  const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const code = typeof obj.code === 'string' ? obj.code : null
  const message = typeof obj.error === 'string' ? obj.error : rawText.slice(0, 200) || `HTTP ${status}`
  return new VoightApiError(status, code, message)
}

/** The fields of the API's agent shape that this server reads. */
export interface ApiAgent {
  id: string
  name: string
  role: string | null
  model: string
  persona: string | null
  framework: string
  template: string | null
  keySource: string
  telegramEnabled: boolean
  telegramBotUsername: string | null
  githubConnected: boolean
  githubRepo: string | null
  linkedinConnected: boolean
  xConnected: boolean
  status: string
  error: string | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
  isFree: boolean
  daysLeft: number
  active: boolean
  registryStatus: string
  registryUrl: string | null
  host: string
  nosanaJobUrl: string | null
  gpuStopped: boolean
  gpuMarketName: string | null
  runtimeModel: string | null
}

export interface ApiAgentUsage {
  turns: number
  totalTokens: number
  costUsd: number
  daily: { date: string; tokens: number }[]
  gpuHours: { total: number; today: number; costUsd: number } | null
}

export interface ApiTask {
  id: string
  title: string
  owner: string
  priority: string
  status: string
  dueDate: string | null
  prompt: string | null
  enabled: boolean
  scheduleKind: string | null
  scheduleHour: number | null
  scheduleMinute: number | null
  scheduleWeekday: number | null
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  lastError: string | null
  lastResult: string | null
  runCount: number
}
