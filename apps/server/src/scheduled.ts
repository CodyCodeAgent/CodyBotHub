import { randomUUID, createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { z } from 'zod'
import type { FeishuCard } from '@codycodeagent/cody-web-core/feishu'
import { feishuMarkdownCards, feishuTextCard } from '@codycodeagent/cody-web-core/feishu'
import type { HubStore } from './db.js'
import type { CodyBotRuntime } from './runtime.js'
import type { SkillSyncService } from './skills.js'
import { nextScheduleDates } from './schedule.js'
import { ScheduledStore } from './scheduled-store.js'
import { inspectWorkspace, WorkspaceSyncService, validatePreservedPaths } from './workspace-sync.js'
import { workspacePathsOverlap } from './workspace-access.js'
import { ToolPackageRunner } from './tool-execution.js'
import { ScheduledRunScheduler } from './scheduled-run-scheduler.js'
import { ScheduledRunOrchestrator, type ActiveScheduledRun } from './scheduled-run-orchestrator.js'
import type { ScheduledAction, ScheduledRun, ScheduledTask, ScheduledTaskInput } from './scheduled-types.js'
export { scheduledTemplates } from './scheduled-types.js'
const at = () => new Date().toISOString()
const ids = z.array(z.string().min(1).max(120)).max(100).default([])
const schema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  workspaceId: z.string().min(1),
  template: z.string().max(80).default('custom'),
  prompt: z.string().trim().min(1).max(50000),
  runtimeKind: z.enum(['codex', 'traex']).default('codex'),
  model: z.string().max(200).default(''),
  reasoningEffort: z.string().max(40).default(''),
  mode: z.enum(['read_only', 'maintenance']).default('read_only'),
  skillPackageIds: ids,
  toolPackageIds: ids,
  schedule: z.object({
    kind: z.enum(['interval', 'daily', 'weekly', 'cron']),
    intervalMinutes: z.number().int().min(1).max(525600).default(120),
    time: z.string().default('09:00'),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([1]),
    cron: z.string().max(200).default('0 9 * * *'),
    timezone: z.string().max(80).default('Asia/Shanghai')
  }),
  enabled: z.boolean().default(false),
  timeoutMinutes: z.number().int().min(1).max(240).default(30),
  overlap: z.enum(['skip', 'merge']).default('skip'),
  contextMode: z.enum(['fresh', 'reuse']).default('fresh'),
  output: z
    .object({
      botId: z.string().default(''),
      chatId: z.string().default(''),
      when: z.enum(['always', 'attention']).default('always')
    })
    .default({ botId: '', chatId: '', when: 'always' }),
  sync: z
    .object({
      branch: z.string().max(200).default('master'),
      submodules: z
        .array(
          z.object({
            path: z.string().min(1).max(1000),
            mode: z.enum(['pinned', 'branch', 'merge']),
            branch: z.string().max(200).default(''),
            required: z.boolean().default(true)
          })
        )
        .max(200)
        .default([]),
      installSkills: z.boolean().default(true),
      skillRoots: z.array(z.string().max(1000)).max(30).default(['skills', '.agents/skills']),
      sourceIds: ids,
      preserveLocalFiles: z.array(z.string().min(1).max(1000)).max(100).default([])
    })
    .default({
      branch: 'master',
      submodules: [],
      installSkills: true,
      skillRoots: ['skills', '.agents/skills'],
      sourceIds: [],
      preserveLocalFiles: []
    })
})
export type ScheduledTransport = {
  send: (botId: string, chatId: string, card: FeishuCard, uuid: string) => Promise<string>
  update: (botId: string, messageId: string, card: FeishuCard) => Promise<void>
  mayApprove: (botId: string, packageId: string, actorId: string) => Promise<boolean>
}
export class ScheduledTaskService {
  readonly records: ScheduledStore
  private readonly active = new Map<string, ActiveScheduledRun>()
  private readonly sync: WorkspaceSyncService
  private readonly scheduler: ScheduledRunScheduler
  private readonly runOrchestrator: ScheduledRunOrchestrator
  private readonly runner: ToolPackageRunner
  private timer: ReturnType<typeof setInterval> | null = null
  private draining = false
  private ticking = false
  constructor(
    private readonly hub: HubStore,
    private readonly runtime: CodyBotRuntime,
    private readonly skills: SkillSyncService,
    dataDir: string,
    private readonly transport: ScheduledTransport
  ) {
    this.records = new ScheduledStore(hub)
    this.sync = new WorkspaceSyncService(dataDir)
    this.scheduler = new ScheduledRunScheduler(this.records, this.sync, runtime.workspaceAccess, runId => this.active.has(runId))
    this.runOrchestrator = new ScheduledRunOrchestrator(this.records, this.active, (run, controller) => this.execute(run, controller))
    this.runner = new ToolPackageRunner(hub)
    runtime.setScheduledInvoker((id, tool, args) => this.invoke(id, tool, args))
  }
  maintenance(workspaceId: string): { paused: boolean; reason: string } {
    const reason = this.runtime.workspaceAccess.paused(this.hub.getWorkspace(workspaceId).path)
    return { paused: Boolean(reason), reason }
  }
  resumeWorkspace(workspaceId: string): void {
    const root = realpathSync.native(this.hub.getWorkspace(workspaceId).path)
    this.runtime.workspaceAccess.resume(root)
    this.sync.acknowledgeRecovery(root)
  }
  async validate(body: unknown): Promise<ScheduledTaskInput> {
    const config = schema.parse(body),
      workspace = this.hub.getWorkspace(config.workspaceId)
    realpathSync.native(workspace.path)
    validatePreservedPaths(config.sync.preserveLocalFiles || [])
    nextScheduleDates(config.schedule)
    for (const id of config.skillPackageIds)
      if (!this.hub.listSkillPackages().some((p) => p.id === id && p.workspaceId === workspace.id))
        throw new Error('技能包不存在或属于其他工作区')
    for (const id of config.toolPackageIds) {
      const pack = this.hub.getToolPackage(id)
      if (pack.workspaceId !== workspace.id || !pack.enabled) throw new Error('工具包不可用或属于其他工作区')
      if (config.mode === 'read_only') throw new Error('只读任务不能挂载可执行工具包，请选择维护与工具执行模式')
      if (pack.approvalRequired && (!config.output.botId || !config.output.chatId))
        throw new Error('工具包需要人工确认，请配置发送 Bot 和审批接收群')
    }
    if (Boolean(config.output.botId) !== Boolean(config.output.chatId)) throw new Error('发送 Bot 和接收群必须同时配置')
    if (config.output.botId) {
      const bot = this.hub.listBots().find((b) => b.id === config.output.botId)
      if (!bot || !bot.workspaceIds.includes(workspace.id)) throw new Error('发送 Bot 未关联当前工作区')
      if (!/^oc_[a-z\d]+$/iu.test(config.output.chatId)) throw new Error('接收群需要有效的飞书 Chat ID（oc_）')
    }
    for (const id of config.sync.sourceIds)
      if (!this.hub.listSkillSources().some((s) => s.id === id && s.workspaceId === workspace.id))
        throw new Error('技能源不属于当前工作区')
    if (config.template === 'workspace_sync' && config.mode !== 'maintenance')
      throw new Error('资源同步模板需要维护与工具执行模式')
    await this.runtime.validateModelSelection(config.runtimeKind, config.model, config.reasoningEffort)
    return config
  }
  async save(body: unknown, actor: string, id?: string): Promise<ScheduledTask> {
    const input = await this.validate(body),
      previous = id ? this.records.getTask(id) : null
    if (previous && this.records.active(id!)) {
      if (previous.workspaceId !== input.workspaceId || previous.runtimeKind !== input.runtimeKind)
        throw new Error('任务尚未结束，不能切换工作区或引擎')
    }
    return this.records.save(input, actor, input.enabled ? nextScheduleDates(input.schedule)[0]! : '', id)
  }
  trigger(id: string, actor: string): ScheduledRun {
    const task = this.records.getTask(id)
    if (this.records.active(id)) throw new Error('任务已有排队、运行或等待审批的执行，请先处理当前执行')
    return this.records.enqueue(task, `手动执行 · ${actor}`, `manual:${randomUUID()}`, at())
  }
  start(): void {
    this.timer = setInterval(() => {
      void this.tick().catch((e) => console.error('[scheduler] tick failed', e))
    }, 2000)
    this.timer.unref()
    void this.tick().catch((e) => console.error('[scheduler] startup failed', e))
  }
  beginDrain(): void {
    this.draining = true
  }
  cancelDrain(): void {
    this.draining = false
  }
  async stop(): Promise<void> {
    this.beginDrain()
    if (this.timer) clearInterval(this.timer)
    await this.waitForIdle()
    this.scheduler.stop()
  }
  async waitForIdle(): Promise<void> {
    while (this.active.size) await new Promise((r) => setTimeout(r, 100))
  }
  health(): {
    draining: boolean
    activeTasks: number
    queuedTasks: number
    ready: boolean
    totalTasks: number
    enabledTasks: number
    recentRuns: number
    recentFailed: number
    awaitingApproval: number
  } {
    return {
      draining: this.draining,
      activeTasks: this.active.size,
      queuedTasks: this.records.listRuns({ status: 'queued', limit: 1 }).total,
      ready: this.scheduler.ready,
      totalTasks: this.records.listTasks({ limit: 1 }).total,
      enabledTasks: this.records.listTasks({ limit: 1, enabled: '1' }).total,
      recentRuns: this.records.listRuns({ from: new Date(Date.now() - 86400000).toISOString(), limit: 1 }).total,
      recentFailed: this.records.listRuns({
        status: 'failed',
        from: new Date(Date.now() - 86400000).toISOString(),
        limit: 1
      }).total,
      awaitingApproval: this.records.listRuns({ status: 'awaiting_approval', limit: 1 }).total
    }
  }
  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      if (!this.scheduler.tick(now, this.draining)) return
      this.runOrchestrator.dispatch()
    } finally {
      this.ticking = false
    }
  }
  cancel(id: string): ScheduledRun {
    const run = this.records.getRun(id)
    if (run.status === 'running') {
      this.active.get(id)?.controller.abort(new Error('已请求中断；外部副作用需要核实'))
      this.records.event(id, 'cancel', '用户请求中断，等待运行时和当前工具结束')
    } else if (['queued', 'awaiting_approval'].includes(run.status)) {
      for (const action of run.actions)
        if (['queued', 'awaiting_approval'].includes(action.status))
          this.records.updateAction(action.id, { status: 'rejected', error: '任务已取消' })
      this.records.updateRun(id, { status: 'cancelled', completedAt: at(), error: '用户取消了本次执行' })
    } else throw new Error('当前执行已结束')
    return this.records.getRun(id)
  }
  async retryDelivery(id: string): Promise<ScheduledRun> {
    const run = this.records.getRun(id)
    if (
      run.deliveryStatus !== 'failed' ||
      !['completed', 'warning', 'failed', 'interrupted', 'no_change'].includes(run.status) ||
      !run.report
    )
      throw new Error('该执行尚无可投递的最终结果')
    await this.deliver(run)
    return this.records.getRun(id)
  }
  private async execute(run: ScheduledRun, controller: AbortController): Promise<void> {
    const timer = setTimeout(
      () => controller.abort(new Error('任务达到运行时限，已请求中断；请核实外部操作状态')),
      run.snapshot.timeoutMinutes * 60000
    )
    timer.unref()
    try {
      const workspace = this.hub.getWorkspace(run.workspaceId)
      if (realpathSync.native(workspace.path) !== realpathSync.native(run.snapshot.workspacePath))
        throw new Error('工作区路径已变化，请重新运行任务')
      this.records.event(
        run.id,
        'start',
        run.coreThreadId ? '恢复当前任务的工具结果续写' : '开始执行，配置快照已保存',
        { revision: run.snapshot.revision }
      )
      for (const action of this.records.actions(run.id))
        if (action.status === 'queued') await this.executeAction(action, controller.signal)
      const latest = this.records.latest(run.taskId, true),
        actions = this.records.actions(run.id)
      const replacements: Record<string, string> = {
        current_time: at(),
        run_id: run.id,
        last_success_at: latest?.completedAt || '首次执行',
        last_result_summary: latest?.report.slice(0, 8000) || '无上次结果'
      }
      const prompt = run.snapshot.prompt.replace(/\{\{\s*(\w+)\s*\}\}/gu, (m, k: string) => replacements[k] ?? m)
      let lastProgress = 0
      const task = this.records.getTask(run.taskId)
      const report = await this.runtime.executeScheduled({
        runId: run.id,
        taskId: run.taskId,
        workspacePath: run.snapshot.workspacePath,
        workspacePrompt: run.snapshot.workspacePrompt,
        coreThreadId:
          run.coreThreadId ||
          (run.snapshot.contextMode === 'reuse' && task.revision === run.snapshot.revision ? task.coreThreadId : ''),
        config: run.snapshot,
        signal: controller.signal,
        prompt: [
          prompt,
          `运行参数：${JSON.stringify(replacements)}`,
          latest?.report ? `上次成功结果摘要（历史参考，重新核实变化事实）：\n${latest.report.slice(0, 8000)}` : '',
          actions.length ? `本轮工具包的真实状态（已拒绝/过期的操作不得重新申请）：\n${JSON.stringify(actions)}` : ''
        ]
          .filter(Boolean)
          .join('\n\n'),
        onThread: (id) => {
          this.records.updateRun(run.id, { coreThreadId: id })
          if (run.snapshot.contextMode === 'reuse')
            this.records.db
              .prepare('UPDATE scheduled_tasks SET core_thread_id=? WHERE id=? AND revision=?')
              .run(id, run.taskId, run.snapshot.revision)
        },
        onModel: (model) =>
          this.records.updateRun(run.id, { model: model.model, reasoningEffort: model.reasoningEffort }),
        onProgress: (text) => {
          if (Date.now() - lastProgress > 1500) {
            lastProgress = Date.now()
            this.records.updateRun(run.id, { report: text.slice(-100000) })
          }
        }
      })
      const updated = this.records.getRun(run.id),
        unreported = updated.actions.some(
          (a) =>
            ['completed', 'failed', 'rejected', 'expired'].includes(a.status) &&
            !actions.some((old) => old.id === a.id && old.status === a.status)
        ),
        pending = updated.actions.some((a) => a.status === 'awaiting_approval'),
        queued = updated.actions.some((a) => a.status === 'queued')
      if (pending || queued || unreported) {
        this.records.updateRun(run.id, {
          status: queued || (!pending && unreported) ? 'queued' : 'awaiting_approval',
          report: report.slice(0, 100000)
        })
        this.records.event(run.id, 'approval', '任务已保存，等待人工处理后续写原 Thread')
        return
      }
      const syncEvent = updated.events.findLast(
        (e) => e.phase === 'completed' && e.data && typeof e.data === 'object' && 'skills' in e.data
      )
      const syncResult = syncEvent?.data as
        | {
            before?: string
            after?: string
            submodules?: Array<{ before: string; after: string }>
            skills?: { installed: number; updated: number }
            warnings?: string[]
          }
        | undefined
      const missedSync = run.snapshot.template === 'workspace_sync' && !syncEvent
      const warning =
        missedSync ||
        updated.actions.some((a) => ['failed', 'rejected', 'expired'].includes(a.status)) ||
        Boolean(syncResult?.warnings?.length)
      const noChange = Boolean(
        syncResult &&
          syncResult.before === syncResult.after &&
          !syncResult.submodules?.some((m) => m.before !== m.after) &&
          !syncResult.skills?.installed &&
          !syncResult.skills?.updated &&
          !run.snapshot.sync.sourceIds.length &&
          !warning
      )
      this.records.updateRun(run.id, {
        status: warning ? 'warning' : noChange ? 'no_change' : 'completed',
        report: (missedSync ? '本轮 AI 未完成受管同步调用，不能视为资源已更新。\n\n' : '') + report.slice(0, 100000),
        completedAt: at()
      })
      this.records.event(run.id, 'finish', '报告已保存，投递状态单独记录')
      await this.deliver(this.records.getRun(run.id))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.records.updateRun(run.id, {
        status: controller.signal.aborted ? 'interrupted' : 'failed',
        error: detail.slice(0, 10000),
        completedAt: at()
      })
      this.records.event(run.id, 'error', detail)
      const current = this.records.getRun(run.id)
      if (!current.report) this.records.updateRun(run.id, { report: `任务未完成：${detail}` })
      await this.deliver(this.records.getRun(run.id)).catch(() => undefined)
    } finally {
      clearTimeout(timer)
    }
  }
  private async deliver(run: ScheduledRun): Promise<void> {
    const output = run.snapshot.output
    if (
      !output.botId ||
      !output.chatId ||
      (output.when === 'attention' && ['completed', 'no_change'].includes(run.status))
    )
      return
    if (
      !Number(
        this.records.db
          .prepare(
            "UPDATE scheduled_runs SET delivery_status='pending',delivery_error='' WHERE id=? AND delivery_status IN ('none','failed')"
          )
          .run(run.id).changes
      )
    )
      return
    try {
      const cards = feishuMarkdownCards(`**任务状态：${run.status}**\n\n${run.report || run.error}`, {
        note: `定时任务：${run.taskName} | 执行：${run.id} | Thread：${run.coreThreadId || '无'}`
      })
      for (let i = 0; i < cards.length; i++) {
        if (run.events.some((e) => e.phase === 'delivery_part' && (e.data as { index?: number })?.index === i)) continue
        await this.transport.send(output.botId, output.chatId, cards[i]!, `scheduled:${run.id}:report:${i}`)
        this.records.event(run.id, 'delivery_part', '报告分段已发送', { index: i })
      }
      this.records.updateRun(run.id, { deliveryStatus: 'sent', deliveryError: '' })
      this.records.event(run.id, 'delivery', '结果已投递')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.records.updateRun(run.id, { deliveryStatus: 'failed', deliveryError: detail })
      this.records.event(run.id, 'delivery_failed', '结果投递失败，可单独重发', { error: detail })
    }
  }
  private verify(run: ScheduledRun): Promise<unknown> {
    return this.runtime.workspaceResources(run.snapshot.workspacePath, '', run.snapshot.runtimeKind).then((result) => ({
      skillCount: result.skills.filter((s) => s.enabled).length,
      skills: result.skills.filter((s) => s.enabled).map((s) => s.name),
      knowledgeCount: result.knowledge.length,
      knowledgeRoots: result.knowledgeRoots
    }))
  }
  async invoke(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const run = this.records.getRun(id),
      active = this.active.get(id)
    if (!active || run.status !== 'running') throw new Error('任务不在活动执行状态')
    active.controller.signal.throwIfAborted()
    if (tool === 'inspect_workspace') {
      const result = await inspectWorkspace(run.snapshot.workspacePath)
      this.records.event(id, 'inspect', '工作区状态已检查', result)
      return result
    }
    if (tool === 'verify_resources') {
      const result = await this.verify(run)
      this.records.event(id, 'verify', '资源识别结果', result)
      return result
    }
    if (tool === 'sync_workspace') {
      if (run.snapshot.mode !== 'maintenance') throw new Error('当前任务未授权工作区维护')
      const selection = z
        .object({
          preserveLocalFiles: z.array(z.string().min(1).max(1000)).max(100).optional(),
          submodulePaths: z.array(z.string().min(1).max(1000)).max(200).optional()
        })
        .strict()
        .parse(args)
      const allowedFiles = run.snapshot.sync.preserveLocalFiles || []
      if (selection.preserveLocalFiles?.some((file) => !allowedFiles.includes(file)))
        throw new Error('保留文件超出任务配置范围，请先在任务配置中添加')
      if (selection.submodulePaths?.some((file) => !run.snapshot.sync.submodules.some((m) => m.path === file)))
        throw new Error('子模块超出任务配置范围，请先在任务配置中添加')
      const syncConfig = {
        ...run.snapshot.sync,
        preserveLocalFiles: selection.preserveLocalFiles ?? allowedFiles,
        submodules:
          selection.submodulePaths === undefined
            ? run.snapshot.sync.submodules
            : run.snapshot.sync.submodules.filter((m) => selection.submodulePaths!.includes(m.path))
      }
      if (run.events.some((e) => e.phase === 'completed' && e.data && typeof e.data === 'object' && 'skills' in e.data))
        throw new Error('本轮同步已经完成，请使用现有结果，不重复应用')
      try {
        return await this.sync.run({
          workspaceId: run.workspaceId,
          workspacePath: run.snapshot.workspacePath,
          runId: run.id,
          config: syncConfig,
          signal: active.controller.signal,
          event: (phase, message, data) => this.records.event(id, phase, message, data),
          maintain: (action) =>
            this.runtime.workspaceAccess.maintain(run.snapshot.workspacePath, id, action, active.controller.signal),
          syncSource: async (source) => {
            const result = await this.skills.sync(source)
            if (run.snapshot.sync.installSkills && !result.source.autoInstall) {
              const installed = await this.skills.install({ sourceId: source, workspaceId: run.workspaceId, all: true })
              if (installed.errors.length) throw new Error(installed.errors.join('; '))
              return { ...result, installation: installed }
            }
            return result
          },
          verify: () => this.verify(run)
        })
      } catch (error) {
        if (error && typeof error === 'object' && 'workspaceNeedsReview' in error && error.workspaceNeedsReview)
          this.runtime.workspaceAccess.pause(run.snapshot.workspacePath, String(error))
        throw error
      }
    }
    if (tool === 'invoke_tool_package') return this.requestAction(run, args)
    throw new Error('未知的定时任务工具')
  }
  private async requestAction(run: ScheduledRun, args: Record<string, unknown>): Promise<unknown> {
    if (run.snapshot.mode !== 'maintenance' || !run.snapshot.toolPackageIds.includes(String(args.packageId)))
      throw new Error('本任务未授权该工具包')
    const pack = this.hub.getToolPackage(String(args.packageId))
    if (!pack.enabled || pack.workspaceId !== run.workspaceId) throw new Error('工具包已停用或工作区不一致')
    if (run.actions.some((a) => a.packageId === pack.id && ['rejected', 'expired'].includes(a.status)))
      throw new Error('该工具包本轮已被拒绝或过期，不得重复申请')
    const input =
      args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : {}
    const canonical = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(canonical)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, canonical(x)])
            )
          : v
    const key = createHash('sha256')
        .update(JSON.stringify([pack.id, canonical(input)]))
        .digest('hex'),
      old = this.records.db
        .prepare('SELECT id FROM scheduled_actions WHERE run_id=? AND request_key=?')
        .get(run.id, key) as { id: string } | undefined
    if (old) return this.records.action(old.id)
    if (run.actions.length >= 10) throw new Error('本轮工具包申请次数达到上限')
    const action = this.records.createAction(
      {
        id: randomUUID(),
        runId: run.id,
        packageId: pack.id,
        packageName: pack.name,
        arguments: input,
        reason: String(args.reason || '').slice(0, 4000),
        status: pack.approvalRequired ? 'awaiting_approval' : 'queued',
        botId: run.snapshot.output.botId,
        chatId: run.snapshot.output.chatId,
        cardMessageId: '',
        operatorId: '',
        createdAt: at(),
        expiresAt: new Date(Date.now() + 6 * 3600000).toISOString(),
        packageUpdatedAt: pack.updatedAt,
        toolVersions: Object.fromEntries(pack.steps.map((s) => [s.toolId, this.hub.getTool(s.toolId).updatedAt])),
        result: null,
        error: ''
      },
      key
    )
    this.records.event(run.id, 'tool_request', `申请工具包：${pack.name}`, {
      actionId: action.id,
      status: action.status,
      arguments: input
    })
    if (pack.approvalRequired) {
      try {
        const card = feishuTextCard(
          pack.cardTitle || `确认执行：${pack.name}`,
          `${pack.cardDescription}\n\n**定时任务**：${run.taskName}\n\n**原因**：${action.reason}\n\n**参数**\n\`\`\`json\n${JSON.stringify(input, null, 2).slice(0, 8000)}\n\`\`\``,
          {
            color: 'orange',
            note: `任务执行：${run.id} | 请求：${action.id} | 6 小时后过期`,
            actions: [
              {
                text: '确认执行',
                type: 'primary',
                value: { action: 'scheduled_tool_approve', botId: action.botId, executionId: action.id }
              },
              {
                text: '拒绝',
                type: 'danger',
                value: { action: 'scheduled_tool_reject', botId: action.botId, executionId: action.id }
              }
            ]
          }
        )
        const cardMessageId = await this.transport.send(
          action.botId,
          action.chatId,
          card,
          `scheduled-approval:${action.id}`
        )
        this.records.updateAction(action.id, { cardMessageId })
      } catch (error) {
        this.records.updateAction(action.id, { status: 'failed', error: `发送审批卡失败：${String(error)}` })
        throw error
      }
    } else await this.executeAction(action, this.active.get(run.id)!.controller.signal)
    return this.records.action(action.id)
  }
  private async executeAction(action: ScheduledAction, signal: AbortSignal): Promise<void> {
    const run = this.records.getRun(action.runId),
      pack = this.hub.getToolPackage(action.packageId)
    if (!this.records.updateAction(action.id, { status: 'running' }, 'queued')) return
    try {
      if (!run.snapshot.toolPackageIds.includes(pack.id) || !pack.enabled || pack.workspaceId !== run.workspaceId)
        throw new Error('工具包授权已失效')
      if (
        pack.updatedAt !== action.packageUpdatedAt ||
        pack.steps.some((s) => this.hub.getTool(s.toolId).updatedAt !== action.toolVersions[s.toolId])
      )
        throw new Error('工具或工具包配置已变化，请重新发起任务以确认最新操作')
      signal.throwIfAborted()
      const result = await this.runtime.workspaceAccess.use(
        run.snapshot.workspacePath,
        () => this.runner.run(pack, action.arguments, run.snapshot.workspacePath),
        run.id,
        signal
      )
      this.records.updateAction(action.id, { status: 'completed', result })
      this.records.event(run.id, 'tool_completed', `工具包 ${pack.name} 完成`, { actionId: action.id, result })
    } catch (error) {
      this.records.updateAction(action.id, { status: 'failed', error: String(error) })
      this.records.event(run.id, 'tool_failed', `工具包 ${pack.name} 未完成`, {
        actionId: action.id,
        error: String(error)
      })
    }
    const current = this.records.action(action.id)
    if (current.cardMessageId)
      await this.transport
        .update(
          current.botId,
          current.cardMessageId,
          feishuTextCard(
            `${current.status === 'completed' ? '执行完成' : '执行失败'}：${pack.name}`,
            current.error || '工具结果已保存，AI 将继续原定时任务。',
            { color: current.status === 'completed' ? 'green' : 'red', note: `执行：${run.id}` }
          )
        )
        .catch(() => undefined)
  }
  async onAction(botId: string, actorId: string, actionId: string, reject: boolean): Promise<Record<string, unknown>> {
    const action = this.records.action(actionId)
    if (action.botId !== botId) return { toast: { type: 'error', content: '审批不属于当前 Bot' } }
    if (!(await this.transport.mayApprove(botId, action.packageId, actorId)))
      return { toast: { type: 'error', content: `当前 Bot 身份 ${actorId} 没有工具包审批权限` } }
    const run = this.records.getRun(action.runId)
    if (!['running', 'awaiting_approval'].includes(run.status) || action.expiresAt <= at())
      return { toast: { type: 'warning', content: '审批已过期或任务已结束' } }
    if (
      !this.records.updateAction(
        action.id,
        { status: reject ? 'rejected' : 'queued', operatorId: actorId, error: reject ? '人工拒绝' : '' },
        'awaiting_approval'
      )
    )
      return { toast: { type: 'info', content: '请求已经处理' } }
    this.records.event(
      run.id,
      reject ? 'approval_rejected' : 'approval_granted',
      `${actorId} ${reject ? '拒绝' : '确认'}了 ${action.packageName}`,
      { actionId }
    )
    if (!this.active.has(run.id)) this.records.updateRun(run.id, { status: 'queued' })
    if (action.cardMessageId)
      void this.transport
        .update(
          botId,
          action.cardMessageId,
          feishuTextCard(
            reject ? '已拒绝执行' : '已确认，等待任务续写',
            `工具包：${action.packageName}\n操作人：${actorId}`,
            { color: reject ? 'red' : 'blue' }
          )
        )
        .catch(() => undefined)
    return { toast: { type: 'success', content: reject ? '已拒绝，不执行该操作' : '已确认，进入定时任务执行队列' } }
  }
}
