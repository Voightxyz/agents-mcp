import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../../src/config.js'
import { createServer, type ServerDeps } from '../../src/server.js'
import { CLOUD_AGENT, CONFIG, GPU_AGENT, fakeFetch } from '../helpers.js'

const open: { close: () => Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()))
})

async function connect(config: Config, deps: ServerDeps = {}) {
  const server = createServer(config, deps)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  await client.connect(clientSide)
  open.push(client, server)
  return client
}
const text = (r: { content?: unknown }) => (r.content as { text: string }[])[0]?.text ?? ''
const out = <T>(r: { structuredContent?: unknown }) => r.structuredContent as T

const STARTING = { ...CLOUD_AGENT, id: 'ag_new', name: 'Scout', status: 'PROVISIONING', createdAt: '2026-09-20T10:00:00.000Z', cancelRefundable: false }
const TASK = {
  id: 't1', title: 'Morning brief', owner: 'AGENT', priority: 'MEDIUM', status: 'OPEN', dueDate: null, prompt: 'Summarize the news', enabled: true,
  scheduleKind: 'DAILY', scheduleHour: 8, scheduleMinute: 0, scheduleWeekday: null, nextRunAt: '2026-09-21T08:00:00.000Z', lastRunAt: null,
  lastStatus: null, lastError: null, lastResult: null, runCount: 0,
}

describe('quotes cost nothing and say what to confirm', () => {
  it('cloud quote: cost, balance and the exact confirm values for deploy_agent', async () => {
    const f = fakeFetch({
      'POST /v1/mcp/agents/quote': { body: { quote: { costUsd: 15, periodDays: 30, host: 'voight', gpu: null, balanceUsd: 40, sufficientBalance: true, cancelRefundable: false } } },
    })
    const client = await connect(CONFIG, { fetch: f.impl })
    const r = await client.callTool({ name: 'quote_agent_deploy', arguments: { name: 'Scout', description: 'Finds leads', tone: 'Direct' } })
    expect(f.calls[0]).toMatchObject({ method: 'POST', path: '/v1/mcp/agents/quote', body: { name: 'Scout', description: 'Finds leads', tone: 'Direct' } })
    expect(out<any>(r)).toMatchObject({ costUsd: 15, hosting: 'voight_cloud', confirm: { confirm_cost_usd: 15, confirm_hourly_usd: null } })
    expect(out<any>(r).next_step).toMatch(/costs \$15 for 30 days/)
    expect(out<any>(r).next_step).toMatch(/cannot be cancelled for a refund/)
  })

  it('GPU quote carries the hourly price to confirm; a short balance says do not deploy', async () => {
    const gpu = { market: '3060', name: 'NVIDIA 3060', hourlyUsd: 0.1, hoursBilled: false }
    const client = await connect(CONFIG, {
      fetch: fakeFetch({
        'POST /v1/mcp/agents/quote': { body: { quote: { costUsd: 15, periodDays: 30, host: 'nosana', gpu, balanceUsd: 3, sufficientBalance: false, cancelRefundable: true } } },
      }).impl,
    })
    const r = await client.callTool({ name: 'quote_agent_deploy', arguments: { name: 'GPU scout', host: 'nosana', market: '3060' } })
    expect(out<any>(r)).toMatchObject({ hosting: 'nosana_gpu', confirm: { confirm_cost_usd: 15, confirm_hourly_usd: 0.1 }, sufficientBalance: false })
    expect(out<any>(r).next_step).toMatch(/Do not call deploy_agent yet/)
  })

  it('a renewal that is not due says so', async () => {
    const client = await connect(CONFIG, {
      fetch: fakeFetch({
        'POST /v1/mcp/agents/ag_cloud/renew/quote': {
          body: { quote: { costUsd: 15, periodDays: 30, due: false, renewableFrom: '2026-10-05T00:00:00.000Z', expiresAt: '2026-10-12T00:00:00.000Z', balanceUsd: 40, sufficientBalance: true } },
        },
      }).impl,
    })
    const r = await client.callTool({ name: 'quote_agent_renewal', arguments: { agent_id: 'ag_cloud' } })
    expect(out<any>(r).next_step).toMatch(/Not due yet: it can be renewed from 2026-10-05/)
  })

  it('lists GPU markets as the server reports them', async () => {
    const markets = [{ market: '3060', name: 'NVIDIA 3060', hourlyUsd: 0.1, availableGpus: 4, queuedJobs: 0 }]
    const client = await connect(CONFIG, { fetch: fakeFetch({ 'GET /v1/mcp/gpu-markets': { body: { hoursBilled: false, markets } } }).impl })
    expect(out<any>(await client.callTool({ name: 'list_gpu_markets', arguments: {} }))).toEqual({ hoursBilled: false, markets })
  })
})

