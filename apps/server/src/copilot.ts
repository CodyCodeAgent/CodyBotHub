import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HubStore } from './db.js'
import type { CodyBotRuntime } from './runtime.js'
import { syncToolSource } from './tool-source.js'
import type { AdminAccountRecord, CopilotMessageRecord, CopilotProposalRecord, CopilotSessionRecord, ToolScriptLanguage } from './types.js'

const execFileAsync = promisify(execFile)
type Json = Record<string, unknown>

export type CopilotToolCall = {
  tool: string
  arguments: Json
  sessionId: string
  accountId: string
  workspaceId: string
}

export type CopilotApplyResult = {
  proposal: CopilotProposalRecord
  target: { type: 'tool' | 'bot'; id: string; name: string }
}

const objectValue = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const stringValue = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []

export class CopilotService {
  constructor(private readonly store: HubStore, private readonly runtime: CodyBotRuntime) {}

  session(accountId: string, workspaceId: string): { session: CopilotSessionRecord; messages: CopilotMessageRecord[]; proposals: CopilotProposalRecord[] } {
    const session = this.store.getOrCreateCopilotSession(accountId, workspaceId)
    return { session, messages: this.store.listCopilotMessages(session.id, accountId), proposals: this.store.listCopilotProposals(session.id, accountId) }
  }

  reset(sessionId: string, accountId: string): { session: CopilotSessionRecord; messages: CopilotMessageRecord[]; proposals: CopilotProposalRecord[] } {
    this.runtime.resetCopilotSession(sessionId)
    const session = this.store.resetCopilotSession(sessionId, accountId)
    return { session, messages: [], proposals: [] }
  }

  async ask(sessionId: string, account: AdminAccountRecord, content: string, onProgress?: (value: string) => void): Promise<{ session: CopilotSessionRecord; messages: CopilotMessageRecord[]; proposals: CopilotProposalRecord[] }> {
    if (!content.trim() || content.trim().length > 20_000) throw new Error('Copilot message must contain 1-20000 characters')
    let session = this.store.getCopilotSession(sessionId, account.id)
    const workspace = this.store.getWorkspace(session.workspaceId)
    this.store.addCopilotMessage(session.id, 'user', content.trim())
    const answer = await this.runtime.executeCopilot({
      sessionId: session.id,
      coreThreadId: session.coreThreadId,
      accountId: account.id,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      workspaceName: workspace.name,
      content: content.trim(),
      platformContext: this.platformContext(),
      ...(onProgress ? { onProgress } : {}),
      onThreadResolved: threadId => { session = this.store.setCopilotCoreThread(session.id, threadId) },
    })
    this.store.addCopilotMessage(session.id, 'assistant', answer)
    return { session: this.store.getCopilotSession(session.id, account.id), messages: this.store.listCopilotMessages(session.id, account.id), proposals: this.store.listCopilotProposals(session.id, account.id) }
  }

  async invokeTool(call: CopilotToolCall): Promise<Json> {
    const session = this.store.getCopilotSession(call.sessionId, call.accountId)
    if (session.workspaceId !== call.workspaceId) throw new Error('Copilot Workspace context changed')
    if (call.tool === 'inspect_platform') return this.inspectPlatform(stringValue(call.arguments.resource), stringValue(call.arguments.query))
    if (call.tool === 'search_feishu_user') return this.searchFeishuUser(stringValue(call.arguments.query))
    if (call.tool === 'propose_managed_script') return this.proposeManagedScript(call, session)
    if (call.tool === 'propose_bot_operator') return this.proposeBotOperator(call, session)
    throw new Error(`Unknown admin Copilot tool: ${call.tool}`)
  }

