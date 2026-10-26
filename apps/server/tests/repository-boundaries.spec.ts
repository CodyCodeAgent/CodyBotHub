import { describe, expect, it } from 'vitest'
import { HubStore } from '../src/db.js'
import { WorkspaceRepository } from '../src/persistence/workspace-repository.js'
import { SkillSourceRepository } from '../src/persistence/skill-source-repository.js'
import { ProvisioningRepository } from '../src/persistence/provisioning-repository.js'
import { HubTaskRepository } from '../src/persistence/hub-task-repository.js'
import { BotSceneRepository } from '../src/persistence/bot-scene-repository.js'
import { AuditRepository } from '../src/persistence/audit-repository.js'

describe('repository boundaries', () => {
  it('keeps Bot and Scene workspace invariants inside their aggregate repository', () => {
    const hub = new HubStore(':memory:')
    const repository = new BotSceneRepository(hub.db)
    const workspace = hub.createWorkspace({ name: 'Bot', path: '/tmp/bot-scene-aggregate' })
    const bot = repository.createBot({ name: 'Bot', defaultWorkspaceId: workspace.id })
    expect(repository.listBots()[0]?.id).toBe(bot.id)
    expect(() => repository.createScene({ botId: bot.id, workspaceId: 'missing', name: 'invalid', prompt: '', priority: 1, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })).toThrow('attached')
    hub.close()
  })

  it('persists Task snapshots and revisions through its repository', () => {
    const hub = new HubStore(':memory:')
    const tasks = new HubTaskRepository(hub.db)
    const task = tasks.createHubTask({ kind: 'agent_turn', origin: 'test', principal: 'tester', idempotencyKey: 'key', taskInput: { text: 'hello' } })
    expect(tasks.findHubTask('test', 'key')?.id).toBe(task.id)
    expect(tasks.transitionHubTask(task.id, { type: 'start' }).status).toBe('running')
    hub.close()
  })

  it('shares one connection across skill-source and provisioning aggregates', () => {
    const hub = new HubStore(':memory:')
    const workspaces = new WorkspaceRepository(hub.db)
    const workspace = workspaces.createWorkspace({ name: 'shared', path: '/tmp/shared' })
    const sources = new SkillSourceRepository(hub.db, workspaces)
    const source = sources.createSkillSource({ name: 'skills', repositoryUrl: 'https://example.com/repo.git', branch: 'main', workspaceId: workspace.id, skillRoots: ['skills'], knowledgeRoots: [], autoInstall: true })
    const jobs = new ProvisioningRepository(hub.db)
    expect(sources.getSkillSource(source.id).workspaceId).toBe(workspace.id)
    expect(jobs.getProvisioningRequest(jobs.createProvisioningJob({ name: 'bot' }).id)).toEqual({ name: 'bot' })
    hub.close()
  })
  it('shares one connection so a transaction spans workspaces and audit records', () => {
    const store = new HubStore(':memory:')
    const workspaces = new WorkspaceRepository(store.db)
    const audit = new AuditRepository(store.db)
    store.db.exec('BEGIN IMMEDIATE')
    try {
      const workspace = workspaces.createWorkspace({ name: 'Temporary', path: '/tmp/repository-boundary' })
      audit.createAuditLog({ action: 'workspace.create', targetType: 'workspace', targetId: workspace.id, summary: 'Create' })
      store.db.exec('ROLLBACK')
    } catch (error) {
      store.db.exec('ROLLBACK')
      throw error
    }
    expect(store.listWorkspaces()).toEqual([])
    expect(store.listAuditLogs().total).toBe(0)
    store.close()
  })
})
