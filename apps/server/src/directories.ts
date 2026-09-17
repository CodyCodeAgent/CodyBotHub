import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface DirectoryListing {
  roots: Array<{ name: string; path: string }>
  current: string
  parent: string | null
  directories: Array<{ name: string; path: string }>
}

const canonicalDirectory = (value: string): string => {
  const normalized = resolve(value.trim())
  if (!isAbsolute(normalized) || !existsSync(normalized)) throw new Error('目录不存在')
  const canonical = realpathSync(normalized)
  readdirSync(canonical, { withFileTypes: true })
  return canonical
}

const isWithin = (value: string, root: string): boolean => {
  const difference = relative(root, value)
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))
}

const configuredRoots = (): string[] => {
  const extra = process.env.CODY_BOT_HUB_DIRECTORY_ROOTS?.split(',').map(value => value.trim()).filter(Boolean) ?? []
  return [homedir(), ...extra]
}

export function listBrowsableDirectories(requestedPath?: string, rootPaths = configuredRoots()): DirectoryListing {
  const seen = new Set<string>()
  const roots = rootPaths.flatMap(value => {
    try {
      const canonical = canonicalDirectory(value)
      if (seen.has(canonical)) return []
      seen.add(canonical)
      return [{ name: canonical === homedir() ? '主目录' : basename(canonical) || canonical, path: canonical }]
    } catch { return [] }
  })
  if (!roots.length) throw new Error('没有可浏览的目录根')
  const current = requestedPath?.trim() ? canonicalDirectory(requestedPath) : roots[0]!.path
  if (!roots.some(root => isWithin(current, root.path))) throw new Error('目录不在允许浏览范围内')
  const directories = readdirSync(current, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: join(current, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const candidateParent = dirname(current)
  const parent = roots.some(root => isWithin(candidateParent, root.path)) ? candidateParent : null
  return { roots, current, parent, directories }
}