  applyProposal(id: string, account: AdminAccountRecord): CopilotApplyResult {
    const proposal = this.store.getCopilotProposal(id, account.id)
    if (proposal.status !== 'draft') throw new Error(`Copilot proposal is already ${proposal.status}`)
    const session = this.store.getCopilotSession(proposal.sessionId, account.id)
    if (proposal.kind === 'bot_operator') return this.applyBotOperator(proposal, session, account)
    const payload = proposal.payload
    const language = stringValue(payload.language) as ToolScriptLanguage
    if (!['python', 'shell', 'node'].includes(language)) throw new Error('Unsupported script language')
    const scriptContent = typeof payload.scriptContent === 'string' ? payload.scriptContent : ''
    if (!scriptContent.trim()) throw new Error('Managed script content is empty')
    const tool = this.store.createTool({
      workspaceId: session.workspaceId,
      name: stringValue(payload.name),
      description: stringValue(payload.description),
      executorType: 'command', command: '', argumentsTemplate: stringList(payload.argumentsTemplate),
      inputSchema: objectValue(payload.inputSchema), rpcConfig: { service: '', method: '', vregion: '', environment: 'prod', cluster: 'default', requestTemplate: {} },
      scriptLanguage: language, scriptContent, timeoutSeconds: Math.min(900, Math.max(1, Number(payload.timeoutSeconds) || 60)), enabled: true,
    })
    try { syncToolSource(this.store, tool) }
    catch (error) { this.store.deleteTool(tool.id); throw error }
    return {
      proposal: this.store.finishCopilotProposal(id, account.id, 'applied', { targetType: 'tool', targetId: tool.id, targetName: tool.name }),
      target: { type: 'tool', id: tool.id, name: tool.name },
    }
  }

  dismissProposal(id: string, accountId: string): CopilotProposalRecord { return this.store.finishCopilotProposal(id, accountId, 'dismissed') }

  private platformContext(): string {
    const settings = this.store.getPlatformSettings()
    return JSON.stringify({
      counts: { workspaces: this.store.listWorkspaces().length, bots: this.store.listBots().length, scenes: this.store.listScenes().length, skillPackages: this.store.listSkillPackages().length, tools: this.store.listTools().length, toolPackages: this.store.listToolPackages().length },
      platformModel: settings.defaultModel || 'Codex default',
      workspaces: this.store.listWorkspaces().map(item => ({ id: item.id, name: item.name })),
    })
  }

  private inspectPlatform(resource: string, query: string): Json {
    const normalized = query.toLocaleLowerCase()
    const filter = <T extends { name: string }>(items: T[]) => items.filter(item => !normalized || item.name.toLocaleLowerCase().includes(normalized))
    const all = {
      workspaces: this.store.listWorkspaces().map(item => ({ id: item.id, name: item.name, path: item.path })),
      bots: filter(this.store.listBots()).map(item => ({ id: item.id, name: item.name, runtimeKind: item.runtimeKind, model: item.model, workspaceIds: item.workspaceIds, operatorIds: item.operatorIds })),
      scenes: filter(this.store.listScenes()).map(item => ({ id: item.id, name: item.name, botId: item.botId, workspaceId: item.workspaceId, enabled: item.enabled })),
      skillPackages: filter(this.store.listSkillPackages()).map(item => ({ id: item.id, name: item.name, workspaceId: item.workspaceId, skills: item.skills, toolPackageIds: item.toolPackageIds })),
      tools: filter(this.store.listTools()).map(item => ({ id: item.id, name: item.name, workspaceId: item.workspaceId, executorType: item.executorType, scriptLanguage: item.scriptLanguage, enabled: item.enabled })),
      toolPackages: filter(this.store.listToolPackages()).map(item => ({ id: item.id, name: item.name, workspaceId: item.workspaceId, approvalRequired: item.approvalRequired, enabled: item.enabled, steps: item.steps.map(step => ({ phase: step.phase, toolId: step.toolId, toolName: step.toolName })) })),
    }
    if (resource && resource !== 'all' && resource in all) return { resource, items: all[resource as keyof typeof all] }
    return all
  }

  private async searchFeishuUser(query: string): Promise<Json> {
    if (!query || query.length > 80) throw new Error('A Feishu name or email with 1-80 characters is required')
    try {
      const { stdout } = await execFileAsync('lark-cli', ['contact', '+search-user', '--query', query, '--exclude-external-users', '--as', 'user', '--format', 'json'], { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 })
      const value = JSON.parse(stdout) as { data?: { users?: Array<Record<string, unknown>>; has_more?: boolean } }
      return { query, users: (value.data?.users ?? []).slice(0, 20).map(item => ({ openId: item.open_id, name: item.localized_name, enterpriseEmail: item.enterprise_email, department: item.department, activated: item.is_activated, hasChatted: item.has_chatted })), hasMore: Boolean(value.data?.has_more) }
    } catch (error) {
      return { query, users: [], unavailable: true, error: error instanceof Error ? error.message.slice(0, 500) : String(error) }
    }
  }

