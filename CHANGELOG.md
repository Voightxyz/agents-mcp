# Changelog

All notable changes to `@voightxyz/agents-mcp` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
