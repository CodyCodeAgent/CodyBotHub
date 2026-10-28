// Explicit opt-in smoke check: real App Server, temporary SQLite/workspace, loopback HTTP only.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { HubStore } from '../src/db.js'
import { SecretVault } from '../src/crypto.js'
import { CodyBotRuntime } from '../src/runtime.js'
import { HubTaskService } from '../src/tasks.js'
import { createHubServer } from '../src/http.js'

const directory = mkdtempSync(path.join(tmpdir(), 'codybothub-cli-live-'))
const store = new HubStore(path.join(directory, 'hub.sqlite'))
const runtimeDirectory = path.join(directory, 'runtime')
mkdirSync(runtimeDirectory)
const runtime = new CodyBotRuntime(store, runtimeDirectory, { codex: process.env.CODY_BOT_HUB_CODEX_COMMAND ?? 'codex', traex: 'traex' }, 120_000)
const tasks = new HubTaskService(store, runtime)
const server = createHubServer({ store, vault: await SecretVault.open(directory), runtime, tasks, provisioning: {} as never, copilot: {} as never, skills: {} as never })

try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  const url = `http://127.0.0.1:${address.port}`
  const workspacePath = path.join(directory, 'workspace')
  mkdirSync(workspacePath)
  const workspace = store.createWorkspace({ name: 'CLI smoke', path: workspacePath })
  const bot = store.createBot({ name: 'CLI smoke', defaultWorkspaceId: workspace.id, conversationMode: 'topic' })
  const scene = store.createScene({ botId: bot.id, workspaceId: workspace.id, name: 'CLI scene smoke', description: '只读验证场景与会话连续性。', prompt: '', priority: 100, enabled: true,
    matcher: { chatIds: ['oc_does_not_match'], messageTypes: [], textIncludes: [], cardTitleIncludes: [] } })
  const identity = store.identities.create({ name: 'CLI smoke', type: 'service', defaultBotId: bot.id })
  const { token } = store.identities.issue(identity.id, 'local-smoke')
  const cli = fileURLToPath(new URL('../../cli/src/cli.mjs', import.meta.url))
  const env = { ...process.env, CODYBOTHUB_URL: url, CODYBOTHUB_TOKEN: token }
  const catalog = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'scene', 'list', '--json'], { env })).stdout) as { scenes: Array<{ sceneId: string }> }
  if (!catalog.scenes.some(item => item.sceneId === scene.id)) throw new Error('Scene discovery failed')
  console.log('PASS authenticated CLI scene catalog')
  const marker = `LOCAL_CLI_OK_${randomBytes(4).toString('hex')}`
  const call = async (messageId: string, text: string, explicit = true) => {
    const result = await promisify(execFile)(process.execPath, [cli, 'message', 'submit', ...(explicit ? ['--scene-id', scene.id] : []), '--chat-id', 'oc_local_smoke', '--topic-id', 'om_smoke_topic', '--message-id', messageId, '--sender-id', 'ou_local_smoke', '--text', text, '--json', '--timeout', '120'], {
      env, timeout: 150_000,
    })
    return JSON.parse(result.stdout) as { taskId: string; answer: string; status: string; route: { threadChannelId: string; sceneId: string; routeSource: string } }
  }
  const first = await call('om_smoke_first', `本轮是本地 CLI 验证。请记住标记 ${marker}。不要调用工具，只回答这个标记。`)
  if (first.status !== 'completed' || !first.answer.includes(marker)) throw new Error(`First turn failed: ${JSON.stringify(first)}`)
  if (first.route.sceneId !== scene.id || first.route.routeSource !== 'explicit') throw new Error('Explicit scene routing failed')
  console.log(`PASS real CLI → HTTP → identity → Codex: ${first.taskId}`)
  const next = await call('om_smoke_followup', '请回忆上一轮我要求记住的验证标记，只输出那个标记，不要调用工具。', false)
  if (!next.answer.includes(marker) || next.route.threadChannelId !== first.route.threadChannelId) throw new Error(`Thread continuity failed: ${JSON.stringify(next)}`)
  if (next.route.sceneId !== scene.id || next.route.routeSource !== 'topic_context') throw new Error('Explicit scene topic inheritance failed')
  const duplicate = await call('om_smoke_first', `本轮是本地 CLI 验证。请记住标记 ${marker}。不要调用工具，只回答这个标记。`)
  if (duplicate.taskId !== first.taskId) throw new Error('Idempotency failed')
  console.log('PASS native Thread continuity and duplicate message idempotency')
  console.log('Local smoke completed. No Feishu provider or deployment was started.')
} finally {
  tasks.beginDrain()
  await tasks.waitForIdle()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await runtime.dispose()
  store.close()
  rmSync(directory, { recursive: true, force: true })
}
