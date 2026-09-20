# Changelog

All notable changes to `@voightxyz/agents-mcp` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0-beta.1] - 2026-09-20

Deploy, manage and orchestrate: the server now covers the whole life of an agent. The new spending and deleting tools need an **Agents: full** key; everything in 0.1 keeps working with an **Agents: operate** key.

### Added

- `quote_agent_deploy` + `deploy_agent`: deploy on Voight cloud or a Nosana GPU. The quote is a separate read-only tool, so clients ask for permission exactly when credits are spent; the deploy repeats the quoted cost and hourly GPU price and is refused if the real price is higher. A repeated identical deploy returns the agent already starting (`allow_duplicate` to opt out).
- `wait_for_agent`: bounded wait for a starting agent, with `keep_waiting`, typical start times and an explicit "stop, do not deploy another" once it takes too long. Tells a failed deploy and a failed GPU wake apart from a stopped GPU.
- `quote_agent_renewal` + `renew_agent`, `delete_agent` (exact name required, key-deployed agents only).
- `create_task`, `update_task`, `delete_task`: once, daily or weekly.
- `message_agents` + `get_replies`: instructions to up to 10 agents with one shared wait, a per-agent status, a shared reply budget, and nothing sent to agents that are busy or not ready.
- `list_gpu_markets`.
- Clear one-sentence explanations for every new refusal: balance, changed cost, daily and stock limits, GPU invite, renewal not due, key-deployed only, name mismatch, agent still starting, task needs approval, expired key, missing access level.

### Changed

- Personas and task titles and instructions are fenced as untrusted content like replies, and the agent name inside a fence label is reduced to one plain line: these fields can now be written through the server.
- Finished chat turns that were never collected are no longer evicted (the limit was 30 turns); collected ones make room first.
- `--read-only` now also exposes the quotes, `list_gpu_markets` and `wait_for_agent`.

## [0.1.0-beta.1] - 2026-09-18

First release: operate deployed Voight Agents from any MCP client.

### Added

- Read tools: `list_agents`, `get_agent`, `get_credits`, `get_agent_usage`, `list_tasks`.
- `chat_with_agent` with a bounded wait (about 50 seconds) and `get_reply` to collect turns that take longer, so long agent turns work inside client tool timeouts and a message is never sent twice.
- `wake_agent` for agents hosted on Nosana GPUs.
- `--read-only` flag (and `VOIGHT_MCP_READ_ONLY=1`) that removes every tool that can act or spend.
- Endpoint allowlist: the API key is only ever sent to `https://api.voight.xyz` or a localhost dev server.
- Agent replies and task results are returned inside a fenced, per-call marked untrusted block.
- Results capped at about 24,000 characters.
- Single bundled bin with zero runtime dependencies.
