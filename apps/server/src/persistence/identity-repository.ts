import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { InteractionIdentity, IdentityCredential, IdentityType } from '@cody-bot-hub/contracts/interaction'
import { HttpError } from '../http/common.js'

type IdentityInput = { name: string; type: IdentityType; defaultBotId: string; allowedBotIds?: string[] | undefined }
const hash = (token: string) => createHash('sha256').update(token).digest('hex')

export const migrateIdentitySchema = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE interaction_identities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      registration_source TEXT NOT NULL, default_bot_id TEXT NOT NULL REFERENCES bots(id),
      allowed_bot_ids TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE identity_credentials (
      id TEXT PRIMARY KEY, identity_id TEXT NOT NULL REFERENCES interaction_identities(id),
      name TEXT NOT NULL, prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, revoked_at TEXT
    );
    CREATE INDEX identity_credentials_owner ON identity_credentials(identity_id);
    CREATE TABLE identity_invitations (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL,
      created_by TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT
    );
  `)
}

export class IdentityRepository {
  constructor(private readonly db: DatabaseSync) {}

  private grants(input: IdentityInput): string[] {
    const bots = [...new Set(input.allowedBotIds ?? [input.defaultBotId])]
    if (!bots.includes(input.defaultBotId)) throw new HttpError(400, 'Default Bot must be allowed')
    for (const bot of bots) {
      if (!this.db.prepare('SELECT id FROM bots WHERE id = ?').get(bot)) throw new HttpError(400, 'Bot not found')
    }
    return bots
  }

  create(input: IdentityInput, source: InteractionIdentity['registrationSource'] = 'manual'): InteractionIdentity {
    const bots = this.grants(input), id = randomUUID()
    this.db.prepare(`INSERT INTO interaction_identities
      (id, name, type, registration_source, default_bot_id, allowed_bot_ids, enabled, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(id, input.name, input.type, source, input.defaultBotId, JSON.stringify(bots), new Date().toISOString())
    return this.get(id)
  }

  list(): InteractionIdentity[] {
    return (this.db.prepare('SELECT id FROM interaction_identities ORDER BY created_at DESC').all() as { id: string }[]).map(row => this.get(row.id))
  }

  get(id: string): InteractionIdentity {
    const row = this.db.prepare('SELECT * FROM interaction_identities WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, 'Identity not found')
    return {
      id: String(row.id), name: String(row.name), type: String(row.type) as IdentityType,
      registrationSource: String(row.registration_source) as InteractionIdentity['registrationSource'],
      defaultBotId: String(row.default_bot_id), allowedBotIds: JSON.parse(String(row.allowed_bot_ids)) as string[],
      enabled: Boolean(row.enabled), createdAt: String(row.created_at),
    }
  }

  update(id: string, input: IdentityInput & { enabled: boolean }): InteractionIdentity {
    this.get(id)
    const bots = this.grants(input)
    this.db.prepare(`UPDATE interaction_identities SET name = ?, type = ?, default_bot_id = ?, allowed_bot_ids = ?, enabled = ? WHERE id = ?`)
      .run(input.name, input.type, input.defaultBotId, JSON.stringify(bots), input.enabled ? 1 : 0, id)
    return this.get(id)
  }

  credentials(identityId: string): IdentityCredential[] {
    this.get(identityId)
    return this.db.prepare(`SELECT id, identity_id AS identityId, name, prefix, created_at AS createdAt, revoked_at AS revokedAt
      FROM identity_credentials WHERE identity_id = ? ORDER BY created_at DESC`).all(identityId) as unknown as IdentityCredential[]
  }

  issue(identityId: string, name: string): { credential: IdentityCredential; token: string } {
    if (!this.get(identityId).enabled) throw new HttpError(400, 'Identity is disabled')
    const id = randomUUID(), token = `cbh_${randomBytes(32).toString('base64url')}`
    this.db.prepare(`INSERT INTO identity_credentials (id, identity_id, name, prefix, token_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, identityId, name, token.slice(0, 12), hash(token), new Date().toISOString())
    return { credential: this.credentials(identityId).find(item => item.id === id)!, token }
  }

  revoke(identityId: string, credentialId: string): void {
    const changed = this.db.prepare('UPDATE identity_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND identity_id = ?')
      .run(new Date().toISOString(), credentialId, identityId).changes
    if (!changed) throw new HttpError(404, 'Credential not found')
  }

  authenticate(token: string): { identity: InteractionIdentity; credentialId: string } {
    if (!token || token.length > 512) throw new HttpError(401, 'Invalid bearer token')
    const row = this.db.prepare('SELECT id, identity_id FROM identity_credentials WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token))
    if (!row) throw new HttpError(401, 'Invalid bearer token')
    const identity = this.get(String(row.identity_id))
    if (!identity.enabled) throw new HttpError(401, 'Identity is disabled')
    return { identity, credentialId: String(row.id) }
  }

  invite(input: IdentityInput, createdBy: string, expiresInMinutes: number): { invitationId: string; registrationToken: string; expiresAt: string } {
    this.grants(input)
    const id = randomUUID(), token = `cbh_invite_${randomBytes(32).toString('base64url')}`
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60_000).toISOString()
    this.db.prepare('INSERT INTO identity_invitations (id, token_hash, input_json, created_by, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, hash(token), JSON.stringify(input), createdBy, expiresAt)
    return { invitationId: id, registrationToken: token, expiresAt }
  }

  register(token: string): { identity: InteractionIdentity; credential: IdentityCredential; token: string } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM identity_invitations WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?')
        .get(hash(token), new Date().toISOString())
      if (!row) throw new HttpError(401, 'Invalid or expired registration token')
      const identity = this.create(JSON.parse(String(row.input_json)) as IdentityInput, 'bot_registered')
      const issued = this.issue(identity.id, 'registration')
      this.db.prepare('UPDATE identity_invitations SET consumed_at = ? WHERE id = ?').run(new Date().toISOString(), String(row.id))
      this.db.exec('COMMIT')
      return { identity, ...issued }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
