/** Output schemas shared by the tool modules. */

import * as z from 'zod/v4'

export const agentSummaryShape = {
  id: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  state: z.enum(['ready', 'gpu_stopped', 'starting', 'failed', 'expired', 'deleting', 'unknown']),
  hosting: z.enum(['voight_cloud', 'nosana_gpu']),
  framework: z.string(),
  model: z.string(),
  gpuMarket: z.string().nullable(),
  daysLeft: z.number(),
  isFree: z.boolean(),
  channels: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  error: z.string().nullable(),
}
export const agentSummarySchema = z.object(agentSummaryShape)
export const agentDetailSchema = z.object({
  ...agentSummaryShape,
  template: z.string().nullable(),
  usesOwnModelKey: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  telegramBot: z.string().nullable(),
  githubRepo: z.string().nullable(),
  onchainStatus: z.string(),
  onchainUrl: z.string().nullable(),
  nosanaJobUrl: z.string().nullable(),
  persona: z.string().nullable(),
})

export const turnSchema = z.object({
  status: z.enum(['done', 'running', 'error']),
  turn_ref: z.string(),
  agent_id: z.string(),
  reply: z.string().nullable().describe('The agent reply, fenced as untrusted content. Partial while status is "running".'),
  reply_truncated: z.boolean().describe('The reply was shortened to fit: get_reply returns the full text.'),
  activity: z.string().nullable().describe('What the agent is doing right now, when it reports it.'),
  elapsed_seconds: z.number(),
  tokens: z.object({ prompt: z.number(), completion: z.number() }).nullable(),
  next_step: z.string(),
})
