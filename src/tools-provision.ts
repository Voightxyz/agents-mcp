/**
 * Tools that create, renew, delete and schedule. They need an "Agents: full"
 * key, and every rule that protects the account (charging, caps, duplicate
 * detection, what a key may delete, tasks on agents that act in public) is
 * enforced by the Voight API, not here: an LLM can echo any confirmation.
 *
 * Reads that cost nothing (GPU markets, quotes, wait_for_agent) register even
 * in --read-only mode; the rest do not.
 */

import * as z from 'zod/v4'
import type { DeployInput, TaskWrite } from './api.js'
import { AGENTS_URL } from './config.js'
import { agentState, agentSummary, taskSummary, wakeFailed } from './format.js'
import { READ, clampWait, fail, ok, type ToolContext } from './result.js'
import { agentSummarySchema } from './schemas.js'

const deployFields = {
  name: z.string().trim().min(1).max(60).describe('Display name of the agent.'),
  role: z.string().trim().max(60).optional().describe('Short role label, for example "Researcher".'),
  description: z.string().trim().max(280).optional().describe('What the agent is for. Used to write its persona when "persona" is omitted.'),
  tone: z.enum(['Friendly', 'Professional', 'Direct', 'Sharp']).optional(),
  persona: z.string().trim().min(1).max(8000).optional().describe('Full persona text. Omit to let Voight compose one from template, description and tone.'),
  template: z.enum(['general', 'sales', 'social', 'prediction']).optional().describe('Starting skill set. Default "general".'),
  host: z.enum(['voight', 'nosana']).optional().describe('"voight" = Voight cloud (default). "nosana" = a Nosana GPU running a local open model; invite-only.'),
  market: z.enum(['3060', '3090', '4090']).optional().describe('GPU market when host is "nosana" (see list_gpu_markets). Default "3060".'),
  model: z.string().trim().max(40).optional().describe('Model id for a cloud agent. Omit for the default. Ignored on GPU, which runs a local model.'),
  framework: z.enum(['hermes', 'zeroclaw']).optional().describe('Agent runtime. Default "hermes"; "zeroclaw" is not open to every account.'),
}
const deployShape = z.object(deployFields)

function toDeployInput(a: z.infer<typeof deployShape>): DeployInput {
  const input: DeployInput = { name: a.name }
  for (const k of ['role', 'description', 'tone', 'persona', 'template', 'host', 'market', 'model', 'framework'] as const) {
    if (a[k] !== undefined) (input as unknown as Record<string, unknown>)[k] = a[k]
  }
  return input
}

const scheduleFields = {
  schedule: z.enum(['once', 'daily', 'weekly']).optional().describe('"once" runs a single time, soon after it is created. Hourly is not available here.'),
  hour: z.number().int().min(0).max(23).optional().describe('Hour in UTC (daily and weekly).'),
  minute: z.number().int().min(0).max(59).optional().describe('Minute. Default 0.'),
  weekday: z.number().int().min(0).max(6).optional().describe('Weekly only: 0 = Sunday ... 6 = Saturday.'),
}

function toSchedule(a: { schedule?: 'once' | 'daily' | 'weekly'; hour?: number; minute?: number; weekday?: number }): TaskWrite {
  const out: TaskWrite = {}
  if (a.schedule === 'once') out.scheduleKind = null
  if (a.schedule === 'daily') out.scheduleKind = 'DAILY'
  if (a.schedule === 'weekly') out.scheduleKind = 'WEEKLY'
  if (a.hour !== undefined) out.scheduleHour = a.hour
  if (a.minute !== undefined) out.scheduleMinute = a.minute
  if (a.weekday !== undefined) out.scheduleWeekday = a.weekday
  return out
}

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  owner: z.enum(['agent', 'user']),
  status: z.string(),
  enabled: z.boolean(),
  schedule: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  runCount: z.number(),
  prompt: z.string().nullable(),
  lastResult: z.string().nullable(),
})

/** How long a healthy start takes; past three times this the tool stops recommending to wait. */
const TYPICAL_START_SECONDS = { voight_cloud: 60, nosana_gpu: 240 } as const
const POLL_MS = 5_000

