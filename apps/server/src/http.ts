import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { FEISHU_MESSAGE_TYPES } from '@codycodeagent/cody-web-core/feishu'
import { AuthService } from './auth.js'
import { SecretVault } from './crypto.js'
import { HubStore } from './db.js'
import type { SceneRecord, SkillPackageRecord } from './types.js'
import type { FeishuProvisioningService, ProvisioningRequest } from './provisioning.js'
import { listBrowsableDirectories } from './directories.js'
import type { CodyBotRuntime } from './runtime.js'

type Json = Record<string, unknown>

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(value))
}

const readJson = async (request: IncomingMessage): Promise<Json> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array)
    size += value.length
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body is too large')
    chunks.push(value)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json }
  catch { throw new HttpError(400, 'Invalid JSON body') }
}

const required = (body: Json, key: string): string => {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} is required`)
  return value.trim()
}
const optional = (body: Json, key: string): string => typeof body[key] === 'string' ? String(body[key]).trim() : ''
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []
const bool = (value: unknown, fallback = false): boolean => typeof value === 'boolean' ? value : fallback
const number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback

export interface HubServerOptions {
  store: HubStore
  vault: SecretVault
  runtime: CodyBotRuntime
  webDist?: string
  onConfigurationChanged?: () => void | Promise<void>
  provisioning: FeishuProvisioningService
}

export const createHubServer = ({ store, vault, runtime, webDist, onConfigurationChanged, provisioning }: HubServerOptions) => {
  const auth = new AuthService(store)

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      const method = request.method ?? 'GET'
      if (url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
          const origin = request.headers.origin
          const host = request.headers.host
          if (origin && host && new URL(origin).host !== host) throw new HttpError(403, 'Cross-origin write rejected')
        }
        if (method === 'GET' && url.pathname === '/api/health') return sendJson(response, 200, { ok: true, product: 'CodyBotHub', core: 'CodyWebCore' })
        if (method === 'GET' && url.pathname === '/api/auth/status') return sendJson(response, 200, auth.status(request))
        if (method === 'POST' && url.pathname === '/api/auth/setup') {
          const body = await readJson(request); await auth.setup(required(body, 'password'), request, response); return sendJson(response, 201, auth.status(request))
        }
        if (method === 'POST' && url.pathname === '/api/auth/login') {
          const body = await readJson(request); await auth.login(required(body, 'password'), request, response); return sendJson(response, 200, auth.status(request))
        }
        if (method === 'POST' && url.pathname === '/api/auth/logout') { auth.logout(request, response); return sendJson(response, 200, { ok: true }) }
        if (!auth.isAuthenticated(request)) throw new HttpError(401, 'Authentication required')

        if (method === 'GET' && url.pathname === '/api/filesystem/directories') {
          return sendJson(response, 200, listBrowsableDirectories(url.searchParams.get('path') ?? undefined))
        }
        if (method === 'GET' && url.pathname === '/api/feishu/message-types') {
          const labels: Record<(typeof FEISHU_MESSAGE_TYPES)[number], string> = { text: '文本', post: '富文本', image: '图片', file: '文件', audio: '音频', media: '视频', interactive: '消息卡片' }
          return sendJson(response, 200, FEISHU_MESSAGE_TYPES.map(value => ({ value, label: labels[value] })))
        }
        if (method === 'GET' && url.pathname === '/api/skills') {
          const workspace = store.listWorkspaces().find(item => item.id === url.searchParams.get('workspaceId'))
          if (!workspace) throw new HttpError(404, 'Workspace not found')
          return sendJson(response, 200, (await runtime.listSkills(workspace.path)).filter(skill => skill.enabled))
        }

        if (method === 'GET' && url.pathname === '/api/dashboard') return sendJson(response, 200, store.stats())
        if (method === 'GET' && url.pathname === '/api/settings') return sendJson(response, 200, { basePrompt: store.getPlatformPrompt() })
        if (method === 'PUT' && url.pathname === '/api/settings') {
          const body = await readJson(request)
          return sendJson(response, 200, { basePrompt: store.setPlatformPrompt(optional(body, 'basePrompt')) })
        }
        if (method === 'GET' && url.pathname === '/api/provisioning') return sendJson(response, 200, provisioning.list())
        if (method === 'POST' && url.pathname === '/api/provisioning') {
          const body = await readJson(request)
          const defaultWorkspaceId = required(body, 'defaultWorkspaceId')
          if (!store.listWorkspaces().some(item => item.id === defaultWorkspaceId)) throw new HttpError(400, 'Workspace not found')
          const input: ProvisioningRequest = { name: required(body, 'name'), description: optional(body, 'description'), prompt: optional(body, 'prompt'), permissions: stringList(body.permissions), operatorIds: stringList(body.operatorIds), replyMode: body.replyMode === 'topic' ? 'topic' : 'reply', defaultWorkspaceId, workspaceIds: stringList(body.workspaceIds) }
          return sendJson(response, 202, provisioning.start(input))
        }
        const provisioningId = matchId(url.pathname, '/api/provisioning/')
        if (provisioningId && method === 'GET') return sendJson(response, 200, provisioning.get(provisioningId))
        if (provisioningId && method === 'DELETE') return sendJson(response, 200, provisioning.cancel(provisioningId))
        if (method === 'GET' && url.pathname === '/api/workspaces') return sendJson(response, 200, store.listWorkspaces())
        if (method === 'POST' && url.pathname === '/api/workspaces') {
          const body = await readJson(request)
          const directory = required(body, 'path')
          if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new HttpError(400, 'Workspace path must be an existing local directory')
          return sendJson(response, 201, store.createWorkspace({ name: required(body, 'name'), path: directory, prompt: optional(body, 'prompt') }))
        }
        const workspaceId = matchId(url.pathname, '/api/workspaces/')
        if (workspaceId && method === 'PUT') {
          const body = await readJson(request), directory = required(body, 'path')
          if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new HttpError(400, 'Workspace path must be an existing local directory')
          return sendJson(response, 200, store.updateWorkspace(workspaceId, { name: required(body, 'name'), path: directory, prompt: optional(body, 'prompt') }))
        }
        if (workspaceId && method === 'DELETE') { store.deleteWorkspace(workspaceId); response.statusCode = 204; return response.end() }

        if (method === 'GET' && url.pathname === '/api/bots') return sendJson(response, 200, store.listBots())
        if (method === 'POST' && url.pathname === '/api/bots') {
          const body = await readJson(request), secret = optional(body, 'appSecret')
          const result = store.createBot({ name: required(body, 'name'), description: optional(body, 'description'), appId: optional(body, 'appId'), ...(secret ? { appSecretEncrypted: vault.encrypt(secret) } : {}), prompt: optional(body, 'prompt'), permissions: stringList(body.permissions), operatorIds: stringList(body.operatorIds), replyMode: body.replyMode === 'topic' ? 'topic' : 'reply', defaultWorkspaceId: required(body, 'defaultWorkspaceId'), workspaceIds: stringList(body.workspaceIds) })
          await onConfigurationChanged?.()
          return sendJson(response, 201, result)
        }
        const botId = matchId(url.pathname, '/api/bots/')
        if (botId && method === 'PUT') {
          const body = await readJson(request), secret = optional(body, 'appSecret')
          const result = store.updateBot(botId, { name: required(body, 'name'), description: optional(body, 'description'), appId: optional(body, 'appId'), ...(secret ? { appSecretEncrypted: vault.encrypt(secret) } : {}), prompt: optional(body, 'prompt'), permissions: stringList(body.permissions), operatorIds: stringList(body.operatorIds), replyMode: body.replyMode === 'topic' ? 'topic' : 'reply', defaultWorkspaceId: required(body, 'defaultWorkspaceId'), workspaceIds: stringList(body.workspaceIds) })
          await onConfigurationChanged?.()
          return sendJson(response, 200, result)
        }
        if (botId && method === 'DELETE') { store.deleteBot(botId); await onConfigurationChanged?.(); response.statusCode = 204; return response.end() }

        if (method === 'GET' && url.pathname === '/api/scenes') return sendJson(response, 200, store.listScenes())
        if (method === 'POST' && url.pathname === '/api/scenes') {
          const body = await readJson(request)
          return sendJson(response, 201, store.createScene(sceneInput(body)))
        }
        const sceneId = matchId(url.pathname, '/api/scenes/')
        if (sceneId && method === 'PUT') return sendJson(response, 200, store.updateScene(sceneId, sceneInput(await readJson(request))))
        if (sceneId && method === 'DELETE') { store.deleteScene(sceneId); response.statusCode = 204; return response.end() }

        if (method === 'GET' && url.pathname === '/api/skill-packages') return sendJson(response, 200, store.listSkillPackages())
        if (method === 'POST' && url.pathname === '/api/skill-packages') return sendJson(response, 201, store.createSkillPackage(skillPackageInput(await readJson(request))))
        const packageId = matchId(url.pathname, '/api/skill-packages/')
        if (packageId && method === 'PUT') return sendJson(response, 200, store.updateSkillPackage(packageId, skillPackageInput(await readJson(request))))
        if (packageId && method === 'DELETE') { store.deleteSkillPackage(packageId); response.statusCode = 204; return response.end() }
        throw new HttpError(404, 'Route not found')
      }
      await serveWeb(url.pathname, response, webDist)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : messageStatus(error)
      sendJson(response, status, { error: error instanceof Error ? error.message : 'Unexpected error' })
    }
  })
}

const matchId = (pathname: string, prefix: string): string | null => {
  if (!pathname.startsWith(prefix)) return null
  const value = pathname.slice(prefix.length)
  return value && !value.includes('/') ? decodeURIComponent(value) : null
}

const sceneInput = (body: Json): Omit<SceneRecord, 'id' | 'createdAt' | 'updatedAt'> & { skillPackageIds: string[] } => {
  const matcher = (body.matcher && typeof body.matcher === 'object' ? body.matcher : {}) as Json
  const replyMode = ['reply', 'topic'].includes(String(body.replyMode)) ? String(body.replyMode) as 'reply' | 'topic' : 'inherit'
  const supportedMessageTypes = new Set<string>(FEISHU_MESSAGE_TYPES)
  return { botId: required(body, 'botId'), workspaceId: required(body, 'workspaceId'), name: required(body, 'name'), prompt: optional(body, 'prompt'), priority: number(body.priority, 100), replyMode, enabled: bool(body.enabled, true), matcher: { chatIds: stringList(matcher.chatIds), messageTypes: stringList(matcher.messageTypes).filter(value => supportedMessageTypes.has(value)), textIncludes: stringList(matcher.textIncludes), cardTitleIncludes: stringList(matcher.cardTitleIncludes) }, skillPackageIds: stringList(body.skillPackageIds) }
}

const skillPackageInput = (body: Json): Omit<SkillPackageRecord, 'id' | 'createdAt' | 'updatedAt'> => ({
  workspaceId: required(body, 'workspaceId'), name: required(body, 'name'), description: optional(body, 'description'), prompt: optional(body, 'prompt'), skills: stringList(body.skills), fallbackMode: ['mixed', 'package_only'].includes(String(body.fallbackMode)) ? String(body.fallbackMode) as 'mixed' | 'package_only' : 'package_first',
})

const messageStatus = (error: unknown): number => {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('UNIQUE constraint')) return 409
  if (message.includes('FOREIGN KEY constraint')) return 409
  if (message.includes('not found')) return 404
  if (message.includes('Invalid password')) return 401
  if (message.includes('Too many login')) return 429
  if (message.includes('required') || message.includes('must') || message.includes('still use') || message.includes('different Workspace')) return 400
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
