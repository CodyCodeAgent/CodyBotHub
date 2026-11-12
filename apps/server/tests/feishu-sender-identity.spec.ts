import { describe, expect, it } from 'vitest'
import { resolveSenderIdentity } from '../src/feishu/sender-identity.js'

const message = (sender: Record<string, unknown>) => ({ sender }) as never

describe('Feishu sender identity', () => {
  it('looks up the human sender in the current Bot application namespace', async () => {
    const calls: string[] = []
    const provider = { userMetadata: async (openId: string) => {
      calls.push(openId)
      return { id: openId, name: '张三', email: 'zhangsan@example.com' }
    } }
    await expect(resolveSenderIdentity(provider, message({ id: 'ou_sender', idType: 'open_id', type: 'user' })))
      .resolves.toEqual({ openId: 'ou_sender', name: '张三', email: 'zhangsan@example.com' })
    expect(calls).toEqual(['ou_sender'])
  })

  it('preserves the Open ID when contact access or email is unavailable', async () => {
    const unavailable = { userMetadata: async () => { throw new Error('missing scope') } }
    await expect(resolveSenderIdentity(unavailable, message({ id: 'ou_sender', idType: 'open_id', type: 'user', name: '发言人' })))
      .resolves.toEqual({ openId: 'ou_sender', name: '发言人' })
    const noEmail = { userMetadata: async (openId: string) => ({ id: openId, name: '发言人' }) }
    await expect(resolveSenderIdentity(noEmail, message({ id: 'ou_sender', idType: 'open_id', type: 'user' })))
      .resolves.toEqual({ openId: 'ou_sender', name: '发言人' })
  })

  it('does not look up Bot senders', async () => {
    const provider = { userMetadata: async () => { throw new Error('unexpected lookup') } }
    await expect(resolveSenderIdentity(provider, message({ id: 'ou_bot', idType: 'open_id', type: 'bot' }))).resolves.toBeUndefined()
  })
})
