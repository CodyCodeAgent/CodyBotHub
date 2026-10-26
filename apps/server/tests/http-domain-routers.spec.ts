import { describe, expect, it, vi } from 'vitest'
import { HubStore } from '../src/db.js'
import { handleCopilotRoute } from '../src/http/copilot-router.js'
import { handleAdminRoute } from '../src/http/admin-router.js'
import { handleSkillRoute } from '../src/http/skill-router.js'
import { handleInsightsRoute } from '../src/http/insights-router.js'
import { handleConfigurationRoute } from '../src/http/configuration-router.js'

describe('HTTP domain routers', () => {
  it('dispatches Copilot and account paths without claiming unrelated domains', async () => {
    const store = new HubStore(':memory:')
    const actor = store.createAdminAccount({ loginName: 'admin', displayName: 'Admin', passwordHash: 'hash' })
    const workspace = store.createWorkspace({ name: 'Workspace', path: '/tmp/router-workspace' })
    const payloads: string[] = []
    const response = { setHeader: vi.fn(), end: vi.fn((value: string) => payloads.push(value)) }
    const base = { request: { headers: {} }, response, method: 'GET', actor, store, audit: vi.fn() }
    const copilot = { session: vi.fn(() => ({ session: { workspaceId: workspace.id }, messages: [] })) }
    expect(await handleCopilotRoute({ ...base, url: new URL('http://localhost/api/copilot/session'), copilot } as never)).toBe(true)
    expect(copilot.session).toHaveBeenCalledWith(actor.id, workspace.id)
    expect(JSON.parse(payloads.pop()!)).toMatchObject({ session: { workspaceId: workspace.id } })
    expect(await handleAdminRoute({ ...base, url: new URL('http://localhost/api/accounts'), auth: {} } as never)).toBe(true)
    expect(JSON.parse(payloads.pop()!)).toMatchObject([{ loginName: 'admin' }])
    expect(await handleCopilotRoute({ ...base, url: new URL('http://localhost/api/bots'), copilot } as never)).toBe(false)
    store.close()
  })

  it('keeps skills, insights and configuration routes in separate domains', async () => {
    const store = new HubStore(':memory:')
    const actor = store.createAdminAccount({ loginName: 'admin', displayName: 'Admin', passwordHash: 'hash' })
    const payloads: string[] = []
    const response = { setHeader: vi.fn(), end: vi.fn((value: string) => payloads.push(value)) }
    const base = { request: { headers: {} }, response, method: 'GET', actor, store, audit: vi.fn() }
    expect(await handleSkillRoute({ ...base, url: new URL('http://localhost/api/skill-sources'), runtime: {}, skills: {} } as never)).toBe(true)
    expect(JSON.parse(payloads.pop()!)).toEqual([])
    expect(await handleInsightsRoute({ ...base, url: new URL('http://localhost/api/dashboard/dimensions'), onMessageRetry: undefined } as never)).toBe(true)
    expect(JSON.parse(payloads.pop()!)).toBeDefined()
    expect(await handleConfigurationRoute({ ...base, url: new URL('http://localhost/api/workspaces'), vault: {}, runtime: {}, provisioning: {}, onConfigurationChanged: undefined } as never)).toBe(true)
    expect(JSON.parse(payloads.pop()!)).toEqual([])
    expect(await handleSkillRoute({ ...base, url: new URL('http://localhost/api/workspaces'), runtime: {}, skills: {} } as never)).toBe(false)
    expect(await handleInsightsRoute({ ...base, url: new URL('http://localhost/api/workspaces'), onMessageRetry: undefined } as never)).toBe(false)
    store.close()
  })
})
