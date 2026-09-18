import { describe, expect, it } from 'vitest'
import { DEFAULT_ENDPOINT, loadConfig, resolveApiKey, resolveEndpoint } from '../../src/config.js'

describe('resolveEndpoint', () => {
  it('defaults to the production API', () => {
    expect(resolveEndpoint(undefined)).toBe(DEFAULT_ENDPOINT)
    expect(resolveEndpoint('  ')).toBe(DEFAULT_ENDPOINT)
  })

  it('accepts production over https and a localhost dev server', () => {
    expect(resolveEndpoint('https://api.voight.xyz/')).toBe('https://api.voight.xyz')
    expect(resolveEndpoint('http://localhost:4000')).toBe('http://localhost:4000')
    expect(resolveEndpoint('http://127.0.0.1:4000/v1')).toBe('http://127.0.0.1:4000')
  })

  it('refuses to send the key anywhere else', () => {
    expect(() => resolveEndpoint('https://evil.example')).toThrow(/Refusing to send the API key/)
    expect(() => resolveEndpoint('http://api.voight.xyz')).toThrow(/Refusing/)
    expect(() => resolveEndpoint('https://api.voight.xyz.evil.example')).toThrow(/Refusing/)
    expect(() => resolveEndpoint('https://api.voight.xyz@evil.example')).toThrow(/Refusing/)
    expect(() => resolveEndpoint('not a url')).toThrow(/not a valid URL/)
  })
})

describe('resolveApiKey', () => {
  it('explains a missing or malformed key instead of throwing', () => {
    expect(resolveApiKey(undefined)).toMatchObject({ apiKey: null })
    expect(resolveApiKey(undefined).apiKeyProblem).toMatch(/VOIGHT_API_KEY is not set/)
    expect(resolveApiKey('sk-123').apiKeyProblem).toMatch(/should start with "vk_"/)
  })

  it('accepts a vk_ key', () => {
    expect(resolveApiKey(' vk_abc ')).toEqual({ apiKey: 'vk_abc', apiKeyProblem: null })
  })
})

describe('loadConfig', () => {
  it('reads read-only from the flag or the env', () => {
    expect(loadConfig({ VOIGHT_API_KEY: 'vk_a' }, []).readOnly).toBe(false)
    expect(loadConfig({ VOIGHT_API_KEY: 'vk_a' }, ['--read-only']).readOnly).toBe(true)
    expect(loadConfig({ VOIGHT_API_KEY: 'vk_a', VOIGHT_MCP_READ_ONLY: '1' }, []).readOnly).toBe(true)
  })
})
