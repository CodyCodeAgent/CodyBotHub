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
    expect(store.listAdminAccounts()).toMatchObject([{ id: 'legacy-admin', loginName: 'admin', displayName: '管理员' }])
    expect(store.getSessionAccount('legacy-token')).toMatchObject({ id: 'legacy-admin' })
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('manages administrator accounts, sessions, and immutable audit snapshots', () => {
    const store = new HubStore(':memory:')
    const first = store.createAdminAccount({ loginName: 'admin', displayName: '平台管理员', passwordHash: 'hash-1' })
    const second = store.createAdminAccount({ loginName: 'operator', displayName: '运营同学', passwordHash: 'hash-2' })
    store.createSession('token-2', second.id, '2099-01-01T00:00:00.000Z')
    expect(store.getSessionAccount('token-2')).toMatchObject({ loginName: 'operator' })
    store.createAuditLog({ actor: second, action: 'scene.update', targetType: 'scene', targetId: 'scene-1', summary: '更新场景' })
    store.deleteAdminAccount(second.id)
    expect(store.getSessionAccount('token-2')).toBeNull()
    expect(store.listAuditLogs({ query: '运营同学' })).toMatchObject({ total: 1, items: [{ actorAccountId: second.id, actorLoginName: 'operator' }] })
    expect(() => store.deleteAdminAccount(first.id)).toThrow('last administrator')
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
    expect(() => store.createScene({ botId: bot.id, workspaceId: detached.id, name: 'Wrong workspace', prompt: '', priority: 100, replyMode: 'inherit', enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })).toThrow('Scene Workspace must be attached to its Bot')
    store.close()
  })

  it('rejects Skill Packages from a different Workspace', () => {
    const store = new HubStore(':memory:')
    const first = workspace(store, 'First')
    const second = workspace(store, 'Second')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: first.id })
    const skillPackage = store.createSkillPackage({ workspaceId: second.id, name: 'Foreign package', description: '', prompt: '', skills: ['test'], fallbackMode: 'package_first' })
    expect(() => store.createScene({ botId: bot.id, workspaceId: first.id, name: 'Scene', prompt: '', priority: 100, replyMode: 'inherit', enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] }, skillPackageIds: [skillPackage.id] })).toThrow('Scene and Skill Package must use the same Workspace')
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
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id, prompt: 'bot' })
    const skillPackage = store.createSkillPackage({ workspaceId: linked.id, name: 'Package', description: '', prompt: 'package', skills: ['report'], fallbackMode: 'package_first' })
    store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Fallback', prompt: 'fallback', priority: 200, replyMode: 'inherit', enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
    const selected = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Alert', prompt: 'scene', priority: 10, replyMode: 'topic', enabled: true, matcher: { chatIds: ['oc_1'], messageTypes: ['interactive'], textIncludes: [], cardTitleIncludes: ['P0'] }, skillPackageIds: [skillPackage.id] })
    const route = store.resolveRoute(bot.id, {
      provider: 'feishu', accountId: bot.id, eventId: 'event-1', messageId: 'message-1',
      conversation: { id: 'oc_1', scope: 'group' }, sender: { id: 'ou_1', type: 'user' },
      content: { type: 'interactive', title: 'P0 发布失败' }, text: 'P0 发布失败', attachments: [],
      addressedToAgent: false, mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    })
    expect(route.scene?.id).toBe(selected.id)
    expect(route.replyMode).toBe('topic')
    expect(route.conversationKey).toBe(`scene:${bot.id}:${selected.id}:oc_1`)
    expect(route.systemPrompt).toBe('platform\n\nworkspace\n\nbot\n\nscene\n\npackage')
    store.close()
  })

  it('lets an authorized card action bind a group to a reusable Scene', () => {
    const store = new HubStore(':memory:')
    const linked = workspace(store, 'Group binding')
    const bot = store.createBot({ name: 'Assistant', defaultWorkspaceId: linked.id })
    const scene = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Chosen', prompt: '', priority: 100, replyMode: 'inherit', enabled: true, matcher: { chatIds: ['another-chat'], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
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
    store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Enabled', prompt: '', priority: 10, replyMode: 'inherit', enabled: true, matcher })
    store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Disabled', prompt: '', priority: 20, replyMode: 'inherit', enabled: false, matcher })
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
    const scene = store.createScene({ botId: bot.id, workspaceId: linked.id, name: 'Alert', prompt: '', priority: 10, replyMode: 'inherit', enabled: true, matcher: { chatIds: ['oc_review'], messageTypes: ['text'], textIncludes: ['alarm'], cardTitleIncludes: [] }, skillPackageIds: [skillPackage.id] })
    const message = {
      provider: 'feishu' as const, accountId: bot.id, eventId: 'event-review', messageId: 'message-review',
      conversation: { id: 'oc_review', scope: 'group' as const }, sender: { id: 'ou_reviewer', type: 'user' as const },
      content: { type: 'text' }, text: 'alarm database latency', attachments: [], addressedToAgent: true,
      mentionsOtherRecipient: false, createdAtIso: new Date().toISOString(),
    }
    const route = store.resolveRoute(bot.id, message)
    const log = store.createMessageLog(bot.id, route, message)
    expect(log).toMatchObject({ status: 'processing', sceneId: scene.id, sceneName: 'Alert', inboundContent: 'alarm database latency', skillPackages: [{ id: skillPackage.id, name: 'Triage' }] })
    const completed = store.finishMessageLog(log.id, { responseContent: 'database recovered' })
    expect(completed).toMatchObject({ status: 'completed', responseContent: 'database recovered' })
    expect(completed.durationMs).toBeTypeOf('number')
    expect(store.listMessageLogs({ query: 'recovered', sceneId: scene.id })).toMatchObject({ total: 1, items: [{ id: log.id }] })
    expect(store.listMessageLogs({ query: log.id })).toMatchObject({ total: 1, items: [{ messageId: message.messageId }] })
    expect(store.stats().messageLogs).toBe(1)
    store.close()
  })
})
