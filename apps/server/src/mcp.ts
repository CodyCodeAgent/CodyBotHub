import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { HubTaskService } from './tasks.js'
import { newTaskRequestId } from './tasks.js'
import type { HubTaskRecord } from './types.js'

const taskResult = (task: HubTaskRecord) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ task }) }],
})

const bearerToken = (request: IncomingMessage): string => {
  const authorization = request.headers.authorization ?? ''
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : ''
}

const tokenMatches = (actual: string, expected: string): boolean => {
  const actualBytes = Buffer.from(actual), expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export const createMcpEndpoint = (tasks: HubTaskService, configuredToken: string, configuredPrincipal = 'mcp-client') => {
  const handler = createMcpHandler(ctx => {
    const principal = ctx.authInfo?.clientId || 'mcp-client'
    const server = new McpServer({ name: 'CodyBotHub', version: '0.1.0' })
    server.registerTool('inspect_platform', {
      title: 'Inspect CodyBotHub', description: 'List the managed Bots and Scenes available for task submission. The result is represented as a completed task.',
      inputSchema: z.object({ requestId: z.string().min(1).max(200).optional() }), annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ requestId }) => taskResult(tasks.inspectPlatform({ requestId: requestId ?? newTaskRequestId(), principal })))
    server.registerTool('submit_agent_task', {
      title: 'Submit read-only Bot task',
      description: 'Run a managed CodyBotHub Bot as a durable read-only task. Returns immediately by default; use waitMs for a bounded inline wait or query the task later.',
      inputSchema: z.object({
        botId: z.string().uuid(), sceneId: z.string().uuid().optional(), prompt: z.string().min(1).max(200_000), sessionId: z.string().min(1).max(200).default('default'),
        requestId: z.string().min(1).max(200).optional(), waitMs: z.number().int().min(0).max(25_000).default(0),
      }), annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ botId, sceneId, prompt, sessionId, requestId, waitMs }) => {
      const task = tasks.dispatchAgentTask({ botId, ...(sceneId ? { sceneId } : {}), prompt, sessionId, requestId: requestId ?? newTaskRequestId(), principal })
      return taskResult(waitMs > 0 ? await tasks.wait(task.id, waitMs, principal) : task)
    })
    server.registerTool('get_task', {
      title: 'Get task', description: 'Read the latest durable snapshot for a CodyBotHub task.',
      inputSchema: z.object({ taskId: z.string().uuid() }), annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ taskId }) => taskResult(tasks.get(taskId, principal)))
    server.registerTool('wait_task', {
      title: 'Wait for task', description: 'Wait up to 25 seconds for a task to finish, then return its latest snapshot.',
      inputSchema: z.object({ taskId: z.string().uuid(), timeoutMs: z.number().int().min(0).max(25_000).default(25_000) }), annotations: { readOnlyHint: true, idempotentHint: true },
    }, async ({ taskId, timeoutMs }) => taskResult(await tasks.wait(taskId, timeoutMs, principal)))
    return server
  }, { responseMode: 'json', onerror: error => console.error('[mcp] request failed:', error) })
  const nodeHandler = toNodeHandler(handler)

  return {
    close: () => handler.close(),
    handle: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (!configuredToken) {
        response.statusCode = 503
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({ error: 'MCP endpoint is disabled' }))
        return
      }
      const actualToken = bearerToken(request)
      if (!actualToken || !tokenMatches(actualToken, configuredToken)) {
        response.statusCode = 401
        response.setHeader('WWW-Authenticate', 'Bearer')
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({ error: 'Invalid bearer token' }))
        return
      }
      const origin = request.headers.origin
      let crossOrigin = false
      if (origin) {
        try { crossOrigin = new URL(origin).host !== request.headers.host }
        catch { crossOrigin = true }
      }
      if (crossOrigin) {
        response.statusCode = 403
        response.setHeader('Content-Type', 'application/json; charset=utf-8')
        response.end(JSON.stringify({ error: 'Cross-origin MCP request rejected' }))
        return
      }
      const principal = configuredPrincipal.trim().slice(0, 128) || 'mcp-client'
      ;(request as IncomingMessage & { auth?: AuthInfo }).auth = { token: actualToken, clientId: principal, scopes: ['codybothub:tasks'] }
      await (nodeHandler as unknown as (request: IncomingMessage, response: ServerResponse) => Promise<void>)(request, response)
    },
  }
}
