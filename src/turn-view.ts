/**
 * How a chat turn is shown to the model: one shape for a single reply
 * (chat_with_agent, get_reply) and for each member of a fan-out.
 */

import type { ChatTurns, Turn } from './chat.js'
import { MAX_RESULT_CHARS, capText, untrusted } from './format.js'

export interface TurnView {
  status: 'done' | 'running' | 'error'
  turn_ref: string
  agent_id: string
  reply: string | null
  reply_truncated: boolean
  activity: string | null
  elapsed_seconds: number
  tokens: { prompt: number; completion: number } | null
  next_step: string
}

export function viewTurn(turn: Turn, agentName: string | null, now: number, turns: ChatTurns, budget = MAX_RESULT_CHARS): TurnView {
  const elapsed = Math.round(((turn.finishedAt ?? now) - turn.startedAt) / 1000)
  const source = `agent ${agentName ? `"${agentName}"` : turn.agentId}`
  const truncated = turn.text.length > budget
  const reply = turn.text ? untrusted(source, capText(turn.text, budget)) : null
  let nextStep: string
  if (turn.status === 'running') {
    nextStep = `The agent is still working. Call get_reply with turn_ref "${turn.ref}" to collect the reply. Do NOT send the message again.`
  } else if (turn.status === 'error') {
    nextStep = turn.error ?? 'The turn failed.'
  } else if (turn.timedOut) {
    nextStep = 'The agent hit its time budget: the reply above may be incomplete.'
  } else if (truncated) {
    nextStep = `Reply complete but shortened here. Call get_reply with turn_ref "${turn.ref}" for the full text.`
  } else {
    nextStep = 'Reply complete.'
  }
  // A shortened reply is not "collected": the full text must stay retrievable.
  if (turn.status !== 'running' && !truncated) turns.markCollected(turn.ref)
  return {
    status: turn.status,
    turn_ref: turn.ref,
    agent_id: turn.agentId,
    reply,
    reply_truncated: truncated,
    activity: turn.status === 'running' ? turn.activity : null,
    elapsed_seconds: elapsed,
    tokens: turn.tokens,
    next_step: nextStep,
  }
}

export function turnText(view: TurnView, heading?: string): string {
  const lines = [`${heading ? `${heading}: ` : ''}status ${view.status} (${view.elapsed_seconds}s, turn_ref ${view.turn_ref})`]
  if (view.activity) lines.push(`agent activity: ${view.activity}`)
  if (view.reply) lines.push('', view.reply)
  lines.push('', view.next_step)
  return lines.join('\n')
}
