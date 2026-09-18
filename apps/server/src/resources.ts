import { constants } from 'node:fs'
import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export type KnowledgeResource = {
  title: string
  description: string
  path: string
  relativePath: string
  updatedAt: string
}

const ignoredDirectories = new Set(['.git', 'node_modules', '.cache', 'dist', 'build', 'coverage', '.next'])
const readableExtensions = new Set(['.md', '.mdx', '.txt', '.json', '.yaml', '.yml'])
const defaultRoots = ['.codex/knowledge', 'knowledge', 'docs']
const skillRoots = ['.codex/skills', '.agents/skills', 'skills']

export class WorkspaceResourceIndex {
  async listKnowledge(workspacePath: string, query = '', limit = 200, minimumScore = 0): Promise<KnowledgeResource[]> {
    const workspace = await realpath(workspacePath)
    const roots = await this.knowledgeRoots(workspace)
    const resources: KnowledgeResource[] = []
    const seen = new Set<string>()
    let visited = 0
    const walk = async (directory: string): Promise<void> => {
      if (visited++ >= 10_000 || resources.length >= 2_000) return
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (ignoredDirectories.has(entry.name)) continue
        const filename = path.join(directory, entry.name)
        if (entry.isDirectory()) { await walk(filename); continue }
        if (!entry.isFile() || !readableExtensions.has(path.extname(entry.name).toLocaleLowerCase())) continue
        let canonical: string
        try { canonical = await realpath(filename) } catch { continue }
        if (!canonical.startsWith(`${workspace}${path.sep}`) || seen.has(canonical)) continue
        seen.add(canonical)
        const info = await stat(canonical)
        if (info.size > 2 * 1024 * 1024) continue
        const source = await readFile(canonical, 'utf8')
        const metadata = describe(source, path.basename(canonical))
        resources.push({
          ...metadata, path: canonical,
          relativePath: path.relative(workspace, canonical).split(path.sep).join('/'),
          updatedAt: info.mtime.toISOString(),
        })
      }
    }
    for (const root of roots) await walk(root)
    const normalized = query.trim().toLocaleLowerCase()
    return resources
      .map(resource => ({ resource, score: relevance(`${resource.title} ${resource.description} ${resource.relativePath}`, normalized) }))
      .filter(item => !normalized || item.score >= minimumScore)
      .sort((left, right) => right.score - left.score || left.resource.relativePath.localeCompare(right.resource.relativePath, 'zh-CN'))
      .slice(0, Math.min(500, Math.max(1, limit)))
      .map(item => item.resource)
  }

  async listRoots(workspacePath: string): Promise<string[]> {
    const workspace = await realpath(workspacePath)
    return this.knowledgeRoots(workspace)
  }

  private async knowledgeRoots(workspace: string): Promise<string[]> {
    const result: string[] = []
    for (const name of defaultRoots) {
      const candidate = path.join(workspace, name)
      if (await exists(candidate)) result.push(await realpath(candidate))
    }
    for (const name of skillRoots) {
      const root = path.join(workspace, name)
      if (!await exists(root)) continue
      let visited = 0
      const findReferences = async (directory: string): Promise<void> => {
        if (visited++ >= 10_000) return
        let entries
        try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue
          const child = path.join(directory, entry.name)
          if (entry.name === 'references') result.push(await realpath(child))
          else await findReferences(child)
        }
      }
      await findReferences(root)
    }
    return [...new Set(result)]
  }
}

export const readSkillSearchTags = async (filename: string): Promise<string[]> => {
  let source = ''
  try { source = await readFile(filename, 'utf8') } catch { return [] }
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1]
  if (!frontmatter) return []
  const lines = frontmatter.split('\n')
  const tags: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(/^\s*(tags|keywords|triggers)\s*:\s*(.*?)\s*$/iu)
    if (!match) continue
    const inline = match[2]?.trim() ?? ''
    if (inline) {
      tags.push(...inline.replace(/^\[|\]$/gu, '').split(',').map(value => value.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean))
      continue
    }
    for (let child = index + 1; child < lines.length; child += 1) {
      const item = lines[child]?.match(/^\s+-\s+(.+?)\s*$/u)
      if (!item) break
      tags.push(item[1]!.trim().replace(/^['"]|['"]$/gu, ''))
      index = child
    }
  }
  return [...new Set(tags.map(value => value.toLocaleLowerCase()))]
}

export const relevance = (value: string, query: string): number => {
  if (!query) return 0
  const haystack = value.toLocaleLowerCase()
  let score = 0
  for (const token of tokens(query)) {
    if (!haystack.includes(token)) continue
    score += token.length >= 6 ? 5 : token.length >= 3 ? 3 : 1
  }
  return score
}

const tokens = (value: string): string[] => {
  const normalized = value.toLocaleLowerCase()
  const words = normalized.match(/[a-z0-9_.-]{2,}|[\p{Script=Han}]{2,}/gu) ?? []
  const chinese = words.flatMap(word => /[\p{Script=Han}]/u.test(word) && word.length > 4
    ? [word, ...Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2))]
    : [word])
  return [...new Set(chinese)]
}

const describe = (source: string, fallback: string): { title: string; description: string } => {
  const frontmatter = source.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? ''
  const frontmatterValue = (key: string) => frontmatter.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'mu'))?.[1]?.trim() ?? ''
  const heading = source.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? ''
  const paragraphs = source.replace(/^---[\s\S]*?---/u, '').split(/\n\s*\n/u).map(item => item.replace(/^#+\s+/u, '').replace(/\s+/gu, ' ').trim())
  return {
    title: frontmatterValue('title') || heading || fallback,
    description: frontmatterValue('description') || paragraphs.find(item => item && item !== heading)?.slice(0, 280) || '',
  }
}

const exists = async (filename: string): Promise<boolean> => {
  try {
    await access(filename, constants.F_OK)
    return (await lstat(filename)).isDirectory()
  } catch { return false }
}
