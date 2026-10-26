import { existsSync, statSync } from 'node:fs'
import type { SecretVault } from '../crypto.js'
import type { FeishuProvisioningService, ProvisioningRequest } from '../provisioning.js'
import type { CodyBotRuntime } from '../runtime.js'
import { removeToolSource, syncToolSource } from '../tool-source.js'
import { bool, HttpError, matchId, number, optional, page, readJson, required, sendJson, type AuthenticatedRouteContext } from './common.js'
import { botMessagePolicy, runtimeKind, sceneInput, skillPackageInput, stringList, toolInput, toolPackageInput } from './input-parsers.js'

export const handleConfigurationRoute = async ({ request, response, url, method, store, audit, vault, runtime, provisioning, onConfigurationChanged }: AuthenticatedRouteContext & { vault: SecretVault; runtime: CodyBotRuntime; provisioning: FeishuProvisioningService; onConfigurationChanged: (() => void | Promise<void>) | undefined }): Promise<boolean> => {
  if (!/^\/api\/(settings|provisioning|workspaces|bots|scenes|skill-packages|tools|tool-packages|tool-package-executions)(?:\/|$)/u.test(url.pathname)) return false
  await (async () => {
        if (method === 'GET' && url.pathname === '/api/settings') return sendJson(response, 200, store.getPlatformSettings())
        if (method === 'PUT' && url.pathname === '/api/settings') {
          const body = await readJson(request)
          const input = { basePrompt: optional(body, 'basePrompt'), defaultModel: optional(body, 'defaultModel'), defaultReasoningEffort: optional(body, 'defaultReasoningEffort'), modelFallbackEnabled: bool(body.modelFallbackEnabled, true), threadProfileRefreshIntervalSeconds: number(body.threadProfileRefreshIntervalSeconds, 5), threadProfileBatchSize: number(body.threadProfileBatchSize, 20) }
          await runtime.validateModelSelection('codex', input.defaultModel, input.defaultReasoningEffort)
          const result = store.setPlatformSettings(input)
          audit('settings.update', 'settings', 'platform', '更新平台设置', { defaultModel: result.defaultModel, defaultReasoningEffort: result.defaultReasoningEffort, modelFallbackEnabled: result.modelFallbackEnabled, threadProfileRefreshIntervalSeconds: result.threadProfileRefreshIntervalSeconds, threadProfileBatchSize: result.threadProfileBatchSize })
          return sendJson(response, 200, result)
        }
        if (method === 'GET' && url.pathname === '/api/provisioning') return sendJson(response, 200, provisioning.list())
        if (method === 'POST' && url.pathname === '/api/provisioning') {
          const body = await readJson(request)
          const defaultWorkspaceId = required(body, 'defaultWorkspaceId')
          if (!store.listWorkspaces().some(item => item.id === defaultWorkspaceId)) throw new HttpError(400, 'Workspace not found')
          const kind = runtimeKind(body.runtimeKind)
          await runtime.validateModelSelection(kind, optional(body, 'model'), optional(body, 'reasoningEffort'))
          const input: ProvisioningRequest = { name: required(body, 'name'), description: optional(body, 'description'), prompt: optional(body, 'prompt'), permissions: stringList(body.permissions), operatorIds: stringList(body.operatorIds), conversationMode: body.conversationMode === 'topic' ? 'topic' : 'chat', botMessagePolicy: botMessagePolicy(body.botMessagePolicy), mentionSourceBot: bool(body.mentionSourceBot, true), botSourceAllowlist: stringList(body.botSourceAllowlist), maxBotReplyDepth: Math.max(0, Math.min(10, Math.trunc(number(body.maxBotReplyDepth, 1)))), runtimeKind: kind, model: optional(body, 'model'), reasoningEffort: optional(body, 'reasoningEffort'), defaultWorkspaceId, workspaceIds: stringList(body.workspaceIds) }
          const job = provisioning.start(input)
          audit('bot.provision', 'provisioning', job.id, `发起飞书 Bot 自动注册：${input.name}`)
          return sendJson(response, 202, job)
        }
        const provisioningId = matchId(url.pathname, '/api/provisioning/')
        if (provisioningId && method === 'GET') return sendJson(response, 200, provisioning.get(provisioningId))
        if (provisioningId && method === 'DELETE') {
          const job = provisioning.cancel(provisioningId)
          audit('bot.provision_cancel', 'provisioning', provisioningId, '取消飞书 Bot 自动注册')
          return sendJson(response, 200, job)
        }
        if (method === 'GET' && url.pathname === '/api/workspaces/page') return sendJson(response, 200, page(store.listWorkspaces(), url))
        if (method === 'GET' && url.pathname === '/api/workspaces') return sendJson(response, 200, store.listWorkspaces())
        if (method === 'POST' && url.pathname === '/api/workspaces') {
          const body = await readJson(request)
          const directory = required(body, 'path')
          if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new HttpError(400, 'Workspace path must be an existing local directory')
          const result = store.createWorkspace({ name: required(body, 'name'), path: directory, prompt: optional(body, 'prompt') })
          audit('workspace.create', 'workspace', result.id, `创建工作区 ${result.name}`, { path: result.path })
          return sendJson(response, 201, result)
        }
        const workspaceId = matchId(url.pathname, '/api/workspaces/')
        if (workspaceId && method === 'PUT') {
          const body = await readJson(request), directory = required(body, 'path')
          if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new HttpError(400, 'Workspace path must be an existing local directory')
          const result = store.updateWorkspace(workspaceId, { name: required(body, 'name'), path: directory, prompt: optional(body, 'prompt') })
          audit('workspace.update', 'workspace', result.id, `更新工作区 ${result.name}`, { path: result.path })
          return sendJson(response, 200, result)
        }
        if (workspaceId && method === 'DELETE') { const item = store.listWorkspaces().find(value => value.id === workspaceId); store.deleteWorkspace(workspaceId); audit('workspace.delete', 'workspace', workspaceId, `删除工作区 ${item?.name ?? workspaceId}`); response.statusCode = 204; return response.end() }

        if (method === 'GET' && url.pathname === '/api/bots/page') return sendJson(response, 200, page(store.listBots(), url))
        if (method === 'GET' && url.pathname === '/api/bots') return sendJson(response, 200, store.listBots())
        if (method === 'POST' && url.pathname === '/api/bots') {
          const body = await readJson(request), secret = optional(body, 'appSecret')
          const kind = runtimeKind(body.runtimeKind)
          await runtime.validateModelSelection(kind, optional(body, 'model'), optional(body, 'reasoningEffort'))
          const result = store.createBot({ name: required(body, 'name'), description: optional(body, 'description'), appId: optional(body, 'appId'), ...(secret ? { appSecretEncrypted: vault.encrypt(secret) } : {}), prompt: optional(body, 'prompt'), permissions: stringList(body.permissions), operatorIds: stringList(body.operatorIds), conversationMode: body.conversationMode === 'topic' ? 'topic' : 'chat', botMessagePolicy: botMessagePolicy(body.botMessagePolicy), mentionSourceBot: bool(body.mentionSourceBot, true), botSourceAllowlist: stringList(body.botSourceAllowlist), maxBotReplyDepth: Math.max(0, Math.min(10, Math.trunc(number(body.maxBotReplyDepth, 1)))), runtimeKind: kind, model: optional(body, 'model'), reasoningEffort: optional(body, 'reasoningEffort'), defaultWorkspaceId: required(body, 'defaultWorkspaceId'), workspaceIds: stringList(body.workspaceIds) })
          await onConfigurationChanged?.()
          audit('bot.create', 'bot', result.id, `创建飞书 Bot ${result.name}`, { appId: result.appId })
          return sendJson(response, 201, result)
        }
        const botId = matchId(url.pathname, '/api/bots/')
        if (botId && method === 'PUT') {
          const body = await readJson(request), secret = optional(body, 'appSecret')
          const kind = runtimeKind(body.runtimeKind)
          await runtime.validateModelSelection(kind, optional(body, 'model'), optional(body, 'reasoningEffort'))
          const result = store.updateBot(botId, { name: required(body, 'name'), description: optional(body, 'description'), appId: optional(body, 'appId'), ...(secret ? { appSecretEncrypted: vault.encrypt(secret) } : {}), prompt: optional(body, 'prompt'), permissions: stringList(body.permissions), operatorIds: stringList(body.operatorIds), conversationMode: body.conversationMode === 'topic' ? 'topic' : 'chat', botMessagePolicy: botMessagePolicy(body.botMessagePolicy), mentionSourceBot: bool(body.mentionSourceBot, true), botSourceAllowlist: stringList(body.botSourceAllowlist), maxBotReplyDepth: Math.max(0, Math.min(10, Math.trunc(number(body.maxBotReplyDepth, 1)))), runtimeKind: kind, model: optional(body, 'model'), reasoningEffort: optional(body, 'reasoningEffort'), defaultWorkspaceId: required(body, 'defaultWorkspaceId'), workspaceIds: stringList(body.workspaceIds) })
          await onConfigurationChanged?.()
          audit('bot.update', 'bot', result.id, `更新飞书 Bot ${result.name}`, { appId: result.appId, secretChanged: Boolean(secret) })
          return sendJson(response, 200, result)
        }
        if (botId && method === 'DELETE') { const item = store.listBots().find(value => value.id === botId); store.deleteBot(botId); await onConfigurationChanged?.(); audit('bot.delete', 'bot', botId, `删除飞书 Bot ${item?.name ?? botId}`); response.statusCode = 204; return response.end() }

        if (method === 'GET' && url.pathname === '/api/scenes/page') return sendJson(response, 200, page(store.listScenes(), url))
        if (method === 'GET' && url.pathname === '/api/scenes') return sendJson(response, 200, store.listScenes())
        if (method === 'POST' && url.pathname === '/api/scenes') {
          const body = await readJson(request)
          const bot = store.listBots().find(item => item.id === required(body, 'botId'))
          if (!bot) throw new HttpError(404, 'Bot not found')
          await runtime.validateModelSelection(bot.runtimeKind, optional(body, 'model'), optional(body, 'reasoningEffort'))
          const result = store.createScene(sceneInput(body))
          audit('scene.create', 'scene', result.id, `创建场景 ${result.name}`)
          return sendJson(response, 201, result)
        }
        const sceneId = matchId(url.pathname, '/api/scenes/')
        if (sceneId && method === 'PUT') { const body = await readJson(request); const bot = store.listBots().find(item => item.id === required(body, 'botId')); if (!bot) throw new HttpError(404, 'Bot not found'); await runtime.validateModelSelection(bot.runtimeKind, optional(body, 'model'), optional(body, 'reasoningEffort')); const result = store.updateScene(sceneId, sceneInput(body)); audit('scene.update', 'scene', result.id, `更新场景 ${result.name}`); return sendJson(response, 200, result) }
        if (sceneId && method === 'DELETE') { const item = store.listScenes().find(value => value.id === sceneId); store.deleteScene(sceneId); audit('scene.delete', 'scene', sceneId, `删除场景 ${item?.name ?? sceneId}`); response.statusCode = 204; return response.end() }

        if (method === 'GET' && url.pathname === '/api/skill-packages/page') return sendJson(response, 200, page(store.listSkillPackages(), url))
        if (method === 'GET' && url.pathname === '/api/skill-packages') return sendJson(response, 200, store.listSkillPackages())
        if (method === 'POST' && url.pathname === '/api/skill-packages') { const result = store.createSkillPackage(skillPackageInput(await readJson(request))); audit('skill_package.create', 'skill_package', result.id, `创建技能包 ${result.name}`); return sendJson(response, 201, result) }
        const packageId = matchId(url.pathname, '/api/skill-packages/')
        if (packageId && method === 'PUT') { const result = store.updateSkillPackage(packageId, skillPackageInput(await readJson(request))); audit('skill_package.update', 'skill_package', result.id, `更新技能包 ${result.name}`); return sendJson(response, 200, result) }
        if (packageId && method === 'DELETE') { const item = store.listSkillPackages().find(value => value.id === packageId); store.deleteSkillPackage(packageId); audit('skill_package.delete', 'skill_package', packageId, `删除技能包 ${item?.name ?? packageId}`); response.statusCode = 204; return response.end() }

        if (method === 'GET' && url.pathname === '/api/tools/page') return sendJson(response, 200, page(store.listTools(), url))
        if (method === 'GET' && url.pathname === '/api/tools') return sendJson(response, 200, store.listTools())
        if (method === 'POST' && url.pathname === '/api/tools') { const result = store.createTool(toolInput(await readJson(request))); syncToolSource(store, result); audit('tool.create', 'tool', result.id, `创建工具 ${result.name}`); return sendJson(response, 201, result) }
        const toolVersions = url.pathname.match(/^\/api\/tools\/([^/]+)\/versions$/u)
        if (toolVersions && method === 'GET') return sendJson(response, 200, store.listToolScriptVersions(decodeURIComponent(toolVersions[1]!)))
        const toolId = matchId(url.pathname, '/api/tools/')
        if (toolId && method === 'PUT') { const previous = store.getTool(toolId); const result = store.updateTool(toolId, toolInput(await readJson(request))); if (previous.workspaceId !== result.workspaceId) removeToolSource(store, previous); syncToolSource(store, result); audit('tool.update', 'tool', result.id, `更新工具 ${result.name}`); return sendJson(response, 200, result) }
        if (toolId && method === 'DELETE') { const item = store.getTool(toolId); store.deleteTool(toolId); removeToolSource(store, item); audit('tool.delete', 'tool', toolId, `删除工具 ${item.name}`); response.statusCode = 204; return response.end() }

        if (method === 'GET' && url.pathname === '/api/tool-packages/page') return sendJson(response, 200, page(store.listToolPackages(), url))
        if (method === 'GET' && url.pathname === '/api/tool-packages') return sendJson(response, 200, store.listToolPackages())
        if (method === 'GET' && url.pathname === '/api/tool-package-executions') return sendJson(response, 200, page(store.listToolPackageExecutions(500), url))
        if (method === 'POST' && url.pathname === '/api/tool-packages') { const result = store.createToolPackage(toolPackageInput(await readJson(request), store)); audit('tool_package.create', 'tool_package', result.id, `创建工具包 ${result.name}`); return sendJson(response, 201, result) }
        const toolPackageId = matchId(url.pathname, '/api/tool-packages/')
        if (toolPackageId && method === 'PUT') { const result = store.updateToolPackage(toolPackageId, toolPackageInput(await readJson(request), store)); audit('tool_package.update', 'tool_package', result.id, `更新工具包 ${result.name}`); return sendJson(response, 200, result) }
        if (toolPackageId && method === 'DELETE') { const item = store.listToolPackages().find(value => value.id === toolPackageId); store.deleteToolPackage(toolPackageId); audit('tool_package.delete', 'tool_package', toolPackageId, `删除工具包 ${item?.name ?? toolPackageId}`); response.statusCode = 204; return response.end() }
        throw new HttpError(404, 'Route not found')
  })()
  return true
}
