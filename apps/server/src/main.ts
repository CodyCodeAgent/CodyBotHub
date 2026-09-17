import path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SecretVault } from './crypto.js'
import { HubStore } from './db.js'
import { createHubServer } from './http.js'
import { CodyBotRuntime } from './runtime.js'
import { FeishuBotManager } from './feishu.js'
import { FeishuProvisioningService } from './provisioning.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(here, '../../..')
const dataDir = process.env.CODY_BOT_HUB_DATA_DIR ?? path.join(repositoryRoot, '.data')
const webDist = process.env.CODY_BOT_HUB_WEB_DIST ?? path.join(repositoryRoot, 'apps/web/dist')
const host = process.env.CODY_BOT_HUB_HOST ?? '127.0.0.1'
const port = Number(process.env.CODY_BOT_HUB_PORT ?? 4310)

const store = new HubStore(path.join(dataDir, 'cody-bot-hub.sqlite'))
const vault = await SecretVault.open(dataDir)
const runtimeDirectory = path.join(dataDir, 'runtime')
mkdirSync(runtimeDirectory, { recursive: true })
const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex'
const codexCommand = process.env.CODY_BOT_HUB_CODEX_COMMAND ?? process.env.CODEX_CLI_PATH ?? (process.platform === 'darwin' && existsSync(bundledCodex) ? bundledCodex : 'codex')
const runtime = new CodyBotRuntime(store, runtimeDirectory, codexCommand)
const feishu = new FeishuBotManager(store, vault, runtime, path.join(dataDir, 'attachments'))
const provisioning = new FeishuProvisioningService(store, vault, () => feishu.reload())
const server = createHubServer({ store, vault, runtime, webDist, provisioning, onConfigurationChanged: () => feishu.reload() })

server.listen(port, host, () => {
  console.log(`CodyBotHub listening on http://${host}:${port}`)
  void feishu.reload()
})

const shutdown = () => {
  feishu.stop()
  server.close(() => { void runtime.dispose().finally(() => { store.close(); process.exit(0) }) })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
