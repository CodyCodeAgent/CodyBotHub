import type { AgentRuntimeKind, ModelConfigSource } from './platform.js'

export type ThreadRoutingDecisionType = 'fixed' | 'new' | 'reused' | 'experience'
export interface ThreadRoutingDecision {
  type: ThreadRoutingDecisionType
  matchedThreadId: string
  score: number
  reason: string
}

export interface ThreadRoutingRuleRecord {
  sceneId: string
  sceneName: string
  botId: string
  botName: string
  workspaceId: string
  workspaceName: string
  enabled: boolean
  reuseThreshold: number
  experienceThreshold: number
  timeWindowHours: number
  maxCandidates: number
  structuredWeight: number
  textWeight: number
  profileCount: number
  updatedAt: string
}

export interface ThreadProfileRecord {
  coreThreadId: string
  threadChannelId: string
  botId: string
  workspaceId: string
  sceneId: string
  runtimeKind: AgentRuntimeKind
  title: string
  fields: Record<string, string>
  normalizedText: string
  experienceSummary: string
  messageCount: number
  lastMessageLogId: string
  lastActiveAt: string
  updatedAt: string
}

export interface SceneRecord {
  requireMention: boolean
  turnTimeoutMinutes: number
  completionStatisticsEnabled: boolean
  id: string
  botId: string
  workspaceId: string
  name: string
  prompt: string
  priority: number
  enabled: boolean
  model: string
  reasoningEffort: string
  retrieval: {
    skillBoosts: Array<{ keyword: string; weight: number }>
    skillCandidateLimit: number
    knowledgeCandidateLimit: number
    minimumScore: number
  }
  matcher: {
    chatIds: string[]
    messageTypes: string[]
    textIncludes: string[]
    cardTitleIncludes: string[]
  }
  createdAt: string
  updatedAt: string
}

export type SceneView = SceneRecord & { skillPackageIds: string[] }

export interface SkillPackageRecord {
  id: string
  workspaceId: string
  name: string
  description: string
  prompt: string
  skills: string[]
  toolPackageIds: string[]
  fallbackMode: 'package_first' | 'mixed' | 'package_only'
  createdAt: string
  updatedAt: string
}

