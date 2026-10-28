import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod/v4'
import type { HubStore } from '../db.js'
import type { HubTaskService } from '../tasks.js'
import { credentialInput, groupMessageInput, identityInput, inviteInput } from '../interaction-input.js'
import { HttpError, readJson, sendJson, type AuthenticatedRouteContext } from './common.js'

const bearer = (request: IncomingMessage): string => {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')
  if (!match) throw new HttpError(401, 'Bearer authentication required')
  return match[1]!
}
const waitMs = (url: URL, key: string, fallback: number): number =>
  z.coerce.number().int().min(0).max(25_000).parse(url.searchParams.get(key) ?? fallback)

export async function handleInteractionRoute(context: {
  request: IncomingMessage; response: ServerResponse; url: URL; method: string; store: HubStore; tasks: HubTaskService
}): Promise<boolean> {
  const { request, response, url, method, store, tasks } = context
  if (!url.pathname.startsWith('/api/v1/')) return false
  if (url.pathname === '/api/v1/identities/register' && method === 'POST') {
    const token = bearer(request)
    const body = z.strictObject({}).parse(await readJson(request))
    void body
    const result = store.identities.register(token)
    store.createAuditLog({ action: 'identity.register', targetType: 'identity', targetId: result.identity.id,
      summary: `${result.identity.name} 使用邀请码注册`, details: { registrationSource: 'bot_registered' } })
    sendJson(response, 201, result)
    return true
  }
  const { identity, credentialId } = store.identities.authenticate(bearer(request))
  if (url.pathname === '/api/v1/identity' && method === 'GET') {
    sendJson(response, 200, { identity, credentialId })
    return true
  }
  if (url.pathname === '/api/v1/message-schema' && method === 'GET') {
    sendJson(response, 200, z.toJSONSchema(groupMessageInput))
    return true
  }
  if (url.pathname === '/api/v1/messages' && method === 'POST') {
    const inlineWait = waitMs(url, 'waitMs', 0)
    const task = tasks.dispatchMessage(await readJson(request), identity, credentialId)
    sendJson(response, 202, inlineWait ? await tasks.waitInteraction(task.taskId, identity.id, inlineWait) : task)
    return true
  }
  const match = /^\/api\/v1\/tasks\/([^/]+)(\/wait)?$/.exec(url.pathname)
  if (match && method === 'GET') {
    const id = z.uuid().parse(match[1])
    sendJson(response, 200, match[2]
      ? await tasks.waitInteraction(id, identity.id, waitMs(url, 'timeoutMs', 25_000))
      : tasks.getInteraction(id, identity.id))
    return true
  }
  throw new HttpError(404, 'Route not found')
}

export async function handleIdentityAdminRoute({ request, response, url, method, store, actor, audit }: AuthenticatedRouteContext): Promise<boolean> {
  const repository = store.identities
  if (url.pathname === '/api/identities') {
    if (method === 'GET') { sendJson(response, 200, repository.list()); return true }
    if (method === 'POST') {
      const identity = repository.create(identityInput.parse(await readJson(request)))
      const issued = repository.issue(identity.id, 'default')
      audit('identity.create', 'identity', identity.id, `创建交互身份 ${identity.name}`)
      sendJson(response, 201, { identity, ...issued })
      return true
    }
  }
  if (url.pathname === '/api/identity-invitations' && method === 'POST') {
    const { expiresInMinutes, ...input } = inviteInput.parse(await readJson(request))
    const invitation = repository.invite(input, actor.id, expiresInMinutes)
    audit('identity.invite', 'identity_invitation', invitation.invitationId, `创建 ${input.name} 的一次性注册邀请`)
    sendJson(response, 201, invitation)
    return true
  }
  const match = /^\/api\/identities\/([^/]+)(?:\/credentials(?:\/([^/]+))?)?$/.exec(url.pathname)
  if (!match) return false
  const id = z.uuid().parse(match[1])
  if (url.pathname.endsWith('/credentials')) {
    if (method === 'GET') { sendJson(response, 200, repository.credentials(id)); return true }
    if (method === 'POST') {
      const input = credentialInput.parse(await readJson(request)), issued = repository.issue(id, input.name)
      audit('identity.credential.issue', 'identity', id, `签发 Token ${input.name}`, { credentialId: issued.credential.id })
      sendJson(response, 201, issued)
      return true
    }
  } else if (match[2] && method === 'DELETE') {
    const credentialId = z.uuid().parse(match[2])
    repository.revoke(id, credentialId)
    audit('identity.credential.revoke', 'identity', id, '吊销交互 Token', { credentialId })
    sendJson(response, 204, null)
    return true
  } else if (!match[2] && method === 'PUT') {
    const input = identityInput.extend({ enabled: z.boolean() }).parse(await readJson(request))
    const identity = repository.update(id, input)
    audit('identity.update', 'identity', id, `更新交互身份 ${identity.name}`, { enabled: identity.enabled, defaultBotId: identity.defaultBotId })
    sendJson(response, 200, identity)
    return true
  }
  throw new HttpError(405, 'Method not allowed')
}
