import { createServer } from 'node:http'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpEndpoint } from '../src/mcp.js'
import type { HubTaskRecord } from '../src/types.js'

const completedTask = (): HubTaskRecord => ({
  id: '5ba887cc-3882-4623-9017-3d3ca2b875c0', kind: 'inspect_platform', origin: 'mcp', principal: 'dot-test', idempotencyKey: 'request-1',
  status: 'completed', input: {}, progress: null, result: { data: { bots: [] } }, error: null, revision: 2,
  botId: '', sceneId: '', threadChannelId: '', sourceKind: 'mcp_request', sourceId: 'request-1',
  createdAtIso: '2026-01-01T00:00:00.000Z', updatedAtIso: '2026-01-01T00:00:01.000Z',
  startedAtIso: '2026-01-01T00:00:00.500Z', completedAtIso: '2026-01-01T00:00:01.000Z',
})

const closers: Array<() => Promise<void>> = []
afterEach(async () => { while (closers.length) await closers.pop()!() })

describe('CodyBotHub MCP endpoint', () => {
  it('requires a bearer token and serves task-oriented tools through MCP', async () => {
    const task = completedTask()
    const tasks = {
      inspectPlatform: vi.fn(() => task), dispatchAgentTask: vi.fn(() => task), get: vi.fn(() => task), wait: vi.fn(async () => task),
    }
    const endpoint = createMcpEndpoint(tasks as never, 'test-secret', 'dot-test')
    const server = createServer((request, response) => { void endpoint.handle(request, response) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`)
    closers.push(async () => {
      await endpoint.close()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    })

    const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(unauthorized.status).toBe(401)
    const malformedOrigin = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-secret', origin: 'not-a-url' }, body: '{}' })
    expect(malformedOrigin.status).toBe(403)
    const crossOrigin = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer test-secret', origin: 'https://attacker.example' }, body: '{}' })
    expect(crossOrigin.status).toBe(403)

    const client = new Client({ name: 'codybothub-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => 'test-secret' } })
    await client.connect(transport)
    closers.push(async () => client.close())
    const tools = await client.listTools()
    expect(tools.tools.map(item => item.name)).toEqual(expect.arrayContaining(['inspect_platform', 'submit_agent_task', 'get_task', 'wait_task']))
    expect(tools.tools.find(item => item.name === 'submit_agent_task')?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    expect(JSON.stringify(tools.tools.find(item => item.name === 'submit_agent_task')?.inputSchema)).toContain('sceneId')
    const result = await client.callTool({ name: 'inspect_platform', arguments: { requestId: 'request-1' } })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ task })
    expect(tasks.inspectPlatform).toHaveBeenCalledWith({ requestId: 'request-1', principal: 'dot-test' })
    const sceneId = 'b4506fec-9f76-4e6b-a995-3c3aee147f9a'
    await client.callTool({ name: 'submit_agent_task', arguments: { botId: 'f195f9af-2276-4ddb-b4df-83331e1bdbcf', sceneId, prompt: 'run capability', sessionId: 'session-1', requestId: 'request-2' } })
    expect(tasks.dispatchAgentTask).toHaveBeenCalledWith(expect.objectContaining({ sceneId, principal: 'dot-test' }))
  })
})
