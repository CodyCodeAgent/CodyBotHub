import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { HubStore } from '../src/db.js'
import { SecretVault } from '../src/crypto.js'
import { createHubServer } from '../src/http.js'
import { HubTaskService } from '../src/tasks.js'

const cleaners: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleaners.splice(0).reverse()) await cleanup() })

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'hub-interaction-')), store = new HubStore(':memory:')
  const vault = await SecretVault.open(directory)
  const workspace = store.createWorkspace({ name: 'Local', path: directory })
  const bot = store.createBot({ name: 'Headless', defaultWorkspaceId: workspace.id })
  const execute = vi.fn(async (...args: unknown[]) => {
    const message = args[1] as { text: string }
    if (message.text.includes('FAIL_TEST')) throw new Error('Intentional runtime failure')
    ;(args[3] as (progress: unknown) => void)({ phase: 'answering', answer: 'working' })
    return 'Local answer'
  })
  const tasks = new HubTaskService(store, { execute } as never)
  const server = createHubServer({ store, vault, runtime: { validateModelSelection: vi.fn(async () => {}) } as never, provisioning: {} as never, skills: {} as never, copilot: {} as never, tasks })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  const url = `http://127.0.0.1:${address.port}`
  cleaners.push(async () => {
    await tasks.waitForIdle()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close(); rmSync(directory, { recursive: true, force: true })
  })
  const setup = await fetch(`${url}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'admin', displayName: 'Admin', password: 'Local-Only-12345' }) })
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!
  const admin = (route: string, method = 'GET', body?: unknown) => fetch(`${url}${route}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const api = (token: string, route: string, method = 'GET', body?: unknown) => fetch(`${url}/api/v1${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const create = async (name: string) => {
    const response = await admin('/api/identities', 'POST', { name, defaultBotId: bot.id })
    expect(response.status).toBe(201)
    return response.json() as Promise<{ identity: { id: string }; credential: { id: string }; token: string }>
  }
  const message = { chatId: 'oc_local', messageId: 'om_local', sender: { id: 'ou_original' }, message: { text: 'Explain this' } }
  return { url, store, bot, tasks, execute, admin, api, create, message }
}

describe('identity and group-message HTTP API', () => {
  it('lists only authorized enabled Scenes and public rules without creating work or exposing internal prompts', async () => {
    const { url, store, bot, api, admin, create, execute } = await fixture()
    const { token } = await create('Scene catalog client')
    const input = { name: '支付故障', description: '分析支付服务告警、超时和错误率异常。', botId: bot.id, workspaceId: bot.defaultWorkspaceId, prompt: 'INTERNAL_PROMPT_MUST_NOT_LEAK', priority: 5, enabled: true,
      matcher: { chatIds: ['oc_payment'], messageTypes: ['interactive'], textIncludes: ['支付', 'payment'], cardTitleIncludes: ['告警'] } }
    const created = await admin('/api/scenes', 'POST', input)
    expect(created.status).toBe(201)
    const scene = await created.json() as { id: string }
    store.createScene({ ...input, name: 'Fallback', description: '', priority: 100, matcher: { chatIds: [], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
    store.createScene({ ...input, name: 'Disabled', enabled: false })
    const otherBot = store.createBot({ name: 'Unauthorized', defaultWorkspaceId: bot.defaultWorkspaceId })
    store.createScene({ ...input, botId: otherBot.id, name: 'Hidden scene' })
    const before = ['hub_tasks', 'thread_channels', 'conversation_bindings', 'topic_route_contexts'].map(table => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count)
    expect((await api('invalid', '/scenes')).status).toBe(401)
    expect((await api(token, `/scenes?botId=${otherBot.id}`)).status).toBe(403)
    expect((await api(token, '/scenes?botId=bad')).status).toBe(400)
    const response = await api(token, '/scenes')
    expect(response.status).toBe(200)
    const catalog = await response.json() as { scenes: Array<Record<string, unknown>>; matchSemantics: unknown }
    expect(catalog.matchSemantics).toMatchObject({ acrossFields: 'AND', withinField: 'OR', emptyField: 'unrestricted', priority: 'ascending' })
    expect(catalog.scenes).toHaveLength(2)
    expect(catalog.scenes[0]).toMatchObject({ sceneId: scene.id, botId: bot.id, description: input.description, isFallback: false, matcher: input.matcher, executionMode: 'read_only' })
    expect(catalog.scenes[1]).toMatchObject({ name: 'Fallback', isFallback: true })
    for (const item of catalog.scenes) {
      expect(item).not.toHaveProperty('prompt')
      expect(item).not.toHaveProperty('workspaceId')
      expect(item).not.toHaveProperty('skillPackageIds')
    }
    expect(JSON.stringify(catalog)).not.toContain(input.prompt)
    expect((await (await api(token, `/scenes?botId=${bot.id}`)).json() as { scenes: unknown[] }).scenes).toEqual(catalog.scenes)
    const cli = fileURLToPath(new URL('../../cli/src/cli.mjs', import.meta.url))
    const result = await promisify(execFile)(process.execPath, [cli, 'scene', 'list', '--json'], { env: { ...process.env, CODYBOTHUB_URL: url, CODYBOTHUB_TOKEN: token } })
    expect(JSON.parse(result.stdout)).toEqual(catalog)
    const after = ['hub_tasks', 'thread_channels', 'conversation_bindings', 'topic_route_contexts'].map(table => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count)
    expect(after).toEqual(before)
    expect(execute).not.toHaveBeenCalled()
    // Older admin clients omitting description must preserve the public description.
    const { description: _description, ...oldClientInput } = input
    expect((await admin(`/api/scenes/${scene.id}`, 'PUT', oldClientInput)).status).toBe(200)
    expect(store.botScenes.getScene(scene.id).description).toBe(input.description)
    expect((await admin(`/api/scenes/${scene.id}`, 'PUT', { ...input, description: 'x'.repeat(2001) })).status).toBe(400)
    expect((await admin(`/api/scenes/${scene.id}`, 'PUT', { ...input, description: '' })).status).toBe(200)
    expect(store.botScenes.getScene(scene.id).description).toBe('')
  })

  it('enforces admin and token boundaries, validates payloads, isolates tasks and never exposes stored secrets', async () => {
    const { url, store, bot, api, admin, create, message, execute } = await fixture()
    expect((await fetch(`${url}/api/identities`)).status).toBe(401)
    expect((await api('bad', '/identity')).status).toBe(401)
    const one = await create('One'), two = await create('Two')
    expect((await fetch(`${url}/api/identities`, { headers: { authorization: `Bearer ${one.token}` } })).status).toBe(401)
    expect(JSON.stringify(await (await admin('/api/identities')).json())).not.toContain(one.token)
    expect(JSON.stringify(await (await admin(`/api/identities/${one.identity.id}/credentials`)).json())).not.toContain(one.token)
    const result = await api(one.token, '/messages?waitMs=1000', 'POST', message)
    expect(result.status).toBe(202)
    const task = await result.json() as { taskId: string; answer: string; status: string }
    expect(task).toMatchObject({ status: 'completed', answer: 'Local answer' })
    expect((await (await api(one.token, '/messages', 'POST', message)).json() as { taskId: string }).taskId).toBe(task.taskId)
    expect(execute).toHaveBeenCalledTimes(1)
    expect((await api(one.token, '/messages', 'POST', { ...message, message: { text: 'changed' } })).status).toBe(409)
    expect((await api(two.token, `/tasks/${task.taskId}`)).status).toBe(404)
    expect((await api(two.token, `/tasks/${task.taskId}/wait?timeoutMs=1000`)).status).toBe(404)
    expect((await api(one.token, '/messages?waitMs=NaN', 'POST', message)).status).toBe(400)
    expect((await api(one.token, '/messages', 'POST', { ...message, principal: two.identity.id })).status).toBe(400)
    expect((await api(one.token, '/messages', 'POST', { ...message, createdAt: 'yesterday' })).status).toBe(400)
    expect((await api(one.token, '/messages', 'POST', null)).status).toBe(400)
    expect((await api(one.token, '/messages', 'POST', { ...message, botId: '00000000-0000-4000-8000-000000000000' })).status).toBe(403)
    const otherBot = store.createBot({ name: 'Other', defaultWorkspaceId: bot.defaultWorkspaceId })
    expect((await api(one.token, '/messages', 'POST', { ...message, botId: otherBot.id })).status).toBe(403)
    const ownSchema = await (await api(one.token, '/message-schema')).json() as { required: string[] }
    expect(ownSchema.required).not.toContain('botId')
    expect(ownSchema.required).toContain('messageId')
    expect((await admin(`/api/identities/${one.identity.id}/credentials/${one.credential.id}`, 'DELETE')).status).toBe(204)
    expect((await api(one.token, `/tasks/${task.taskId}`)).status).toBe(401)
    const audits = JSON.stringify(store.listAuditLogs())
    expect(audits).toContain('interaction.submit')
    expect(audits).toContain('ou_original')
    expect(audits).not.toContain(one.token)
  })

  it('lets an invited robot register once with server-chosen grants and rejects cross-origin writes', async () => {
    const { bot, url, api, admin } = await fixture()
    const invitation = await (await admin('/api/identity-invitations', 'POST', { name: 'Invited', type: 'bot', defaultBotId: bot.id })).json() as { registrationToken: string }
    expect((await api(invitation.registrationToken, '/identities/register', 'POST', { defaultBotId: 'spoofed' })).status).toBe(400)
    const registered = await api(invitation.registrationToken, '/identities/register', 'POST', {})
    expect(registered.status).toBe(201)
    const result = await registered.json() as { token: string; identity: { defaultBotId: string; registrationSource: string } }
    expect(result.identity).toMatchObject({ defaultBotId: bot.id, registrationSource: 'bot_registered' })
    expect((await api(result.token, '/identity')).status).toBe(200)
    expect((await api(invitation.registrationToken, '/identities/register', 'POST', {})).status).toBe(401)
    expect((await fetch(`${url}/api/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${result.token}`, origin: 'https://foreign.invalid', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
  })

  it('executes the actual CLI against the HTTP server for sync/async results and failure exit codes', async () => {
    const { url, create, store, bot } = await fixture()
    const { token } = await create('CLI test')
    const scene = store.createScene({ name: 'Explicit CLI scene', botId: bot.id, workspaceId: bot.defaultWorkspaceId, prompt: '', enabled: true, priority: 100,
      matcher: { chatIds: ['different_group'], messageTypes: [], textIncludes: ['different_text'], cardTitleIncludes: [] } })
    const cli = fileURLToPath(new URL('../../cli/src/cli.mjs', import.meta.url))
    const env = { ...process.env, CODYBOTHUB_URL: url, CODYBOTHUB_TOKEN: token }
    const exec = promisify(execFile)
    const args = ['message', 'submit', '--scene-id', scene.id, '--chat-id', 'oc_cli', '--message-id', 'om_cli', '--sender-id', 'ou_cli', '--text', 'Explain']
    const sync = await exec(process.execPath, [cli, ...args, '--json'], { env })
    expect(JSON.parse(sync.stdout)).toMatchObject({ answer: 'Local answer', status: 'completed', route: { sceneId: scene.id, routeSource: 'explicit' } })
    const asyncResult = await exec(process.execPath, [cli, ...args, '--async'], { env })
    const task = JSON.parse(asyncResult.stdout) as { taskId: string }
    expect(task.taskId).toBe(JSON.parse(sync.stdout).taskId)
    const get = await exec(process.execPath, [cli, 'task', 'get', task.taskId, '--json'], { env })
    expect(JSON.parse(get.stdout).answer).toBe('Local answer')
    await expect(exec(process.execPath, [cli, 'message', 'submit', '--chat-id', 'oc_cli', '--message-id', 'om_failed', '--sender-id', 'ou_cli', '--text', 'FAIL_TEST'], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Intentional runtime failure') })
    await expect(exec(process.execPath, [cli, 'identity', 'whoami'], { env: { ...env, CODYBOTHUB_TOKEN: 'invalid' } })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('401') })
  })
})
