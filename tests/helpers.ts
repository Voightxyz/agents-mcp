import type { ApiAgent, StreamOpener } from '../src/api.js'
import type { Config } from '../src/config.js'

export const CONFIG: Config = { apiKey: 'vk_test', apiKeyProblem: null, endpoint: 'https://api.voight.xyz', readOnly: false }

export const CLOUD_AGENT: ApiAgent = {
  id: 'ag_cloud',
  name: 'Research bot',
  role: 'Researcher',
  model: 'z-ai/glm-4.6',
  persona: 'You research things.',
  framework: 'hermes',
  template: 'general',
  keySource: 'PLATFORM',
  telegramEnabled: true,
  telegramBotUsername: '@research_bot',
  githubConnected: false,
  githubRepo: null,
  linkedinConnected: false,
  xConnected: false,
  status: 'READY',
  error: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  lastUsedAt: null,
  expiresAt: '2026-10-01T00:00:00.000Z',
  isFree: true,
  daysLeft: 12,
  active: true,
  registryStatus: 'REGISTERED',
  registryUrl: 'https://example.test/asset',
  host: 'cloudrun',
  nosanaJobUrl: null,
  gpuStopped: false,
  gpuMarketName: null,
  runtimeModel: null,
}

export const GPU_AGENT: ApiAgent = {
  ...CLOUD_AGENT,
  id: 'ag_gpu',
  name: 'GPU bot',
  host: 'nosana',
  nosanaJobUrl: 'https://dashboard.nosana.com/jobs/JOB1',
  gpuStopped: true,
  gpuMarketName: 'NVIDIA 3060',
  runtimeModel: 'hermes3:8b',
  telegramEnabled: false,
}


type Route = { status?: number; body: unknown }

/** A fetch that answers from a `METHOD /path` table and records every call. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: { method: string; path: string; auth: string | null }[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    calls.push({ method, path: url.pathname, auth: headers.get('authorization') })
    const route = routes[`${method} ${url.pathname}`]
    if (!route) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 })
  }) as typeof fetch
  return { impl, calls }
}

/** An SSE body the test pushes chunks into, to model a slow agent. */
export function controlledStream() {
  const queue: (string | null)[] = []
  let notify: (() => void) | null = null
  const push = (chunk: string | null) => {
    queue.push(chunk)
    notify?.()
  }
  async function* body() {
    for (;;) {
      if (!queue.length) await new Promise<void>((r) => (notify = r))
      notify = null
      const next = queue.shift()
      if (next == null) return
      yield next
    }
  }
  return { body: body(), send: (chunk: string) => push(chunk), end: () => push(null) }
}

export const sse = {
  delta: (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
  usage: (prompt: number, completion: number) =>
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`,
  tool: (label: string) => `event: hermes.tool.progress\ndata: ${JSON.stringify({ status: 'running', label, emoji: 'x' })}\n\n`,
  timeout: () => 'event: hermes.timeout\ndata: {}\n\n',
  done: () => 'data: [DONE]\n\n',
}

/** A stream opener that replays a scripted response per call and records request bodies. */
export function fakeStreams(responses: { status: number; body: AsyncIterable<string> | string[] }[]) {
  const requests: { url: string; body: any }[] = []
  let i = 0
  const open: StreamOpener = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    const res = responses[i++]
    if (!res) throw new Error('no scripted stream response left')
    const body = Array.isArray(res.body)
      ? (async function* () {
          for (const c of res.body as string[]) yield c
        })()
      : res.body
    return { status: res.status, body }
  }
  return { open, requests }
}
