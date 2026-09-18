import { createHash, randomBytes } from 'node:crypto'
import { Algorithm, hash, verify } from '@node-rs/argon2'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HubStore } from './db.js'
import type { AdminAccountRecord } from './types.js'

const COOKIE = 'cody_bot_hub_session'
const SESSION_MS = 1000 * 60 * 60 * 24 * 14

export interface AuthStatus {
  setupRequired: boolean
  authenticated: boolean
  account: AdminAccountRecord | null
}

const digest = (value: string) => createHash('sha256').update(value).digest('base64url')
const clientIp = (request: IncomingMessage): string => {
  const forwarded = request.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  return value?.trim() || request.socket.remoteAddress || ''
}

export class AuthService {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()

  constructor(private readonly store: HubStore) {}

  status(request: IncomingMessage): AuthStatus {
    const account = this.currentAccount(request)
    return { setupRequired: !this.store.hasAdmin(), authenticated: Boolean(account), account }
  }

  currentAccount(request: IncomingMessage): AdminAccountRecord | null {
    const token = this.readCookie(request)
    return token ? this.store.getSessionAccount(digest(token)) : null
  }

  isAuthenticated(request: IncomingMessage): boolean { return Boolean(this.currentAccount(request)) }

  async setup(loginName: string, displayName: string, password: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.store.hasAdmin()) throw new Error('Administrator is already configured')
    this.assertAccount(loginName, displayName)
    this.assertPassword(password)
    const account = this.store.createAdminAccount({ loginName, displayName, passwordHash: await this.passwordHash(password) })
    this.store.touchAdminLogin(account.id)
    this.issueSession(account.id, request, response)
    this.store.createAuditLog({ actor: account, action: 'account.setup', targetType: 'account', targetId: account.id, summary: `初始化管理员账号 ${account.loginName}`, ipAddress: clientIp(request) })
  }

  async login(loginName: string, password: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const key = clientIp(request) || 'unknown'
    this.checkRateLimit(key)
    const candidates = loginName ? [this.store.findAdminAccountByLogin(loginName)] : this.store.listAdminAccounts().length === 1 ? [this.store.findAdminAccountByLogin(this.store.listAdminAccounts()[0]!.loginName)] : []
    const account = candidates[0]
    if (!account?.enabled || !(await verify(account.passwordHash, password))) {
      this.failedAttempt(key)
      throw new Error('Invalid account or password')
    }
    this.attempts.delete(key)
    this.store.touchAdminLogin(account.id)
    const current = this.store.getAdminAccount(account.id)
    this.issueSession(account.id, request, response)
    this.store.createAuditLog({ actor: current, action: 'auth.login', targetType: 'account', targetId: account.id, summary: `${current.displayName} 登录平台`, ipAddress: clientIp(request) })
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    const account = this.currentAccount(request)
    const token = this.readCookie(request)
    if (token) this.store.deleteSession(digest(token))
    if (account) this.store.createAuditLog({ actor: account, action: 'auth.logout', targetType: 'account', targetId: account.id, summary: `${account.displayName} 退出平台`, ipAddress: clientIp(request) })
    response.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  }

  async createAccount(input: { loginName: string; displayName: string; password: string }, actor: AdminAccountRecord, request: IncomingMessage): Promise<AdminAccountRecord> {
    this.assertAccount(input.loginName, input.displayName)
    this.assertPassword(input.password)
    const account = this.store.createAdminAccount({ loginName: input.loginName, displayName: input.displayName, passwordHash: await this.passwordHash(input.password) })
    this.store.createAuditLog({ actor, action: 'account.create', targetType: 'account', targetId: account.id, summary: `创建平台账号 ${account.loginName}（${account.displayName}）`, ipAddress: clientIp(request) })
    return account
  }

  async updateAccount(id: string, input: { loginName: string; displayName: string; password?: string }, actor: AdminAccountRecord, request: IncomingMessage): Promise<AdminAccountRecord> {
    this.assertAccount(input.loginName, input.displayName)
    if (input.password) this.assertPassword(input.password)
    const account = this.store.updateAdminAccount(id, { loginName: input.loginName, displayName: input.displayName, ...(input.password ? { passwordHash: await this.passwordHash(input.password) } : {}) })
    this.store.createAuditLog({ actor, action: 'account.update', targetType: 'account', targetId: account.id, summary: `更新平台账号 ${account.loginName}（${account.displayName}）${input.password ? '并重置密码' : ''}`, ipAddress: clientIp(request) })
    return account
  }

  deleteAccount(id: string, actor: AdminAccountRecord, request: IncomingMessage): void {
    if (id === actor.id) throw new Error('Cannot delete the current account')
    const account = this.store.getAdminAccount(id)
    this.store.deleteAdminAccount(id)
    this.store.createAuditLog({ actor, action: 'account.delete', targetType: 'account', targetId: id, summary: `删除平台账号 ${account.loginName}（${account.displayName}）`, ipAddress: clientIp(request) })
  }

  private async passwordHash(password: string): Promise<string> {
    return hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 3, parallelism: 1, outputLen: 32 })
  }

  private assertAccount(loginName: string, displayName: string): void {
    if (!/^[A-Za-z0-9._@-]{2,64}$/u.test(loginName)) throw new Error('Account name must contain 2-64 letters, numbers, dots, underscores, @ or hyphens')
    if (displayName.length < 1 || displayName.length > 64) throw new Error('User name must contain 1-64 characters')
  }

  private assertPassword(password: string): void {
    if (password.length < 10) throw new Error('Password must contain at least 10 characters')
    if (password.length > 256) throw new Error('Password is too long')
  }

  private issueSession(accountId: string, request: IncomingMessage, response: ServerResponse): void {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_MS).toISOString()
    this.store.createSession(digest(token), accountId, expiresAt)
    const forwardedProto = Array.isArray(request.headers['x-forwarded-proto']) ? request.headers['x-forwarded-proto'][0] : request.headers['x-forwarded-proto']
    const secure = forwardedProto === 'https' || Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted)
    response.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`)
  }

  private readCookie(request: IncomingMessage): string | null {
    const cookies = request.headers.cookie?.split(';') ?? []
    for (const cookie of cookies) {
      const [key, ...parts] = cookie.trim().split('=')
      if (key === COOKIE) return parts.join('=')
    }
    return null
  }

  private checkRateLimit(key: string): void {
    const entry = this.attempts.get(key)
    if (!entry || entry.resetAt <= Date.now()) return
    if (entry.count >= 6) throw new Error('Too many login attempts. Try again later')
  }

  private failedAttempt(key: string): void {
    const current = this.attempts.get(key)
    if (!current || current.resetAt <= Date.now()) this.attempts.set(key, { count: 1, resetAt: Date.now() + 60_000 })
    else current.count += 1
  }
}
