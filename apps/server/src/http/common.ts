import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HubStore } from '../db.js'
import type { AdminAccountRecord } from '../types.js'

export type Json = Record<string, unknown>
export type AuthenticatedRouteContext = {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  method: string
  actor: AdminAccountRecord
  store: HubStore
  audit: (action: string, targetType: string, targetId: string, summary: string, details?: Record<string, unknown>) => void
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(value))
}

export const readJson = async (request: IncomingMessage): Promise<Json> => {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array)
    size += value.length
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body is too large')
    chunks.push(value)
  }
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json }
  catch { throw new HttpError(400, 'Invalid JSON body') }
}

export const required = (body: Json, key: string): string => {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${key} is required`)
  return value.trim()
}
export const bool = (value: unknown, fallback = false): boolean => typeof value === 'boolean' ? value : fallback
export const optional = (body: Json, key: string): string => typeof body[key] === 'string' ? String(body[key]).trim() : ''
export const number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
export const matchId = (pathname: string, prefix: string): string | null => {
  if (!pathname.startsWith(prefix)) return null
  const value = pathname.slice(prefix.length)
  return value && !value.includes('/') ? decodeURIComponent(value) : null
}
export const page = <T>(items: T[], url: URL, fallback = 20): { items: T[]; total: number } => {
  const requestedLimit = Number(url.searchParams.get('limit') ?? fallback)
  const requestedOffset = Number(url.searchParams.get('offset') ?? 0)
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : fallback))
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.trunc(requestedOffset) : 0)
  return { items: items.slice(offset, offset + limit), total: items.length }
}
