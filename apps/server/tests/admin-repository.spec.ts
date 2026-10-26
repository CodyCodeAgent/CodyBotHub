import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AdminRepository } from '../src/persistence/admin-repository.js'

describe('administrator repository', () => {
  it('uses its caller-owned connection for account and session changes', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE admin_accounts (
      id TEXT PRIMARY KEY, login_name TEXT UNIQUE, display_name TEXT, password_hash TEXT,
      is_primary INTEGER, enabled INTEGER, theme TEXT, last_login_at TEXT, created_at TEXT, updated_at TEXT
    ); CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT, expires_at TEXT, created_at TEXT)`)
    const accounts = new AdminRepository(db)
    const first = accounts.createAdminAccount({ loginName: 'admin', displayName: 'Admin', passwordHash: 'hash' })
    accounts.createSession('token', first.id, '2099-01-01T00:00:00.000Z')
    expect(accounts.getSessionAccount('token')?.id).toBe(first.id)
    expect(db.prepare('SELECT account_id FROM auth_sessions WHERE token_hash = ?').get('token')).toEqual({ account_id: first.id })
    db.close()
  })
})
