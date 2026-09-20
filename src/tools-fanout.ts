/**
 * Talking to several agents at once: the orchestration tools.
 *
 * Same rules as a single chat (one turn per agent at a time, a message is
 * never sent twice, replies are fenced), plus three that only matter in a
 * group:
 *   - ONE shared deadline, so ten agents take one wait, not ten;
 *   - a per-reply character budget, so ten long answers still fit what MCP
 *     clients accept (each full reply stays available through get_reply);
 *   - nothing is sent to an agent that cannot answer right now (a stopped GPU
 *     would be woken, and billed, without delivering the message).
 */

import * as z from 'zod/v4'
import { explainError } from './api.js'
import { agentState, plainLabel } from './format.js'
import { clampWait, fail, ok, type ToolContext } from './result.js'
import { viewTurn } from './turn-view.js'

export const MAX_FANOUT = 10
/** Total characters of reply text one fan-out result may carry. */
const FANOUT_BUDGET = 20_000
const MIN_REPLY_BUDGET = 1_200

type ItemStatus = 'done' | 'running' | 'error' | 'busy_not_sent' | 'not_ready_not_sent' | 'waking_not_sent' | 'unknown_turn'

interface Item {
  agent_id: string | null
  name: string | null
  status: ItemStatus
  turn_ref: string | null
  reply: string | null
  reply_truncated: boolean
  activity: string | null
  elapsed_seconds: number | null
  detail: string
}

const itemSchema = z.object({
  agent_id: z.string().nullable(),
  name: z.string().nullable(),
  status: z.enum(['done', 'running', 'error', 'busy_not_sent', 'not_ready_not_sent', 'waking_not_sent', 'unknown_turn']),
  turn_ref: z.string().nullable(),
  reply: z.string().nullable().describe('Fenced as untrusted content. May be shortened: see reply_truncated.'),
  reply_truncated: z.boolean(),
  activity: z.string().nullable(),
  elapsed_seconds: z.number().nullable(),
  detail: z.string(),
})
const resultSchema = z.object({ results: z.array(itemSchema), done: z.number(), running: z.number(), not_sent: z.number(), failed: z.number(), next_step: z.string() })

function summarize(items: Item[]) {
  const count = (...s: ItemStatus[]) => items.filter((i) => s.includes(i.status)).length
  const running = items.filter((i) => i.status === 'running' && i.turn_ref).map((i) => i.turn_ref as string)
  const truncated = items.filter((i) => i.reply_truncated && i.turn_ref).map((i) => i.turn_ref as string)
  const steps: string[] = []
  if (running.length) steps.push(`Still working: call get_replies with turn_refs ${JSON.stringify(running)}. Do NOT send those messages again.`)
  if (truncated.length) steps.push(`Shortened replies: get_reply returns each full text (${truncated.join(', ')}).`)
  if (count('busy_not_sent', 'not_ready_not_sent', 'waking_not_sent')) steps.push('Some messages were NOT sent: see each "detail".')
  if (!steps.length) steps.push('All replies are in.')
  return {
    done: count('done'),
    running: count('running'),
    not_sent: count('busy_not_sent', 'not_ready_not_sent', 'waking_not_sent'),
    failed: count('error', 'unknown_turn'),
    next_step: steps.join(' '),
  }
}

function render(items: Item[], summary: ReturnType<typeof summarize>): string {
  const blocks = items.map((i) => {
    const head = `${i.name ? `"${plainLabel(i.name)}" ` : ''}(${i.agent_id ?? 'unknown agent'}): ${i.status}${i.turn_ref ? `, turn_ref ${i.turn_ref}` : ''}${
      i.elapsed_seconds !== null ? `, ${i.elapsed_seconds}s` : ''
    }`
    return [head, i.activity ? `agent activity: ${i.activity}` : null, i.reply, i.detail].filter(Boolean).join('\n')
  })
  return [...blocks, summary.next_step].join('\n\n')
}