describe('deploy_agent', () => {
  it('sends the confirmed amounts and tells the model to wait, not to redeploy', async () => {
    const f = fakeFetch({ 'POST /v1/mcp/agents': { status: 201, body: { agent: STARTING, replayed: false, chargedUsd: 15 } } })
    const client = await connect(CONFIG, { fetch: f.impl })
    const r = await client.callTool({ name: 'deploy_agent', arguments: { name: 'Scout', host: 'nosana', market: '3060', confirm_cost_usd: 15, confirm_hourly_usd: 0.1 } })
    expect(f.calls[0]!.body).toEqual({ name: 'Scout', host: 'nosana', market: '3060', confirmCostUsd: 15, confirmHourlyUsd: 0.1 })
    expect(out<any>(r)).toMatchObject({ replayed: false, charged_usd: 15, agent: { id: 'ag_new', state: 'starting' } })
    expect(out<any>(r).next_step).toMatch(/wait_for_agent with agent_id "ag_new"\. Do not deploy it again/)
  })

  it('a replay is reported as nothing charged', async () => {
    const client = await connect(CONFIG, { fetch: fakeFetch({ 'POST /v1/mcp/agents': { body: { agent: STARTING, replayed: true, chargedUsd: 0 } } }).impl })
    const r = await client.callTool({ name: 'deploy_agent', arguments: { name: 'Scout', confirm_cost_usd: 15 } })
    expect(out<any>(r)).toMatchObject({ replayed: true, charged_usd: 0 })
    expect(out<any>(r).next_step).toMatch(/NOTHING was charged/)
  })

  it('refuses without a confirmed cost (schema), before any request', async () => {
    const f = fakeFetch({})
    const client = await connect(CONFIG, { fetch: f.impl })
    const r = await client.callTool({ name: 'deploy_agent', arguments: { name: 'Scout' } })
    expect(r.isError).toBe(true)
    expect(f.calls).toHaveLength(0)
  })

  it.each([
    [402, { error: 'insufficient balance', code: 'INSUFFICIENT_FUNDS', needed: 4.6, balance: 10.4, priceUsd: 15 }, /\$4\.60 more is needed\. Nothing was charged/],
    [409, { error: 'x', code: 'COST_CHANGED', hourlyUsd: 0.5 }, /higher than the confirmed one \(GPU \$0\.5 per hour\)\. Nothing was charged/],
    [429, { error: 'daily limit reached: 10 deploys per 24 hours through API keys. Use the dashboard, or try again later.', code: 'KEY_DAILY_CAP' }, /Daily limit reached: 10 deploys/],
    [403, { error: 'GPU hosting is invite-only for now. Deploy on Voight cloud (host "voight"), or claim a GPU invite on the web first.', code: 'GPU_NOT_AVAILABLE' }, /invite-only/],
    [403, { error: 'forbidden: this API key lacks the agents:deploy scope. Create a key with "agents_full" access in the dashboard Settings.', code: 'KEY_SCOPE_MISSING' }, /"Agents: full" access/],
    [401, { error: 'unauthorized: this API key expired.', code: 'KEY_EXPIRED' }, /expired \("Agents: full" keys last 90 days\)/],
    [500, { error: 'internal error', code: 'INTERNAL' }, /unclear whether the action was applied: check list_agents/],
  ])('explains a %i refusal in one actionable sentence', async (status, body, expected) => {
    const client = await connect(CONFIG, { fetch: fakeFetch({ 'POST /v1/mcp/agents': { status, body } }).impl })
    const r = await client.callTool({ name: 'deploy_agent', arguments: { name: 'Scout', confirm_cost_usd: 15 } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(expected)
  })
})

describe('wait_for_agent', () => {
  const at = (iso: string) => () => new Date(iso).getTime()

  it('returns as soon as the agent is ready', async () => {
    let reads = 0
    const impl = (async () => {
      reads++
      return new Response(JSON.stringify({ agent: reads < 3 ? STARTING : { ...STARTING, status: 'READY' } }))
    }) as typeof fetch
    const client = await connect(CONFIG, { fetch: impl, now: at('2026-09-20T10:00:30.000Z'), sleep: async () => {} })
    const r = await client.callTool({ name: 'wait_for_agent', arguments: { agent_id: 'ag_new' } })
    expect(out<any>(r)).toMatchObject({ state: 'ready', keep_waiting: false, typical_seconds: 60 })
    expect(reads).toBe(3)
  })

  it('still starting inside the normal window: keep waiting', async () => {
    let t = new Date('2026-09-20T10:00:20.000Z').getTime()
    const client = await connect(CONFIG, {
      fetch: fakeFetch({ 'GET /v1/mcp/agents/ag_new': { body: { agent: STARTING } } }).impl,
      now: () => t,
      sleep: async (ms) => void (t += ms),
    })
    const r = await client.callTool({ name: 'wait_for_agent', arguments: { agent_id: 'ag_new', wait_seconds: 12 } })
    expect(out<any>(r)).toMatchObject({ state: 'starting', keep_waiting: true })
    expect(out<any>(r).next_step).toMatch(/Call wait_for_agent again/)
  })

  it('past three times the usual start it says stop, and never to deploy another', async () => {
    const gpuStarting = { ...GPU_AGENT, id: 'ag_new', status: 'PROVISIONING', gpuStopped: false, createdAt: '2026-09-20T10:00:00.000Z', cancelRefundable: true }
    const client = await connect(CONFIG, {
      fetch: fakeFetch({ 'GET /v1/mcp/agents/ag_new': { body: { agent: gpuStarting } } }).impl,
      now: at('2026-09-20T10:20:00.000Z'),
      sleep: async () => {},
    })
    const r = await client.callTool({ name: 'wait_for_agent', arguments: { agent_id: 'ag_new', wait_seconds: 1 } })
    expect(out<any>(r)).toMatchObject({ state: 'starting', keep_waiting: false, typical_seconds: 240, cancel_refundable: true })
    expect(out<any>(r).next_step).toMatch(/Do NOT deploy another agent/)
    expect(out<any>(r).next_step).toMatch(/refunded in full/)
  })

  it('tells a failed deploy and a failed GPU wake apart from "stopped"', async () => {
    const failed = { ...STARTING, status: 'FAILED', error: 'provisioning error: quota' }
    const wake = { ...GPU_AGENT, id: 'ag_new', error: 'wake failed: no nodes' }
    const c1 = await connect(CONFIG, { fetch: fakeFetch({ 'GET /v1/mcp/agents/ag_new': { body: { agent: failed } } }).impl })
    expect(out<any>(await c1.callTool({ name: 'wait_for_agent', arguments: { agent_id: 'ag_new' } })).next_step).toMatch(/refunds a failed deploy.*do not redeploy/)
    const c2 = await connect(CONFIG, { fetch: fakeFetch({ 'GET /v1/mcp/agents/ag_new': { body: { agent: wake } } }).impl })
    const r = out<any>(await c2.callTool({ name: 'wait_for_agent', arguments: { agent_id: 'ag_new' } }))
    expect(r).toMatchObject({ state: 'gpu_stopped', wake_failed: true })
    expect(r.next_step).toMatch(/Do NOT call wake_agent again automatically/)
  })

  it('an unknown agent is an error, not an endless wait', async () => {
    const client = await connect(CONFIG, { fetch: fakeFetch({}).impl })
    const r = await client.callTool({ name: 'wait_for_agent', arguments: { agent_id: 'nope' } })
    expect(r.isError).toBe(true)
  })
})

describe('renew and delete', () => {
  it('renew sends the confirmed cost; a debounced renew says nothing was charged', async () => {
    const f = fakeFetch({ 'POST /v1/mcp/agents/ag_cloud/renew': { body: { agent: { ...CLOUD_AGENT, daysLeft: 42 }, chargedUsd: 15, debounced: false } } })
    const client = await connect(CONFIG, { fetch: f.impl })
    const r = await client.callTool({ name: 'renew_agent', arguments: { agent_id: 'ag_cloud', confirm_cost_usd: 15 } })
    expect(f.calls[0]!.body).toEqual({ confirmCostUsd: 15 })
    expect(out<any>(r).next_step).toMatch(/charged \$15: 42 days/)
    const c2 = await connect(CONFIG, { fetch: fakeFetch({ 'POST /v1/mcp/agents/ag_cloud/renew': { body: { agent: CLOUD_AGENT, chargedUsd: 0, debounced: true } } }).impl })
    expect(out<any>(await c2.callTool({ name: 'renew_agent', arguments: { agent_id: 'ag_cloud', confirm_cost_usd: 15 } })).next_step).toMatch(/nothing was charged again/)
  })

  it('delete sends the exact name in a DELETE body and reports a refund', async () => {
    const f = fakeFetch({ 'DELETE /v1/mcp/agents/ag_new': { body: { ok: true, already: false, refunded: 'credits', teardown: 'pending' } } })
    const client = await connect(CONFIG, { fetch: f.impl })
    const r = await client.callTool({ name: 'delete_agent', arguments: { agent_id: 'ag_new', confirm_name: 'Scout' } })
    expect(f.calls[0]).toMatchObject({ method: 'DELETE', path: '/v1/mcp/agents/ag_new', body: { confirmName: 'Scout' } })
    expect(out<any>(r)).toMatchObject({ deleted: true, already: false, refunded: 'credits' })
    expect(out<any>(r).next_step).toMatch(/the deploy was refunded/)
  })

  it('passes the server reason when the agent was not deployed with a key', async () => {
    const client = await connect(CONFIG, {
      fetch: fakeFetch({
        'DELETE /v1/mcp/agents/ag_cloud': { status: 403, body: { error: 'API keys can only delete agents that were deployed with an API key. Delete this one from the dashboard: https://agent.voight.xyz', code: 'NOT_KEY_DEPLOYED' } },
      }).impl,
    })
    const r = await client.callTool({ name: 'delete_agent', arguments: { agent_id: 'ag_cloud', confirm_name: 'Research bot' } })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/only delete agents that were deployed with an API key/)
  })
})

describe('tasks', () => {
  it('maps a friendly schedule to the API and fences the stored instruction', async () => {
    const f = fakeFetch({ 'POST /v1/mcp/agents/ag_cloud/tasks': { status: 201, body: { task: TASK, pausedForApproval: false } } })
    const client = await connect(CONFIG, { fetch: f.impl })
    const r = await client.callTool({ name: 'create_task', arguments: { agent_id: 'ag_cloud', title: 'Morning brief', prompt: 'Summarize the news', schedule: 'daily', hour: 8 } })
    expect(f.calls[0]!.body).toEqual({ title: 'Morning brief', prompt: 'Summarize the news', scheduleKind: 'DAILY', scheduleHour: 8 })
    const task = out<any>(r).task
    expect(task.schedule).toBe('daily at 08:00 UTC')
    expect(task.prompt).toMatch(/^<<<VOIGHT_UNTRUSTED_[0-9a-f]{12} /)
    expect(out<any>(r).next_step).toMatch(/Next run: 2026-09-21/)
  })

  it('"once" sends no recurrence, and hourly is not offered', async () => {
    const f = fakeFetch({ 'POST /v1/mcp/agents/ag_cloud/tasks': { status: 201, body: { task: { ...TASK, scheduleKind: null, scheduleHour: null }, pausedForApproval: false } } })
    const client = await connect(CONFIG, { fetch: f.impl })
    await client.callTool({ name: 'create_task', arguments: { agent_id: 'ag_cloud', title: 'One shot', prompt: 'Do it', schedule: 'once' } })
    expect(f.calls[0]!.body).toEqual({ title: 'One shot', prompt: 'Do it', scheduleKind: null })
    const bad = await client.callTool({ name: 'create_task', arguments: { agent_id: 'ag_cloud', title: 't', prompt: 'p', schedule: 'hourly' } })
    expect(bad.isError).toBe(true)
    expect(f.calls).toHaveLength(1)
  })

  it('says clearly when a task was saved paused for a person to approve', async () => {
    const client = await connect(CONFIG, {
      fetch: fakeFetch({ 'POST /v1/mcp/agents/ag_cloud/tasks': { status: 201, body: { task: { ...TASK, enabled: false, nextRunAt: null }, pausedForApproval: true } } }).impl,
    })
    const r = await client.callTool({ name: 'create_task', arguments: { agent_id: 'ag_cloud', title: 'Post', prompt: 'Post to X', schedule: 'daily', hour: 9 } })
    expect(out<any>(r)).toMatchObject({ paused_for_approval: true })
    expect(out<any>(r).next_step).toMatch(/saved PAUSED.*cannot be enabled from here/)
  })

  it('update uses PATCH with only what changed; an empty edit never reaches the API; delete uses DELETE', async () => {
    const f = fakeFetch({
      'PATCH /v1/mcp/agents/ag_cloud/tasks/t1': { body: { task: { ...TASK, enabled: false, nextRunAt: null }, pausedForApproval: false } },
      'DELETE /v1/mcp/agents/ag_cloud/tasks/t1': { body: { ok: true } },
    })
    const client = await connect(CONFIG, { fetch: f.impl })
    const paused = await client.callTool({ name: 'update_task', arguments: { agent_id: 'ag_cloud', task_id: 't1', enabled: false } })
    expect(f.calls[0]).toMatchObject({ method: 'PATCH', body: { enabled: false } })
    expect(out<any>(paused).next_step).toMatch(/paused/)
    const empty = await client.callTool({ name: 'update_task', arguments: { agent_id: 'ag_cloud', task_id: 't1' } })
    expect(empty.isError).toBe(true)
    expect(f.calls).toHaveLength(1)
    expect(out<any>(await client.callTool({ name: 'delete_task', arguments: { agent_id: 'ag_cloud', task_id: 't1' } }))).toEqual({ deleted: true })
    expect(f.calls[1]).toMatchObject({ method: 'DELETE', path: '/v1/mcp/agents/ag_cloud/tasks/t1' })
  })
})
