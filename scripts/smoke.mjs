// Publish-time check of the BUILT binary over real stdio:
//   npm run build && npm run smoke
// Without VOIGHT_API_KEY it lists the tools and checks the missing-key error.
// With a key it also reads the account (no chat, no wake: nothing is spent).
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const env = { PATH: process.env.PATH ?? '' }
if (process.env.VOIGHT_API_KEY) env.VOIGHT_API_KEY = process.env.VOIGHT_API_KEY
if (process.env.VOIGHT_ENDPOINT) env.VOIGHT_ENDPOINT = process.env.VOIGHT_ENDPOINT

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/cli.js', import.meta.url).pathname, ...process.argv.slice(2)],
  env,
  stderr: 'inherit',
})
const client = new Client({ name: 'voight-agents-mcp-smoke', version: '0.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`)

const list = await client.callTool({ name: 'list_agents', arguments: {} })
if (env.VOIGHT_API_KEY) {
  if (list.isError) throw new Error(`list_agents failed: ${list.content[0]?.text}`)
  console.log(`list_agents: ${list.structuredContent.returned} of ${list.structuredContent.total} agents`)
  const credits = await client.callTool({ name: 'get_credits', arguments: {} })
  if (credits.isError) throw new Error(`get_credits failed: ${credits.content[0]?.text}`)
  console.log(`get_credits: plan ${credits.structuredContent.plan}`)
} else {
  if (!list.isError) throw new Error('expected a missing-key error')
  console.log(`no key: ${list.content[0]?.text}`)
}

await client.close()
console.log('smoke ok')
