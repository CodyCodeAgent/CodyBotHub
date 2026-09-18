import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HubStore } from '../src/db.js'

const workspace = (store: HubStore, name = 'Workspace') => store.createWorkspace({ name, path: `/tmp/${name.toLowerCase().replaceAll(' ', '-')}` })

describe('HubStore invariants', () => {
  it('migrates the legacy administrator and keeps existing sessions authenticated', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'codybothub-auth-'))
    const filename = path.join(directory, 'hub.sqlite')
    const legacy = new DatabaseSync(filename)
    legacy.exec(`
      CREATE TABLE admin_credentials (id INTEGER PRIMARY KEY, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO admin_credentials VALUES (1, 'legacy-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO auth_sessions VALUES ('legacy-token', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `)
    legacy.close()
    const store = new HubStore(filename)
    expect(store.listAdminAccounts()).toMatchObject([{ id: 'legacy-admin', loginName: 'admin', displayName: '管理员', primary: true }])
    expect(store.getSessionAccount('legacy-token')).toMatchObject({ id: 'legacy-admin' })
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('manages administrator accounts, sessions, and immutable audit snapshots', () => {
    const store = new HubStore(':memory:')
    const first = store.createAdminAccount({ loginName: 'admin', displayName: '平台管理员', passwordHash: 'hash-1' })
    const second = store.createAdminAccount({ loginName: 'operator', displayName: '运营同学', passwordHash: 'hash-2' })
    expect(first.primary).toBe(true)
    expect(second.primary).toBe(false)
    store.createSession('token-2', second.id, '2099-01-01T00:00:00.000Z')
    expect(store.getSessionAccount('token-2')).toMatchObject({ loginName: 'operator' })
    store.createAuditLog({ actor: second, action: 'scene.update', targetType: 'scene', targetId: 'scene-1', summary: '更新场景' })
    store.deleteAdminAccount(second.id)
    expect(store.getSessionAccount('token-2')).toBeNull()
    expect(store.listAuditLogs({ query: '运营同学' })).toMatchObject({ total: 1, items: [{ actorAccountId: second.id, actorLoginName: 'operator' }] })
    store.updateAdminAccount(first.id, { loginName: 'renamed-admin', displayName: '平台管理员' })
    expect(() => store.deleteAdminAccount(first.id)).toThrow('primary administrator')
    store.close()
  })

  it('requires the Bot default Workspace to be attached', () => {
    const store = new HubStore(':memory:')
    const primary = workspace(store, 'Primary')
    const secondary = workspace(store, 'Secondary')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: primary.id, workspaceIds: [secondary.id] })
    expect(bot.workspaceIds).toEqual(expect.arrayContaining([primary.id, secondary.id]))
    expect(bot.defaultWorkspaceId).toBe(primary.id)
    store.close()
  })

  it('rejects a Scene Workspace outside its Bot', () => {
    const store = new HubStore(':memory:')
    const attached = workspace(store, 'Attached')
    const detached = workspace(store, 'Detached')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: attached.id })
    expect(() => store.createScene({ botId: bot.id, workspaceId: detached.id, name: 'Wrong workspace', prompt: '', priority: 100, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })).toThrow('Scene Workspace must be attached to its Bot')
    store.close()
  })

  it('rejects Skill Packages from a different Workspace', () => {
    const store = new HubStore(':memory:')
    const first = workspace(store, 'First')
    const second = workspace(store, 'Second')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: first.id })
    const skillPackage = store.createSkillPackage({ workspaceId: second.id, name: 'Foreign package', description: '', prompt: '', skills: ['test'], fallbackMode: 'package_first' })
    expect(() => store.createScene({ botId: bot.id, workspaceId: first.id, name: 'Scene', prompt: '', priority: 100, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] }, skillPackageIds: [skillPackage.id] })).toThrow('Scene and Skill Package must use the same Workspace')
    store.close()
  })

  it('prevents deleting a Workspace that remains in use', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Linked')
    store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id })
    expect(() => store.deleteWorkspace(linked.id)).toThrow('Workspace is still used')
    store.close()
  })

  it('matches the lowest-priority Scene and composes Prompt layers in order', () => {
    const store = new HubStore(':memory:')
    store.setPlatformPrompt('platform')
    const linked = store.createWorkspace({ name: 'Linked', path: '/tmp', prompt: 'workspace' })
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id, prompt: 'bot', conversationMode: 'topic' })
    const skillPackage = store.createSkillPackage({ workspaceId: linked.id, name: 'Package', description: '', prompt: 'package', skills: ['report'], fallbackMode: 'package_first' })
    store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Fallback', prompt: 'fallback', priority: 200, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
    const selected = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Alert', prompt: 'scene', priority: 10, enabled: true, retrieval: { skillBoosts: [{ keyword: 'Argos', weight: 20 }], skillCandidateLimit: 8, knowledgeCandidateLimit: 6, minimumScore: 2 }, matcher: { chatIds: ['oc_1'], messageTypes: ['interactive'], textIncludes: [], cardTitleIncludes: ['P0'] }, skillPackageIds: [skillPackage.id] })
    const route = store.resolveRoute(bot.id, {
      provider: 'feishu', accountId: bot.id, eventId: 'event-1', messageId: 'message-1',
      conversation: { id: 'oc_1', scope: 'group' }, sender: { id: 'ou_1', type: 'user' },
      content: { type: 'interactive', title: 'P0 发布失败' }, text: 'P0 发布失败', attachments: [],
      addressedToAgent: false, mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    })
    expect(route.scene?.id).toBe(selected.id)
    expect(route.scene?.retrieval).toEqual({ skillBoosts: [{ keyword: 'Argos', weight: 20 }], skillCandidateLimit: 8, knowledgeCandidateLimit: 6, minimumScore: 2 })
    expect(route.conversationMode).toBe('topic')
    expect(route.replyInTopic).toBe(true)
    expect(route.conversationKey).toBe(`bot:${bot.id}:chat:oc_1:topic:message-1`)
    expect(route.turnInstructions).toContain('platform\n\nworkspace\n\nbot\n\nscene\n\npackage')
    store.close()
  })

  it('lets an authorized card action bind a group to a reusable Scene', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Group binding')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id })
    const scene = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Chosen', prompt: '', priority: 100, enabled: true, matcher: { chatIds: ['another-chat'], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
    store.bindGroupScene(bot.id, 'oc_target', scene.id, 'ou_admin')
    const route = store.resolveRoute(bot.id, {
      provider: 'feishu', accountId: bot.id, eventId: 'event-2', messageId: 'message-2',
      conversation: { id: 'oc_target', scope: 'group' }, sender: { id: 'ou_1', type: 'user' },
      content: { type: 'text' }, text: 'hello', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    })
    expect(route.scene?.id).toBe(scene.id)
    store.close()
  })

  it('inherits the original Scene for addressed follow-ups in the same topic', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Topic inheritance')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id, conversationMode: 'topic' })
    const fallback = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Group fallback', prompt: '', priority: 200, enabled: true, matcher: { chatIds: ['another-chat'], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
    const alert = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Alert', prompt: '', priority: 10, enabled: true, matcher: { chatIds: ['oc_alert'], messageTypes: ['interactive', 'text'], textIncludes: [], cardTitleIncludes: ['Argos-CRITICAL'] } })
    const initial = {
      provider: 'feishu' as const, accountId: bot.id, eventId: 'event-alert', messageId: 'om_alert',
      conversation: { id: 'oc_alert', scope: 'group' as const }, sender: { id: 'app-alert', type: 'app' as const },
      content: { type: 'interactive', title: 'Argos-CRITICAL service error' }, text: 'critical alert', attachments: [], addressedToAgent: false,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const initialRoute = store.resolveRoute(bot.id, initial)
    expect(initialRoute).toMatchObject({ scene: { id: alert.id }, routeSource: 'matcher' })
    store.rememberTopicRoute(bot.id, 'oc_alert', initial.messageId, alert.id)
    store.bindGroupScene(bot.id, 'oc_alert', fallback.id, 'ou_admin')
    const followUp = {
      ...initial, eventId: 'event-follow-up', messageId: 'om_follow_up',
      conversation: { id: 'oc_alert', scope: 'topic' as const, rootId: initial.messageId },
      sender: { id: 'ou_user', type: 'user' as const }, content: { type: 'text' }, text: '只是 PPE base 是吧', addressedToAgent: true,
    }
    const inherited = store.resolveRoute(bot.id, followUp)
    expect(inherited).toMatchObject({ scene: { id: alert.id }, routeSource: 'topic_context', conversationKey: initialRoute.conversationKey })
    const unrelated = store.resolveRoute(bot.id, { ...followUp, conversation: { ...followUp.conversation, rootId: 'om_other_topic' } })
    expect(unrelated).toMatchObject({ scene: { id: fallback.id }, routeSource: 'group_binding' })
    store.close()
  })

  it('keeps Thread identity independent from the matched Scene in chat mode', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Scene independent')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id, conversationMode: 'chat' })
    const first = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'First', prompt: '', priority: 10, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: ['alpha'], cardTitleIncludes: [] } })
    const second = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Second', prompt: '', priority: 20, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: ['beta'], cardTitleIncludes: [] } })
    const message = {
      provider: 'feishu' as const, accountId: bot.id, eventId: 'event-alpha', messageId: 'message-alpha',
      conversation: { id: 'oc_shared', scope: 'group' as const }, sender: { id: 'ou_user', type: 'user' as const },
      content: { type: 'text' as const }, text: 'alpha', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const alpha = store.resolveRoute(bot.id, message)
    const beta = store.resolveRoute(bot.id, { ...message, eventId: 'event-beta', messageId: 'message-beta', text: 'beta' })
    expect(alpha.scene?.id).toBe(first.id)
    expect(beta.scene?.id).toBe(second.id)
    expect(beta.conversationKey).toBe(alpha.conversationKey)
    expect(beta.conversationKey).toBe(`bot:${bot.id}:chat:oc_shared`)
    store.close()
  })

  it('resolves model and reasoning overrides per field without changing Thread identity', () => {
    const store = new HubStore(':memory:')
    store.setPlatformSettings({ basePrompt: '', defaultModel: 'platform-model', defaultReasoningEffort: 'medium', modelFallbackEnabled: false })
    const linked = workspace(store, 'Model routing')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id, model: 'bot-model' })
    store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Deep analysis', prompt: '', priority: 10, enabled: true, model: '', reasoningEffort: 'high', matcher: { chatIds: [], messageTypes: [], textIncludes: ['deep'], cardTitleIncludes: [] } })
    const message = {
      provider: 'feishu' as const, accountId: bot.id, eventId: 'event-model', messageId: 'message-model', conversation: { id: 'oc_model', scope: 'group' as const },
      sender: { id: 'ou_user', type: 'user' as const }, content: { type: 'text' as const }, text: 'deep review', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const route = store.resolveRoute(bot.id, message)
    expect(route.modelConfig).toEqual({ model: 'bot-model', reasoningEffort: 'high', modelSource: 'bot', reasoningEffortSource: 'scene', fallbackEnabled: false })
    expect(route.conversationKey).toBe(`bot:${bot.id}:chat:oc_model`)
    store.close()
  })

  it('uses one Thread per topic in topic mode and one Thread for private chat', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Topic boundaries')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id, conversationMode: 'topic' })
    const base = {
      provider: 'feishu' as const, accountId: bot.id, eventId: 'event-1', messageId: 'message-1',
      conversation: { id: 'oc_topics', scope: 'topic' as const, rootId: 'root-1' }, sender: { id: 'ou_user', type: 'user' as const },
      content: { type: 'text' as const }, text: 'hello', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const first = store.resolveRoute(bot.id, base)
    const same = store.resolveRoute(bot.id, { ...base, eventId: 'event-2', messageId: 'message-2' })
    const other = store.resolveRoute(bot.id, { ...base, eventId: 'event-3', messageId: 'message-3', conversation: { ...base.conversation, rootId: 'root-2' } })
    const privateMessage = store.resolveRoute(bot.id, { ...base, eventId: 'event-4', messageId: 'message-4', conversation: { id: 'ou_private', scope: 'private' as const } })
    expect(same.conversationKey).toBe(first.conversationKey)
    expect(other.conversationKey).not.toBe(first.conversationKey)
    expect(privateMessage).toMatchObject({ conversationKey: `bot:${bot.id}:chat:ou_private`, topicId: '', replyInTopic: false })
    store.close()
  })

  it('lists the persisted relationship between a route and its Codex Thread', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Thread mapping')
    const bot = store.createBot({ name: 'Thread Bot', defaultWorkspaceId: linked.id })
    const scene = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Alert triage', prompt: '', priority: 10, enabled: true, matcher: { chatIds: ['oc_thread'], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
    const route = store.resolveRoute(bot.id, {
      provider: 'feishu', accountId: bot.id, eventId: 'event-thread', messageId: 'message-thread',
      conversation: { id: 'oc_thread', scope: 'group' }, sender: { id: 'ou_1', type: 'user' },
      content: { type: 'text' }, text: 'check thread mapping', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    })
    const conversation = store.getOrCreateConversation(route, 'oc_thread')
    store.setConversationThread(conversation.id, '01-thread-id')
    store.upsertChatMetadata(bot.id, { chatId: 'oc_thread', name: '告警排查群', mode: 'group' })
    expect(store.listChatMetadata({ botId: bot.id, query: '告警' })).toMatchObject([{ chatId: 'oc_thread', name: '告警排查群' }])
    expect(store.listChatIdsForMetadataSync(bot.id)).toContain('oc_thread')
    expect(store.listConversationThreads({ query: '01-thread-id' })).toMatchObject({
      total: 1,
      items: [{ id: route.conversationKey, botName: 'Thread Bot', conversationMode: 'chat', chatId: 'oc_thread', chatName: '告警排查群', chatMode: 'group', topicId: '', coreThreadId: '01-thread-id' }],
    })
    expect(store.getConversationThread(route.conversationKey)).toMatchObject({ conversationMode: 'chat', coreThreadId: '01-thread-id' })
    store.close()
  })

  it('persists provisioning progress and fails interrupted scans on restart', () => {
    const store = new HubStore(':memory:')
    const job = store.createProvisioningJob({ name: 'Bot' })
    store.updateProvisioningJob(job.id, { status: 'waiting_scan', qrUrl: 'https://example.test/scan', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    expect(store.getProvisioningJob(job.id)).toMatchObject({ status: 'waiting_scan', qrUrl: 'https://example.test/scan' })
    store.failInterruptedProvisioningJobs()
    expect(store.getProvisioningJob(job.id)).toMatchObject({ status: 'failed', qrUrl: '' })
    store.close()
  })

  it('counts only enabled Scenes in dashboard statistics', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Statistics')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id })
    const matcher = { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] }
    store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Enabled', prompt: '', priority: 10, enabled: true, matcher })
    store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Disabled', prompt: '', priority: 20, enabled: false, matcher })
    expect(store.stats().scenes).toBe(1)
    store.close()
  })

  it('deduplicates Feishu retries by stable message id even when event ids change', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Dedupe')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id })
    expect(store.claimInboundEvent(bot.id, 'event-1', 'message-1')).toBe(true)
    expect(store.claimInboundEvent(bot.id, 'event-2', 'message-1')).toBe(false)
    expect(store.claimInboundEvent(bot.id, 'event-2', 'message-2')).toBe(true)
    store.close()
  })

  it('stores reviewable message, route, skill package, response, and duration snapshots', () => {
    const store = new HubStore(':memory:')
    const linked = store.createWorkspace({ name: 'Review', path: '/tmp/review' })
    const bot = store.createBot({ name: 'Reviewer', defaultWorkspaceId: linked.id })
    const skillPackage = store.createSkillPackage({ workspaceId: linked.id, name: 'Triage', description: '', prompt: '', skills: [], fallbackMode: 'package_first' })
    const scene = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Alert', prompt: '', priority: 10, enabled: true, matcher: { chatIds: ['oc_review'], messageTypes: ['text'], textIncludes: ['alarm'], cardTitleIncludes: [] }, skillPackageIds: [skillPackage.id] })
    const message = {
      provider: 'feishu' as const, accountId: bot.id, eventId: 'event-review', messageId: 'message-review',
      conversation: { id: 'oc_review', scope: 'group' as const }, sender: { id: 'ou_reviewer', type: 'user' as const },
      content: { type: 'text', raw: { text: 'alarm database latency', ticket: 'T-1' } }, text: 'alarm database latency', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const route = store.resolveRoute(bot.id, message)
    const log = store.createMessageLog(bot.id, route, message)
    expect(log).toMatchObject({ status: 'processing', sceneId: scene.id, sceneName: 'Alert', inboundContent: 'alarm database latency', inboundRaw: { text: 'alarm database latency', ticket: 'T-1' }, skillPackages: [{ id: skillPackage.id, name: 'Triage' }], modelSource: 'codex' })
    expect(store.setMessageLogInvestigation(log.id, { mode: 'package_first', primarySkills: [{ name: 'triage', description: '告警处理', path: '/skills/triage/SKILL.md' }], candidateSkills: [{ name: 'rds', description: '数据库查询', path: '/skills/rds/SKILL.md' }], knowledgeResources: [{ title: '表结构', path: '/knowledge/schema.md' }], knowledgeRoots: ['/knowledge'], codeRoot: '/workspace', tools: [{ kind: 'command', title: 'Command execution', summary: 'rg IssueBudget', status: 'completed' }] })).toMatchObject({ investigation: { mode: 'package_first', primarySkills: [{ name: 'triage' }], candidateSkills: [{ name: 'rds' }], tools: [{ summary: 'rg IssueBudget' }] } })
    expect(store.setMessageLogModel(log.id, { model: 'gpt-test', reasoningEffort: 'high', modelSource: 'platform', reasoningEffortSource: 'scene', fallback: true })).toMatchObject({ model: 'gpt-test', reasoningEffort: 'high', modelSource: 'platform', reasoningEffortSource: 'scene', modelFallback: true })
    expect(store.setMessageLogThread(log.id, '01a0-test-thread')).toMatchObject({ coreThreadId: '01a0-test-thread' })
    const completed = store.finishMessageLog(log.id, { responseContent: 'database recovered' })
    expect(completed).toMatchObject({ status: 'completed', responseContent: 'database recovered' })
    expect(completed.durationMs).toBeTypeOf('number')
    expect(store.listMessageLogs({ query: 'recovered', sceneId: scene.id })).toMatchObject({ total: 1, items: [{ id: log.id }] })
    expect(store.listMessageLogs({ query: log.id })).toMatchObject({ total: 1, items: [{ messageId: message.messageId }] })
    expect(store.listMessageLogs({ query: '01a0-test-thread' })).toMatchObject({ total: 1, items: [{ id: log.id }] })
    const interruptedMessage = { ...message, eventId: 'event-interrupted', messageId: 'message-interrupted' }
    const interrupted = store.createMessageLog(bot.id, route, interruptedMessage)
    expect(store.failProcessingMessageLogs()).toBe(1)
    expect(store.getMessageLog(interrupted.id)).toMatchObject({ status: 'failed', error: '服务在任务完成前重启，执行已中断' })
    expect(store.getMessageLog(interrupted.id).completedAt).not.toBe('')
    expect(store.stats().messageLogs).toBe(2)
    store.close()
  })
})
