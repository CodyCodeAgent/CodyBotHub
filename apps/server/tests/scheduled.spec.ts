import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HubStore } from '../src/db.js'
import { nextScheduleDates } from '../src/schedule.js'
import { ScheduledTaskService } from '../src/scheduled.js'
import { WorkspaceAccess } from '../src/workspace-access.js'
import type { ScheduledRuntimeInput } from '../src/runtime.js'
import type { ScheduledTaskInput } from '../src/scheduled-types.js'
const cleaners: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const clean of cleaners.splice(0).reverse()) await clean()
})
const setup = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'hub-scheduled-')),
    hub = new HubStore(':memory:'),
    workspace = hub.createWorkspace({ name: 'Task workspace', path: directory })
  const runtime = {
    setScheduledInvoker: vi.fn(),
    validateModelSelection: vi.fn(async () => {}),
    workspaceAccess: new WorkspaceAccess(),
    executeScheduled: vi.fn(async (input: ScheduledRuntimeInput) => {
      input.onThread('native-thread')
      input.onModel({
        model: 'test-model',
        reasoningEffort: 'high',
        modelSource: 'platform',
        reasoningEffortSource: 'platform',
        fallback: false
      })
      input.onProgress('final report')
      return 'final report'
    }),
    workspaceResources: vi.fn(async () => ({ skills: [], knowledge: [], knowledgeRoots: [] }))
  }
  const transport = {
    send: vi.fn(async () => 'card-1'),
    update: vi.fn(async () => {}),
    mayApprove: vi.fn(async () => true)
  }
  const service = new ScheduledTaskService(
    hub,
    runtime as never,
    { sync: vi.fn(), install: vi.fn() } as never,
    directory,
    transport
  )
  const input: ScheduledTaskInput = {
    name: 'Daily task',
    description: 'report',
    workspaceId: workspace.id,
    template: 'custom',
    prompt: 'Read repository. {{run_id}}',
    runtimeKind: 'codex',
    model: '',
    reasoningEffort: '',
    mode: 'read_only',
    skillPackageIds: [],
    toolPackageIds: [],
    enabled: false,
    schedule: {
      kind: 'interval',
      intervalMinutes: 60,
      time: '09:00',
      weekdays: [1],
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai'
    },
    timeoutMinutes: 5,
    overlap: 'skip',
    contextMode: 'fresh',
    output: { botId: '', chatId: '', when: 'always' },
    sync: { branch: 'main', submodules: [], installSkills: true, skillRoots: ['skills'], sourceIds: [] }
  }
  cleaners.push(async () => {
    await service.stop()
    hub.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { directory, hub, workspace, runtime, transport, service, input }
}
const finish = async (service: ScheduledTaskService) => {
  await service.tick()
  await service.waitForIdle()
}
const toolFixture = (s: ReturnType<typeof setup>, approval = true) => {
  const bot = s.hub.createBot({ name: 'Approval bot', defaultWorkspaceId: s.workspace.id })
  const tool = s.hub.createTool({
    workspaceId: s.workspace.id,
    name: 'Write marker',
    description: '',
    executorType: 'command',
    command: process.execPath,
    argumentsTemplate: [
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(path.join(s.directory, 'marker.txt'))},'one\\n')`
    ],
    inputSchema: {},
    timeoutSeconds: 5,
    enabled: true
  })
  const pack = s.hub.createToolPackage({
    workspaceId: s.workspace.id,
    name: 'Controlled package',
    description: '',
    prompt: '',
    approvalRequired: approval,
    approverIds: ['ou_allowed'],
    cardTitle: 'Confirm',
    cardDescription: '',
    enabled: true,
    steps: [{ toolId: tool.id, toolName: tool.name, position: 0, phase: 'execute', arguments: {} }]
  })
  s.input.mode = 'maintenance'
  s.input.toolPackageIds = [pack.id]
  s.input.output = { botId: bot.id, chatId: 'oc_test', when: 'always' }
  return { bot, pack, tool }
}
describe('scheduled plan calculations', () => {
  it('computes interval dates from activation time', () => {
    expect(
      nextScheduleDates(
        { kind: 'interval', intervalMinutes: 90, time: '09:00', weekdays: [1], cron: '', timezone: 'Asia/Shanghai' },
        new Date('2026-10-19T00:00:00Z'),
        2
      )
    ).toEqual(['2026-10-19T01:30:00.000Z', '2026-10-19T03:00:00.000Z'])
  })
  it('handles local daily time and daylight-saving transitions', () => {
    expect(
      nextScheduleDates(
        { kind: 'daily', intervalMinutes: 60, time: '09:00', weekdays: [1], cron: '', timezone: 'America/New_York' },
        new Date('2026-03-07T11:00:00Z'),
        2
      )
    ).toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z'])
  })
  it('rejects invalid timezones, empty weekday sets and six-field cron', () => {
    const s = setup().input.schedule
    expect(() => nextScheduleDates({ ...s, timezone: 'invalid/timezone' })).toThrow()
    expect(() => nextScheduleDates({ ...s, kind: 'weekly', weekdays: [] })).toThrow()
    expect(() => nextScheduleDates({ ...s, kind: 'cron', cron: '* * * * * *' })).toThrow('5 段')
  })
})
describe('persistent AI scheduled tasks', () => {
  it('keeps definitions paused, snapshots each run and records actual thread/model', async () => {
    const s = setup(),
      task = await s.service.save(s.input, 'admin'),
      run = s.service.trigger(task.id, 'admin')
    expect(task.enabled).toBe(false)
    expect(task.nextRunAt).toBe('')
    await s.service.save({ ...s.input, prompt: 'changed future prompt' }, 'admin', task.id)
    await finish(s.service)
    const result = s.service.records.getRun(run.id)
    expect(result).toMatchObject({
      status: 'completed',
      model: 'test-model',
      coreThreadId: 'native-thread',
      report: 'final report',
      snapshot: { prompt: s.input.prompt, revision: 1 }
    })
    expect(s.runtime.executeScheduled.mock.calls[0]![0].prompt).toContain(run.id)
    expect(s.service.records.getTask(task.id).revision).toBe(2)
  })
  it('prevents duplicate manual starts and preserves paginated records', async () => {
    const s = setup(),
      task = await s.service.save(s.input, 'admin')
    s.service.trigger(task.id, 'admin')
    expect(() => s.service.trigger(task.id, 'admin')).toThrow('已有')
    for (let i = 0; i < 24; i++)
      s.service.records.enqueue(task, 'test', `seed-${i}`, new Date().toISOString(), 'skipped')
    expect(s.service.records.listRuns({ taskId: task.id, limit: 20 }).items).toHaveLength(20)
    expect(s.service.records.listRuns({ taskId: task.id, limit: 20, offset: 20 }).items).toHaveLength(5)
    expect(s.service.records.listRuns({ taskId: task.id }).total).toBe(25)
  })
  it('creates one scheduled slot and records overlap without replaying missed intervals', async () => {
    const s = setup(),
      task = await s.service.save({ ...s.input, enabled: true }, 'admin')
    s.service.trigger(task.id, 'admin')
    s.service.beginDrain()
    const due = '2026-01-01T00:00:00.000Z'
    s.service.records.db.prepare('UPDATE scheduled_tasks SET next_run_at=? WHERE id=?').run(due, task.id)
    await s.service.tick()
    expect(s.runtime.executeScheduled).not.toHaveBeenCalled()
    s.service.cancelDrain()
    await finish(s.service)
    await s.service.tick()
    const rows = s.service.records.listRuns({ taskId: task.id })
    expect(rows.total).toBe(2)
    expect(rows.items.filter((r) => r.status === 'skipped')).toHaveLength(1)
    expect(s.service.records.getTask(task.id).nextRunAt > new Date().toISOString()).toBe(true)
  })
  it('merges at most one queued slot behind an approval and never starts it early', async () => {
    const s = setup(),
      task = await s.service.save({ ...s.input, enabled: true, overlap: 'merge' }, 'admin')
    const first = s.service.records.enqueue(task, 'test', 'first', new Date().toISOString())
    s.service.records.updateRun(first.id, { status: 'awaiting_approval' })
    s.service.records.db
      .prepare('UPDATE scheduled_tasks SET next_run_at=? WHERE id=?')
      .run(new Date(Date.now() - 1000).toISOString(), task.id)
    await s.service.tick()
    expect(s.runtime.executeScheduled).not.toHaveBeenCalled()
    expect(s.service.records.listRuns({ status: 'queued' }).total).toBe(1)
    s.service.records.db
      .prepare('UPDATE scheduled_tasks SET next_run_at=? WHERE id=?')
      .run(new Date(Date.now() - 500).toISOString(), task.id)
    await s.service.tick()
    expect(s.service.records.listRuns({ status: 'queued' }).total).toBe(1)
  })
  it('marks interrupted executions for review while recovering queued work', async () => {
    const s = setup(),
      task = await s.service.save(s.input, 'admin'),
      run = s.service.trigger(task.id, 'admin')
    s.service.records.updateRun(run.id, { status: 'running' })
    await finish(s.service)
    expect(s.runtime.executeScheduled).not.toHaveBeenCalled()
    expect(s.service.records.getRun(run.id).status).toBe('interrupted')
  })
  it('runs queued jobs only after deployment drain ends', async () => {
    const s = setup(),
      task = await s.service.save(s.input, 'admin'),
      run = s.service.trigger(task.id, 'admin')
    s.service.beginDrain()
    await s.service.tick()
    expect(s.service.records.getRun(run.id).status).toBe('queued')
    s.service.cancelDrain()
    await finish(s.service)
    expect(s.service.records.getRun(run.id).status).toBe('completed')
  })
  it('retries report delivery independently from AI execution', async () => {
    const s = setup(),
      bot = s.hub.createBot({ name: 'Sender', defaultWorkspaceId: s.workspace.id })
    s.transport.send.mockRejectedValueOnce(new Error('network down'))
    const task = await s.service.save(
        { ...s.input, output: { botId: bot.id, chatId: 'oc_report', when: 'always' } },
        'admin'
      ),
      run = s.service.trigger(task.id, 'admin')
    await finish(s.service)
    expect(s.service.records.getRun(run.id)).toMatchObject({ status: 'completed', deliveryStatus: 'failed' })
    await s.service.retryDelivery(run.id)
    expect(s.service.records.getRun(run.id).deliveryStatus).toBe('sent')
    expect(s.runtime.executeScheduled).toHaveBeenCalledOnce()
  })
  it('requires approval and resumes the original run/thread exactly once', async () => {
    const s = setup(),
      { bot, pack } = toolFixture(s)
    let phase = 0
    s.runtime.executeScheduled.mockImplementation(async (input) => {
      input.onThread('approval-thread')
      if (phase++ === 0) {
        const result = await s.service.invoke(input.runId, 'invoke_tool_package', {
          packageId: pack.id,
          arguments: {},
          reason: 'test'
        })
        expect(result).toMatchObject({ status: 'awaiting_approval' })
        return 'waiting'
      }
      expect(input.coreThreadId).toBe('approval-thread')
      return 'verified completed action'
    })
    const task = await s.service.save(s.input, 'admin'),
      run = s.service.trigger(task.id, 'admin')
    await finish(s.service)
    let current = s.service.records.getRun(run.id)
    expect(current.status).toBe('awaiting_approval')
    expect(s.transport.send).toHaveBeenCalledOnce()
    const action = current.actions[0]!
    await s.service.onAction(bot.id, 'ou_allowed', action.id, false)
    await s.service.onAction(bot.id, 'ou_allowed', action.id, false)
    await finish(s.service)
    current = s.service.records.getRun(run.id)
    expect(current.status).toBe('completed')
    expect(current.coreThreadId).toBe('approval-thread')
    expect(readFileSync(path.join(s.directory, 'marker.txt'), 'utf8')).toBe('one\n')
  })
  it('rejects unauthorized approvers and does not repeat a rejected request', async () => {
    const s = setup(),
      { bot, pack } = toolFixture(s)
    let phase = 0
    s.runtime.executeScheduled.mockImplementation(async (input) => {
      input.onThread('reject-thread')
      if (phase++ === 0) {
        await s.service.invoke(input.runId, 'invoke_tool_package', {
          packageId: pack.id,
          arguments: {},
          reason: 'test'
        })
        return 'waiting'
      }
      await expect(
        s.service.invoke(input.runId, 'invoke_tool_package', { packageId: pack.id, arguments: {}, reason: 'again' })
      ).rejects.toThrow('拒绝')
      return 'request rejected; no action'
    })
    const task = await s.service.save(s.input, 'admin'),
      run = s.service.trigger(task.id, 'admin')
    await finish(s.service)
    const action = s.service.records.getRun(run.id).actions[0]!
    s.transport.mayApprove.mockResolvedValueOnce(false)
    expect(await s.service.onAction(bot.id, 'ou_other', action.id, false)).toMatchObject({ toast: { type: 'error' } })
    expect(s.service.records.action(action.id).status).toBe('awaiting_approval')
    await s.service.onAction(bot.id, 'ou_allowed', action.id, true)
    await finish(s.service)
    expect(s.service.records.getRun(run.id).status).toBe('warning')
    expect(s.service.records.getRun(run.id).actions).toHaveLength(1)
  })
  it('rejects package configuration changes after approval', async () => {
    const s = setup(),
      { bot, pack, tool } = toolFixture(s)
    let phase = 0
    s.runtime.executeScheduled.mockImplementation(async (input) => {
      input.onThread('config-thread')
      if (phase++ === 0)
        await s.service.invoke(input.runId, 'invoke_tool_package', {
          packageId: pack.id,
          arguments: {},
          reason: 'test'
        })
      return 'summary'
    })
    const task = await s.service.save(s.input, 'admin'),
      run = s.service.trigger(task.id, 'admin')
    await finish(s.service)
    const action = s.service.records.getRun(run.id).actions[0]!
    s.hub.db.prepare('UPDATE tools SET updated_at=? WHERE id=?').run('2099-01-01', tool.id)
    await s.service.onAction(bot.id, 'ou_allowed', action.id, false)
    await finish(s.service)
    expect(s.service.records.getRun(run.id).actions[0]).toMatchObject({ status: 'failed' })
    expect(s.service.records.getRun(run.id).actions[0]!.error).toContain('配置已变化')
  })
  it('checks workspace ownership and approval transport before saving', async () => {
    const s = setup(),
      { pack } = toolFixture(s)
    await expect(s.service.save({ ...s.input, mode: 'read_only' }, 'admin')).rejects.toThrow('只读')
    await expect(
      s.service.save({ ...s.input, output: { botId: '', chatId: '', when: 'always' } }, 'admin')
    ).rejects.toThrow('人工确认')
    const other = s.hub.createWorkspace({ name: 'Other', path: tmpdir() })
    await expect(
      s.service.save({ ...s.input, workspaceId: other.id, toolPackageIds: [pack.id] }, 'admin')
    ).rejects.toThrow('工作区')
  })
  it('keeps native thread reuse scoped to unchanged task configuration', async () => {
    const s = setup(),
      task = await s.service.save({ ...s.input, contextMode: 'reuse' }, 'admin')
    s.service.trigger(task.id, 'admin')
    await finish(s.service)
    s.service.trigger(task.id, 'admin')
    await finish(s.service)
    expect(s.runtime.executeScheduled.mock.calls[1]![0].coreThreadId).toBe('native-thread')
  })
})
describe('workspace maintenance coordination', () => {
  it('waits for active readers and blocks new readers while applying', async () => {
    const gate = new WorkspaceAccess(),
      root = tmpdir()
    let finishReader!: () => void
    const started: string[] = []
    const read = gate.use(root, async () => {
      started.push('old')
      await new Promise<void>((r) => (finishReader = r))
    })
    await new Promise((r) => setTimeout(r, 5))
    const write = gate.maintain(root, 'sync', async () => {
      started.push('write')
    })
    const next = gate.use(root, async () => {
      started.push('new')
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(started).toEqual(['old'])
    finishReader()
    await Promise.all([read, write, next])
    expect(started).toEqual(['old', 'write', 'new'])
  })
  it('supports a writer upgrading its own scheduled read lease', async () => {
    const gate = new WorkspaceAccess()
    await gate.use(tmpdir(), () => gate.maintain(tmpdir(), 'owner', async () => 42), 'owner')
  })
  it('persists maintenance pauses across runtime restarts', async () => {
    const s = setup(),
      file = path.join(s.directory, 'pauses.json')
    new WorkspaceAccess(file).pause(s.directory, 'rollback incomplete')
    const next = new WorkspaceAccess(file)
    await expect(next.use(s.directory, async () => true)).rejects.toThrow('rollback incomplete')
    next.resume(s.directory)
    await expect(next.use(s.directory, async () => true)).resolves.toBe(true)
  })
})
