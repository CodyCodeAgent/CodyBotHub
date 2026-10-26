import { FeishuProvider, feishuTextCard, type FeishuCardAction } from '@codycodeagent/cody-web-core/feishu'
import type { HubStore } from '../db.js'
import { FeishuPresentation } from './presentation.js'

export class FeishuApproval {
  constructor(
    private readonly store: HubStore,
    private readonly presentation: FeishuPresentation,
    private readonly queueTool: (executionId: string) => void,
    private readonly continueTool: (execution: ReturnType<HubStore['getToolPackageExecution']>, provider: FeishuProvider) => void,
  ) {}

  async mayApproveScheduled(botId: string, packageId: string, actorId: string, provider?: FeishuProvider): Promise<boolean> {
    const bot = this.store.listBots().find(b => b.id === botId), pack = this.store.getToolPackage(packageId)
    if (!bot || !bot.workspaceIds.includes(pack.workspaceId)) return false
    if (pack.approverIds.includes(actorId) || bot.operatorIds.includes(actorId)) return true
    if (pack.approverIds.length || bot.operatorIds.length || !provider) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return (await Promise.race([provider.applicationAdministrators(), new Promise<never>((_, reject) => { timer=setTimeout(()=>reject(new Error('管理员身份查询超时')),1200) })])).administratorIds.includes(actorId) }
    catch { return false } finally { if(timer)clearTimeout(timer) }
  }

  async onToolPackageAction(botId: string, provider: FeishuProvider, action: FeishuCardAction): Promise<Record<string, unknown>> {
    if (action.value.botId !== botId) return { toast: { type: 'warning', content: '这个操作已失效' } }
    const executionId = String(action.value.executionId ?? '')
    const execution = this.store.getToolPackageExecution(executionId)
    if (execution.botId !== botId) return { toast: { type: 'warning', content: '这个操作不属于当前 Bot' } }
    if (execution.status !== 'awaiting_approval') return { toast: { type: 'info', content: `当前状态：${execution.status}` } }
    const pack = this.store.getToolPackage(execution.toolPackageId)
    const bot = this.store.listBots().find(item => item.id === botId)
    let allowed = pack.approverIds.includes(action.actorId) || Boolean(bot?.operatorIds.includes(action.actorId))
    if (!pack.approverIds.length && !bot?.operatorIds.length) {
      try {
        const administrators = await Promise.race([
          provider.applicationAdministrators(),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('administrator lookup timed out')), 1_200)),
        ])
        allowed = administrators.administratorIds.includes(action.actorId)
      } catch { allowed = false }
    }
    if (!allowed) {
      console.warn(`[feishu] tool package approval denied: execution=${execution.id} package=${pack.id} bot=${botId} actor=${action.actorId}`)
      return { toast: { type: 'error', content: `当前 Bot 身份 ${action.actorId} 不在工具包审批人或 Bot 操作人列表中` } }
    }
    if (action.value.action === 'tool_package_reject') {
      const rejected = this.store.transitionToolPackageExecution(execution.id, 'awaiting_approval', 'rejected', action.actorId, new Date().toISOString())
      if (!rejected) return { toast: { type: 'info', content: '这个请求已经被处理' } }
      if (action.remoteMessageId) void this.presentation.retryDelivery(provider, () => provider.updateCard(action.remoteMessageId, feishuTextCard(`已拒绝：${pack.name}`, `操作人 ${action.actorId} 拒绝了本次执行。`, { color: 'red', note: `执行 ID：${execution.id}` }))).catch(error => console.warn('[feishu] failed to patch rejected tool card:', error))
      this.continueTool(rejected, provider)
      return { toast: { type: 'success', content: '已拒绝执行' } }
    }
    const queued = this.store.transitionToolPackageExecution(execution.id, 'awaiting_approval', 'queued', action.actorId)
    if (!queued) return { toast: { type: 'info', content: '这个请求已经被处理' } }
    if (action.remoteMessageId) void this.presentation.retryDelivery(provider, () => provider.updateCard(action.remoteMessageId, feishuTextCard(`已确认：${pack.name}`, '已进入当前 Thread Channel 的串行执行队列。', { color: 'blue', note: `执行 ID：${execution.id}` }))).catch(error => console.warn('[feishu] failed to patch approved tool card:', error))
    this.queueTool(execution.id)
    return { toast: { type: 'success', content: '已确认，开始执行' } }
  }
}
