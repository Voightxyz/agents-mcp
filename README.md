<div align="center">

# @voightxyz/agents-mcp

**Deploy, operate and orchestrate your Voight Agents from any MCP client.**

Deploy agents on Voight cloud or Nosana GPUs, talk to one or to ten at once, schedule their work, renew and delete them, from Claude Code, Cursor, Codex, VS Code, Claude Desktop or Gemini CLI.

[![npm](https://img.shields.io/npm/v/@voightxyz/agents-mcp.svg)](https://www.npmjs.com/package/@voightxyz/agents-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

[Voight Agents](https://agent.voight.xyz) · [Docs](https://docs.voight.xyz) · [Voight](https://voight.xyz)

</div>

---

[Voight Agents](https://agent.voight.xyz) are autonomous AI agents you deploy in minutes. They run 24/7 on Voight cloud or on Nosana GPUs, browse the web, run scheduled tasks and work through the channels you connect (Telegram, GitHub and more). This package is a local [Model Context Protocol](https://modelcontextprotocol.io) server that lets your coding assistant operate them for you.

```
"Deploy three research agents, give each a topic, and merge what they find."
"Which of my agents are running, and how much did they use this week?"
"Schedule a daily 8:00 brief on my research agent."
"Delete the test agents we deployed this morning."
```

## Quick start

**1. Create an API key.** Open [agent.voight.xyz](https://agent.voight.xyz), open the account menu and choose **MCP / API**. Pick the access level and generate the key. It is shown once.

| Access | What it can do | Expires |
| --- | --- | --- |
| **Agents: operate** | List agents, read usage and tasks, chat, wake GPUs | Never |
| **Agents: full** | All of the above, plus deploy, renew, schedule tasks and delete | After 90 days |

Ingest keys (the ones used by `@voightxyz/sdk`) do not work here, by design.

**2. Add the server to your client.** It runs with `npx`, there is nothing to install.

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add --env VOIGHT_API_KEY=vk_your_key --transport stdio voight-agents -- npx -y @voightxyz/agents-mcp
```

To share the config with a team without sharing the secret, commit a `.mcp.json` that reads the key from each person's environment:

```json
{
  "mcpServers": {
    "voight-agents": {
      "command": "npx",
      "args": ["-y", "@voightxyz/agents-mcp"],
      "env": { "VOIGHT_API_KEY": "${VOIGHT_API_KEY}" }
    }
  }
}
```

</details>

<details>
<summary><b>Cursor</b></summary>

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "voight-agents": {
      "command": "npx",
      "args": ["-y", "@voightxyz/agents-mcp"],
      "env": { "VOIGHT_API_KEY": "vk_your_key" }
    }
  }
}
```

</details>

<details>
<summary><b>VS Code</b></summary>

`.vscode/mcp.json`. VS Code asks for the key once and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "voight-api-key", "description": "Voight API key (Agents: operate or Agents: full)", "password": true }
  ],
  "servers": {
    "voight-agents": {
      "command": "npx",
      "args": ["-y", "@voightxyz/agents-mcp"],
      "env": { "VOIGHT_API_KEY": "${input:voight-api-key}" }
    }
  }
}
```

</details>

<details>
<summary><b>Codex CLI</b></summary>

`~/.codex/config.toml`:

```toml
[mcp_servers.voight_agents]
command = "npx"
args = ["-y", "@voightxyz/agents-mcp"]
startup_timeout_sec = 30

[mcp_servers.voight_agents.env]
VOIGHT_API_KEY = "vk_your_key"
```

</details>

<details>
<summary><b>Claude Desktop</b></summary>

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "voight-agents": {
      "command": "npx",
      "args": ["-y", "@voightxyz/agents-mcp"],
      "env": { "VOIGHT_API_KEY": "vk_your_key" }
    }
  }
}
```

</details>

<details>
<summary><b>Gemini CLI</b></summary>

`~/.gemini/settings.json`. Gemini CLI does not pass variables named like `*KEY*` from your shell, so the key has to be set in the `env` block:

```json
{
  "mcpServers": {
    "voight-agents": {
      "command": "npx",
      "args": ["-y", "@voightxyz/agents-mcp"],
      "env": { "VOIGHT_API_KEY": "vk_your_key" }
    }
  }
}
```

</details>

**3. Ask.** "List my Voight agents" is a good first message.

---

## Tools

| Tool | What it does | Key | Spends |
| --- | --- | --- | --- |
| `list_agents` | Agents on the account: id, state, hosting, model, days left | operate | No |
| `get_agent` | One agent in detail: channels, expiry, on-chain identity, Nosana job, persona | operate | No |
| `get_credits` | Credit balance, plan and the price of one deploy | operate | No |
| `get_agent_usage` | Turns, tokens and cost for one agent or the whole account | operate | No |
| `list_tasks` | Tasks of an agent, with the result of the last run | operate | No |
| `list_gpu_markets` | GPU markets with hourly price and live availability | operate | No |
| `chat_with_agent` | Sends one message and waits for the reply | operate | Inference |
| `get_reply` | Collects the reply of a turn that was still running | operate | No |
| `message_agents` | Sends instructions to up to 10 agents at once | operate | Inference |
| `get_replies` | Collects several pending replies in one call | operate | No |
| `wake_agent` | Starts the GPU of a stopped Nosana agent | operate | Can bill a GPU hour |
| `wait_for_agent` | Waits for a starting agent, and says when to stop waiting | operate | No |
| `quote_agent_deploy` | What a deploy would cost, and whether the account may do it | full | No |
| `deploy_agent` | Deploys an agent on Voight cloud or a Nosana GPU | full | **Yes** |
| `quote_agent_renewal` | What a renewal would cost, and whether it is due | full | No |
| `renew_agent` | Extends hosting by another period | full | **Yes** |
| `create_task` / `update_task` / `delete_task` | Work an agent runs on its own: once, daily or weekly | full | Each run is a normal turn |
| `delete_agent` | Permanently deletes an agent | full | No |

Run with `--read-only` (or `VOIGHT_MCP_READ_ONLY=1`) to expose only tools that read.

### Deploying

Spending always takes two steps, in two different tools, so your client asks for permission at the moment money moves:

1. `quote_agent_deploy` answers what it costs, your balance, and whether the account may deploy it. It spends nothing.
2. `deploy_agent` repeats the quoted amounts. If the real price is higher, the deploy is refused and nothing is charged.
3. `wait_for_agent` follows the start (about a minute on Voight cloud, about four on a GPU) and says when to stop waiting instead of polling forever.

**Every deploy and renewal made through this server is charged**, on every account. Free and trial agents are claimed on the web. Asking twice for the same deploy returns the agent that is already starting instead of a second one and a second charge (`allow_duplicate` deploys identical agents on purpose). Repeating the quoted cost is there for you to see it: it is not what protects the account. The limits below are, and they live on Voight's side.

### Limits

Per account, across all its keys, enforced by the API:

| Limit | Value |
| --- | --- |
| Deploys | 10 per 24 hours |
| Renewals | 10 per 24 hours, and only in the 7 days before an agent expires |
| Agent deletes | 10 per 24 hours |
| Task creates, edits and deletes | 30 per 24 hours |
| Live agents deployed through keys | 15, of which 3 on GPU |
| Tasks per agent | 50 |

### Orchestrating several agents

`message_agents` sends one instruction to many agents, or a different one to each, and waits once for all of them (about 45 seconds). Agents still working come back as `running` with a `turn_ref`; `get_replies` collects them. Nothing is sent to an agent that is busy or not ready, so a message is never queued behind another or lost. Long replies are shortened to fit your client; `get_reply` returns the full text of any of them.

### How chat works

An agent can work on a single message for minutes: it searches, runs tools and writes files before it answers. MCP clients give a tool call much less time than that (60 seconds in several of them). So `chat_with_agent` waits up to about 50 seconds:

- If the reply is ready, you get it.
- If not, you get `status: "running"`, a `turn_ref` and what the agent is doing right now. `get_reply` with that `turn_ref` collects the answer, and can be called as many times as needed.

A message is never sent twice: while a turn is running, a new message to the same agent is refused. The conversation continues across calls; pass `new_conversation: true` to start over.

Turns are kept in the memory of this process. If your client restarts the server while an agent is working, the `turn_ref` is lost. The agent still finishes on its side.

### GPU agents

GPU hosting on Nosana is **invite-only** for now: deploying on a GPU works for accounts that were invited, and everyone can deploy on Voight cloud.

Agents hosted on GPUs stop their GPU when the paid hours end, and show up as `gpu_stopped`. `wake_agent` starts the GPU again, which takes a few minutes and can bill one GPU hour. Sending a chat message to a stopped agent also starts it, but that message is not delivered: wait until `wait_for_agent` says `ready`, then send it. `message_agents` skips stopped GPU agents unless you pass `wake_stopped: true`.

### Tasks

A task is an instruction the agent runs on its own: once, every day or every week (times are UTC). Each run is a normal agent turn.

- On an agent connected to **GitHub, LinkedIn or X**, a task created from here is saved **paused**, and a person enables it in the dashboard. A key can pause such an agent's tasks, and edit a task it created that never ran, but it can never enable one or change one that a person approved. Scheduled runs act without anyone watching, so arming them is a human decision.
- **Revoking a key does not stop the tasks it scheduled.** Pause or delete them from here or from the dashboard.

### Deleting

`delete_agent` is permanent: the agent, its memory and its tasks are gone, and a used period is not refunded. It needs the agent's exact name, and it **only works on agents that were deployed with an API key**. Agents you built in the dashboard, with their connectors, bot and on-chain identity, cannot be deleted from any MCP session. A GPU deploy that has not started yet is refunded when deleted; a cloud agent that is still starting cannot be deleted until it is up.

---

## Security and privacy

- **Scoped keys.** An **Agents: operate** key cannot deploy, renew, schedule or delete. An **Agents: full** key can, expires after 90 days, and is bounded by the limits above. Neither can touch billing, top up, or create, list or revoke API keys. Revoke a key at any time in Settings.
- **The rules live on the server.** Charging, limits, duplicate detection, what a key may delete and the task rules are enforced by the Voight API. Nothing in this package is a security boundary: a model can repeat any confirmation it is asked for.
- **The key goes to one place.** Requests are only sent to `https://api.voight.xyz`. If `VOIGHT_ENDPOINT` points anywhere else (other than a localhost dev server) the server refuses to start, so a project config cannot redirect your key to another host.
- **Stored text is fenced.** Agents read the open web, inboxes and repos, so their replies can contain text written by a third party, and personas and task instructions can now be written through this server. All of it (replies, task results, personas, task instructions) comes back inside a block marked as untrusted content, with a random marker per call, and the model is told to treat it as data. This server never chains tool calls on its own.
- **Bounded output.** Results are capped at about 24,000 characters and say so when something was cut.
- **What leaves your machine.** The messages you send to an agent go to Voight, as they would from the dashboard. What comes back (agent names, personas, replies, task results, usage numbers) is handed to your MCP client and therefore to the model provider behind it. Account email and wallet are never returned.
- **No telemetry.** The package reads no files and sends nothing anywhere except the API calls above. Logs go to stderr.
- **No transitive installs.** The published bin is a single bundled file with zero runtime dependencies. Pin a version (`@voightxyz/agents-mcp@0.2.0`) if you want upgrades to be explicit.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `VOIGHT_API_KEY` | Yes | An **Agents: operate** or **Agents: full** key. |
| `VOIGHT_ENDPOINT` | No | Defaults to `https://api.voight.xyz`. Only that host or localhost is accepted. |
| `VOIGHT_MCP_READ_ONLY` | No | `1` is the same as `--read-only`. |

## Not in this version

Editing an agent's persona or model, retrying a failed deploy, connectors, attachments and claim codes are not exposed. Topping up credits and managing API keys will stay in the dashboard.

---

## Local development

```bash
npm install
npm run type-check
npm test
npm run build
npm run smoke                      # lists tools through the built binary
VOIGHT_API_KEY=vk_... npm run smoke  # also reads the account; never chats, wakes or deploys
```

```
src/
  cli.ts       entry point (stdio)
  config.ts    env and flags, endpoint allowlist
  api.ts       HTTP client and error messages
  chat.ts      chat turns with a bounded wait
  format.ts    compact views, size cap, untrusted fence
  server.ts    read and chat tools
  tools-provision.ts   quotes, deploy, wait, renew, delete, tasks
  tools-fanout.ts      message_agents, get_replies
```

Inspect it with the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/cli.js`.

## License

Apache 2.0 © Voight. See [LICENSE](./LICENSE).

---

Voight is the observability and debugging infrastructure for autonomous systems, built by Galaxyhub Labs Inc. Voight Agents is its hosted-agents product. Company, team and traction: https://voight.xyz/company
