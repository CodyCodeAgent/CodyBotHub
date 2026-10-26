import type { AuthService } from '../auth.js'
import { HttpError, matchId, number, optional, page, readJson, required, sendJson, type AuthenticatedRouteContext } from './common.js'

export async function handleAdminRoute(
  { request, response, url, method, actor, store, audit, auth }: AuthenticatedRouteContext & { auth: AuthService },
): Promise<boolean> {
  if (method === 'GET' && url.pathname === '/api/preferences') sendJson(response, 200, { theme: actor.theme })
  else if (method === 'PUT' && url.pathname === '/api/preferences') {
    const body = await readJson(request), theme = optional(body, 'theme')
    if (!['system', 'light', 'dark'].includes(theme)) throw new HttpError(400, 'theme must be system, light, or dark')
    const account = store.setAdminTheme(actor.id, theme as 'system' | 'light' | 'dark')
    audit('preferences.update', 'account', actor.id, `切换界面主题：${theme}`)
    sendJson(response, 200, { theme: account.theme })
  } else if (method === 'GET' && url.pathname === '/api/accounts/page') sendJson(response, 200, page(store.listAdminAccounts(), url))
  else if (method === 'GET' && url.pathname === '/api/accounts') sendJson(response, 200, store.listAdminAccounts())
  else if (method === 'POST' && url.pathname === '/api/accounts') {
    const body = await readJson(request)
    sendJson(response, 201, await auth.createAccount({ loginName: required(body, 'loginName'), displayName: required(body, 'displayName'), password: required(body, 'password') }, actor, request))
  } else if (url.pathname.startsWith('/api/accounts/')) {
    const id = matchId(url.pathname, '/api/accounts/')
    if (!id) return false
    if (method === 'PUT') {
      const body = await readJson(request), password = optional(body, 'password')
      sendJson(response, 200, await auth.updateAccount(id, { loginName: required(body, 'loginName'), displayName: required(body, 'displayName'), ...(password ? { password } : {}) }, actor, request))
    } else if (method === 'DELETE') {
      auth.deleteAccount(id, actor, request)
      response.statusCode = 204
      response.end()
    } else return false
  } else if (method === 'GET' && url.pathname === '/api/audit-logs') {
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50
    const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0
    sendJson(response, 200, store.listAuditLogs({ limit: number(limit, 50), offset: number(offset, 0), actorAccountId: url.searchParams.get('actorAccountId') ?? '', action: url.searchParams.get('action') ?? '', query: url.searchParams.get('query') ?? '' }))
  } else if (method === 'GET' && matchId(url.pathname, '/api/audit-logs/')) sendJson(response, 200, store.getAuditLog(matchId(url.pathname, '/api/audit-logs/')!))
  else return false
  return true
}
