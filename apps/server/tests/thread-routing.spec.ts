import { describe, expect, it } from 'vitest'
import { extractThreadFeatures, scoreThreadSimilarity } from '../src/thread-routing.js'

describe('Thread similarity', () => {
  it('treats a stable service and event signature as the same event despite changing timestamps', () => {
    const previous = extractThreadFeatures('2026-09-18 12:20 service: life.marketing.budget event: sync_allocation group: consumer partition: 7 lag 318')
    const current = extractThreadFeatures('2026-09-18 12:35 service: life.marketing.budget event: sync_allocation group: consumer partition: 7 lag 992')
    const result = scoreThreadSimilarity(current, previous, { structuredWeight: 0.7, textWeight: 0.3 })
    expect(result.sameEvent).toBe(true)
    expect(result.score).toBeGreaterThanOrEqual(0.98)
  })

  it('does not classify unrelated alerts as the same event', () => {
    const previous = extractThreadFeatures('service: life.marketing.budget event: issue_budget database timeout')
    const current = extractThreadFeatures('service: life.trade.order event: create_order rpc panic')
    const result = scoreThreadSimilarity(current, previous, { structuredWeight: 0.7, textWeight: 0.3 })
    expect(result.sameEvent).toBe(false)
    expect(result.score).toBeLessThan(0.55)
  })
})
