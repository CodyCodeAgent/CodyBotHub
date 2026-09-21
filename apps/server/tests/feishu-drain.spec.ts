import { describe, expect, it, vi } from 'vitest'
import { FeishuBotManager } from '../src/feishu.js'

const managerFixture = () => {
  const store = {
    listBots: vi.fn(() => []),
    listQueuedThreadJobs: vi.fn(() => []),
    listQueuedToolPackageExecutions: vi.fn(() => []),
  }
  const manager = new FeishuBotManager(store as never, {} as never, {} as never, '/tmp/codybothub-attachments')
  return { manager, store }
}

describe('FeishuBotManager deployment drain', () => {
  it('keeps queued work dormant while draining and resumes it after cancellation', () => {
    const { manager, store } = managerFixture()
    manager.beginDrain()
    manager.resumeQueuedJobs()

    expect(store.listQueuedThreadJobs).not.toHaveBeenCalled()
    expect(manager.health()).toMatchObject({ draining: true, activeJobs: 0, pendingReceipts: 0 })

    manager.cancelDrain()
    expect(store.listQueuedThreadJobs).toHaveBeenCalledOnce()
    expect(manager.health()).toMatchObject({ draining: false, drainStartedAt: '' })
  })

  it('waits for active work and pending receipts before becoming idle', async () => {
    const { manager } = managerFixture()
    const internals = manager as unknown as { scheduledJobs: Set<string>; pendingReceipts: Set<string> }
    internals.scheduledJobs.add('job-1')
    internals.pendingReceipts.add('job-2')

    let settled = false
    const waiting = manager.waitForIdle().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    internals.scheduledJobs.delete('job-1')
    internals.pendingReceipts.delete('job-2')
    await waiting
    expect(settled).toBe(true)
  })
})
