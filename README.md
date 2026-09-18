<div align="center">

# @voightxyz/agents-mcp

**Operate your Voight Agents from any MCP client.**

List your deployed agents, check their state and usage, talk to them and wake their GPUs, from Claude Code, Cursor, Codex, VS Code, Claude Desktop or Gemini CLI.

[![npm](https://img.shields.io/npm/v/@voightxyz/agents-mcp.svg)](https://www.npmjs.com/package/@voightxyz/agents-mcp)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

[Voight Agents](https://agent.voight.xyz) · [Docs](https://docs.voight.xyz) · [Voight](https://voight.xyz)

</div>

---

[Voight Agents](https://agent.voight.xyz) are autonomous AI agents you deploy in minutes. They run 24/7 on Voight cloud or on Nosana GPUs, browse the web, run scheduled tasks and work through the channels you connect (Telegram, GitHub and more). This package is a local [Model Context Protocol](https://modelcontextprotocol.io) server that lets your coding assistant operate them for you.

```
"Which of my agents are running, and how much did they use this week?"
"Ask my research agent for a summary of today's AI funding news."
"Wake my GPU agent and tell me when it is ready."
```

## Quick start

**1. Create an API key.** Open [voight.xyz/dashboard/settings](https://voight.xyz/dashboard/settings), create a key and choose the access level **Agents: operate**. The key is shown once. Ingest keys (the ones used by `@voightxyz/sdk`) do not work here, by design.

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
    { "type": "promptString", "id": "voight-api-key", "description": "Voight API key (Agents: operate)", "password": true }
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

| Tool | What it does | Spends credits |
| --- | --- | --- |
| `list_agents` | Agents on the account: id, state, hosting (Voight cloud or Nosana GPU), model, days left. Optional `state` filter. | No |
| `get_agent` | One agent in detail: channels, expiry, on-chain identity link, Nosana job link, persona. | No |
| `get_credits` | Credit balance, plan and the price of one deploy. | No |
| `get_agent_usage` | Turns, tokens and inference cost for one agent (with 14 days of daily tokens and billed GPU hours) or for the whole account. | No |
| `list_tasks` | Scheduled and one-off tasks of an agent, with the result of the last run. | No |
| `chat_with_agent` | Sends one message and waits for the reply. | Inference, like any chat turn |
| `get_reply` | Collects the reply of a turn that was still running. Never sends anything. | No |
| `wake_agent` | Starts the GPU of a stopped Nosana agent. | Can bill one GPU hour |

Run with `--read-only` (or `VOIGHT_MCP_READ_ONLY=1`) to expose only the first five tools.

### How chat works

An agent can work on a single message for minutes: it searches, runs tools and writes files before it answers. MCP clients give a tool call much less time than that (60 seconds in several of them). So `chat_with_agent` waits up to about 50 seconds:

- If the reply is ready, you get it.
- If not, you get `status: "running"`, a `turn_ref` and what the agent is doing right now. `get_reply` with that `turn_ref` collects the answer, and can be called as many times as needed.

A message is never sent twice: while a turn is running, a new message to the same agent is refused. The conversation continues across calls; pass `new_conversation: true` to start over.

Turns are kept in the memory of this process. If your client restarts the server while an agent is working, the `turn_ref` is lost. The agent still finishes on its side.

### GPU agents

Agents hosted on Nosana GPUs stop their GPU when the paid hours end, and show up as `gpu_stopped`. `wake_agent` starts the GPU again, which takes a few minutes and can bill one GPU hour. Sending a chat message to a stopped agent also starts it, but that message is not delivered: wait until `get_agent` says `ready`, then send it.

---

## Security and privacy

- **Scoped key.** The server only works with a key created with **Agents: operate** access (`agents:read`, `agents:chat`, `agents:write`). That key cannot deploy, delete or renew agents, cannot touch billing, and cannot create or list API keys. Revoke it at any time in Settings.
- **The key goes to one place.** Requests are only sent to `https://api.voight.xyz`. If `VOIGHT_ENDPOINT` points anywhere else (other than a localhost dev server) the server refuses to start, so a project config cannot redirect your key to another host.
- **Agent output is fenced.** Agents read the open web, inboxes and repos, so their replies can contain text written by a third party. Replies and task results are returned inside a block marked as untrusted content, with a random marker per call, and the model is told to treat it as data. This server never chains tool calls on its own.
- **Bounded output.** Results are capped at about 24,000 characters and say so when something was cut.
- **What leaves your machine.** The messages you send to an agent go to Voight, as they would from the dashboard. What comes back (agent names, personas, replies, task results, usage numbers) is handed to your MCP client and therefore to the model provider behind it. Account email and wallet are never returned.
- **No telemetry.** The package reads no files and sends nothing anywhere except the API calls above. Logs go to stderr.
- **No transitive installs.** The published bin is a single bundled file with zero runtime dependencies. Pin a version (`@voightxyz/agents-mcp@0.1.0`) if you want upgrades to be explicit.

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `VOIGHT_API_KEY` | Yes | Key with **Agents: operate** access. |
| `VOIGHT_ENDPOINT` | No | Defaults to `https://api.voight.xyz`. Only that host or localhost is accepted. |
| `VOIGHT_MCP_READ_ONLY` | No | `1` is the same as `--read-only`. |

## Not in this version

Deploying, renewing and deleting agents, editing tasks and managing connectors are not exposed yet. Billing and API key management will stay in the dashboard.

---

## Local development

```bash
npm install
npm run type-check
npm test
npm run build
npm run smoke                      # lists tools through the built binary
VOIGHT_API_KEY=vk_... npm run smoke  # also reads the account; never chats or wakes
```

```
src/
  cli.ts       entry point (stdio)
  config.ts    env and flags, endpoint allowlist
  api.ts       HTTP client and error messages
  chat.ts      chat turns with a bounded wait
  format.ts    compact views, size cap, untrusted fence
  server.ts    tool definitions
```

Inspect it with the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/cli.js`.

## License

Apache 2.0 © Voight. See [LICENSE](./LICENSE).
