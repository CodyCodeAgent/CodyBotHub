import { describe, expect, it } from 'vitest'
import { HubStore } from '../src/db.js'
import { CopilotRepository } from '../src/persistence/copilot-repository.js'
import { PlatformSettingsRepository } from '../src/persistence/platform-settings-repository.js'
import { StoreReadModel } from '../src/persistence/store-read-model.js'

describe('separated store aggregates and read models', () => {
  it('shares a database without duplicating data across repositories', () => {
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'Main', path: '/tmp/read-model-workspace' })
    const account = store.createAdminAccount({ loginName: 'admin', displayName: 'Admin', passwordHash: 'hash' })
    const copilot = new CopilotRepository(store.db, store.accounts, store.workspaces)
    const settings = new PlatformSettingsRepository(store.db)
    const readModel = new StoreReadModel(store.db)
    const session = copilot.getOrCreateCopilotSession(account.id, workspace.id)
    expect(store.getCopilotSession(session.id).workspaceId).toBe(workspace.id)
    expect(settings.getPlatformSettings()).toEqual(store.getPlatformSettings())
    expect(readModel.dashboardDimensions()).toEqual(store.dashboardDimensions())
    expect(readModel.systemHealth().database.ok).toBe(true)
    store.close()
  })
})
