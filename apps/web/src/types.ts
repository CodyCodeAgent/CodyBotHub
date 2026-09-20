export interface Workspace { id: string; name: string; path: string; prompt: string; createdAt: string; updatedAt: string }
export type ModelConfigSource = 'scene'|'bot'|'platform'|'codex'
export interface ModelOption { id: string; model: string; label: string; description: string; hidden: boolean; isDefault: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: string[] }
export interface ModelCatalog { items: ModelOption[]; defaultModel: string; defaultReasoningEffort: string }
export interface PlatformSettings { basePrompt: string; defaultModel: string; defaultReasoningEffort: string; modelFallbackEnabled: boolean; threadProfileRefreshIntervalSeconds: number; threadProfileBatchSize: number }
export interface Bot { id: string; name: string; description: string; appId: string; hasAppSecret: boolean; prompt: string; permissions: string[]; operatorIds: string[]; conversationMode: 'chat' | 'topic'; model: string; reasoningEffort: string; defaultWorkspaceId: string; workspaceIds: string[]; createdAt: string; updatedAt: string }
export interface Matcher { chatIds: string[]; messageTypes: string[]; textIncludes: string[]; cardTitleIncludes: string[] }
export interface RetrievalConfig { skillBoosts: Array<{ keyword: string; weight: number }>; skillCandidateLimit: number; knowledgeCandidateLimit: number; minimumScore: number }
export interface Scene { id: string; botId: string; workspaceId: string; name: string; prompt: string; priority: number; enabled: boolean; model: string; reasoningEffort: string; retrieval: RetrievalConfig; matcher: Matcher; skillPackageIds: string[]; createdAt: string; updatedAt: string }
export interface SkillPackage { id: string; workspaceId: string; name: string; description: string; prompt: string; skills: string[]; fallbackMode: 'package_first' | 'mixed' | 'package_only'; createdAt: string; updatedAt: string }
export interface ProvisioningJob { id: string; status: 'starting'|'waiting_scan'|'creating'|'completed'|'failed'|'cancelled'; qrUrl: string; expiresAt: string; error: string; botId: string; createdAt: string; updatedAt: string }
export interface InvestigationTrace { mode: 'package_only'|'package_first'|'mixed'|'workspace'; primarySkills: Array<{ name: string; description: string; path: string }>; candidateSkills: Array<{ name: string; description: string; path: string }>; knowledgeResources: Array<{ title: string; path: string }>; knowledgeRoots: string[]; codeRoot: string; tools: Array<{ kind: string; title: string; summary: string; status: string }> }
export type ThreadRoutingDecisionType = 'fixed'|'new'|'reused'|'experience'
export interface ThreadRoutingDecision { type: ThreadRoutingDecisionType; matchedThreadId: string; score: number; reason: string }
export interface ThreadRoutingRule { sceneId: string; sceneName: string; botId: string; botName: string; workspaceId: string; workspaceName: string; enabled: boolean; reuseThreshold: number; experienceThreshold: number; timeWindowHours: number; maxCandidates: number; structuredWeight: number; textWeight: number; profileCount: number; updatedAt: string }
export interface ThreadProfile { coreThreadId: string; threadChannelId: string; botId: string; workspaceId: string; sceneId: string; title: string; fields: Record<string, string>; normalizedText: string; experienceSummary: string; messageCount: number; lastMessageLogId: string; lastActiveAt: string; updatedAt: string }
export interface ThreadRoutingDecisionRecord { logId: string; messageId: string; inboundContent: string; sceneName: string; type: ThreadRoutingDecisionType; threadChannelId: string; coreThreadId: string; matchedThreadId: string; score: number; reason: string; receivedAt: string }
export interface ThreadChannel { id: string; botId: string; botName: string; coreThreadId: string; bindingCount: number; queuedJobs: number; processingJobs: number; createdAt: string; updatedAt: string }
export interface ThreadJob { id: string; botId: string; threadChannelId: string; eventId: string; messageId: string; status: 'queued'|'processing'|'completed'|'failed'; attempts: number; logId: string; receiptReactionId: string; error: string; createdAt: string; startedAt: string; completedAt: string; updatedAt: string }
export interface MessageLog { id: string; eventId: string; messageId: string; botId: string; botName: string; chatId: string; topicId: string; senderId: string; messageType: string; inboundContent: string; inboundRaw: unknown; responseContent: string; status: 'processing'|'completed'|'failed'; error: string; workspaceId: string; workspaceName: string; sceneId: string; sceneName: string; skillPackages: Array<{ id: string; name: string }>; investigation: InvestigationTrace; model: string; reasoningEffort: string; modelSource: ModelConfigSource; reasoningEffortSource: ModelConfigSource; modelFallback: boolean; coreThreadId: string; threadChannelId: string; threadRouting: ThreadRoutingDecision; receivedAt: string; startedAt: string; completedAt: string; durationMs: number|null }
export interface MessageAttempt { id: string; logId: string; attemptNumber: number; status: 'queued'|'processing'|'completed'|'failed'; requestedByAccountId: string; requestedByLoginName: string; requestedByDisplayName: string; responseContent: string; error: string; model: string; reasoningEffort: string; startedAt: string; completedAt: string; durationMs: number|null; createdAt: string; updatedAt: string }
export type ThemePreference = 'system' | 'light' | 'dark'
export interface AdminAccount { id: string; loginName: string; displayName: string; primary: boolean; enabled: boolean; theme: ThemePreference; lastLoginAt: string; createdAt: string; updatedAt: string }
export interface AuditLog { id: string; actorAccountId: string; actorLoginName: string; actorDisplayName: string; action: string; targetType: string; targetId: string; summary: string; details: Record<string, unknown>; ipAddress: string; createdAt: string }
export interface ChatMetadata { botId: string; chatId: string; name: string; mode: 'group'|'topic'|'p2p'; updatedAt: string }
export interface ConversationThread { id: string; threadChannelId: string; botId: string; botName: string; conversationMode: 'chat'|'topic'; chatId: string; chatName: string; chatMode: ChatMetadata['mode']|''; topicId: string; coreThreadId: string; createdAt: string; updatedAt: string }
export interface SkillSource { id: string; name: string; repositoryUrl: string; branch: string; workspaceId: string; workspaceName: string; skillRoots: string[]; knowledgeRoots: string[]; autoInstall: boolean; lastSyncedAt: string; lastCommit: string; lastError: string; createdAt: string; updatedAt: string }
export interface SkillCatalogItem { key: string; name: string; description: string; sourceId: string; sourceName: string; workspaceId: string; workspaceName: string; sourcePath: string; targetPath: string; status: 'available'|'installed'|'update_available'|'conflict'|'local'; checksum: string; installedCommit: string }
export interface WorkspaceResources { codeRoot: string; knowledgeRoots: string[]; knowledge: Array<{ title: string; description: string; path: string; relativePath: string; updatedAt: string }>; knowledgeTotal: number; skills: Array<{ name: string; path: string; displayName: string; description: string; scope: 'repo'|'user'|'system'|'admin'; enabled: boolean }> }
export interface DashboardOverview {
  workspaces: number; bots: number; scenes: number; skillPackages: number; messageLogs: number
  today: { received: number; completed: number; failed: number; processing: number; reused: number; experience: number; created: number; averageDurationMs: number }
  threads: { channels: number; bindings: number; profiles: number; queuedJobs: number; processingJobs: number }
  analytics: {
    total: { received: number; completed: number; failed: number; processing: number; uniqueChats: number; averageDurationMs: number }
    daily: Array<{ date: string; received: number; completed: number; failed: number; reused: number; experience: number }>
    chats: Array<{ botId: string; botName: string; chatId: string; chatName: string; chatMode: string; received: number; completed: number; failed: number; averageDurationMs: number; lastActiveAt: string }>
    scenes: Array<{ sceneId: string; sceneName: string; received: number; completed: number; failed: number }>
    routes: Array<{ type: string; count: number }>
  }
}
export interface SystemHealth {
  status: 'healthy'|'attention'
  checkedAt: string
  startedAt: string
  uptimeSeconds: number
  store: { database: { ok: boolean; result: string }; queue: { queued: number; processing: number; staleProcessing: number; oldestQueuedAt: string }; profiles: { queued: number; failed: number } }
  feishu: { draining: boolean; drainStartedAt: string; activeJobs: number; pendingReceipts: number; configuredBots: number; activeProviders: number; connectedProviders: number; scheduledJobs: number; activeChannels: number; lastQueueScanAt: string; lastError: string; providers: Array<{ botId: string; botName: string; state: string; error: string }> }
  runtime: { initialized: boolean; attachedChannels: number }
}
