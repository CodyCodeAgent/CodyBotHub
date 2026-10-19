import { CronExpressionParser } from 'cron-parser'
import type { ScheduleConfig } from './scheduled-types.js'
export const scheduleExpression = (s: ScheduleConfig): string => {
  new Intl.DateTimeFormat('en', { timeZone: s.timezone }).format()
  if (s.kind === 'interval') {
    if (!Number.isSafeInteger(s.intervalMinutes) || s.intervalMinutes < 1 || s.intervalMinutes > 525600)
      throw new Error('执行间隔必须为 1–525600 分钟')
    return ''
  }
  if (s.kind === 'cron') {
    if (s.cron.trim().split(/\s+/u).length !== 5) throw new Error('Cron 必须是 5 段表达式')
    return s.cron.trim()
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(s.time)) throw new Error('执行时间格式应为 HH:mm')
  if (!['daily', 'weekly'].includes(s.kind)) throw new Error('不支持的执行周期')
  if (s.kind === 'weekly' && (!s.weekdays.length || s.weekdays.some((x) => !Number.isInteger(x) || x < 0 || x > 6)))
    throw new Error('请选择有效的星期')
  const [hour, minute] = s.time.split(':')
  return `${minute} ${hour} * * ${s.kind === 'weekly' ? [...new Set(s.weekdays)].sort().join(',') : '*'}`
}
export const nextScheduleDates = (schedule: ScheduleConfig, from = new Date(), count = 3): string[] => {
  if (!schedule || typeof schedule !== 'object') throw new Error('Schedule is required')
  const expression = scheduleExpression(schedule)
  if (!expression)
    return Array.from({ length: count }, (_, i) =>
      new Date(from.getTime() + schedule.intervalMinutes * 60000 * (i + 1)).toISOString()
    )
  const parser = CronExpressionParser.parse(expression, { currentDate: from, tz: schedule.timezone })
  return Array.from({ length: count }, () => parser.next().toISOString()!)
}
