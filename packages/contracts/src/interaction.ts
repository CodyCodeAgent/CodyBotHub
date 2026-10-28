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
    type?: 'text' | 'post' | 'card' | 'image' | 'file' | 'audio' | 'video' | 'unknown'
    text: string
    title?: string
    raw?: unknown
  }
  addressedToBot?: boolean
  mentions?: Array<{ id: string; name?: string; type?: 'user' | 'bot' | 'app'; isCurrentBot?: boolean }>
  createdAt?: string
  metadata?: Record<string, unknown>
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
