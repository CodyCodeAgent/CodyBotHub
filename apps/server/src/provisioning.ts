import { registerApp } from '@larksuiteoapi/node-sdk'
import type { SecretVault } from './crypto.js'
import type { HubStore } from './db.js'
import type { AgentRuntimeKind, BotMessagePolicy, ProvisioningJobRecord } from './types.js'

export interface ProvisioningRequest {
  name: string
  description: string
  prompt: string
  permissions: string[]
  operatorIds: string[]
  conversationMode: 'chat' | 'topic'
  botMessagePolicy: BotMessagePolicy
  mentionSourceBot: boolean
  botSourceAllowlist: string[]
  maxBotReplyDepth: number
  runtimeKind: AgentRuntimeKind
  model: string
  reasoningEffort: string
  defaultWorkspaceId: string
  workspaceIds: string[]
}

export class FeishuProvisioningService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly store: HubStore, private readonly vault: SecretVault, private readonly onCompleted: () => void | Promise<void>) {
    this.store.failInterruptedProvisioningJobs()
  }

  start(request: ProvisioningRequest): ProvisioningJobRecord {
    const job = this.store.createProvisioningJob(request as unknown as Record<string, unknown>)
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    void this.run(job.id, request, controller).finally(() => this.controllers.delete(job.id))
    return job
  }

  list(): ProvisioningJobRecord[] { return this.store.listProvisioningJobs() }
  get(id: string): ProvisioningJobRecord { return this.store.getProvisioningJob(id) }

  cancel(id: string): ProvisioningJobRecord {
    const job = this.store.getProvisioningJob(id)
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job
    this.controllers.get(id)?.abort()
    return this.store.updateProvisioningJob(id, { status: 'cancelled', error: '用户取消扫码注册' })
  }

  private async run(id: string, request: ProvisioningRequest, controller: AbortController): Promise<void> {
    try {
      const result = await registerApp({
        signal: controller.signal,
        source: 'cody-bot-hub',
        onQRCodeReady: info => this.store.updateProvisioningJob(id, { status: 'waiting_scan', qrUrl: info.url, expiresAt: new Date(Date.now() + info.expireIn * 1000).toISOString() }),
        onStatusChange: info => { if (info.status !== 'slow_down') console.info(`[provisioning:${id}] ${info.status}`) },
      })
      if (controller.signal.aborted) return
      if (!result.client_id || !result.client_secret) throw new Error('飞书注册接口没有返回 App ID 或 App Secret')
      this.store.updateProvisioningJob(id, { status: 'creating', qrUrl: '' })
      const bot = this.store.createBot({ ...request, appId: result.client_id, appSecretEncrypted: this.vault.encrypt(result.client_secret) })
      this.store.updateProvisioningJob(id, { status: 'completed', botId: bot.id, error: '' })
      await this.onCompleted()
    } catch (error) {
      if (controller.signal.aborted) return
      const code = (error as { code?: string }).code
      const message = code === 'expired_token' ? '二维码已过期，请重试' : code === 'access_denied' ? '用户拒绝了应用创建授权' : error instanceof Error ? error.message.replace(/[A-Za-z0-9_-]{30,}/gu, '[REDACTED]') : '自动注册失败'
      this.store.updateProvisioningJob(id, { status: 'failed', error: message.slice(0, 800), qrUrl: '' })
    }
  }
}
