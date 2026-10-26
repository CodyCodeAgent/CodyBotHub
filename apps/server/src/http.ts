import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { AuthService } from './auth.js'
import { SecretVault } from './crypto.js'
import { HubStore } from './db.js'
import type { DeploymentStatusRecord, HubTaskRecord, SystemHealthRecord } from './types.js'
import type { FeishuProvisioningService } from './provisioning.js'
import type { CodyBotRuntime } from './runtime.js'
import type { SkillSyncService } from './skills.js'
import type { CopilotService } from './copilot.js'
import type { HubTaskService } from './tasks.js'
import { createMcpEndpoint } from './mcp.js'
import type { ScheduledTaskService } from './scheduled.js'
import { HttpError, matchId, optional, page, sendJson, readJson, required } from './http/common.js'
import { handleScheduledRoute } from './http/scheduled-router.js'
import { handleCopilotRoute } from './http/copilot-router.js'
import { handleAdminRoute } from './http/admin-router.js'
import { handleSkillRoute } from './http/skill-router.js'
import { handleInsightsRoute } from './http/insights-router.js'
import { handleConfigurationRoute } from './http/configuration-router.js'

export interface HubServerOptions {
  store: HubStore
  vault: SecretVault
  runtime: CodyBotRuntime
  webDist?: string
  onConfigurationChanged?: () => void | Promise<void>
  onMessageRetry?: () => void | Promise<void>
  getSystemHealth?: () => SystemHealthRecord
  getDeploymentStatus?: () => DeploymentStatusRecord
  provisioning: FeishuProvisioningService
  skills: SkillSyncService
  copilot: CopilotService
  tasks: HubTaskService
  scheduled?: ScheduledTaskService
  mcpToken?: string
  mcpPrincipal?: string
}

export const createHubServer = ({ store, vault, runtime, webDist, onConfigurationChanged, onMessageRetry, getSystemHealth, getDeploymentStatus, provisioning, skills, copilot, tasks, scheduled, mcpToken = '', mcpPrincipal = 'mcp-client' }: HubServerOptions) => {
  const auth = new AuthService(store)
  const mcp = createMcpEndpoint(tasks, mcpToken, mcpPrincipal)

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      const method = request.method ?? 'GET'
      if (url.pathname === '/mcp') return await mcp.handle(request, response)
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          const origin = request.headers.origin
          const host = request.headers.host
          if (origin && host && new URL(origin).host !== host) throw new HttpError(403, 'Cross-origin write rejected')
        }
        if (method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, product: 'CodyBotHub', core: 'CodyWebCore' })
        if (method === 'GET' && url.pathname === '/api/deployment-status') return sendJson(response, 200, getDeploymentStatus?.() ?? null)
        if (method === 'GET' && url.pathname === '/api/auth/status') return sendJson(response, 200, auth.status(request))
        if (method === 'POST' && url.pathname === '/api/auth/setup') {
          const body = await readJson(request); await auth.setup(optional(body, 'loginName') || 'admin', optional(body, 'displayName') || '管理员', required(body, 'password'), request, response); return sendJson(response, 201, auth.status(request))
        }
        if (method === 'POST' && url.pathname === '/api/auth/login') {
          const body = await readJson(request); await auth.login(optional(body, 'loginName'), required(body, 'password'), request, response); return sendJson(response, 200, auth.status(request))
        }
        if (method === 'POST' && url.pathname === '/api/auth/logout') { auth.logout(request, response); return sendJson(response, 200, { ok: true }) }
        if (!auth.isAuthenticated(request)) throw new HttpError(401, 'Authentication required')
        const actor = auth.currentAccount(request)!
        const audit = (action: string, targetType: string, targetId: string, summary: string, details: Record<string, unknown> = {}) => store.createAuditLog({ actor, action, targetType, targetId, summary, details, ipAddress: requestIp(request) })

        if (await handleScheduledRoute({ request, response, url, method, actor, store, scheduled, audit })) return

        if (method === 'GET' && url.pathname === '/api/system-health') return sendJson(response, 200, getSystemHealth?.() ?? null)
        if (method === 'GET' && url.pathname === '/api/tasks/page') {
          const requestedStatus = url.searchParams.get('status') ?? ''
          const status = ['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled'].includes(requestedStatus) ? requestedStatus as HubTaskRecord['status'] : undefined
          return sendJson(response, 200, page(store.listHubTasks({ ...(status ? { status } : {}), ...(url.searchParams.get('origin') ? { origin: url.searchParams.get('origin')! } : {}), limit: 500 }), url))
        }
        const taskId = matchId(url.pathname, '/api/tasks/')
        if (taskId && method === 'GET') return sendJson(response, 200, store.getHubTask(taskId))

        if (await handleCopilotRoute({ request, response, url, method, actor, store, audit, copilot, onConfigurationChanged })) return

        if (await handleAdminRoute({ request, response, url, method, actor, store, audit, auth })) return

        if (await handleSkillRoute({ request, response, url, method, actor, store, audit, runtime, skills })) return

        if (await handleInsightsRoute({ request, response, url, method, actor, store, audit, onMessageRetry })) return
        if (await handleConfigurationRoute({ request, response, url, method, actor, store, audit, vault, runtime, provisioning, onConfigurationChanged })) return
        throw new HttpError(404, 'Route not found')
      }
      await serveWeb(url.pathname, response, webDist)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : messageStatus(error)
      sendJson(response, status, { error: error instanceof Error ? error.message : 'Unexpected error' })
    }
  })
  server.on('close', () => { void mcp.close() })
  return server
}

const requestIp = (request: IncomingMessage): string => {
  const forwarded = request.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  return value?.trim() || request.socket.remoteAddress || ''
}


const messageStatus = (error: unknown): number => {
  const message = error instanceof Error ? error.message : ''
  if (error instanceof Error && ['ZodError','RangeError'].includes(error.name)) return 400
  if (/定时任务不存在|执行记录不存在|工具执行请求不存在/u.test(message)) return 404
  if (/任务已有|任务尚未|当前执行|工作区|工具包|技能包|技能源|接收群|发送 Bot|执行间隔|执行时间|执行周期|请选择|Cron|同步模板/u.test(message) || message.startsWith('Git ')) return 400
  if (message.includes('UNIQUE constraint')) return 409
  if (message.includes('FOREIGN KEY constraint')) return 409
  if (message.includes('not found')) return 404
  if (message.includes('Invalid account or password')) return 401
  if (message.includes('Too many login')) return 429
  if (message.includes('required') || message.includes('must') || message.includes('still use') || message.includes('different Workspace') || message.includes('Cannot delete') || message.includes('contain') || message.includes('unavailable') || message.includes('unsupported') || message.includes('can be retried')) return 400
  return 500
}

const serveWeb = async (pathname: string, response: ServerResponse, webDist?: string): Promise<void> => {
  if (!webDist) throw new HttpError(404, 'CodyBotHub API is running')
  const clean = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
  let filename = path.resolve(webDist, clean)
  if (!filename.startsWith(path.resolve(webDist))) throw new HttpError(403, 'Invalid path')
  if (!existsSync(filename) || statSync(filename).isDirectory()) filename = path.join(webDist, 'index.html')
  const ext = path.extname(filename)
  response.setHeader('Content-Type', ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript; charset=utf-8' : ext === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream')
  response.end(await readFile(filename))
}
