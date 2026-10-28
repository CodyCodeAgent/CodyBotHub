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
  const server = createHubServer({ store, vault, runtime: {} as never, provisioning: {} as never, skills: {} as never, copilot: {} as never, tasks })
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
    const { url, create } = await fixture()
    const { token } = await create('CLI test')
    const cli = fileURLToPath(new URL('../../cli/src/cli.mjs', import.meta.url))
    const env = { ...process.env, CODYBOTHUB_URL: url, CODYBOTHUB_TOKEN: token }
    const exec = promisify(execFile)
    const args = ['message', 'submit', '--chat-id', 'oc_cli', '--message-id', 'om_cli', '--sender-id', 'ou_cli', '--text', 'Explain']
    const sync = await exec(process.execPath, [cli, ...args, '--json'], { env })
    expect(JSON.parse(sync.stdout)).toMatchObject({ answer: 'Local answer', status: 'completed' })
    const asyncResult = await exec(process.execPath, [cli, ...args, '--async'], { env })
    const task = JSON.parse(asyncResult.stdout) as { taskId: string }
    expect(task.taskId).toBe(JSON.parse(sync.stdout).taskId)
    const get = await exec(process.execPath, [cli, 'task', 'get', task.taskId, '--json'], { env })
    expect(JSON.parse(get.stdout).answer).toBe('Local answer')
    await expect(exec(process.execPath, [cli, 'message', 'submit', '--chat-id', 'oc_cli', '--message-id', 'om_failed', '--sender-id', 'ou_cli', '--text', 'FAIL_TEST'], { env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Intentional runtime failure') })
    await expect(exec(process.execPath, [cli, 'identity', 'whoami'], { env: { ...env, CODYBOTHUB_TOKEN: 'invalid' } })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining('401') })
  })
})
