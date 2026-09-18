/**
 * Runtime configuration: everything comes from the environment and argv the
 * MCP client launches us with. Nothing is read from disk.
 */

export const DEFAULT_ENDPOINT = 'https://api.voight.xyz'
export const SETTINGS_URL = 'https://voight.xyz/dashboard/settings'
export const AGENTS_URL = 'https://agent.voight.xyz'

export interface Config {
  /** `vk_…` key with "Agents: operate" access. Null when unset or malformed. */
  apiKey: string | null
  /** Why `apiKey` is null, phrased for the person who has to fix it. */
  apiKeyProblem: string | null
  endpoint: string
  /** Only the read tools are registered. */
  readOnly: boolean
}

/**
 * The key travels as a Bearer token, so the endpoint decides who receives it.
 * A project-level MCP config can set env vars for us, which means a hostile
 * repo could point `VOIGHT_ENDPOINT` at its own host and harvest the key.
 * Only the production API (https) and a local dev server are accepted.
 */
export function resolveEndpoint(raw: string | undefined): string {
  if (!raw || !raw.trim()) return DEFAULT_ENDPOINT
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error(`VOIGHT_ENDPOINT is not a valid URL: ${raw}`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  const prod = url.protocol === 'https:' && url.hostname === 'api.voight.xyz'
  if (!prod && !(local && (url.protocol === 'http:' || url.protocol === 'https:'))) {
    throw new Error(
      `VOIGHT_ENDPOINT must be ${DEFAULT_ENDPOINT} (or a localhost dev server). Refusing to send the API key to ${url.host}.`,
    )
  }
  return url.origin
}

export function resolveApiKey(raw: string | undefined): Pick<Config, 'apiKey' | 'apiKeyProblem'> {
  const key = raw?.trim()
  if (!key) {
    return {
      apiKey: null,
      apiKeyProblem: `VOIGHT_API_KEY is not set. Create a key with "Agents: operate" access at ${SETTINGS_URL} and pass it to this server as the VOIGHT_API_KEY environment variable.`,
    }
  }
  if (!key.startsWith('vk_')) {
    return {
      apiKey: null,
      apiKeyProblem: `VOIGHT_API_KEY does not look like a Voight key (it should start with "vk_"). Create one with "Agents: operate" access at ${SETTINGS_URL}.`,
    }
  }
  return { apiKey: key, apiKeyProblem: null }
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: string[]): Config {
  return {
    ...resolveApiKey(env.VOIGHT_API_KEY),
    endpoint: resolveEndpoint(env.VOIGHT_ENDPOINT),
    readOnly: argv.includes('--read-only') || env.VOIGHT_MCP_READ_ONLY === '1',
  }
}
