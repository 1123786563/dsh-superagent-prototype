/** Loads the saved Corsair MCP connection into each dsh-superagent Worker Session. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { apply as mcpClient } from '@deepseek-ai/dsh-mcp-client'

const KEY = credentialKey('dsh-superagent', 'corsair-mcp')
const URL_ENV = 'CORSAIR_MCP_URL'

export const name = 'dsh-superagent/corsair-worker'
export const inject = ['credentials']

/**
 * Presets are shared across Agents, so load the key when each scoped Worker Agent is created.
 * The credential stays on the Host and is passed directly to that Agent's MCP client.
 */
export function apply(ctx: Context): void {
  ctx.on('agent/created', async ({ agent }) => {
    const record = await ctx.credentials.readRecord(KEY)
    if (record?.kind !== 'api-key' || !record.key) return
    const endpoint = record.env?.[URL_ENV]
    if (!endpoint || !validEndpoint(endpoint)) return
    await agent.ctx.plugin(mcpClient, {
      transport: 'streamable-http',
      serverName: 'corsair',
      url: endpoint,
      headers: { Authorization: `Bearer ${record.key}` },
      toolCallTimeoutMs: 120_000,
      failOnStartupError: false,
    })
  })
}

function validEndpoint(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname
    return url.protocol === 'https:' && (host === 'corsair.dev' || host.endsWith('.corsair.dev')
      || host === 'corsair.cloud' || host.endsWith('.corsair.cloud')) && url.pathname === '/mcp'
      && !url.href.split('//')[1]?.split('/')[0]?.includes('@') && !url.search && !url.hash
  } catch { return false }
}

