import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { AuthService } from '../src/auth.js'
import { HubStore } from '../src/db.js'

const request = (cookie = '') => ({ headers: cookie ? { cookie } : {}, socket: { remoteAddress: '127.0.0.1' } }) as IncomingMessage
const response = () => ({ setHeader: vi.fn() }) as unknown as ServerResponse
const sessionCookie = (target: ServerResponse): string => {
  const header = vi.mocked(target.setHeader).mock.calls.find(([name]) => name === 'Set-Cookie')?.[1]
  return String(header).split(';')[0]!
}

describe('AuthService accounts', () => {
  it('sets up the first account and authenticates an additional account by login name', async () => {
    const store = new HubStore(':memory:')
    const auth = new AuthService(store)
    const setupResponse = response()
    await auth.setup('admin', '管理员', 'Jixi123456', request(), setupResponse)
    const adminRequest = request(sessionCookie(setupResponse))
    const admin = auth.status(adminRequest).account!
    expect(admin).toMatchObject({ loginName: 'admin', displayName: '管理员' })

    const operator = await auth.createAccount({ loginName: 'operator', displayName: '运营同学', password: 'Operator1234' }, admin, adminRequest)
    const loginResponse = response()
    await auth.login('operator', 'Operator1234', request(), loginResponse)
    expect(auth.status(request(sessionCookie(loginResponse))).account).toMatchObject({ id: operator.id, loginName: 'operator' })
    expect(store.listAuditLogs().items.map(item => item.action)).toEqual(expect.arrayContaining(['account.setup', 'account.create', 'auth.login']))
    store.close()
  })
})