export function registerFanoutTools(ctx: ToolContext): void {
  const { server, api, turns, names, guarded, now } = ctx

  function fromTurn(ref: string, budget: number): Item {
    const turn = turns.get(ref)
    if (!turn) {
      return {
        agent_id: null, name: null, status: 'unknown_turn', turn_ref: ref, reply: null, reply_truncated: false, activity: null, elapsed_seconds: null,
        detail: 'Unknown turn_ref: turns live in this server process and are lost if the MCP client restarts it. Check with a new short message instead of resending the original.',
      }
    }
    const view = viewTurn(turn, names.get(turn.agentId) ?? null, now(), turns, budget)
    return {
      agent_id: turn.agentId,
      name: names.get(turn.agentId) ?? null,
      status: view.status,
      turn_ref: turn.ref,
      reply: view.reply,
      reply_truncated: view.reply_truncated,
      activity: view.activity,
      elapsed_seconds: view.elapsed_seconds,
      detail: view.next_step,
    }
  }

  server.registerTool(
    'message_agents',
    {
      title: 'Message several agents at once',
      description:
        'Send an instruction to up to 10 agents in one call and wait (about 45 seconds, shared) for their replies. Use "agent_ids" + "message" to send everyone the same text, or "messages" to give each agent its own. Agents still working come back as "running" with a turn_ref for get_replies; never resend. Nothing is sent to an agent that is busy or not ready; a stopped GPU agent is skipped unless wake_stopped is true (that starts its GPU, which may bill a GPU hour, and the message still has to be sent again once it is ready). Each turn uses inference credits. Long replies are shortened here; get_reply returns the full text.',
      inputSchema: z.object({
        agent_ids: z.array(z.string().min(1)).min(1).max(MAX_FANOUT).optional().describe('Agents that all receive "message".'),
        message: z.string().min(1).max(8000).optional().describe('The text for every agent in agent_ids.'),
        messages: z
          .array(z.object({ agent_id: z.string().min(1), message: z.string().min(1).max(8000) }))
          .min(1)
          .max(MAX_FANOUT)
          .optional()
          .describe('A different text per agent. Use instead of agent_ids + message.'),
        new_conversation: z.boolean().optional().describe('Start a fresh conversation with each agent.'),
        wake_stopped: z.boolean().optional().describe('Start the GPU of stopped GPU agents instead of skipping them. Default false.'),
        wait_seconds: z.number().int().min(1).max(50).optional().describe('Shared wait for all replies. Default 45.'),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ agent_ids, message, messages, new_conversation, wake_stopped, wait_seconds }) =>
      guarded(async () => {
        const wanted = messages ?? (agent_ids && message ? agent_ids.map((agent_id) => ({ agent_id, message })) : null)
        if (!wanted || (messages && (agent_ids || message))) {
          return fail('Pass either "agent_ids" with "message" (same text for all), or "messages" (one text per agent), not both.')
        }
        const seen = new Set<string>()
        const targets = wanted.filter((t) => (seen.has(t.agent_id) ? false : (seen.add(t.agent_id), true)))

        const { agents } = await api.listAgents()
        for (const a of agents) names.set(a.id, a.name)
        const byId = new Map(agents.map((a) => [a.id, a]))

        const items: (Item | { pending: string; agent_id: string })[] = []
        for (const t of targets) {
          const agent = byId.get(t.agent_id)
          const base = { agent_id: t.agent_id, name: agent?.name ?? null, reply: null, reply_truncated: false, activity: null, elapsed_seconds: null }
          if (!agent) {
            items.push({ ...base, status: 'error', turn_ref: null, detail: 'Agent not found on this account. Nothing was sent.' })
            continue
          }
          const busy = turns.running(t.agent_id)
          if (busy) {
            items.push({ ...base, status: 'busy_not_sent', turn_ref: busy.ref, detail: `Still working on its previous message: collect turn_ref "${busy.ref}" first. The new message was NOT sent.` })
            continue
          }
          const state = agentState(agent)
          if (state === 'gpu_stopped' && wake_stopped) {
            try {
              await api.wake(t.agent_id)
              items.push({ ...base, status: 'waking_not_sent', turn_ref: null, detail: 'Its GPU is starting (a few minutes, may bill one GPU hour). The message was NOT sent: send it once wait_for_agent says ready.' })
            } catch (err) {
              items.push({ ...base, status: 'error', turn_ref: null, detail: `Could not start its GPU: ${explainError(err)} The message was NOT sent.` })
            }
            continue
          }
          if (state !== 'ready') {
            items.push({
              ...base,
              status: 'not_ready_not_sent',
              turn_ref: null,
              detail:
                state === 'gpu_stopped'
                  ? 'Its GPU is stopped. The message was NOT sent. wake_agent (or wake_stopped: true) starts it, which may bill one GPU hour.'
                  : `The agent is ${state}. The message was NOT sent.`,
            })
            continue
          }
          if (new_conversation) turns.reset(t.agent_id)
          items.push({ pending: turns.start(t.agent_id, t.message).ref, agent_id: t.agent_id })
        }

        const pending = items.filter((i): i is { pending: string; agent_id: string } => 'pending' in i)
        const waitMs = clampWait(wait_seconds, 45, 50)
        await Promise.all(pending.map((p) => turns.wait(p.pending, waitMs)))
        const budget = Math.max(MIN_REPLY_BUDGET, Math.floor(FANOUT_BUDGET / Math.max(1, pending.length)))
        const results = items.map((i) => ('pending' in i ? fromTurn(i.pending, budget) : i))
        const summary = summarize(results)
        return ok({ results, ...summary }, render(results, summary))
      }),
  )

  server.registerTool(
    'get_replies',
    {
      title: 'Collect several pending replies',
      description:
        'Collect the replies of up to 10 turns that were still running (from message_agents or chat_with_agent), waiting about 45 seconds shared. Safe to repeat: it never sends anything to an agent.',
      inputSchema: z.object({
        turn_refs: z.array(z.string().min(1)).min(1).max(MAX_FANOUT).describe('turn_ref values still marked "running".'),
        wait_seconds: z.number().int().min(1).max(50).optional().describe('Shared wait. Default 45.'),
      }),
      outputSchema: resultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ turn_refs, wait_seconds }) =>
      guarded(async () => {
        const refs = [...new Set(turn_refs)]
        const waitMs = clampWait(wait_seconds, 45, 50)
        await Promise.all(refs.map((ref) => turns.wait(ref, waitMs)))
        const budget = Math.max(MIN_REPLY_BUDGET, Math.floor(FANOUT_BUDGET / refs.length))
        const results = refs.map((ref) => fromTurn(ref, budget))
        const summary = summarize(results)
        return ok({ results, ...summary }, render(results, summary))
      }),
  )
}
