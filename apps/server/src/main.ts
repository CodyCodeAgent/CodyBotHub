import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SecretVault } from './crypto.js'
import { HubStore } from './db.js'
import { createHubServer } from './http.js'
import { CodyBotRuntime } from './runtime.js'
import { FeishuBotManager } from './feishu.js'
import { FeishuProvisioningService } from './provisioning.js'
import { SkillSyncService } from './skills.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(here, '../../..')
const dataDir = process.env.CODY_BOT_HUB_DATA_DIR ?? path.join(repositoryRoot, '.data')
const webDist = process.env.CODY_BOT_HUB_WEB_DIST ?? path.join(repositoryRoot, 'apps/web/dist')
const host = process.env.CODY_BOT_HUB_HOST ?? '127.0.0.1'
const port = Number(process.env.CODY_BOT_HUB_PORT ?? 4310)
const startedAt = new Date()

const store = new HubStore(path.join(dataDir, 'cody-bot-hub.sqlite'))
const interrupted = store.recoverInterruptedWork()
if (interrupted.jobs || interrupted.messages) console.warn(`[startup] recovered interrupted work: jobs=${interrupted.jobs} messages=${interrupted.messages}; queued jobs will resume`)
const vault = await SecretVault.open(dataDir)
const runtimeDirectory = path.join(dataDir, 'runtime')
mkdirSync(runtimeDirectory, { recursive: true })
const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex'
const codexCommand = process.env.CODY_BOT_HUB_CODEX_COMMAND ?? process.env.CODEX_CLI_PATH ?? (process.platform === 'darwin' && existsSync(bundledCodex) ? bundledCodex : 'codex')
const runtime = new CodyBotRuntime(store, runtimeDirectory, codexCommand, Number(process.env.CODY_BOT_HUB_TURN_TIMEOUT_MS ?? 15 * 60 * 1000))
const feishu = new FeishuBotManager(store, vault, runtime, path.join(dataDir, 'attachments'))
const provisioning = new FeishuProvisioningService(store, vault, () => feishu.reload())
const skills = new SkillSyncService(store, path.join(dataDir, 'skill-sources'))
const server = createHubServer({
  store, vault, runtime, webDist, provisioning, skills,
  onConfigurationChanged: () => feishu.reload(),
  onMessageRetry: () => feishu.resumeQueuedJobs(),
  getSystemHealth: () => {
    const checkedAt = new Date(), storeHealth = store.systemHealth(), feishuHealth = feishu.health(), runtimeHealth = runtime.health()
    const attention = !storeHealth.database.ok || storeHealth.queue.staleProcessing > 0 || feishuHealth.connectedProviders < feishuHealth.configuredBots
    return {
      status: attention ? 'attention' : 'healthy', checkedAt: checkedAt.toISOString(), startedAt: startedAt.toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((checkedAt.getTime() - startedAt.getTime()) / 1_000)), store: storeHealth, feishu: feishuHealth, runtime: runtimeHealth,
    }
  },
})

let nextThreadProfileRefreshAt = 0
const refreshThreadProfiles = () => {
  try {
    const settings = store.getPlatformSettings()
    if (Date.now() < nextThreadProfileRefreshAt) return
    nextThreadProfileRefreshAt = Date.now() + settings.threadProfileRefreshIntervalSeconds * 1_000
    const result = store.processThreadProfileJobs(settings.threadProfileBatchSize)
    if (result.processed || result.failed) console.info(`[thread-profiles] processed=${result.processed} failed=${result.failed}`)
  } catch (error) {
    console.error('[thread-profiles] worker failed:', error)
  }
}
const threadProfileTimer = setInterval(refreshThreadProfiles, 1_000)
threadProfileTimer.unref()
setImmediate(refreshThreadProfiles)

server.listen(port, host, () => {
  console.log(`CodyBotHub listening on http://${host}:${port}`)
  void feishu.start()
})

const shutdown = () => {
  clearInterval(threadProfileTimer)
  feishu.stop()
  server.close(() => { void runtime.dispose().finally(() => { store.close(); process.exit(0) }) })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
