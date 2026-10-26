import { DatabaseSync } from 'node:sqlite'

export type Migration = {
  version: number
  name: string
  up: (database: DatabaseSync) => void
}

export const applyMigrations = (database: DatabaseSync, migrations: Migration[]): void => {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const ordered = [...migrations].sort((left, right) => left.version - right.version)
  if (ordered.some((migration, index) =>
    !Number.isSafeInteger(migration.version) || migration.version < 1 ||
    !migration.name || (index > 0 && ordered[index - 1]!.version === migration.version)
  )) throw new Error('Invalid database migration registry')

  const applied = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as
    Array<{ version: number; name: string }>
  const known = new Map(ordered.map(migration => [migration.version, migration.name]))
  for (const row of applied) {
    if (known.get(row.version) !== row.name) {
      throw new Error(`Database migration ${row.version} (${row.name}) is newer or differs from this application`)
    }
  }
  const appliedVersions = new Set(applied.map(row => row.version))
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) continue
    database.exec('BEGIN IMMEDIATE')
    try {
      migration.up(database)
      database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString())
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}
