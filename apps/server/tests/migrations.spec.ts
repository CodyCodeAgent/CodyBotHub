import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { applyMigrations, type Migration } from '../src/persistence/migrations.js'
import { HubStore } from '../src/db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('database migrations', () => {
  it('upgrades a v3 database while preserving Scenes, credentials and public descriptions across reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'hub-scene-catalog-migration-'))
    const filename = join(directory, 'hub.sqlite')
    let store: HubStore | undefined = new HubStore(filename)
    try {
      const workspace = store.createWorkspace({ name: 'Test', path: directory })
      const bot = store.createBot({ name: 'Test', defaultWorkspaceId: workspace.id })
      const input = { botId: bot.id, workspaceId: workspace.id, name: 'Existing Scene', prompt: 'Internal', priority: 100, enabled: true, matcher: { chatIds: [], messageTypes: [], textIncludes: ['alert'], cardTitleIncludes: [] } }
      const scene = store.createScene(input)
      const identity = store.identities.create({ name: 'Existing caller', type: 'service', defaultBotId: bot.id })
      const { token } = store.identities.issue(identity.id, 'existing')
      store.db.exec('ALTER TABLE scenes DROP COLUMN description; DELETE FROM schema_migrations WHERE version = 4')
      store.close(); store = undefined
      store = new HubStore(filename)
      expect(store.botScenes.getScene(scene.id)).toMatchObject({ name: input.name, prompt: input.prompt, description: '', matcher: input.matcher })
      expect(store.identities.authenticate(token).identity.id).toBe(identity.id)
      store.updateScene(scene.id, { ...input, description: 'Public capability' })
      store.close(); store = undefined
      store = new HubStore(filename)
      expect(store.botScenes.getScene(scene.id).description).toBe('Public capability')
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('creates scheduled tables through a versioned HubStore migration', () => {
    const store = new HubStore(':memory:')
    const versions = store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    expect(versions.map(row => row.version)).toEqual([1, 2, 3, 4])
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduled_runs'").get()).toBeTruthy()
    store.close()
  })

  it('applies a migration once and records its version', () => {
    const db = new DatabaseSync(':memory:')
    let calls = 0
    const migration: Migration = {
      version: 1,
      name: 'create-example',
      up(connection) {
        calls++
        connection.exec('CREATE TABLE example (id TEXT PRIMARY KEY)')
      }
    }
    applyMigrations(db, [migration])
    applyMigrations(db, [migration])
    expect(calls).toBe(1)
    expect(db.prepare('SELECT version, name FROM schema_migrations').all()).toEqual([
      { version: 1, name: 'create-example' }
    ])
    db.close()
  })

  it('rolls back partial schema changes when a migration fails', () => {
    const db = new DatabaseSync(':memory:')
    expect(() => applyMigrations(db, [{
      version: 1,
      name: 'broken',
      up(connection) {
        connection.exec('CREATE TABLE incomplete (id TEXT)')
        throw new Error('migration failed')
      }
    }])).toThrow('migration failed')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'incomplete'").get()).toBeUndefined()
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual([])
    db.close()
  })

  it('rejects a database newer than the application', () => {
    const db = new DatabaseSync(':memory:')
    applyMigrations(db, [{ version: 2, name: 'newer', up() {} }])
    expect(() => applyMigrations(db, [{ version: 1, name: 'older', up() {} }])).toThrow('newer')
    db.close()
  })
})