export type ToolExecutorType = 'bits_rpc' | 'command'
export type ToolScriptLanguage = 'python' | 'shell' | 'node'
export interface BitsRpcConfig {
  service: string
  method: string
  vregion: string
  environment: string
  cluster: string
  requestTemplate: Record<string, unknown>
}
export interface ToolRecord {
  id: string
  workspaceId: string
  name: string
  description: string
  executorType: ToolExecutorType
  command: string
  argumentsTemplate: string[]
  inputSchema: Record<string, unknown>
  rpcConfig: BitsRpcConfig
  scriptLanguage: ToolScriptLanguage | ''
  scriptContent: string
  scriptVersion: number
  timeoutSeconds: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ToolScriptVersionRecord {
  toolId: string
  version: number
  language: ToolScriptLanguage
  content: string
  createdAt: string
}

export interface ToolPackageStepRecord {
  toolId: string
  toolName: string
  phase: 'precheck' | 'execute' | 'verify'
  position: number
  arguments: Record<string, unknown>
}

export interface ToolPackageRecord {
  id: string
  workspaceId: string
  name: string
  description: string
  prompt: string
  approvalRequired: boolean
  approverIds: string[]
  cardTitle: string
  cardDescription: string
  enabled: boolean
  steps: ToolPackageStepRecord[]
  createdAt: string
  updatedAt: string
}

export type ToolPackageExecutionStatus = 'awaiting_approval' | 'queued' | 'running' | 'completed' | 'failed' | 'rejected'
export interface ToolPackageExecutionRecord {
  id: string
  callId: string
  toolPackageId: string
  toolPackageName: string
  botId: string
  sceneId: string
  chatId: string
  topicId: string
  threadChannelId: string
  coreThreadId: string
  sourceMessageId: string
  status: ToolPackageExecutionStatus
  arguments: Record<string, unknown>
  reason: string
  requestedBy: string
  approvedBy: string
  cardMessageId: string
  result: unknown
  error: string
  createdAt: string
  updatedAt: string
  completedAt: string
}

export interface InvestigationSkillRecord {
  name: string
  description: string
  path: string
}

export interface InvestigationToolRecord {
  kind: string
  title: string
  summary: string
  status: string
}

export interface InvestigationTraceRecord {
  mode: 'package_only' | 'package_first' | 'mixed' | 'workspace'
  primarySkills: InvestigationSkillRecord[]
  candidateSkills: InvestigationSkillRecord[]
  knowledgeResources: Array<{ title: string; path: string }>
  knowledgeRoots: string[]
  codeRoot: string
  tools: InvestigationToolRecord[]
}

export interface MessageLogRecord {
  id: string
  eventId: string
  messageId: string
  botId: string
  botName: string
  runtimeKind: AgentRuntimeKind
  chatId: string
  topicId: string
  senderId: string
  messageType: string
  inboundContent: string
  inboundRaw: unknown
  responseContent: string
  status: 'processing' | 'completed' | 'failed'
  error: string
  workspaceId: string
  workspaceName: string
  sceneId: string
  sceneName: string
  skillPackages: Array<{ id: string; name: string }>
  investigation: InvestigationTraceRecord
  model: string
  reasoningEffort: string
  modelSource: ModelConfigSource
  reasoningEffortSource: ModelConfigSource
  modelFallback: boolean
  coreThreadId: string
  threadChannelId: string
  threadRouting: ThreadRoutingDecision
  receivedAt: string
  startedAt: string
  completedAt: string
  durationMs: number | null
  botReplyDepth: number
}

export interface MessageAttemptRecord {
  id: string
  logId: string
  attemptNumber: number
  status: 'queued' | 'processing' | 'completed' | 'failed'
  requestedByAccountId: string
  requestedByLoginName: string
  requestedByDisplayName: string
  responseContent: string
  error: string
  model: string
  reasoningEffort: string
  startedAt: string
  completedAt: string
  durationMs: number | null
  createdAt: string
  updatedAt: string
}

export interface AdminAccountRecord {
  id: string
  loginName: string
  displayName: string
  primary: boolean
  enabled: boolean
  theme: 'system' | 'light' | 'dark'
  lastLoginAt: string
  createdAt: string
  updatedAt: string
}

export interface CopilotSessionRecord {
  id: string
  accountId: string
  workspaceId: string
  workspaceName: string
  coreThreadId: string
  toolContractVersion: number
  title: string
  createdAt: string
  updatedAt: string
}

export interface CopilotMessageRecord {
  id: string
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

export interface CopilotProposalRecord {
  id: string
  sessionId: string
  kind: 'managed_script' | 'bot_operator'
  title: string
  status: 'draft' | 'applied' | 'dismissed'
  payload: Record<string, unknown>
  result: Record<string, unknown>
  createdAt: string
  updatedAt: string
  appliedAt: string
}

export interface SkillSourceRecord {
  id: string
  name: string
  repositoryUrl: string
  branch: string
  workspaceId: string
  workspaceName: string
  skillRoots: string[]
  knowledgeRoots: string[]
  autoInstall: boolean
  lastSyncedAt: string
  lastCommit: string
  lastError: string
  createdAt: string
  updatedAt: string
}

export interface SkillInstallationRecord {
  sourceId: string
  workspaceId: string
  skillKey: string
  targetName: string
  sourcePath: string
  targetPath: string
  installedCommit: string
  sourceChecksum: string
  installedAt: string
  updatedAt: string
}

export interface SkillCatalogItem {
  key: string
  name: string
  description: string
  sourceId: string
  sourceName: string
  workspaceId: string
  workspaceName: string
  sourcePath: string
  targetPath: string
  status: 'available' | 'installed' | 'update_available' | 'conflict' | 'source_conflict' | 'local'
  conflictPaths?: string[]
  checksum: string
  installedCommit: string
}

export interface AuditLogRecord {
  id: string
  actorAccountId: string
  actorLoginName: string
  actorDisplayName: string
  action: string
  targetType: string
  targetId: string
  summary: string
  details: Record<string, unknown>
  ipAddress: string
  createdAt: string
}

export interface ChatMetadataRecord {
  botId: string
  chatId: string
  name: string
  mode: 'group' | 'topic' | 'p2p'
  updatedAt: string
}

export interface ConversationThreadRecord {
  id: string
  threadChannelId: string
  botId: string
  botName: string
  runtimeKind: AgentRuntimeKind
  conversationMode: 'chat' | 'topic'
  chatId: string
  chatName: string
  chatMode: 'group' | 'topic' | 'p2p' | ''
  topicId: string
  coreThreadId: string
  createdAt: string
  updatedAt: string
}

export interface ThreadChannelRecord {
  id: string
  botId: string
  botName: string
  runtimeKind: AgentRuntimeKind
  coreThreadId: string
  bindingCount: number
  queuedJobs: number
  processingJobs: number
  createdAt: string
  updatedAt: string
}

export interface ThreadJobRecord {
  id: string
  botId: string
  threadChannelId: string
  eventId: string
  messageId: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  attempts: number
  logId: string
  receiptReactionId: string
  error: string
  createdAt: string
  startedAt: string
  completedAt: string
  updatedAt: string
}
