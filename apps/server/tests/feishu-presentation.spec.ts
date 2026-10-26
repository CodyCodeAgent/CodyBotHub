import { describe, expect, it, vi } from 'vitest'
import { FeishuPresentation } from '../src/feishu/presentation.js'

describe('Feishu presentation', () => {
  it('retries transient delivery failures but not permanent failures', async () => {
    const presentation = new FeishuPresentation()
    const provider = { classifyError: vi.fn((error: Error) => ({ retryable: error.message === 'transient' })) } as never
    const transient = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce('sent')
    await expect(presentation.retryDelivery(provider, transient)).resolves.toBe('sent')
    expect(transient).toHaveBeenCalledTimes(2)
    const permanent = vi.fn().mockRejectedValue(new Error('permanent'))
    await expect(presentation.retryDelivery(provider, permanent)).rejects.toThrow('permanent')
    expect(permanent).toHaveBeenCalledOnce()
  })
})
