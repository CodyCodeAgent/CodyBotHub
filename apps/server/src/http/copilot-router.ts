import type { CopilotService } from '../copilot.js'
import { HttpError, readJson, required, sendJson, type AuthenticatedRouteContext } from './common.js'

export async function handleCopilotRoute(
  { request, response, url, method, actor, store, audit, copilot, onConfigurationChanged }: AuthenticatedRouteContext & {
    copilot: CopilotService
    onConfigurationChanged: (() => void | Promise<void>) | undefined
  },
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/copilot/')) return false
  if (method === 'GET' && url.pathname === '/api/copilot/session') {
    const workspaceId = url.searchParams.get('workspaceId') ?? store.listWorkspaces()[0]?.id ?? ''
    if (!workspaceId) throw new HttpError(400, 'Create a Workspace before using Copilot')
    sendJson(response, 200, copilot.session(actor.id, workspaceId))
  } else if (method === 'POST' && url.pathname === '/api/copilot/session/reset') {
    const body = await readJson(request), result = copilot.reset(required(body, 'sessionId'), actor.id)
    audit('copilot.reset', 'copilot_session', result.session.id, '重置平台 Copilot 会话', { workspaceId: result.session.workspaceId })
    sendJson(response, 200, result)
  } else if (method === 'POST' && url.pathname === '/api/copilot/messages') {
    const body = await readJson(request), content = required(body, 'content')
    const result = await copilot.ask(required(body, 'sessionId'), actor, content)
    audit('copilot.ask', 'copilot_session', result.session.id, `询问平台 Copilot：${content.slice(0, 120)}`, { workspaceId: result.session.workspaceId })
    sendJson(response, 200, result)
  } else if (method === 'GET' && url.pathname === '/api/copilot/proposals') sendJson(response, 200, store.listCopilotProposals(url.searchParams.get('sessionId') ?? '', actor.id))
  else {
    const proposal = url.pathname.match(/^\/api\/copilot\/proposals\/([^/]+)\/(apply|dismiss)$/u)
    if (!proposal || method !== 'POST') return false
    const id = decodeURIComponent(proposal[1]!), action = proposal[2]
    if (action === 'dismiss') {
      const result = copilot.dismissProposal(id, actor.id)
      audit('copilot.proposal.dismiss', 'copilot_proposal', result.id, `放弃 Copilot 草稿：${result.title}`)
      sendJson(response, 200, result)
    } else {
      const result = copilot.applyProposal(id, actor)
      if (result.target.type === 'bot') await onConfigurationChanged?.()
      audit('copilot.proposal.apply', result.target.type, result.target.id, `应用 Copilot 草稿：${result.proposal.title}`, { proposalId: result.proposal.id, proposalKind: result.proposal.kind })
      sendJson(response, 200, result)
    }
  }
  return true
}
