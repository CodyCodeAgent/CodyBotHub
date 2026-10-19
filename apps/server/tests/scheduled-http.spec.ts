import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { HubStore } from '../src/db.js'
import { SecretVault } from '../src/crypto.js'
import { createHubServer } from '../src/http.js'
import { ScheduledTaskService } from '../src/scheduled.js'
import { WorkspaceAccess } from '../src/workspace-access.js'
import { HubTaskService } from '../src/tasks.js'
const cleaners: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleaners.splice(0).reverse()) await cleanup()
})
describe('scheduled HTTP API', () => {
  it('authenticates, validates, audits, paginates and preserves archived history', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'scheduled-http-')),
      store = new HubStore(':memory:'),
      vault = await SecretVault.open(directory),
      workspace = store.createWorkspace({ name: 'Workspace', path: directory })
    const runtime = {
      validateModelSelection: vi.fn(async () => {}),
      setScheduledInvoker: vi.fn(),
      workspaceAccess: new WorkspaceAccess()
    }
    const scheduled = new ScheduledTaskService(store, runtime as never, {} as never, directory, {
      send: vi.fn(),
      update: vi.fn(),
      mayApprove: vi.fn()
    })
    const server = createHubServer({
      store,
      vault,
      runtime: runtime as never,
      provisioning: {} as never,
      skills: {} as never,
      copilot: {} as never,
      tasks: new HubTaskService(store, runtime as never),
      scheduled
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    const url = `http://127.0.0.1:${address.port}`
    cleaners.push(async () => {
      await scheduled.stop()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      store.close()
      rmSync(directory, { recursive: true, force: true })
    })
    expect((await fetch(url + '/api/scheduled-tasks')).status).toBe(401)
    const setup = await fetch(url + '/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ loginName: 'admin', displayName: 'Admin', password: 'LocalTest-Only-1234' })
      }),
      cookie = setup.headers.get('set-cookie')!.split(';')[0]!
    const request = (route: string, method = 'GET', body?: unknown) =>
      fetch(url + route, {
        method,
        headers: { cookie, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
    const invalid = await request('/api/scheduled-tasks', 'POST', { name: 'bad' })
    expect(invalid.status).toBe(400)
    const templates = (await (await request('/api/scheduled-templates')).json()) as Array<{ id: string }>
    expect(templates.map((x) => x.id)).toContain('workspace_sync')
    const task = (await (
      await request('/api/scheduled-tasks', 'POST', {
        name: 'Read-only task',
        workspaceId: workspace.id,
        prompt: 'Inspect README',
        schedule: { kind: 'daily' }
      })
    ).json()) as { id: string; enabled: boolean; revision: number }
    expect(task).toMatchObject({ enabled: false, revision: 1 })
    const list = (await (await request('/api/scheduled-tasks?limit=1')).json()) as { total: number; items: unknown[] }
    expect(list.total).toBe(1)
    expect(list.items).toHaveLength(1)
    const enabled = await request(`/api/scheduled-tasks/${task.id}/enabled`, 'PUT', { enabled: true })
    expect(enabled.status).toBe(200)
    const result = (await (await request(`/api/scheduled-tasks/${task.id}/run`, 'POST')).json()) as {
      id: string
      status: string
    }
    expect(result.status).toBe('queued')
    expect((await request(`/api/scheduled-tasks/${task.id}/run`, 'POST')).status).toBe(400)
    expect((await request(`/api/scheduled-runs/${result.id}/cancel`, 'POST')).status).toBe(200)
    expect((await request(`/api/scheduled-tasks/${task.id}`, 'DELETE')).status).toBe(204)
    expect(((await (await request(`/api/scheduled-runs/${result.id}`)).json()) as { status: string }).status).toBe(
      'cancelled'
    )
    expect(store.listAuditLogs().items.map((x) => x.action)).toEqual(
      expect.arrayContaining([
        'scheduled_task.create',
        'scheduled_task.toggle',
        'scheduled_task.run',
        'scheduled_run.cancel',
        'scheduled_task.archive'
      ])
    )
    expect(
      (
        await fetch(url + '/api/scheduled-preview', {
          method: 'POST',
          headers: { cookie, origin: 'https://foreign.invalid', 'content-type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(403)
  })
})
