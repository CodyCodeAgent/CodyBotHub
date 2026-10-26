import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminAccountRecord } from '../types.js'
import type { HubStore } from '../db.js'
import { scheduledTemplates, type ScheduledTaskService } from '../scheduled.js'
import type { ScheduleConfig } from '../scheduled-types.js'
import { nextScheduleDates } from '../schedule.js'
import { inspectWorkspace } from '../workspace-sync.js'
import { bool, HttpError, readJson, required, sendJson } from './common.js'

export interface ScheduledRouteContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  method: string
  actor: AdminAccountRecord
  store: HubStore
  scheduled: ScheduledTaskService | undefined
  audit: (action: string, targetType: string, targetId: string, summary: string, details?: Record<string, unknown>) => void
}

export async function handleScheduledRoute({ request, response, url, method, actor, store, scheduled, audit }: ScheduledRouteContext): Promise<boolean> {
  if (!url.pathname.startsWith('/api/scheduled-')) return false
  if (!scheduled) throw new HttpError(503, '定时任务服务未启用')
  const params = url.searchParams
  const pagination = { limit: Math.min(100, Math.max(1, Number(params.get('limit')) || 20)), offset: Math.max(0, Number(params.get('offset')) || 0) }
  if (method === 'GET' && url.pathname === '/api/scheduled-templates') sendJson(response, 200, scheduledTemplates)
  else if (method === 'GET' && url.pathname === '/api/scheduled-maintenance') sendJson(response, 200, scheduled.maintenance(params.get('workspaceId') || ''))
  else if (method === 'POST' && url.pathname === '/api/scheduled-maintenance') {
    const workspaceId = required(await readJson(request), 'workspaceId')
    scheduled.resumeWorkspace(workspaceId)
    audit('scheduled_workspace.resume', 'workspace', workspaceId, '管理员核实后解除工作区维护暂停')
    sendJson(response, 200, { ok: true })
  } else if (method === 'GET' && url.pathname === '/api/scheduled-health') sendJson(response, 200, scheduled.health())
  else if (method === 'GET' && url.pathname === '/api/scheduled-tasks') sendJson(response, 200, scheduled.records.listTasks({ ...pagination, query: params.get('query') || '', workspaceId: params.get('workspaceId') || '', enabled: params.get('enabled') || '' }))
  else if (method === 'POST' && url.pathname === '/api/scheduled-tasks') {
    const task = await scheduled.save(await readJson(request), actor.loginName)
    audit('scheduled_task.create', 'scheduled_task', task.id, `创建定时任务 ${task.name}`)
    sendJson(response, 201, task)
  } else if (method === 'POST' && url.pathname === '/api/scheduled-preview') sendJson(response, 200, nextScheduleDates((await readJson(request)).schedule as ScheduleConfig))
  else if (method === 'GET' && url.pathname === '/api/scheduled-workspace') {
    const workspace = store.getWorkspace(params.get('workspaceId') || '')
    sendJson(response, 200, await inspectWorkspace(workspace.path))
  } else if (method === 'GET' && url.pathname === '/api/scheduled-runs') sendJson(response, 200, scheduled.records.listRuns({ ...pagination, taskId: params.get('taskId') || '', workspaceId: params.get('workspaceId') || '', status: params.get('status') || '', from: params.get('from') || '', to: params.get('to') || '' }))
  else {
    const taskMatch = url.pathname.match(/^\/api\/scheduled-tasks\/([^/]+)(?:\/(run|enabled))?$/u)
    if (taskMatch) {
      const id = taskMatch[1]!, action = taskMatch[2], task = scheduled.records.getTask(id)
      if (method === 'POST' && action === 'run') {
        const run = scheduled.trigger(id, actor.loginName)
        audit('scheduled_task.run', 'scheduled_run', run.id, `手动执行 ${task.name}`)
        sendJson(response, 202, run)
      } else if (method === 'PUT' && action === 'enabled') {
        const input = await readJson(request), updated = await scheduled.save({ ...task, enabled: bool(input.enabled) }, actor.loginName, id)
        audit('scheduled_task.toggle', 'scheduled_task', id, `${updated.enabled ? '启用' : '暂停'}定时任务 ${task.name}`)
        sendJson(response, 200, updated)
      } else if (method === 'GET' && !action) sendJson(response, 200, task)
      else if (method === 'PUT' && !action) {
        const updated = await scheduled.save(await readJson(request), actor.loginName, id)
        audit('scheduled_task.update', 'scheduled_task', id, `修改定时任务 ${updated.name}`, { revision: updated.revision })
        sendJson(response, 200, updated)
      } else if (method === 'DELETE' && !action) {
        scheduled.records.archive(id)
        audit('scheduled_task.archive', 'scheduled_task', id, `归档定时任务 ${task.name}`)
        response.statusCode = 204
        response.end()
      } else throw new HttpError(404, '定时任务接口不存在')
    } else {
      const runMatch = url.pathname.match(/^\/api\/scheduled-runs\/([^/]+)(?:\/(cancel|delivery))?$/u)
      if (!runMatch) throw new HttpError(404, '定时任务接口不存在')
      const id = runMatch[1]!, action = runMatch[2]
      if (method === 'GET' && !action) sendJson(response, 200, scheduled.records.getRun(id))
      else if (method === 'POST' && action === 'cancel') {
        const run = scheduled.cancel(id)
        audit('scheduled_run.cancel', 'scheduled_run', id, '取消或中断定时执行')
        sendJson(response, 200, run)
      } else if (method === 'POST' && action === 'delivery') {
        const run = await scheduled.retryDelivery(id)
        audit('scheduled_run.delivery', 'scheduled_run', id, '重新投递定时任务结果')
        sendJson(response, 200, run)
      } else throw new HttpError(404, '定时任务接口不存在')
    }
  }
  return true
}