export function registerProvisionTools(ctx: ToolContext): void {
  const { server, api, names, guarded, now, sleep } = ctx

  server.registerTool(
    'list_gpu_markets',
    {
      title: 'List GPU markets',
      description:
        'Nosana GPU markets an agent can be hosted on, with the hourly price the account pays, whether GPU hours are being billed right now, and live availability. GPU hosting is invite-only.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        hoursBilled: z.boolean(),
        markets: z.array(
          z.object({ market: z.string(), name: z.string(), hourlyUsd: z.number(), availableGpus: z.number().nullable(), queuedJobs: z.number().nullable() }),
        ),
      }),
      annotations: READ,
    },
    () => guarded(async () => ok({ ...(await api.gpuMarkets()) })),
  )

  server.registerTool(
    'quote_agent_deploy',
    {
      title: 'Quote an agent deploy',
      description:
        'What deploying this agent would cost, the credit balance, and whether this account may deploy it. Spends nothing and creates nothing. ALWAYS call this before deploy_agent, show the cost to the user, and pass the returned confirm values to deploy_agent unchanged.',
      inputSchema: deployShape,
      outputSchema: z.object({
        costUsd: z.number(),
        periodDays: z.number(),
        hosting: z.enum(['voight_cloud', 'nosana_gpu']),
        gpu: z.object({ market: z.string(), name: z.string(), hourlyUsd: z.number(), hoursBilled: z.boolean() }).nullable(),
        balanceUsd: z.number(),
        sufficientBalance: z.boolean(),
        cancelRefundable: z.boolean(),
        confirm: z.object({ confirm_cost_usd: z.number(), confirm_hourly_usd: z.number().nullable() }),
        next_step: z.string(),
      }),
      annotations: READ,
    },
    (args) =>
      guarded(async () => {
        const { quote } = await api.quoteDeploy(toDeployInput(args))
        const gpuLine = quote.gpu
          ? ` It runs on a ${quote.gpu.name} at $${quote.gpu.hourlyUsd} per GPU hour${quote.gpu.hoursBilled ? '' : ' (GPU hours are not being billed right now)'}.`
          : ''
        const next = quote.sufficientBalance
          ? `Tell the user: this deploy costs $${quote.costUsd} for ${quote.periodDays} days.${gpuLine} ${
              quote.cancelRefundable
                ? 'It can be cancelled for a refund until the GPU job starts.'
                : 'A cloud deploy cannot be cancelled for a refund from here.'
            } Once they agree, call deploy_agent with the same fields plus the confirm values.`
          : `The balance ($${quote.balanceUsd}) does not cover the $${quote.costUsd} deploy. The user can top up at ${AGENTS_URL}. Do not call deploy_agent yet.`
        return ok({
          costUsd: quote.costUsd,
          periodDays: quote.periodDays,
          hosting: quote.host === 'nosana' ? 'nosana_gpu' : 'voight_cloud',
          gpu: quote.gpu,
          balanceUsd: quote.balanceUsd,
          sufficientBalance: quote.sufficientBalance,
          cancelRefundable: quote.cancelRefundable,
          confirm: { confirm_cost_usd: quote.costUsd, confirm_hourly_usd: quote.gpu?.hourlyUsd ?? null },
          next_step: next,
        })
      }),
  )

  server.registerTool(
    'quote_agent_renewal',
    {
      title: 'Quote an agent renewal',
      description:
        'What renewing an agent for another period would cost and whether it is due yet (an agent can be renewed from here only in the days before it expires). Spends nothing. Call it before renew_agent.',
      inputSchema: z.object({ agent_id: z.string().min(1).describe('Agent id from list_agents.') }),
      outputSchema: z.object({
        costUsd: z.number(),
        periodDays: z.number(),
        due: z.boolean(),
        renewableFrom: z.string().nullable(),
        expiresAt: z.string().nullable(),
        balanceUsd: z.number(),
        sufficientBalance: z.boolean(),
        confirm: z.object({ confirm_cost_usd: z.number() }),
        next_step: z.string(),
      }),
      annotations: READ,
    },
    ({ agent_id }) =>
      guarded(async () => {
        const { quote } = await api.quoteRenew(agent_id)
        const next = !quote.due
          ? `Not due yet: it can be renewed from ${quote.renewableFrom?.slice(0, 10)}. Do not call renew_agent now.`
          : !quote.sufficientBalance
            ? `The balance ($${quote.balanceUsd}) does not cover the $${quote.costUsd} renewal. The user can top up at ${AGENTS_URL}.`
            : `Tell the user: renewing costs $${quote.costUsd} for ${quote.periodDays} more days. Once they agree, call renew_agent with confirm_cost_usd ${quote.costUsd}.`
        return ok({ ...quote, confirm: { confirm_cost_usd: quote.costUsd }, next_step: next })
      }),
  )

  server.registerTool(
    'wait_for_agent',
    {
      title: 'Wait for an agent to be ready',
      description:
        'Wait (up to about 50 seconds per call) until an agent that is starting becomes ready. A cloud agent usually takes about a minute, a GPU agent about four. Call it again while keep_waiting is true. When keep_waiting is false, stop and tell the user: never deploy another agent because one is slow.',
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent id returned by deploy_agent or list_agents.'),
        wait_seconds: z.number().int().min(1).max(55).optional().describe('How long to wait in this call. Default 50.'),
      }),
      outputSchema: z.object({
        state: z.string(),
        agent: agentSummarySchema,
        elapsed_seconds: z.number(),
        typical_seconds: z.number(),
        keep_waiting: z.boolean(),
        cancel_refundable: z.boolean(),
        wake_failed: z.boolean(),
        next_step: z.string(),
      }),
      annotations: READ,
    },
    ({ agent_id, wait_seconds }) =>
      guarded(async () => {
        const deadline = now() + clampWait(wait_seconds, 50, 50)
        // The first read decides: an unknown agent or a bad key is a real error.
        let agent = (await api.getAgent(agent_id)).agent
        while (agentState(agent) === 'starting' && now() + POLL_MS < deadline) {
          await sleep(POLL_MS)
          try {
            agent = (await api.getAgent(agent_id)).agent
          } catch {
            // A hiccup while polling is not the agent failing: keep the last known state.
          }
        }
        names.set(agent.id, agent.name)
        const summary = agentSummary(agent)
        const typical = TYPICAL_START_SECONDS[summary.hosting]
        const elapsed = Math.max(0, Math.round((now() - new Date(agent.createdAt).getTime()) / 1000))
        const refundable = agent.cancelRefundable === true
        const failedWake = wakeFailed(agent)
        let keepWaiting = false
        let next: string
        if (summary.state === 'ready') {
          next = 'The agent is ready: use chat_with_agent.'
        } else if (summary.state === 'failed') {
          next = `The deploy failed (${agent.error ?? 'no reason given'}). Voight refunds a failed deploy on its own. Tell the user; do not redeploy automatically.`
        } else if (failedWake) {
          next = `The GPU failed to start (${agent.error}). Tell the user. Do NOT call wake_agent again automatically.`
        } else if (summary.state === 'gpu_stopped') {
          next = 'The GPU is stopped. wake_agent starts it (a few minutes, may bill one GPU hour).'
        } else if (summary.state === 'starting') {
          keepWaiting = elapsed < typical * 3
          next = keepWaiting
            ? `Still starting (${elapsed}s so far; about ${typical}s is normal). Call wait_for_agent again.`
            : `It has been starting for ${elapsed}s, well past the usual ${typical}s. Stop polling and tell the user. Voight fails and refunds it on its own if it never comes up. Do NOT deploy another agent: that is a second charge.${
                refundable ? ' Deleting it now is refunded in full.' : ''
              }`
        } else {
          next = `The agent is ${summary.state}. Tell the user.`
        }
        return ok({
          state: summary.state,
          agent: summary,
          elapsed_seconds: elapsed,
          typical_seconds: typical,
          keep_waiting: keepWaiting,
          cancel_refundable: refundable,
          wake_failed: failedWake,
          next_step: next,
        })
      }),
  )

  if (ctx.readOnly) return

  server.registerTool(
    'deploy_agent',
    {
      title: 'Deploy a Voight agent',
      description:
        'Deploy a new agent on Voight cloud or on a Nosana GPU. SPENDS CREDITS: every deploy made here is charged (free or trial agents are claimed on the web). Call quote_agent_deploy first, tell the user the cost, and pass its confirm values: the deploy is refused if the real price is higher. Repeating an identical request returns the agent that is already being deployed instead of a second one; set allow_duplicate to deploy identical agents on purpose. Then call wait_for_agent.',
      inputSchema: z.object({
        ...deployFields,
        confirm_cost_usd: z.number().min(0).describe('confirm.confirm_cost_usd from quote_agent_deploy, after the user agreed.'),
        confirm_hourly_usd: z.number().min(0).optional().describe('GPU only: confirm.confirm_hourly_usd from quote_agent_deploy.'),
        allow_duplicate: z.boolean().optional().describe('Deploy even though an identical agent was just deployed.'),
      }),
      outputSchema: z.object({ agent: agentSummarySchema, replayed: z.boolean(), charged_usd: z.number(), next_step: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ confirm_cost_usd, confirm_hourly_usd, allow_duplicate, ...fields }) =>
      guarded(async () => {
        const r = await api.deploy({
          ...toDeployInput(fields),
          confirmCostUsd: confirm_cost_usd,
          ...(confirm_hourly_usd !== undefined ? { confirmHourlyUsd: confirm_hourly_usd } : {}),
          ...(allow_duplicate ? { allowDuplicate: true } : {}),
        })
        names.set(r.agent.id, r.agent.name)
        return ok({
          agent: agentSummary(r.agent),
          replayed: r.replayed,
          charged_usd: r.chargedUsd,
          next_step: r.replayed
            ? 'This exact deploy already exists, so that agent is returned and NOTHING was charged. If the user really wants a second identical agent, repeat with allow_duplicate true. Otherwise continue with wait_for_agent.'
            : `Deployed and charged $${r.chargedUsd}. It is starting: call wait_for_agent with agent_id "${r.agent.id}". Do not deploy it again.`,
        })
      }),
  )

  server.registerTool(
    'renew_agent',
    {
      title: 'Renew a Voight agent',
      description:
        'Extend an agent’s hosting by another period. SPENDS CREDITS. Only possible in the days before it expires. Call quote_agent_renewal first, tell the user the cost, and pass confirm_cost_usd.',
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent id from list_agents.'),
        confirm_cost_usd: z.number().min(0).describe('confirm.confirm_cost_usd from quote_agent_renewal, after the user agreed.'),
      }),
      outputSchema: z.object({ agent: agentSummarySchema, charged_usd: z.number(), next_step: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ agent_id, confirm_cost_usd }) =>
      guarded(async () => {
        const r = await api.renew(agent_id, confirm_cost_usd)
        names.set(r.agent.id, r.agent.name)
        const summary = agentSummary(r.agent)
        return ok({
          agent: summary,
          charged_usd: r.chargedUsd,
          next_step: r.debounced
            ? 'It was renewed a moment ago, so nothing was charged again.'
            : `Renewed and charged $${r.chargedUsd}: ${summary.daysLeft} days of hosting left.${summary.state === 'gpu_stopped' ? ' Its GPU is stopped: wake_agent starts it.' : ''}`,
        })
      }),
  )

  server.registerTool(
    'delete_agent',
    {
      title: 'Delete a Voight agent',
      description:
        'PERMANENTLY delete an agent, with its memory and scheduled tasks. There is no undo and a used period is not refunded. Only agents that were deployed with an API key can be deleted here; agents built in the dashboard are deleted in the dashboard. Requires the exact agent name. Ask the user before calling.',
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent id from list_agents.'),
        confirm_name: z.string().min(1).max(60).describe('The exact name of that agent, as shown by list_agents.'),
      }),
      outputSchema: z.object({ deleted: z.boolean(), already: z.boolean(), refunded: z.enum(['credits', 'free']).nullable(), next_step: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ agent_id, confirm_name }) =>
      guarded(async () => {
        const r = await api.deleteAgent(agent_id, confirm_name)
        names.delete(agent_id)
        return ok({
          deleted: true,
          already: r.already,
          refunded: r.refunded,
          next_step: r.already
            ? 'That agent was already deleted.'
            : `Deleted. It is gone from list_agents now; its infrastructure is being torn down in the background.${
                r.refunded === 'credits' ? ' It never started, so the deploy was refunded.' : ''
              } A new agent with the same name gets a slightly different handle for a few minutes.`,
        })
      }),
  )

  const taskResult = z.object({ task: taskSchema, paused_for_approval: z.boolean(), next_step: z.string() })
  const pausedNote = `This agent can act in public (GitHub, LinkedIn or X), so the task was saved PAUSED. A person enables it in the dashboard: ${AGENTS_URL}. It cannot be enabled from here.`

  server.registerTool(
    'create_task',
    {
      title: 'Schedule a task for an agent',
      description:
        'Give an agent an instruction to run on its own: once, every day or every week (UTC). Each run is a normal agent turn (it uses inference credits, and on a stopped GPU agent it starts the GPU). On an agent connected to GitHub, LinkedIn or X the task is saved paused until a person enables it in the dashboard. Tasks keep running after the API key is revoked.',
      inputSchema: z.object({
        agent_id: z.string().min(1).describe('Agent id from list_agents.'),
        title: z.string().trim().min(1).max(120).describe('Short name, for example "Morning brief".'),
        prompt: z.string().trim().min(1).max(4000).describe('The instruction the agent receives on every run.'),
        enabled: z.boolean().optional().describe('false saves the task paused. Default true.'),
        ...scheduleFields,
      }),
      outputSchema: taskResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ agent_id, title, prompt, enabled, ...when }) =>
      guarded(async () => {
        const r = await api.createTask(agent_id, { title, prompt, ...(enabled !== undefined ? { enabled } : {}), ...toSchedule(when) })
        return ok({
          task: taskSummary(r.task, names.get(agent_id) ?? agent_id),
          paused_for_approval: r.pausedForApproval,
          next_step: r.pausedForApproval ? pausedNote : !r.task.enabled ? 'Saved paused.' : r.task.nextRunAt ? `Scheduled. Next run: ${r.task.nextRunAt}.` : 'Saved.',
        })
      }),
  )

  server.registerTool(
    'update_task',
    {
      title: 'Edit or pause a task',
      description:
        'Change a task’s title, instruction or schedule, or pause and resume it (enabled). On an agent connected to GitHub, LinkedIn or X, a key can pause any task but can only edit a task it created that never ran, and can never enable one.',
      inputSchema: z.object({
        agent_id: z.string().min(1),
        task_id: z.string().min(1).describe('Task id from list_tasks.'),
        title: z.string().trim().min(1).max(120).optional(),
        prompt: z.string().trim().min(1).max(4000).optional(),
        enabled: z.boolean().optional().describe('false pauses the task, true resumes it.'),
        ...scheduleFields,
      }),
      outputSchema: taskResult,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ agent_id, task_id, title, prompt, enabled, ...when }) =>
      guarded(async () => {
        const body: TaskWrite = { ...toSchedule(when) }
        if (title !== undefined) body.title = title
        if (prompt !== undefined) body.prompt = prompt
        if (enabled !== undefined) body.enabled = enabled
        if (Object.keys(body).length === 0) return fail('Nothing to change: pass at least one of title, prompt, enabled or the schedule fields.')
        const r = await api.updateTask(agent_id, task_id, body)
        return ok({
          task: taskSummary(r.task, names.get(agent_id) ?? agent_id),
          paused_for_approval: r.pausedForApproval,
          next_step: !r.task.enabled ? 'Saved. The task is paused.' : r.task.nextRunAt ? `Saved. Next run: ${r.task.nextRunAt}.` : 'Saved.',
        })
      }),
  )

  server.registerTool(
    'delete_task',
    {
      title: 'Delete a task',
      description: 'Remove a task from an agent. There is no undo. Ask the user before deleting a task you did not create in this conversation.',
      inputSchema: z.object({ agent_id: z.string().min(1), task_id: z.string().min(1).describe('Task id from list_tasks.') }),
      outputSchema: z.object({ deleted: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ agent_id, task_id }) =>
      guarded(async () => {
        await api.deleteTask(agent_id, task_id)
        return ok({ deleted: true })
      }),
  )
}
