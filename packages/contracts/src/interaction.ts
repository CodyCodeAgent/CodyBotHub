export type IdentityType = 'digital_employee' | 'bot' | 'service'

export interface InteractionIdentity {
  id: string
  name: string
  type: IdentityType
  registrationSource: 'manual' | 'bot_registered'
  defaultBotId: string
  allowedBotIds: string[]
  enabled: boolean
  createdAt: string
}

export interface IdentityCredential {
  id: string
  identityId: string
  name: string
  prefix: string
  createdAt: string
  revokedAt: string | null
}

export interface GroupMessageInput {
  botId?: string
  sceneId?: string
  chatId: string
  chatName?: string
  topicId?: string
  messageId: string
  eventId?: string
  sender: {
    id: string
    name?: string
    type?: 'user' | 'bot' | 'app'
    appId?: string
    idType?: 'open_id' | 'user_id' | 'union_id'
  }
  message: {
    type?: 'text' | 'post' | 'card' | 'interactive' | 'image' | 'file' | 'audio' | 'video' | 'media' | 'unknown'
    text: string
    title?: string
    raw?: unknown
  }
  addressedToBot?: boolean
  mentions?: Array<{ id: string; name?: string; type?: 'user' | 'bot' | 'app'; isCurrentBot?: boolean }>
  createdAt?: string
  metadata?: Record<string, unknown>
}

export interface InteractionSceneCatalog {
  matchSemantics: {
    acrossFields: 'AND'
    withinField: 'OR'
    emptyField: 'unrestricted'
    textMatch: 'case_insensitive_substring'
    idMatch: 'exact'
    priority: 'ascending'
  }
  scenes: Array<{
    sceneId: string
    botId: string
    botName: string
    name: string
    description: string
    priority: number
    isFallback: boolean
    conversationMode: 'chat' | 'topic'
    executionMode: 'read_only'
    matcher: {
      chatIds: string[]
      messageTypes: string[]
      textIncludes: string[]
      cardTitleIncludes: string[]
    }
  }>
}

export interface InteractionTask {
  taskId: string
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
  answer: string | null
  error: string | null
  progress: { phase: string; answer?: string; message?: string } | null
  route: {
    botId: string
    sceneId: string
    workspaceId: string
    threadChannelId: string
    routeSource: string
  }
  createdAt: string
  updatedAt: string
}