  private proposeManagedScript(call: CopilotToolCall, session: CopilotSessionRecord): Json {
    const name = stringValue(call.arguments.name), language = stringValue(call.arguments.language), scriptContent = typeof call.arguments.scriptContent === 'string' ? call.arguments.scriptContent : ''
    if (!name || name.length > 120) throw new Error('Tool name must contain 1-120 characters')
    if (!['python', 'shell', 'node'].includes(language)) throw new Error('language must be python, shell, or node')
    if (!scriptContent.trim() || scriptContent.length > 200_000) throw new Error('scriptContent must contain 1-200000 characters')
    const proposal = this.store.createCopilotProposal(session.id, 'managed_script', `创建托管脚本：${name}`, {
      name, description: stringValue(call.arguments.description), language, scriptContent,
      argumentsTemplate: stringList(call.arguments.argumentsTemplate), inputSchema: objectValue(call.arguments.inputSchema),
      timeoutSeconds: Math.min(900, Math.max(1, Number(call.arguments.timeoutSeconds) || 60)), workspaceId: session.workspaceId,
    })
    return { status: 'draft', proposalId: proposal.id, title: proposal.title, message: '草稿已生成，等待管理员在 CodyBotHub Copilot 面板确认后保存。' }
  }

  private proposeBotOperator(call: CopilotToolCall, session: CopilotSessionRecord): Json {
    const botId = stringValue(call.arguments.botId), openId = stringValue(call.arguments.openId), personName = stringValue(call.arguments.personName)
    const action = stringValue(call.arguments.action)
    if (!/^ou_[A-Za-z0-9]+$/u.test(openId)) throw new Error('A valid Feishu ou_ Open ID is required')
    if (!['add', 'remove'].includes(action)) throw new Error('action must be add or remove')
    const bot = this.store.listBots().find(item => item.id === botId)
    if (!bot) throw new Error('Bot not found')
    if (!bot.workspaceIds.includes(session.workspaceId)) throw new Error('The Bot does not belong to the current Copilot Workspace')
    const alreadyIncluded = bot.operatorIds.includes(openId)
    if (action === 'add' && alreadyIncluded) throw new Error(`${openId} is already an operator of ${bot.name}`)
    if (action === 'remove' && !alreadyIncluded) throw new Error(`${openId} is not an operator of ${bot.name}`)
    const display = personName || openId
    const proposal = this.store.createCopilotProposal(session.id, 'bot_operator', `${action === 'add' ? '添加' : '移除'} Bot 操作人：${bot.name} · ${display}`, {
      action, botId: bot.id, botName: bot.name, openId, personName, workspaceId: session.workspaceId,
    })
    return { status: 'draft', proposalId: proposal.id, title: proposal.title, message: '配置草稿已生成，等待管理员在 CodyBotHub Copilot 面板确认后生效。' }
  }

  private applyBotOperator(proposal: CopilotProposalRecord, session: CopilotSessionRecord, account: AdminAccountRecord): CopilotApplyResult {
    const botId = stringValue(proposal.payload.botId), openId = stringValue(proposal.payload.openId), action = stringValue(proposal.payload.action)
    if (!/^ou_[A-Za-z0-9]+$/u.test(openId) || !['add', 'remove'].includes(action)) throw new Error('Invalid Bot operator proposal')
    const bot = this.store.listBots().find(item => item.id === botId)
    if (!bot) throw new Error('Bot not found')
    if (!bot.workspaceIds.includes(session.workspaceId)) throw new Error('The Bot no longer belongs to the proposal Workspace')
    const operatorIds = action === 'add' ? [...new Set([...bot.operatorIds, openId])] : bot.operatorIds.filter(item => item !== openId)
    const updated = this.store.updateBot(bot.id, {
      name: bot.name, description: bot.description, appId: bot.appId, prompt: bot.prompt, permissions: bot.permissions, operatorIds,
      conversationMode: bot.conversationMode, runtimeKind: bot.runtimeKind, model: bot.model, reasoningEffort: bot.reasoningEffort,
      defaultWorkspaceId: bot.defaultWorkspaceId, workspaceIds: bot.workspaceIds,
    })
    return {
      proposal: this.store.finishCopilotProposal(proposal.id, account.id, 'applied', { targetType: 'bot', targetId: updated.id, targetName: updated.name, action, openId }),
      target: { type: 'bot', id: updated.id, name: updated.name },
    }
  }
}
