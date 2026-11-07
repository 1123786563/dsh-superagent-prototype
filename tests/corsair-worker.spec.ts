import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/corsair-worker.ts'

it('reads the latest credential for each Worker and mounts MCP on the Agent context only', async () => {
  let created!: (payload: { agent: { ctx: { plugin: ReturnType<typeof vi.fn> } } }) => Promise<void>
  let record: unknown
  const readRecord = vi.fn(async () => record)
  const rootPlugin = vi.fn()
  apply({ credentials: { readRecord }, plugin: rootPlugin,
    on: (name: string, listener: typeof created) => { expect(name).toBe('agent/created'); created = listener } } as unknown as Context)
  expect(readRecord).not.toHaveBeenCalled()
  const first = { ctx: { plugin: vi.fn() } }
  await created({ agent: first })
  expect(first.ctx.plugin).not.toHaveBeenCalled()

  record = { kind: 'api-key', key: ['test', 'only', 'key', 'one'].join('-'), env: { CORSAIR_MCP_URL: 'https://mcp.corsair.dev/mcp' } }
  const second = { ctx: { plugin: vi.fn() } }
  await created({ agent: second })
  expect(second.ctx.plugin).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
    serverName: 'corsair', url: 'https://mcp.corsair.dev/mcp', headers: { Authorization: 'Bearer test-only-key-one' },
  }))

  record = { kind: 'api-key', key: 'test-only-key-two', env: { CORSAIR_MCP_URL: 'https://mcp.corsair.dev/mcp' } }
  const third = { ctx: { plugin: vi.fn() } }
  await created({ agent: third })
  expect(third.ctx.plugin).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
    headers: { Authorization: 'Bearer test-only-key-two' },
  }))
  expect(second.ctx.plugin).toHaveBeenCalledTimes(1)
  expect(rootPlugin).not.toHaveBeenCalled()

  for (const endpoint of ['http://mcp.corsair.dev/mcp', 'https://corsair.dev.evil.example/mcp',
    'https://user:secret@mcp.corsair.dev/mcp', 'https://mcp.corsair.dev/mcp?key=secret']) {
    record = { kind: 'api-key', key: 'test-only-key', env: { CORSAIR_MCP_URL: endpoint } }
    const invalid = { ctx: { plugin: vi.fn() } }
    await created({ agent: invalid })
    expect(invalid.ctx.plugin).not.toHaveBeenCalled()
  }
})
