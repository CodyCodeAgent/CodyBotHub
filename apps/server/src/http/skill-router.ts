import { FEISHU_MESSAGE_TYPES } from '@codycodeagent/cody-web-core/feishu'
import { listBrowsableDirectories } from '../directories.js'
import type { CodyBotRuntime } from '../runtime.js'
import type { SkillSyncService } from '../skills.js'
import { HttpError, bool, page, readJson, required, sendJson, type AuthenticatedRouteContext } from './common.js'
import { runtimeKind, skillSourceInput, stringList } from './input-parsers.js'

export const handleSkillRoute = async ({ request, response, url, method, store, audit, runtime, skills }: AuthenticatedRouteContext & { runtime: CodyBotRuntime; skills: SkillSyncService }): Promise<boolean> => {
  if (!/^\/api\/(filesystem\/directories|feishu\/message-types|skills|models|skill-sources|skill-catalog|workspace-resources)(?:\/|$)/u.test(url.pathname)) return false
  await (async () => {
        if (method === 'GET' && url.pathname === '/api/filesystem/directories') {
          return sendJson(response, 200, listBrowsableDirectories(url.searchParams.get('path') ?? undefined))
        }
        if (method === 'GET' && url.pathname === '/api/feishu/message-types') {
          const labels: Record<(typeof FEISHU_MESSAGE_TYPES)[number], string> = { text: '文本', post: '富文本', image: '图片', file: '文件', audio: '音频', media: '视频', interactive: '消息卡片' }
          return sendJson(response, 200, FEISHU_MESSAGE_TYPES.map(value => ({ value, label: labels[value] })))
        }
        if (method === 'GET' && url.pathname === '/api/skills') {
          const workspace = store.listWorkspaces().find(item => item.id === url.searchParams.get('workspaceId'))
          if (!workspace) throw new HttpError(404, 'Workspace not found')
          return sendJson(response, 200, (await runtime.listSkills(workspace.path, runtimeKind(url.searchParams.get('runtimeKind')))).filter(skill => skill.enabled))
        }
        if (method === 'GET' && url.pathname === '/api/models') return sendJson(response, 200, await runtime.listModels(runtimeKind(url.searchParams.get('runtimeKind'))))

        if (method === 'GET' && url.pathname === '/api/skill-sources/page') return sendJson(response, 200, page(store.listSkillSources(), url))
        if (method === 'GET' && url.pathname === '/api/skill-sources') return sendJson(response, 200, store.listSkillSources())
        if (method === 'POST' && url.pathname === '/api/skill-sources') {
          const body = await readJson(request), result = store.createSkillSource(skillSourceInput(body))
          audit('skill_source.create', 'skill_source', result.id, `创建技能源 ${result.name}`, { workspaceId: result.workspaceId, repositoryUrl: result.repositoryUrl })
          return sendJson(response, 201, result)
        }
        const skillSourceMatch = url.pathname.match(/^\/api\/skill-sources\/([^/]+)(?:\/(sync))?$/u)
        if (skillSourceMatch) {
          const sourceId = decodeURIComponent(skillSourceMatch[1]!), action = skillSourceMatch[2]
          if (method === 'POST' && action === 'sync') {
            const result = await runtime.workspaceAccess.maintain(store.getWorkspace(store.getSkillSource(sourceId).workspaceId).path, `skill-source:${sourceId}`, () => skills.sync(sourceId))
            audit('skill_source.sync', 'skill_source', sourceId, `同步技能源 ${result.source.name}`, { commit: result.source.lastCommit, installed: result.installed, skipped: result.skipped })
            return sendJson(response, 200, result)
          }
          if (!action && method === 'PUT') {
            const result = store.updateSkillSource(sourceId, skillSourceInput(await readJson(request)))
            audit('skill_source.update', 'skill_source', sourceId, `更新技能源 ${result.name}`)
            return sendJson(response, 200, result)
          }
          if (!action && method === 'DELETE') {
            const item = store.getSkillSource(sourceId)
            store.deleteSkillSource(sourceId)
            await skills.removeSource(sourceId)
            audit('skill_source.delete', 'skill_source', sourceId, `删除技能源 ${item.name}`)
            response.statusCode = 204; return response.end()
          }
        }
        if (method === 'GET' && url.pathname === '/api/skill-catalog') {
          const catalog = await skills.catalog({ workspaceId: url.searchParams.get('workspaceId') ?? '', sourceId: url.searchParams.get('sourceId') ?? '', status: url.searchParams.get('status') ?? '', query: url.searchParams.get('query') ?? '' })
          if (url.searchParams.has('limit') || url.searchParams.has('offset')) {
            const result = page(catalog, url)
            return sendJson(response, 200, { ...result, statusCounts: catalog.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.status]: (counts[item.status] ?? 0) + 1 }), {}) })
          }
          return sendJson(response, 200, catalog)
        }
        if (method === 'GET' && url.pathname === '/api/workspace-resources') {
          const workspace = store.getWorkspace(url.searchParams.get('workspaceId') ?? '')
          const resources = await runtime.workspaceResources(workspace.path, url.searchParams.get('query') ?? '', runtimeKind(url.searchParams.get('runtimeKind')))
          const knowledge = page(resources.knowledge, url)
          return sendJson(response, 200, { ...resources, knowledge: knowledge.items, knowledgeTotal: knowledge.total })
        }
        if (method === 'POST' && url.pathname === '/api/skill-catalog/install') {
          const body = await readJson(request)
          const result = await runtime.workspaceAccess.maintain(store.getWorkspace(required(body, 'workspaceId')).path, `skill-install:${Date.now()}`, () => skills.install({ sourceId: required(body, 'sourceId'), workspaceId: required(body, 'workspaceId'), skillKeys: stringList(body.skillKeys), all: bool(body.all), force: bool(body.force) }))
          audit('skill.install', 'skill_source', String(body.sourceId), `安装或更新 Skill：${result.installed} 个`, { installed: result.installed, skipped: result.skipped, errors: result.errors })
          return sendJson(response, 200, result)
        }
        throw new HttpError(404, 'Route not found')
  })()
  return true
}
