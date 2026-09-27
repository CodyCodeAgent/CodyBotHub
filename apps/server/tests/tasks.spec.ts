import { describe, expect, it, vi } from 'vitest'
import { HubStore } from '../src/db.js'
import { HubTaskService } from '../src/tasks.js'

describe('HubTaskService', () => {
  it('runs idempotent MCP agent work as a durable read-only task', async () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'MCP workspace', path: '/tmp' })
    const bot = store.createBot({ name: 'MCP bot', defaultWorkspaceId: workspace.id })
    const skillPackage = store.createSkillPackage({ workspaceId: workspace.id, name: 'Repository guide', description: 'Explain repositories', prompt: '', skills: ['repo-guide'], fallbackMode: 'package_first' })
    const scene = store.createScene({ botId: bot.id, workspaceId: workspace.id, name: 'Repository scene', prompt: '', priority: 1, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] }, skillPackageIds: [skillPackage.id] })
    const execute = vi.fn(async (...args: unknown[]) => {
      const onProgress = args[3] as ((progress: { phase: 'answering'; reasoning: string; answer: string }) => void)
      onProgress({ phase: 'answering', reasoning: '', answer: 'working' })
      return 'completed answer'
    })
    const service = new HubTaskService(store, { execute } as never)
    const submitted = service.dispatchAgentTask({ botId: bot.id, sceneId: scene.id, prompt: 'explain the repository', sessionId: 'session-1', requestId: 'request-1', principal: 'dot' })
    const duplicate = service.dispatchAgentTask({ botId: bot.id, sceneId: scene.id, prompt: 'different text is ignored for the same request', sessionId: 'session-1', requestId: 'request-1', principal: 'dot' })
    const otherPrincipal = service.dispatchAgentTask({ botId: bot.id, sceneId: scene.id, prompt: 'same request ID in another principal scope', sessionId: 'session-1', requestId: 'request-1', principal: 'another-dot' })

    expect(duplicate.id).toBe(submitted.id)
    expect(otherPrincipal.id).not.toBe(submitted.id)
    expect(() => service.get(submitted.id, 'another-dot')).toThrow('Task not found')
    const completed = await service.wait(submitted.id, 5_000)
    expect(completed).toMatchObject({ status: 'completed', result: { text: 'completed answer' }, principal: 'dot' })
    await service.wait(otherPrincipal.id, 5_000)
    expect(execute).toHaveBeenCalledTimes(2)
    const call = execute.mock.calls[0]!
    expect(call[8]).toBe(false)
    expect(call[9]).toBe('read_only')
    expect(call[0]).toMatchObject({ routeSource: 'explicit', scene: { id: scene.id }, skillPackages: [{ id: skillPackage.id, toolPackageIds: [] }] })
    expect((call[0] as { turnInstructions: string }).turnInstructions).toContain('MCP 只读任务')
    expect(() => service.dispatchAgentTask({ botId: bot.id, sceneId: '00000000-0000-4000-8000-000000000000', prompt: 'invalid scene', sessionId: 'session-1', requestId: 'request-2', principal: 'dot' })).toThrow('Scene not found')

    const catalog = service.inspectPlatform({ requestId: 'catalog-1', principal: 'dot' })
    expect(catalog.result?.data).toMatchObject({
      scenes: [{ id: scene.id, skillPackageIds: [skillPackage.id] }],
      skillPackages: [{ id: skillPackage.id, name: 'Repository guide', skills: ['repo-guide'] }],
    })
    store.close()
  })

  it('resumes queued MCP Tasks after a service restart boundary', async () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Recovery workspace', path: '/tmp' })
    const bot = store.createBot({ name: 'Recovery bot', defaultWorkspaceId: workspace.id })
    const execute = vi.fn(async () => 'resumed answer')
    const stoppedService = new HubTaskService(store, { execute } as never)
    stoppedService.beginDrain()
    const queued = stoppedService.dispatchAgentTask({ botId: bot.id, prompt: 'resume me', sessionId: 'recovery-session', requestId: 'recovery-request', principal: 'dot' })
    expect(queued.status).toBe('queued')
    expect(execute).not.toHaveBeenCalled()

    const restartedService = new HubTaskService(store, { execute } as never)
    restartedService.resumeQueuedTasks()
    await expect(restartedService.wait(queued.id, 5_000, 'dot')).resolves.toMatchObject({ status: 'completed', result: { text: 'resumed answer' } })
    expect(execute).toHaveBeenCalledOnce()
    store.close()
  })
})
