export interface WorkspaceRecord {
  id: string
  name: string
  path: string
  prompt: string
  createdAt: string
  updatedAt: string
}

export type AgentRuntimeKind = 'codex' | 'traex'
export type BotMessagePolicy = 'reject' | 'mentioned' | 'mentioned_or_scene'

export interface BotRecord {
  id: string
  name: string
  description: string
  appId: string
  hasAppSecret: boolean
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
  createdAt: string
  updatedAt: string
}

export type ModelConfigSource = 'scene' | 'bot' | 'platform' | 'codex' | 'runtime'

export interface PlatformSettingsRecord {
  basePrompt: string
  defaultModel: string
  defaultReasoningEffort: string
  modelFallbackEnabled: boolean
  threadProfileRefreshIntervalSeconds: number
  threadProfileBatchSize: number
}

export interface ProvisioningJobRecord {
  id: string
  status: 'starting' | 'waiting_scan' | 'creating' | 'completed' | 'failed' | 'cancelled'
  qrUrl: string
  expiresAt: string
  error: string
  botId: string
  createdAt: string
  updatedAt: string
}
