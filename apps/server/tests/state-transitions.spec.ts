import { describe, expect, it } from 'vitest'
import { assertTransition } from '../src/state-transitions.js'

describe('durable state transitions', () => {
  it('accepts the approval and execution paths', () => {
    expect(() => assertTransition('toolExecution', 'awaiting_approval', 'queued')).not.toThrow()
    expect(() => assertTransition('toolExecution', 'queued', 'running')).not.toThrow()
    expect(() => assertTransition('scheduledRun', 'running', 'awaiting_approval')).not.toThrow()
    expect(() => assertTransition('scheduledRun', 'awaiting_approval', 'queued')).not.toThrow()
    expect(() => assertTransition('threadJob', 'queued', 'failed')).not.toThrow()
    expect(() => assertTransition('threadJob', 'failed', 'queued')).not.toThrow()
    expect(() => assertTransition('messageLog', 'processing', 'failed')).not.toThrow()
    expect(() => assertTransition('messageLog', 'failed', 'processing')).not.toThrow()
  })

  it('rejects reopening terminal states and skipping approval', () => {
    expect(() => assertTransition('toolExecution', 'completed', 'running')).toThrow('Invalid toolExecution transition')
    expect(() => assertTransition('toolExecution', 'awaiting_approval', 'running')).toThrow('Invalid toolExecution transition')
    expect(() => assertTransition('scheduledRun', 'cancelled', 'running')).toThrow('Invalid scheduledRun transition')
    expect(() => assertTransition('threadJob', 'failed', 'completed')).toThrow('Invalid threadJob transition')
    expect(() => assertTransition('messageLog', 'completed', 'processing')).toThrow('Invalid messageLog transition')
  })
})
