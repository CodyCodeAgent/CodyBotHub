export type { WorkspaceRecord as Workspace, AgentRuntimeKind, ModelConfigSource, BotMessagePolicy, BotRecord as Bot, PlatformSettingsRecord as PlatformSettings, ProvisioningJobRecord as ProvisioningJob } from '@cody-bot-hub/contracts/platform'
import type { AgentRuntimeKind, BotMessagePolicy, ModelConfigSource } from '@cody-bot-hub/contracts/platform'
import type { SceneRecord, ThreadRoutingDecisionType, AdminAccountRecord, CopilotSessionRecord, CopilotMessageRecord, CopilotProposalRecord } from '@cody-bot-hub/contracts/domain'
export type { SceneView as Scene, SkillPackageRecord as SkillPackage, BitsRpcConfig, ToolRecord as Tool, ToolScriptVersionRecord as ToolScriptVersion, ToolPackageStepRecord as ToolPackageStep, ToolPackageRecord as ToolPackage, ToolPackageExecutionRecord as ToolPackageExecution, InvestigationTraceRecord as InvestigationTrace, ThreadRoutingDecisionType, ThreadRoutingDecision, ThreadRoutingRuleRecord as ThreadRoutingRule, ThreadProfileRecord as ThreadProfile, ThreadChannelRecord as ThreadChannel, ThreadJobRecord as ThreadJob, MessageLogRecord as MessageLog, MessageAttemptRecord as MessageAttempt, AdminAccountRecord as AdminAccount, CopilotSessionRecord as CopilotSession, CopilotMessageRecord as CopilotMessage, CopilotProposalRecord as CopilotProposal, AuditLogRecord as AuditLog, ChatMetadataRecord as ChatMetadata, ConversationThreadRecord as ConversationThread, SkillSourceRecord as SkillSource, SkillCatalogItem } from '@cody-bot-hub/contracts/domain'
export interface ModelOption { id: string; model: string; label: string; description: string; hidden: boolean; isDefault: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: string[] }
export interface ModelCatalog { items: ModelOption[]; defaultModel: string; defaultReasoningEffort: string }
export type Matcher = SceneRecord['matcher']
export type RetrievalConfig = SceneRecord['retrieval']
export interface ThreadRoutingDecisionRecord { logId: string; messageId: string; inboundContent: string; sceneName: string; type: ThreadRoutingDecisionType; threadChannelId: string; coreThreadId: string; matchedThreadId: string; score: number; reason: string; receivedAt: string }
export type ThemePreference = AdminAccountRecord['theme']
export interface CopilotState { session: CopilotSessionRecord; messages: CopilotMessageRecord[]; proposals: CopilotProposalRecord[] }
export interface WorkspaceResources { codeRoot: string; knowledgeRoots: string[]; knowledge: Array<{ title: string; description: string; path: string; relativePath: string; updatedAt: string }>; knowledgeTotal: number; skills: Array<{ name: string; path: string; displayName: string; description: string; scope: 'repo'|'user'|'system'|'admin'; enabled: boolean }> }
export interface DashboardOverview {
  workspaces: number; bots: number; scenes: number; skillPackages: number; messageLogs: number
  today: { received: number; completed: number; failed: number; processing: number; reused: number; experience: number; created: number; averageDurationMs: number }
  threads: { channels: number; bindings: number; profiles: number; queuedJobs: number; processingJobs: number }
  analytics: {
    range: { fromDate: string; toDate: string; days: number; botId: string; chatId: string; threadChannelId: string }
    total: { received: number; completed: number; failed: number; processing: number; uniqueChats: number; averageDurationMs: number }
    daily: Array<{ date: string; received: number; completed: number; failed: number; reused: number; experience: number }>
    chats: Array<{ botId: string; botName: string; chatId: string; chatName: string; chatMode: string; received: number; completed: number; failed: number; averageDurationMs: number; lastActiveAt: string }>
    scenes: Array<{ sceneId: string; sceneName: string; received: number; completed: number; failed: number }>
    routes: Array<{ type: string; count: number }>
    capabilities: {
      configuredTools: number; configuredToolPackages: number; skillPackageUses: number; toolPackageRequests: number; successfulToolCalls: number
      status: { awaitingApproval: number; queued: number; running: number; completed: number; failed: number; rejected: number }
      skillPackages: Array<{ id: string; name: string; uses: number }>
      toolPackages: Array<{ id: string; name: string; requests: number; awaitingApproval: number; queued: number; running: number; completed: number; failed: number; rejected: number; successfulToolCalls: number }>
    }
  }
}
export interface DashboardDimensions {
  groups: Array<{ botId: string; botName: string; chatId: string; chatName: string; chatMode: string; lastActiveAt: string }>
  conversations: Array<{ botId: string; botName: string; chatId: string; chatName: string; topicId: string; threadChannelId: string; coreThreadId: string; lastActiveAt: string }>
}
export interface SystemHealth {
  status: 'healthy'|'attention'
  checkedAt: string
  startedAt: string
  uptimeSeconds: number
  store: { database: { ok: boolean; result: string }; queue: { queued: number; processing: number; staleProcessing: number; oldestQueuedAt: string }; profiles: { queued: number; failed: number } }
  feishu: { draining: boolean; drainStartedAt: string; activeJobs: number; pendingReceipts: number; configuredBots: number; activeProviders: number; connectedProviders: number; scheduledJobs: number; activeChannels: number; lastQueueScanAt: string; lastError: string; providers: Array<{ botId: string; botName: string; state: string; error: string }> }
  runtime: { initialized: boolean; attachedChannels: number; engines: Array<{ kind: AgentRuntimeKind; label: string; initialized: boolean; attachedChannels: number; state: string; error: string }> }
}

export type { ScheduleConfig, WorkspaceSyncConfig, ScheduledTaskInput, ScheduledTask, ScheduledRunSummary, ScheduledRun, ScheduledRunStatus, ScheduledEvent, ScheduledAction } from '@cody-bot-hub/contracts/scheduled'
export interface SchedulerHealth { draining:boolean; activeTasks:number; queuedTasks:number; ready:boolean; totalTasks:number; enabledTasks:number; recentRuns:number; recentFailed:number; awaitingApproval:number }
export interface ScheduledTemplate {id:string;name:string;description:string;mode:'read_only'|'maintenance';prompt:string}
export interface WorkspaceRepository {root:string;branch:string;commit:string;changes:string;submodules:Array<{path:string;initialized:boolean;commit:string}>}
