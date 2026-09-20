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
    /** The rest of the error body: amounts, dates, the new price. */
    readonly data: Record<string, unknown> = {},
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
        return `${presetNames(err.message)} Keys are created at ${SETTINGS_URL}.`
      case 'KEY_EXPIRED':
        return `This API key expired ("Agents: full" keys last 90 days). Create a new one at ${SETTINGS_URL}.`
      case 'KEY_EXPIRY_REQUIRED':
        return `This action needs an "Agents: full" key created in the dashboard (they carry an expiry). Create one at ${SETTINGS_URL}.`
      case 'KEY_REQUIRED':
        return `This action only works with an "Agents: full" API key. Create one at ${SETTINGS_URL}.`
      case 'INSUFFICIENT_FUNDS': {
        const needed = typeof err.data.needed === 'number' ? ` $${err.data.needed.toFixed(2)} more is needed.` : ''
        return `Not enough credits: this costs $${typeof err.data.priceUsd === 'number' ? err.data.priceUsd : 15}.${needed} Nothing was charged or created. Top up at ${AGENTS_URL}.`
      }
      case 'COST_CHANGED':
        return `The price is higher than the confirmed one (${describeAmounts(err.data)}). Nothing was charged. Ask for a new quote and confirm it with the user.`
      case 'COST_CONFIRMATION_REQUIRED':
        return `A GPU deploy must repeat the quoted hourly price as confirm_hourly_usd (${describeAmounts(err.data)}). Nothing was charged. Call quote_agent_deploy first.`
      case 'PROVISIONING_UNAVAILABLE':
        return 'Voight cannot provision or tear down agents right now. Nothing was charged or changed. Try again later.'
      case 'AGENT_PROVISIONING':
        return 'This agent is still starting. Use wait_for_agent until it is ready, then delete it. Nothing was deleted.'
      case 'CONFIRM_NAME_MISMATCH':
        return "confirm_name must be the agent's exact name (see list_agents). Nothing was deleted."
      case 'HANDLE_UNAVAILABLE':
        return 'Could not allocate a handle for that name. Nothing was charged. Try a different name.'
      case 'INTERNAL':
        return 'Voight hit an internal error. It is unclear whether the action was applied: check list_agents before trying again.'
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
    // Every other coded refusal already carries a sentence written for the caller
    // (caps, GPU invite, renewal not due, key-deployed only, task approval...).
    if (err.code && err.status >= 400 && err.status < 500 && err.message) return sentence(presetNames(err.message))
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

function sentence(text: string): string {
  const t = text.trim()
  const capped = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(capped) ? capped : `${capped}.`
}

/** The server names presets by id; people know them by their Settings label. */
function presetNames(text: string): string {
  return text.replace(/"?agents_full"?/g, '"Agents: full"').replace(/"?agents_operate"?/g, '"Agents: operate"')
}

function describeAmounts(data: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof data.costUsd === 'number') parts.push(`cost $${data.costUsd}`)
  if (typeof data.hourlyUsd === 'number') parts.push(`GPU $${data.hourlyUsd} per hour`)
  return parts.join(', ') || 'see a new quote'
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

  private async json<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.config.endpoint}/v1${path}`, {
      method,
      headers: body === undefined ? this.headers() : { ...this.headers(), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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

  // ── "Agents: full" surface: spends credits, plants tasks, deletes ────────
  gpuMarkets() {
    return this.json<{ hoursBilled: boolean; markets: ApiGpuMarket[] }>('GET', '/mcp/gpu-markets')
  }
  limits() {
    return this.json<{ limits: Record<string, number> }>('GET', '/mcp/limits')
  }
  quoteDeploy(input: DeployInput) {
    return this.json<{ quote: ApiDeployQuote }>('POST', '/mcp/agents/quote', input)
  }
  deploy(input: DeployInput & { confirmCostUsd: number; confirmHourlyUsd?: number; allowDuplicate?: boolean }) {
    return this.json<{ agent: ApiAgent; replayed: boolean; chargedUsd: number }>('POST', '/mcp/agents', input)
  }
  quoteRenew(id: string) {
    return this.json<{ quote: ApiRenewQuote }>('POST', `/mcp/agents/${encodeURIComponent(id)}/renew/quote`, {})
  }
  renew(id: string, confirmCostUsd: number) {
    return this.json<{ agent: ApiAgent; chargedUsd: number; debounced: boolean }>('POST', `/mcp/agents/${encodeURIComponent(id)}/renew`, { confirmCostUsd })
  }
  deleteAgent(id: string, confirmName: string) {
    return this.json<{ ok: true; already: boolean; refunded: 'credits' | 'free' | null; teardown: 'pending' | 'none' }>(
      'DELETE',
      `/mcp/agents/${encodeURIComponent(id)}`,
      { confirmName },
    )
  }
  createTask(agentId: string, body: TaskWrite & { title: string; prompt: string }) {
    return this.json<{ task: ApiTask; pausedForApproval: boolean }>('POST', `/mcp/agents/${encodeURIComponent(agentId)}/tasks`, body)
  }
  updateTask(agentId: string, taskId: string, body: TaskWrite) {
    return this.json<{ task: ApiTask; pausedForApproval: boolean }>(
      'PATCH',
      `/mcp/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}`,
      body,
    )
  }
  deleteTask(agentId: string, taskId: string) {
    return this.json<{ ok: true }>('DELETE', `/mcp/agents/${encodeURIComponent(agentId)}/tasks/${encodeURIComponent(taskId)}`)
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
  const { error: _error, code: _code, ...rest } = obj
  return new VoightApiError(status, code, message, rest)
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
  /** A deploy that has not started anything yet: deleting it now returns the $15. */
  cancelRefundable?: boolean
}

export interface DeployInput {
  name: string
  role?: string
  persona?: string
  model?: string
  framework?: 'hermes' | 'zeroclaw'
  template?: 'general' | 'sales' | 'social' | 'prediction'
  host?: 'voight' | 'nosana'
  market?: '3060' | '3090' | '4090'
  description?: string
  tone?: 'Friendly' | 'Professional' | 'Direct' | 'Sharp'
}

export interface ApiGpuMarket {
  market: string
  name: string
  hourlyUsd: number
  availableGpus: number | null
  queuedJobs: number | null
}

export interface ApiDeployQuote {
  costUsd: number
  periodDays: number
  host: 'voight' | 'nosana'
  gpu: { market: string; name: string; hourlyUsd: number; hoursBilled: boolean } | null
  balanceUsd: number
  sufficientBalance: boolean
  cancelRefundable: boolean
}

export interface ApiRenewQuote {
  costUsd: number
  periodDays: number
  due: boolean
  renewableFrom: string | null
  expiresAt: string | null
  balanceUsd: number
  sufficientBalance: boolean
}

export interface TaskWrite {
  title?: string
  prompt?: string
  enabled?: boolean
  scheduleKind?: 'DAILY' | 'WEEKLY' | null
  scheduleHour?: number | null
  scheduleMinute?: number
  scheduleWeekday?: number | null
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
