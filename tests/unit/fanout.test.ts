import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../../src/config.js'
import { createServer, type ServerDeps } from '../../src/server.js'
import { CLOUD_AGENT, CONFIG, GPU_AGENT, controlledStream, fakeFetch, fakeStreams, sse } from '../helpers.js'

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
const out = <T>(r: { structuredContent?: unknown }) => r.structuredContent as T
const text = (r: { content?: unknown }) => (r.content as { text: string }[])[0]?.text ?? ''

const A = { ...CLOUD_AGENT, id: 'ag_a', name: 'Alpha' }
const B = { ...CLOUD_AGENT, id: 'ag_b', name: 'Beta' }
const STOPPED = { ...GPU_AGENT, id: 'ag_gpu', name: 'GPU bot' }
const listing = (agents: unknown[], extra: Record<string, { status?: number; body: unknown }> = {}) =>
  fakeFetch({ 'GET /v1/mcp/agents': { body: { agents, priceUsd: 15 } }, ...extra })
const say = (t: string) => ({ status: 200, body: [sse.delta(t) + sse.done()] })

describe('message_agents', () => {
  it('sends the same instruction to several agents and fences every reply on its own', async () => {
    const streams = fakeStreams([say('alpha says hi'), say('beta says hi')])
    const client = await connect(CONFIG, { fetch: listing([A, B]).impl, openStream: streams.open })
    const r = await client.callTool({ name: 'message_agents', arguments: { agent_ids: ['ag_a', 'ag_b'], message: 'Report status' } })
    const res = out<any>(r)
    expect(res).toMatchObject({ done: 2, running: 0, not_sent: 0, failed: 0, next_step: 'All replies are in.' })
    expect(res.results.map((i: any) => [i.agent_id, i.name, i.status])).toEqual([['ag_a', 'Alpha', 'done'], ['ag_b', 'Beta', 'done']])
    const fences = res.results.map((i: any) => i.reply.split('\n')[0])
    expect(fences[0]).toMatch(/^<<<VOIGHT_UNTRUSTED_[0-9a-f]{12} source="agent 'Alpha'">>>$/)
    expect(fences[0]).not.toBe(fences[1])
    expect(streams.requests.map((q) => [q.url.split('/agents/')[1], q.body.messages.at(-1).content])).toEqual([
      ['ag_a/chat', 'Report status'], ['ag_b/chat', 'Report status'],
    ])
    expect(text(r)).toContain('alpha says hi')
    expect(text(r)).toContain('beta says hi')
  })

  it('gives each agent its own instruction, and ignores a repeated agent', async () => {
    const streams = fakeStreams([say('one'), say('two')])
    const client = await connect(CONFIG, { fetch: listing([A, B]).impl, openStream: streams.open })
    const r = await client.callTool({
      name: 'message_agents',
      arguments: { messages: [{ agent_id: 'ag_a', message: 'Research X' }, { agent_id: 'ag_b', message: 'Research Y' }, { agent_id: 'ag_a', message: 'again' }] },
    })
    expect(out<any>(r).results).toHaveLength(2)
    expect(streams.requests.map((q) => q.body.messages.at(-1).content)).toEqual(['Research X', 'Research Y'])
  })

  it('needs exactly one way of saying who gets what', async () => {
    const client = await connect(CONFIG, { fetch: listing([A]).impl })
    expect((await client.callTool({ name: 'message_agents', arguments: { agent_ids: ['ag_a'] } })).isError).toBe(true)
    expect((await client.callTool({ name: 'message_agents', arguments: { agent_ids: ['ag_a'], message: 'x', messages: [{ agent_id: 'ag_a', message: 'y' }] } })).isError).toBe(true)
    expect((await client.callTool({ name: 'message_agents', arguments: { agent_ids: Array.from({ length: 11 }, (_, i) => `a${i}`), message: 'x' } })).isError).toBe(true)
  })

  it('never sends to a busy agent, an unknown one, or a stopped GPU (unless asked to wake it)', async () => {
    const slow = controlledStream()
    const streams = fakeStreams([{ status: 200, body: slow.body }, say('beta done')])
    const f = listing([A, B, STOPPED], { 'POST /v1/mcp/agents/ag_gpu/wake': { body: { agent: { ...STOPPED, status: 'PROVISIONING', gpuStopped: false }, waking: true } } })
    const client = await connect(CONFIG, { fetch: f.impl, openStream: streams.open })
    const first = await client.callTool({ name: 'chat_with_agent', arguments: { agent_id: 'ag_a', message: 'long job', wait_seconds: 1 } })
    const busyRef = out<any>(first).turn_ref

    const r = out<any>(await client.callTool({ name: 'message_agents', arguments: { agent_ids: ['ag_a', 'ag_b', 'ag_gpu', 'ghost'], message: 'ping' } }))
    const by = Object.fromEntries(r.results.map((i: any) => [i.agent_id, i]))
    expect(by.ag_a).toMatchObject({ status: 'busy_not_sent', turn_ref: busyRef })
    expect(by.ag_b).toMatchObject({ status: 'done' })
    expect(by.ag_gpu).toMatchObject({ status: 'not_ready_not_sent' })
    expect(by.ag_gpu.detail).toMatch(/GPU is stopped\. The message was NOT sent/)
    expect(by.ghost).toMatchObject({ status: 'error' })
    expect(r).toMatchObject({ done: 1, not_sent: 2, failed: 1 })
    expect(streams.requests).toHaveLength(2) // the busy agent and the stopped GPU got no request
    expect(f.calls.some((c) => c.path.endsWith('/wake'))).toBe(false)

    const woke = out<any>(await client.callTool({ name: 'message_agents', arguments: { agent_ids: ['ag_gpu'], message: 'ping', wake_stopped: true } }))
    expect(woke.results[0]).toMatchObject({ status: 'waking_not_sent' })
    expect(woke.results[0].detail).toMatch(/NOT sent: send it once wait_for_agent says ready/)
    expect(f.calls.filter((c) => c.path.endsWith('/wake'))).toHaveLength(1)
    slow.end()
  })

  it('returns "running" with a turn_ref after ONE shared wait, and get_replies collects it', async () => {
    const slow = controlledStream()
    const streams = fakeStreams([{ status: 200, body: slow.body }, say('quick one')])
    const client = await connect(CONFIG, { fetch: listing([A, B]).impl, openStream: streams.open })
    const started = Date.now()
    const r = out<any>(await client.callTool({ name: 'message_agents', arguments: { agent_ids: ['ag_a', 'ag_b'], message: 'go', wait_seconds: 1 } }))
    expect(Date.now() - started).toBeLessThan(2500)
    expect(r).toMatchObject({ done: 1, running: 1 })
    const ref = r.results.find((i: any) => i.status === 'running').turn_ref
    expect(r.next_step).toContain(ref)
    expect(r.next_step).toMatch(/Do NOT send those messages again/)

    slow.send(sse.delta('finally') + sse.done())
    slow.end()
    const got = out<any>(await client.callTool({ name: 'get_replies', arguments: { turn_refs: [ref, 'turn_missing'] } }))
    expect(got.results[0]).toMatchObject({ status: 'done', turn_ref: ref })
    expect(got.results[0].reply).toContain('finally')
    expect(got.results[1]).toMatchObject({ status: 'unknown_turn' })
  })

  it('shares a character budget across replies, and the full text stays available through get_reply', async () => {
    const long = 'x'.repeat(15_000)
    const streams = fakeStreams([say(long), say(long)])
    const client = await connect(CONFIG, { fetch: listing([A, B]).impl, openStream: streams.open })
    const r = await client.callTool({ name: 'message_agents', arguments: { agent_ids: ['ag_a', 'ag_b'], message: 'write a lot' } })
    const res = out<any>(r)
    for (const item of res.results) {
      expect(item.reply_truncated).toBe(true)
      expect(item.reply.length).toBeLessThan(10_600)
    }
    expect(text(r).length).toBeLessThan(24_000)
    expect(res.next_step).toMatch(/get_reply returns each full text/)
    const full = out<any>(await client.callTool({ name: 'get_reply', arguments: { turn_ref: res.results[0].turn_ref } }))
    expect(full.reply_truncated).toBe(false)
    expect(full.reply).toContain(long)
  })
})
