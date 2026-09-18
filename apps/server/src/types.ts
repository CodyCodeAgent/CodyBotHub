export interface WorkspaceRecord {
  id: string
  name: string
  path: string
  prompt: string
  createdAt: string
  updatedAt: string
}

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
  model: string
  reasoningEffort: string
  defaultWorkspaceId: string
  workspaceIds: string[]
  createdAt: string
  updatedAt: string
}

export interface ResolvedRoute {
  bot: BotRecord
  workspace: WorkspaceRecord
  scene: (SceneRecord & { skillPackageIds: string[] }) | null
  skillPackages: SkillPackageRecord[]
  conversationMode: 'chat' | 'topic'
  replyInTopic: boolean
  routeSource: 'topic_context' | 'group_binding' | 'matcher' | 'default'
  conversationKey: string
  topicId: string
  turnInstructions: string
  modelConfig: ResolvedModelConfig
  threadRouting: ThreadRoutingDecision
}

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
  conversationKey: string
  botId: string
  workspaceId: string
  sceneId: string
  title: string
  fields: Record<string, string>
  normalizedText: string
  experienceSummary: string
  messageCount: number
  lastMessageLogId: string
  lastActiveAt: string
  updatedAt: string
}

export type ModelConfigSource = 'scene' | 'bot' | 'platform' | 'codex'
export interface ResolvedModelConfig {
  model: string
  reasoningEffort: string
  modelSource: ModelConfigSource
  reasoningEffortSource: ModelConfigSource
  fallbackEnabled: boolean
}

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

export interface SceneRecord {
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

export interface SkillPackageRecord {
  id: string
  workspaceId: string
  name: string
  description: string
  prompt: string
  skills: string[]
  fallbackMode: 'package_first' | 'mixed' | 'package_only'
  createdAt: string
  updatedAt: string
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
  threadRouting: ThreadRoutingDecision
  receivedAt: string
  startedAt: string
  completedAt: string
  durationMs: number | null
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
  status: 'available' | 'installed' | 'update_available' | 'conflict' | 'local'
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
  botId: string
  botName: string
  conversationMode: 'chat' | 'topic'
  chatId: string
  chatName: string
  chatMode: 'group' | 'topic' | 'p2p' | ''
  topicId: string
  coreThreadId: string
  createdAt: string
  updatedAt: string
}
