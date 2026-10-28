import { z } from 'zod/v4'

const id = z.string().trim().min(1).max(256)
const name = z.string().trim().min(1).max(200)
export const identityInput = z.strictObject({
  name,
  type: z.enum(['digital_employee', 'bot', 'service']).default('digital_employee'),
  defaultBotId: z.uuid(),
  allowedBotIds: z.array(z.uuid()).min(1).max(100).optional(),
})
export const credentialInput = z.strictObject({ name: name.default('default') })
export const inviteInput = identityInput.extend({ expiresInMinutes: z.number().int().min(1).max(1440).default(15) })

export const groupMessageInput = z.strictObject({
  botId: z.uuid().optional(),
  sceneId: z.uuid().optional(),
  chatId: id,
  chatName: z.string().max(500).optional(),
  topicId: id.optional(),
  messageId: id,
  eventId: id.optional(),
  sender: z.strictObject({
    id,
    name: z.string().max(500).optional(),
    type: z.enum(['user', 'bot', 'app']).default('user'),
    appId: id.optional(),
    idType: z.enum(['open_id', 'user_id', 'union_id']).optional(),
  }),
  message: z.strictObject({
    type: z.enum(['text', 'post', 'card', 'interactive', 'image', 'file', 'audio', 'video', 'media', 'unknown']).default('text'),
    text: z.string().min(1).max(200_000).refine(value => Boolean(value.trim()), 'Message text must not be blank'),
    title: z.string().max(2000).optional(),
    raw: z.json().optional(),
  }),
  addressedToBot: z.boolean().default(true),
  mentions: z.array(z.strictObject({
    id, name: z.string().max(500).optional(), type: z.enum(['user', 'bot', 'app']).optional(), isCurrentBot: z.boolean().optional(),
  })).max(100).optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  metadata: z.record(z.string(), z.json()).optional(),
})

export type ParsedGroupMessageInput = z.infer<typeof groupMessageInput>
