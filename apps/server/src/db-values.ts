export type DatabaseRow = Record<string, unknown>

export const databaseNow = () => new Date().toISOString()

export const validateSceneTimeout = (value?: number) => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 35791)) {
    throw new Error('任务超时必须为 1–35791 分钟的整数')
  }
}

export const stringList = (value: unknown): string[] => {
  try {
    const parsed: unknown = JSON.parse(String(value))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export const jsonObject = (value: unknown): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(String(value))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export const jsonValue = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}
