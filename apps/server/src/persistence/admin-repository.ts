import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { databaseNow as now, type DatabaseRow as Row } from '../db-values.js'
import type { AdminAccountRecord } from '../types.js'

export class AdminRepository {
  constructor(readonly db: DatabaseSync) {}

  hasAdmin(): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM admin_accounts WHERE enabled = 1 LIMIT 1').get())
  }
  listAdminAccounts(): AdminAccountRecord[] {
    return (this.db.prepare('SELECT * FROM admin_accounts ORDER BY login_name COLLATE NOCASE').all() as Row[]).map(this.adminAccount)
  }
  getAdminAccount(id: string): AdminAccountRecord {
    const row = this.db.prepare('SELECT * FROM admin_accounts WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new Error('Account not found')
    return this.adminAccount(row)
  }
  findAdminAccountByLogin(loginName: string): (AdminAccountRecord & { passwordHash: string }) | null {
    const row = this.db.prepare('SELECT * FROM admin_accounts WHERE login_name = ? COLLATE NOCASE').get(loginName) as Row | undefined
    return row ? { ...this.adminAccount(row), passwordHash: String(row.password_hash) } : null
  }
  createAdminAccount(input: { loginName: string; displayName: string; passwordHash: string }): AdminAccountRecord {
    const id = randomUUID(), timestamp = now()
    const primary = this.db.prepare('SELECT 1 FROM admin_accounts LIMIT 1').get() ? 0 : 1
    this.db.prepare('INSERT INTO admin_accounts (id, login_name, display_name, password_hash, is_primary, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, input.loginName, input.displayName, input.passwordHash, primary, timestamp, timestamp)
    return this.getAdminAccount(id)
  }
  updateAdminAccount(id: string, input: { loginName: string; displayName: string; passwordHash?: string }): AdminAccountRecord {
    this.getAdminAccount(id)
    const result = input.passwordHash
      ? this.db.prepare('UPDATE admin_accounts SET login_name = ?, display_name = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(input.loginName, input.displayName, input.passwordHash, now(), id)
      : this.db.prepare('UPDATE admin_accounts SET login_name = ?, display_name = ?, updated_at = ? WHERE id = ?').run(input.loginName, input.displayName, now(), id)
    if (!result.changes) throw new Error('Account not found')
    return this.getAdminAccount(id)
  }
  deleteAdminAccount(id: string): void {
    if (this.getAdminAccount(id).primary) throw new Error('Cannot delete the primary administrator account')
    if (this.listAdminAccounts().filter(item => item.enabled).length <= 1) throw new Error('Cannot delete the last administrator account')
    this.db.prepare('DELETE FROM auth_sessions WHERE account_id = ?').run(id)
    if (!this.db.prepare('DELETE FROM admin_accounts WHERE id = ?').run(id).changes) throw new Error('Account not found')
  }
  touchAdminLogin(id: string): void { this.db.prepare('UPDATE admin_accounts SET last_login_at = ? WHERE id = ?').run(now(), id) }
  setAdminTheme(id: string, theme: AdminAccountRecord['theme']): AdminAccountRecord {
    if (!['system', 'light', 'dark'].includes(theme)) throw new Error('Theme must be system, light, or dark')
    if (!this.db.prepare('UPDATE admin_accounts SET theme = ?, updated_at = ? WHERE id = ?').run(theme, now(), id).changes) throw new Error('Account not found')
    return this.getAdminAccount(id)
  }
  private adminAccount = (row: Row): AdminAccountRecord => ({
    id: String(row.id), loginName: String(row.login_name), displayName: String(row.display_name), primary: Boolean(row.is_primary), enabled: Boolean(row.enabled),
    theme: (String(row.theme || 'system') as AdminAccountRecord['theme']), lastLoginAt: String(row.last_login_at), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  })

  createSession(tokenHash: string, accountId: string, expiresAt: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now())
    this.db.prepare('INSERT INTO auth_sessions (token_hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(tokenHash, accountId, expiresAt, now())
  }
  hasSession(tokenHash: string): boolean {
    return Boolean(this.getSessionAccount(tokenHash))
  }
  getSessionAccount(tokenHash: string): AdminAccountRecord | null {
    const row = this.db.prepare(`SELECT a.* FROM auth_sessions s JOIN admin_accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND a.enabled = 1`).get(tokenHash, now()) as Row | undefined
    return row ? this.adminAccount(row) : null
  }
  deleteSession(tokenHash: string): void { this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash) }
}
