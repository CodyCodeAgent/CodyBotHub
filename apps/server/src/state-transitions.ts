import type { ScheduledAction, ScheduledRunStatus } from './scheduled-types.js'
import type { MessageLogRecord, ToolPackageExecutionStatus } from './types.js'

type ThreadJobStatus = 'queued' | 'processing' | 'completed' | 'failed'
type State = {
  toolExecution: ToolPackageExecutionStatus
  scheduledRun: ScheduledRunStatus
  scheduledAction: ScheduledAction['status']
  threadJob: ThreadJobStatus
  messageLog: MessageLogRecord['status']
}

const transitions: { [K in keyof State]: Partial<Record<State[K], readonly State[K][]>> } = {
  toolExecution: {
    awaiting_approval: ['queued', 'rejected', 'failed'],
    queued: ['running', 'failed'],
    running: ['completed', 'failed'],
  },
  scheduledRun: {
    queued: ['running', 'awaiting_approval', 'cancelled', 'skipped'],
    running: ['queued', 'awaiting_approval', 'completed', 'warning', 'no_change', 'failed', 'interrupted'],
    awaiting_approval: ['queued', 'cancelled'],
  },
  scheduledAction: {
    awaiting_approval: ['queued', 'rejected', 'expired', 'failed'],
    queued: ['running', 'rejected', 'failed'],
    running: ['completed', 'failed'],
  },
  threadJob: {
    queued: ['processing', 'failed'],
    processing: ['completed', 'failed'],
    failed: ['queued'],
  },
  messageLog: {
    processing: ['completed', 'failed'],
    failed: ['processing'],
  },
}

export function assertTransition<K extends keyof State>(domain: K, from: State[K], to: State[K]): void {
  if (from === to) return
  if (!(transitions[domain][from] as readonly State[K][] | undefined)?.includes(to)) {
    throw new Error(`Invalid ${domain} transition: ${from} -> ${to}`)
  }
}
