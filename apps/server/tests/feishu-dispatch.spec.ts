import { describe, expect, it } from 'vitest'
import { FeishuChannelDispatcher } from '../src/feishu/dispatch.js'

describe('Feishu channel dispatcher', () => {
  it('serializes one channel, permits other channels, and coalesces duplicate jobs', async () => {
    const dispatcher = new FeishuChannelDispatcher()
    const order: string[] = []
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const first = dispatcher.enqueue('chat-a', 'job-1', async () => { order.push('first'); await blocked })
    const duplicate = dispatcher.enqueue('chat-a', 'job-1', async () => { order.push('duplicate') })
    const second = dispatcher.enqueue('chat-a', 'job-2', async () => { order.push('second') })
    await dispatcher.enqueue('chat-b', 'job-3', async () => { order.push('other') })
    expect(order).toEqual(['first', 'other'])
    release()
    await Promise.all([first, duplicate, second])
    expect(order).toEqual(['first', 'other', 'second'])
    expect(dispatcher.activeChannels).toBe(0)
    expect(dispatcher.activeJobs).toBe(0)
  })
})
