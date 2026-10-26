import { bool, HttpError, matchId, number, page, readJson, sendJson, type AuthenticatedRouteContext } from './common.js'

export const handleInsightsRoute = async ({ request, response, url, method, actor, store, audit, onMessageRetry }: AuthenticatedRouteContext & { onMessageRetry: (() => void | Promise<void>) | undefined }): Promise<boolean> => {
  if (!/^\/api\/(dashboard|chats|conversation-threads|thread-routing-rules|thread-routing-profiles|thread-routing-decisions|thread-channels|thread-jobs|message-logs)(?:\/|$)/u.test(url.pathname)) return false
  await (async () => {
        if (method === 'GET' && url.pathname === '/api/dashboard') return sendJson(response, 200, store.stats({
          fromDate: url.searchParams.get('fromDate') ?? '',
          toDate: url.searchParams.get('toDate') ?? '',
          botId: url.searchParams.get('botId') ?? '',
          chatId: url.searchParams.get('chatId') ?? '',
          threadChannelId: url.searchParams.get('threadChannelId') ?? '',
        }))
        if (method === 'GET' && url.pathname === '/api/dashboard/dimensions') return sendJson(response, 200, store.dashboardDimensions())
        if (method === 'GET' && url.pathname === '/api/chats') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 200
          return sendJson(response, 200, store.listChatMetadata({ botId: url.searchParams.get('botId') ?? '', query: url.searchParams.get('query') ?? '', limit: number(limit, 200) }))
        }
        if (method === 'GET' && url.pathname === '/api/conversation-threads') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50
          const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0
          return sendJson(response, 200, store.listConversationThreads({
            limit: number(limit, 50),
            offset: number(offset, 0),
            botId: url.searchParams.get('botId') ?? '',
            query: url.searchParams.get('query') ?? '',
          }))
        }
        const conversationThreadId = matchId(url.pathname, '/api/conversation-threads/')
        if (conversationThreadId && method === 'GET') return sendJson(response, 200, store.getConversationThread(conversationThreadId))
        if (method === 'GET' && url.pathname === '/api/thread-routing-rules') return sendJson(response, 200, store.listThreadRoutingRules())
        const threadRoutingSceneId = matchId(url.pathname, '/api/thread-routing-rules/')
        if (threadRoutingSceneId && method === 'PUT') {
          const body = await readJson(request)
          const result = store.setThreadRoutingRule(threadRoutingSceneId, {
            enabled: bool(body.enabled), reuseThreshold: number(body.reuseThreshold, 0.85), experienceThreshold: number(body.experienceThreshold, 0.55),
            timeWindowHours: number(body.timeWindowHours, 72), maxCandidates: number(body.maxCandidates, 100),
            structuredWeight: number(body.structuredWeight, 0.7), textWeight: number(body.textWeight, 0.3),
          })
          audit('thread_routing.update', 'scene', threadRoutingSceneId, `更新场景 ${result.sceneName} 的 Thread 路由规则`, { ...result })
          return sendJson(response, 200, result)
        }
        if (method === 'GET' && url.pathname === '/api/thread-routing-profiles') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100
          const profiles = store.listThreadProfiles(url.searchParams.has('paged') ? 500 : number(limit, 100))
          const sceneId = url.searchParams.get('sceneId') ?? '', query = (url.searchParams.get('query') ?? '').trim().toLocaleLowerCase()
          const filtered = profiles.filter(item => (!sceneId || item.sceneId === sceneId) && (!query || [item.title, item.normalizedText, item.experienceSummary, ...Object.values(item.fields)].join(' ').toLocaleLowerCase().includes(query)))
          return sendJson(response, 200, url.searchParams.has('paged') ? page(filtered, url) : filtered.slice(0, number(limit, 100)))
        }
        if (method === 'GET' && url.pathname === '/api/thread-routing-decisions') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50
          const items = store.listThreadRoutingDecisions(url.searchParams.has('paged') ? 500 : number(limit, 50))
          if (url.searchParams.has('paged')) {
            const result = page(items, url), typeCounts: Record<string, number> = {}
            for (const item of items) typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1
            return sendJson(response, 200, { ...result, typeCounts })
          }
          return sendJson(response, 200, items)
        }
        if (method === 'GET' && url.pathname === '/api/thread-channels') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 200
          const items = store.listThreadChannels(url.searchParams.has('paged') ? 500 : number(limit, 200))
          return sendJson(response, 200, url.searchParams.has('paged') ? page(items, url) : items)
        }
        if (method === 'GET' && url.pathname === '/api/thread-jobs') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100
          const items = store.listThreadJobs(url.searchParams.has('paged') ? 500 : number(limit, 100))
          return sendJson(response, 200, url.searchParams.has('paged') ? page(items, url) : items)
        }
        if (method === 'GET' && url.pathname === '/api/message-logs') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50
          const offset = url.searchParams.has('offset') ? Number(url.searchParams.get('offset')) : 0
          return sendJson(response, 200, store.listMessageLogs({
            limit: number(limit, 50),
            offset: number(offset, 0),
            botId: url.searchParams.get('botId') ?? '',
            sceneId: url.searchParams.get('sceneId') ?? '',
            status: url.searchParams.get('status') ?? '',
            query: url.searchParams.get('query') ?? '',
          }))
        }
        const messageLogAction = url.pathname.match(/^\/api\/message-logs\/([^/]+)\/(attempts|retry)$/u)
        if (messageLogAction) {
          const logId = decodeURIComponent(messageLogAction[1]!), action = messageLogAction[2]
          if (method === 'GET' && action === 'attempts') return sendJson(response, 200, store.listMessageAttempts(logId))
          if (method === 'POST' && action === 'retry') {
            const result = store.retryMessageLog(logId, actor)
            audit('message.retry', 'message_log', logId, `重试失败消息 ${result.log.messageId}`, { attemptNumber: result.attempts.at(-1)?.attemptNumber, threadChannelId: result.log.threadChannelId, coreThreadId: result.log.coreThreadId })
            await onMessageRetry?.()
            return sendJson(response, 202, result)
          }
        }
        const messageLogId = matchId(url.pathname, '/api/message-logs/')
        if (messageLogId && method === 'GET') return sendJson(response, 200, store.getMessageLog(messageLogId))
        throw new HttpError(404, 'Route not found')
  })()
  return true
}
