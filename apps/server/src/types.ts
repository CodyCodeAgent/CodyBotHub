import type { TaskSnapshot } from '@codycodeagent/cody-web-core/task'
import type { WorkspaceRecord, AgentRuntimeKind, BotMessagePolicy, BotRecord, ModelConfigSource, PlatformSettingsRecord, ProvisioningJobRecord } from '@cody-bot-hub/contracts/platform'
import type { SceneRecord, SkillPackageRecord, ThreadRoutingDecision } from '@cody-bot-hub/contracts/domain'
export type { WorkspaceRecord, AgentRuntimeKind, BotMessagePolicy, BotRecord, ModelConfigSource, PlatformSettingsRecord, ProvisioningJobRecord } from '@cody-bot-hub/contracts/platform'
export type { ThreadRoutingDecisionType, ThreadRoutingDecision, ThreadRoutingRuleRecord, ThreadProfileRecord, SceneRecord, SkillPackageRecord, ToolExecutorType, ToolScriptLanguage, BitsRpcConfig, ToolRecord, ToolScriptVersionRecord, ToolPackageStepRecord, ToolPackageRecord, ToolPackageExecutionStatus, ToolPackageExecutionRecord, InvestigationSkillRecord, InvestigationToolRecord, InvestigationTraceRecord, MessageLogRecord, MessageAttemptRecord, AdminAccountRecord, CopilotSessionRecord, CopilotMessageRecord, CopilotProposalRecord, SkillSourceRecord, SkillInstallationRecord, SkillCatalogItem, AuditLogRecord, ChatMetadataRecord, ConversationThreadRecord, ThreadChannelRecord, ThreadJobRecord } from '@cody-bot-hub/contracts/domain'


export interface ResolvedRoute {
  bot: BotRecord
  workspace: WorkspaceRecord
  scene: (SceneRecord & { skillPackageIds: string[] }) | null
  skillPackages: SkillPackageRecord[]
  conversationMode: 'chat' | 'topic'
  replyInTopic: boolean
  routeSource: 'explicit' | 'topic_context' | 'group_binding' | 'matcher' | 'default'
  conversationKey: string
  threadChannelId: string
  topicId: string
  turnInstructions: string
  modelConfig: ResolvedModelConfig
  threadRouting: ThreadRoutingDecision
}


export interface ResolvedModelConfig {
  model: string
  reasoningEffort: string
  modelSource: ModelConfigSource
  reasoningEffortSource: ModelConfigSource
  fallbackEnabled: boolean
}



export type HubTaskProgress = {
  phase: string
  message?: string
  answer?: string
  details?: unknown
}

export type HubTaskResult = {
  text?: string
  data?: unknown
}

export type HubTaskRecord = TaskSnapshot<Record<string, unknown>, HubTaskProgress, HubTaskResult> & {
  botId: string
  sceneId: string
  threadChannelId: string
  sourceKind: string
  sourceId: string
}

export interface StoreHealthRecord {
  database: { ok: boolean; result: string }
  queue: {
    queued: number
    processing: number
    staleProcessing: number
    oldestQueuedAt: string
  }
  profiles: { queued: number; failed: number }
}

export interface FeishuManagerHealthRecord {
  draining: boolean
  drainStartedAt: string
  activeJobs: number
  pendingReceipts: number
  configuredBots: number
  activeProviders: number
  connectedProviders: number
  scheduledJobs: number
  activeChannels: number
  lastQueueScanAt: string
  lastError: string
  providers: Array<{ botId: string; botName: string; state: string; error: string }>
}

export interface DeploymentStatusRecord {
  draining: boolean
  drainStartedAt: string
  activeJobs: number
  pendingReceipts: number
  activeChannels: number
  queuedJobs: number
}

export interface SystemHealthRecord {
  status: 'healthy' | 'attention'
  checkedAt: string
  startedAt: string
  uptimeSeconds: number
  store: StoreHealthRecord
  feishu: FeishuManagerHealthRecord
  runtime: { initialized: boolean; attachedChannels: number; engines: Array<{ kind: AgentRuntimeKind; label: string; initialized: boolean; attachedChannels: number; state: string; error: string }> }
}
