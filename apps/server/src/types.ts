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
  replyMode: 'reply' | 'topic'
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
  replyMode: 'reply' | 'topic'
  conversationKey: string
  systemPrompt: string
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
  replyMode: 'inherit' | 'reply' | 'topic'
  enabled: boolean
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
