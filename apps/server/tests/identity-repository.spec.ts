import { describe, expect, it } from 'vitest'
import { HubStore } from '../src/db.js'

function fixture() {
  const store = new HubStore(':memory:')
  const workspace = store.createWorkspace({ name: 'Local', path: '/tmp' })
  const bot = store.createBot({ name: 'Headless', defaultWorkspaceId: workspace.id })
  const input = { name: 'Digital employee', type: 'digital_employee' as const, defaultBotId: bot.id }
  return { store, bot, input }
}

describe('interaction identities', () => {
  it('stores only token hashes, isolates credentials and supports revocation and identity disabling', () => {
    const { store, input } = fixture()
    try {
      const identity = store.identities.create(input)
      const production = store.identities.issue(identity.id, 'production')
      const test = store.identities.issue(identity.id, 'test')
      expect(store.identities.authenticate(production.token)).toMatchObject({ identity, credentialId: production.credential.id })
      expect(JSON.stringify(store.identities.list())).not.toContain(production.token)
      expect(JSON.stringify(store.identities.credentials(identity.id))).not.toContain(production.token)
      expect(JSON.stringify(store.db.prepare('SELECT * FROM identity_credentials').all())).not.toContain(production.token)
      store.identities.revoke(identity.id, production.credential.id)
      expect(() => store.identities.authenticate(production.token)).toThrow('Invalid bearer')
      expect(store.identities.authenticate(test.token).identity.id).toBe(identity.id)
      store.identities.update(identity.id, { ...input, enabled: false })
      expect(() => store.identities.authenticate(test.token)).toThrow('disabled')
    } finally { store.close() }
  })

  it('consumes invitations once, enforces expiry and prevents caller-selected grants', () => {
    const { store, input } = fixture()
    try {
      const invitation = store.identities.invite(input, 'admin', 15)
      const registered = store.identities.register(invitation.registrationToken)
      expect(registered.identity).toMatchObject({ registrationSource: 'bot_registered', defaultBotId: input.defaultBotId })
      expect(store.identities.authenticate(registered.token).identity.id).toBe(registered.identity.id)
      expect(() => store.identities.register(invitation.registrationToken)).toThrow('Invalid or expired')
      const expired = store.identities.invite(input, 'admin', 15)
      store.db.prepare('UPDATE identity_invitations SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expired.invitationId)
      expect(() => store.identities.register(expired.registrationToken)).toThrow('Invalid or expired')
      expect(() => store.identities.create({ ...input, allowedBotIds: [] })).toThrow('must be allowed')
      expect(() => store.identities.create({ ...input, defaultBotId: 'missing' })).toThrow('Bot not found')
      expect(store.identities.list()).toHaveLength(1)
    } finally { store.close() }
  })
})
