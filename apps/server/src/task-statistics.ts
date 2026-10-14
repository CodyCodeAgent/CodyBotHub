export type TaskTokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number }
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const usage = (value: unknown): TaskTokenUsage | null => {
  const row = record(value)
  if (!row) return null
  const values = [row.inputTokens, row.outputTokens, row.totalTokens]
  if (!values.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return null
  return { inputTokens: row.inputTokens as number, outputTokens: row.outputTokens as number, totalTokens: row.totalTokens as number }
}

/** Native Codex cumulative counters, forwarded unchanged by Core's host. */
export function threadTokenCounters(params: unknown): { threadId: string; turnId: string; total: TaskTokenUsage; last: TaskTokenUsage | null } | null {
  const row = record(params)
  const tokenUsage = record(row?.tokenUsage)
  const total = usage(tokenUsage?.total)
  if (!total || typeof row?.threadId !== 'string' || typeof row.turnId !== 'string') return null
  return { threadId: row.threadId, turnId: row.turnId, total, last: usage(tokenUsage?.last) }
}

const subtract = (end: TaskTokenUsage, start: TaskTokenUsage): TaskTokenUsage | null => {
  const result = { inputTokens: end.inputTokens - start.inputTokens, outputTokens: end.outputTokens - start.outputTokens, totalTokens: end.totalTokens - start.totalTokens }
  return Object.values(result).every(value => value >= 0) ? result : null
}

export class TaskTokenUsageTracker {
  private latest: TaskTokenUsage | null = null
  private invalid = false
  constructor(private baseline: TaskTokenUsage | null) {}
  update(total: TaskTokenUsage, last: TaskTokenUsage | null): void {
    // On a resumed thread with no cached baseline, the first native update's
    // last counter establishes the pre-call cumulative value, without using
    // the entire historical total as this task's consumption.
    if (!this.baseline && !this.latest) this.baseline = last ? subtract(total, last) : null
    if (!this.baseline || (this.latest && !subtract(total, this.latest))) this.invalid = true
    this.latest = total
  }
  result(): TaskTokenUsage | null { return !this.invalid && this.baseline && this.latest ? subtract(this.latest, this.baseline) : null }
}

export const characterCount = (text: string): number => Array.from(text).length

export function taskStatisticsMarkdown(mention: string, elapsedMs: number, input: string, output: string, tokens: TaskTokenUsage | null): string {
  const seconds = Math.max(0, Math.ceil(elapsedMs / 1000))
  const duration = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`
  return [
    mention,
    `**处理时间**：${duration}`,
    `**Token 消耗**：${tokens ? `输入 ${tokens.inputTokens.toLocaleString('en-US')} / 输出 ${tokens.outputTokens.toLocaleString('en-US')} / 合计 ${tokens.totalTokens.toLocaleString('en-US')}` : '暂无数据'}`,
    `**输入字符**：${characterCount(input).toLocaleString('en-US')}`,
    `**输出字符**：${characterCount(output).toLocaleString('en-US')}`,
    '耗时不含排队；字符数仅包含本次用户文字和最终回复。',
  ].join('\n')
}
