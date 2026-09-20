import { describe, expect, it } from 'vitest'
import { VoightApi } from '../../src/api.js'
import { ChatTurns } from '../../src/chat.js'
import { CONFIG, controlledStream, fakeStreams, sse } from '../helpers.js'

function setup(responses: Parameters<typeof fakeStreams>[0]) {
  const streams = fakeStreams(responses)
  const turns = new ChatTurns(new VoightApi(CONFIG, { openStream: streams.open }))
  return { turns, requests: streams.requests }
}

describe('ChatTurns', () => {
  it('assembles a reply from SSE frames split across chunks', async () => {
    const frames = sse.tool('Searching the web') + sse.delta('Hel') + sse.delta('lo') + sse.usage(100, 2) + sse.done()
    const cut = Math.floor(frames.length / 2)
    const { turns } = setup([{ status: 200, body: [frames.slice(0, cut), frames.slice(cut)] }])
    const turn = turns.start('ag_1', 'hi')
    await turns.wait(turn.ref, 1000)
    expect(turn).toMatchObject({ status: 'done', text: 'Hello', tokens: { prompt: 100, completion: 2 }, activity: 'Searching the web', timedOut: false })
  })

  it('returns after the bounded wait while the agent is still working, then completes', async () => {
    const stream = controlledStream()
    const { turns } = setup([{ status: 200, body: stream.body }])
    const turn = turns.start('ag_1', 'long job')
    stream.send(sse.tool('Running code'))
    stream.send(sse.delta('Part one. '))
    await turns.wait(turn.ref, 30)
    expect(turn.status).toBe('running')
    expect(turn.text).toBe('Part one. ')
    expect(turns.running('ag_1')?.ref).toBe(turn.ref)

    stream.send(sse.delta('Part two.') + sse.done())
    stream.end()
    await turns.wait(turn.ref, 1000)
    expect(turn).toMatchObject({ status: 'done', text: 'Part one. Part two.' })
    expect(turns.running('ag_1')).toBeUndefined()
  })

  it('names a session on the first message and resends local history after it', async () => {
    const { turns, requests } = setup([
      { status: 200, body: [sse.delta('one') + sse.done()] },
      { status: 200, body: [sse.delta('two') + sse.done()] },
      { status: 200, body: [sse.delta('fresh') + sse.done()] },
    ])
    const a = turns.start('ag_1', 'first')
    await turns.wait(a.ref, 1000)
    const b = turns.start('ag_1', 'second')
    await turns.wait(b.ref, 1000)
    expect(requests[0]!.body.messages).toEqual([{ role: 'user', content: 'first' }])
    expect(requests[0]!.body.sessionId).toMatch(/^mcp-/)
    expect(requests[1]!.body).toEqual({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'one' },
        { role: 'user', content: 'second' },
      ],
    })

    turns.reset('ag_1')
    const c = turns.start('ag_1', 'again')
    await turns.wait(c.ref, 1000)
    expect(requests[2]!.body.messages).toEqual([{ role: 'user', content: 'again' }])
    expect(requests[2]!.body.sessionId).not.toBe(requests[0]!.body.sessionId)
  })

  it('turns API refusals into an actionable error and keeps them out of history', async () => {
    const { turns, requests } = setup([
      { status: 409, body: [JSON.stringify({ error: 'gpu waking', code: 'AGENT_WAKING' })] },
      { status: 200, body: [sse.delta('ok') + sse.done()] },
    ])
    const turn = turns.start('ag_gpu', 'hello')
    await turns.wait(turn.ref, 1000)
    expect(turn).toMatchObject({ status: 'error', errorCode: 'AGENT_WAKING' })
    expect(turn.error).toMatch(/NOT delivered/)

    const next = turns.start('ag_gpu', 'hello again')
    await turns.wait(next.ref, 1000)
    expect(requests[1]!.body.messages).toEqual([{ role: 'user', content: 'hello again' }])
  })

  it('reports a runtime timeout with no text as an error, and with text as a partial reply', async () => {
    const { turns } = setup([
      { status: 200, body: [sse.timeout()] },
      { status: 200, body: [sse.delta('partial') + sse.timeout()] },
    ])
    const empty = turns.start('ag_1', 'a')
    await turns.wait(empty.ref, 1000)
    expect(empty).toMatchObject({ status: 'error', errorCode: 'AGENT_TIMEOUT' })
    expect(empty.error).toMatch(/do not resend/)

    const partial = turns.start('ag_1', 'b')
    await turns.wait(partial.ref, 1000)
    expect(partial).toMatchObject({ status: 'done', text: 'partial', timedOut: true })
  })

  it('keeps the partial reply when the connection drops mid-stream', async () => {
    const broken = (async function* () {
      yield sse.delta('half an ans')
      throw new Error('socket hang up')
    })()
    const { turns } = setup([{ status: 200, body: broken }])
    const turn = turns.start('ag_1', 'q')
    await turns.wait(turn.ref, 1000)
    expect(turn).toMatchObject({ status: 'error', text: 'half an ans', errorCode: 'NETWORK' })
    expect(turn.error).toMatch(/dropped mid-reply/)
  })

  it('an empty stream is an error, not a finished reply, and leaves no history', async () => {
    const empty = 'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n' + sse.done()
    const { turns, requests } = setup([{ status: 200, body: [empty] }, { status: 200, body: [sse.delta('ok') + sse.done()] }])
    const turn = turns.start('ag_1', 'hello')
    await turns.wait(turn.ref, 1000)
    expect(turn).toMatchObject({ status: 'error', errorCode: 'EMPTY_REPLY', text: '' })
    expect(turn.error).toMatch(/model call failed/)
    const next = turns.start('ag_1', 'hello again')
    await turns.wait(next.ref, 1000)
    expect(requests[1]!.body.messages).toEqual([{ role: 'user', content: 'hello again' }])
  })

  it('never evicts a reply nobody has collected; collected ones make room', async () => {
    const N = 201
    const { turns } = setup(Array.from({ length: N + 1 }, (_, i) => ({ status: 200, body: [sse.delta(`reply ${i}`) + sse.done()] })))
    const refs: string[] = []
    for (let i = 0; i < N; i++) {
      const t = turns.start(`ag_${i}`, 'hi')
      await turns.wait(t.ref, 1000)
      refs.push(t.ref)
    }
    expect(turns.get(refs[0]!)?.text).toBe('reply 0') // over the limit, but unread: kept

    turns.markCollected(refs[0]!)
    turns.markCollected(refs[1]!)
    const extra = turns.start('ag_extra', 'hi')
    await turns.wait(extra.ref, 1000)
    expect(turns.get(refs[0]!)).toBeUndefined()
    expect(turns.get(refs[1]!)).toBeUndefined()
    expect(turns.get(refs[2]!)?.text).toBe('reply 2')
  })
})

