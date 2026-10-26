import { FEISHU_MESSAGE_TYPES } from '@codycodeagent/cody-web-core/feishu'
import type { AgentRuntimeKind, BotMessagePolicy, SceneRecord, SkillPackageRecord, ToolPackageRecord, ToolRecord } from '../types.js'
import type { HubStore } from '../db.js'
import { HttpError, bool, number, optional, required, type Json } from './common.js'

export const rawString = (body: Json, key: string): string => typeof body[key] === 'string' ? String(body[key]) : ''
export const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []
export const runtimeKind = (value: unknown): AgentRuntimeKind => value === 'traex' ? 'traex' : 'codex'
export const botMessagePolicy = (value: unknown): BotMessagePolicy => value === 'reject' || value === 'mentioned' ? value : 'mentioned_or_scene'

const sceneTimeoutInput = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 35791) throw new HttpError(400, '任务超时必须为 1–35791 分钟的整数')
  return value
}
export const sceneInput = (body: Json): Omit<SceneRecord, 'id' | 'createdAt' | 'updatedAt' | 'requireMention' | 'turnTimeoutMinutes'> & { skillPackageIds: string[]; requireMention?: boolean; turnTimeoutMinutes?: number } => {
  const matcher = (body.matcher && typeof body.matcher === 'object' ? body.matcher : {}) as Json
  const retrieval = (body.retrieval && typeof body.retrieval === 'object' ? body.retrieval : {}) as Json
  const skillBoosts = (Array.isArray(retrieval.skillBoosts) ? retrieval.skillBoosts : []).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const value = item as Json
    const keyword = optional(value, 'keyword').trim()
    const weight = Math.min(100, Math.max(0, number(value.weight, 0)))
    return keyword && weight > 0 ? [{ keyword, weight }] : []
  })
  const supportedMessageTypes = new Set<string>(FEISHU_MESSAGE_TYPES)
  return { ...(body.turnTimeoutMinutes === undefined ? {} : { turnTimeoutMinutes: sceneTimeoutInput(body.turnTimeoutMinutes) }), ...(body.requireMention === undefined ? {} : { requireMention: bool(body.requireMention, true) }), completionStatisticsEnabled: bool(body.completionStatisticsEnabled, false), botId: required(body, 'botId'), workspaceId: required(body, 'workspaceId'), name: required(body, 'name'), prompt: optional(body, 'prompt'), priority: number(body.priority, 100), enabled: bool(body.enabled, true), model: optional(body, 'model'), reasoningEffort: optional(body, 'reasoningEffort'), retrieval: { skillBoosts, skillCandidateLimit: number(retrieval.skillCandidateLimit, 12), knowledgeCandidateLimit: number(retrieval.knowledgeCandidateLimit, 12), minimumScore: number(retrieval.minimumScore, 1) }, matcher: { chatIds: stringList(matcher.chatIds), messageTypes: stringList(matcher.messageTypes).filter(value => supportedMessageTypes.has(value)), textIncludes: stringList(matcher.textIncludes), cardTitleIncludes: stringList(matcher.cardTitleIncludes) }, skillPackageIds: stringList(body.skillPackageIds) }
}

export const skillPackageInput = (body: Json): Omit<SkillPackageRecord, 'id' | 'createdAt' | 'updatedAt'> => ({
  workspaceId: required(body, 'workspaceId'), name: required(body, 'name'), description: optional(body, 'description'), prompt: optional(body, 'prompt'), skills: stringList(body.skills), toolPackageIds: stringList(body.toolPackageIds), fallbackMode: ['mixed', 'package_only'].includes(String(body.fallbackMode)) ? String(body.fallbackMode) as 'mixed' | 'package_only' : 'package_first',
})

const objectValue = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const toolInput = (body: Json): Omit<ToolRecord, 'id' | 'createdAt' | 'updatedAt' | 'scriptVersion'> => {
  const requestedType = String(body.executorType ?? 'bits_rpc')
  const executorType: ToolRecord['executorType'] = requestedType === 'bits_rpc' ? 'bits_rpc' : 'command'
  const rpc = objectValue(body.rpcConfig), requestTemplate = objectValue(rpc.requestTemplate)
  const rpcConfig: ToolRecord['rpcConfig'] = {
    service: optional(rpc, 'service'), method: optional(rpc, 'method'), vregion: optional(rpc, 'vregion'),
    environment: optional(rpc, 'environment') || 'prod', cluster: optional(rpc, 'cluster') || 'default', requestTemplate,
  }
  if (executorType === 'bits_rpc' && (!rpcConfig.service || !rpcConfig.method)) throw new HttpError(400, 'Bits RPC service and method are required')
  const language: ToolRecord['scriptLanguage'] = body.scriptLanguage === 'shell' || body.scriptLanguage === 'node' ? body.scriptLanguage : 'python'
  const scriptContent = requestedType === 'script' ? rawString(body, 'scriptContent') : ''
  if (requestedType === 'script' && !scriptContent.trim()) throw new HttpError(400, 'Script content is required')
  const command = executorType === 'bits_rpc' ? (optional(body, 'command') || 'gdpa-cli') : requestedType === 'script' ? '' : required(body, 'command')
  return { workspaceId: required(body, 'workspaceId'), name: required(body, 'name'), description: optional(body, 'description'), executorType, command, argumentsTemplate: stringList(body.argumentsTemplate), inputSchema: objectValue(body.inputSchema), rpcConfig, scriptLanguage: scriptContent ? language : '', scriptContent, timeoutSeconds: Math.min(900, Math.max(1, number(body.timeoutSeconds, 60))), enabled: bool(body.enabled, true) }
}
export const toolPackageInput = (body: Json, store: HubStore): Omit<ToolPackageRecord, 'id' | 'createdAt' | 'updatedAt'> => {
  const workspaceId = required(body, 'workspaceId'), tools = new Map(store.listTools().map(item => [item.id, item]))
  const steps = (Array.isArray(body.steps) ? body.steps : []).flatMap((value, position) => {
    const row = objectValue(value), toolId = optional(row, 'toolId'), tool = tools.get(toolId)
    if (!tool) return []
    if (tool.workspaceId !== workspaceId) throw new HttpError(400, 'Tool Package and Tool must use the same Workspace')
    const phase: 'precheck' | 'execute' | 'verify' = row.phase === 'precheck' || row.phase === 'verify' ? row.phase : 'execute'
    return [{ toolId, toolName: tool.name, phase, position, arguments: objectValue(row.arguments) }]
  })
  return { workspaceId, name: required(body, 'name'), description: optional(body, 'description'), prompt: optional(body, 'prompt'), approvalRequired: bool(body.approvalRequired, true), approverIds: stringList(body.approverIds), cardTitle: optional(body, 'cardTitle'), cardDescription: optional(body, 'cardDescription'), enabled: bool(body.enabled, true), steps }
}

export const skillSourceInput = (body: Json) => ({
  name: required(body, 'name'), repositoryUrl: required(body, 'repositoryUrl'), branch: optional(body, 'branch') || 'main', workspaceId: required(body, 'workspaceId'),
  skillRoots: stringList(body.skillRoots).length ? stringList(body.skillRoots) : ['skills', '.codex/skills', '.agents/skills'], knowledgeRoots: stringList(body.knowledgeRoots), autoInstall: bool(body.autoInstall),
})
