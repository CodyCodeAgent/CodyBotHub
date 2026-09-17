import { createHash, randomBytes } from 'node:crypto'
import { Algorithm, hash, verify } from '@node-rs/argon2'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HubStore } from './db.js'

const COOKIE = 'cody_bot_hub_session'
const SESSION_MS = 1000 * 60 * 60 * 24 * 14

export interface AuthStatus {
  setupRequired: boolean
  authenticated: boolean
}

const digest = (value: string) => createHash('sha256').update(value).digest('base64url')

export class AuthService {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>()

  constructor(private readonly store: HubStore) {}

  status(request: IncomingMessage): AuthStatus {
    return { setupRequired: !this.store.hasAdmin(), authenticated: this.isAuthenticated(request) }
  }

  isAuthenticated(request: IncomingMessage): boolean {
    const token = this.readCookie(request)
    return token ? this.store.hasSession(digest(token)) : false
  }

  async setup(password: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.store.hasAdmin()) throw new Error('Administrator is already configured')
    this.assertPassword(password)
    this.store.setAdminHash(await this.passwordHash(password))
    this.issueSession(request, response)
  }

  async login(password: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const key = request.socket.remoteAddress ?? 'unknown'
    this.checkRateLimit(key)
    const stored = this.store.getAdminHash()
    if (!stored || !(await verify(stored, password))) {
      this.failedAttempt(key)
      throw new Error('Invalid password')
    }
    this.attempts.delete(key)
    this.issueSession(request, response)
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    const token = this.readCookie(request)
    if (token) this.store.deleteSession(digest(token))
    response.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  }

  private async passwordHash(password: string): Promise<string> {
    return hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 3, parallelism: 1, outputLen: 32 })
  }

  private assertPassword(password: string): void {
    if (password.length < 10) throw new Error('Password must contain at least 10 characters')
    if (password.length > 256) throw new Error('Password is too long')
  }

  private issueSession(request: IncomingMessage, response: ServerResponse): void {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_MS).toISOString()
    this.store.createSession(digest(token), expiresAt)
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
