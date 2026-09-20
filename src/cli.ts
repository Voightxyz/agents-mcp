/**
 * Entry point: `npx -y @voightxyz/agents-mcp` speaks MCP over stdio.
 * stdout belongs to the protocol, so everything human goes to stderr.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { loadConfig, SETTINGS_URL } from './config.js'
import { createServer } from './server.js'
import { VERSION } from './version.js'

const HELP = `@voightxyz/agents-mcp ${VERSION}
MCP server for Voight Agents (stdio).

Usage
  npx -y @voightxyz/agents-mcp [--read-only]

Environment
  VOIGHT_API_KEY   Required. "Agents: operate" to use your agents, or
                   "Agents: full" to also deploy, renew, schedule and delete.
                   Create it at ${SETTINGS_URL}
  VOIGHT_ENDPOINT  Optional. Defaults to https://api.voight.xyz

Flags
  --read-only      Only expose tools that read (no chat, no deploy, no delete).
  --version        Print the version.
  --help           Print this help.

This command is started by an MCP client (Claude Code, Cursor, Codex, VS Code).
Docs: https://docs.voight.xyz
`

function main(): void {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(HELP)
    return
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stderr.write(`${VERSION}\n`)
    return
  }

  let config
  try {
    config = loadConfig(process.env, argv)
  } catch (err) {
    process.stderr.write(`[voight-agents-mcp] ${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
    return
  }
  // A missing key is reported by every tool call instead of crashing here:
  // MCP clients show a crashed server as an opaque "failed to connect".
  if (config.apiKeyProblem) process.stderr.write(`[voight-agents-mcp] ${config.apiKeyProblem}\n`)
  process.stderr.write(`[voight-agents-mcp] ${VERSION} ready${config.readOnly ? ' (read-only)' : ''}\n`)

  serveStdio(() => createServer(config))
}

main()
