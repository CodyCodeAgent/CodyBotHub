import type { ScheduledRunStatus, ScheduleConfig } from './types'
export const runLabels: Record<ScheduledRunStatus, string> = {
  queued: '排队中',
  running: '执行中',
  awaiting_approval: '等待人工确认',
  completed: '成功',
  warning: '完成 · 有待处理项',
  failed: '失败',
  interrupted: '已中断 · 需核实',
  cancelled: '已取消',
  skipped: '已跳过',
  no_change: '无更新'
}
export const runColor = (status: ScheduledRunStatus): string =>
  ({
    completed: 'green',
    warning: 'orange',
    failed: 'red',
    interrupted: 'orange',
    awaiting_approval: 'orange',
    queued: 'blue',
    running: 'blue',
    cancelled: 'gray',
    skipped: 'gray',
    no_change: 'gray'
  })[status]
export const formatTime = (value: string, timezone = 'Asia/Shanghai'): string => {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleString('zh-CN', { timeZone: timezone, hour12: false })
  } catch {
    return value
  }
}
export const duration = (start: string, end: string): string =>
  !start
    ? '—'
    : `${Math.max(0, (Date.parse(end || new Date().toISOString()) - Date.parse(start)) / 1000).toFixed(1)} 秒`
export const scheduleLabel = (s: ScheduleConfig): string =>
  s.kind === 'interval'
    ? `每 ${s.intervalMinutes % 60 === 0 ? s.intervalMinutes / 60 + ' 小时' : s.intervalMinutes + ' 分钟'}`
    : s.kind === 'daily'
      ? `每天 ${s.time}`
      : s.kind === 'weekly'
        ? `每周 ${s.weekdays.map((d) => ['日', '一', '二', '三', '四', '五', '六'][d]).join('、')} ${s.time}`
        : s.cron
