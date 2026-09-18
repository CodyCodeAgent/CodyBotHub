import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { HubStore } from './db.js'
import type { SkillCatalogItem, SkillSourceRecord } from './types.js'

const runFile = promisify(execFile)
const ignoredDirectories = new Set(['.git', 'node_modules', '.cache', 'dist', 'build'])

type DiscoveredSkill = { key: string; name: string; targetName: string; description: string; absolutePath: string; relativePath: string; checksum: string }

export class SkillSyncService {
  private readonly running = new Map<string, Promise<unknown>>()

  constructor(private readonly store: HubStore, private readonly rootDirectory: string) {}

  async removeSource(sourceId: string): Promise<void> {
    await rm(this.sourceDirectory(sourceId), { recursive: true, force: true })
  }

  async sync(sourceId: string): Promise<{ source: SkillSourceRecord; installed: number; skipped: number }> {
    if (this.running.has(sourceId)) throw new Error('Skill source sync is already running')
    const task = this.performSync(sourceId)
    this.running.set(sourceId, task)
    try { return await task }
    finally { this.running.delete(sourceId) }
  }

  private async performSync(sourceId: string): Promise<{ source: SkillSourceRecord; installed: number; skipped: number }> {
    const source = this.store.getSkillSource(sourceId)
    const checkout = this.checkoutDirectory(sourceId)
    try {
      await mkdir(this.sourceDirectory(sourceId), { recursive: true })
      if (await exists(path.join(checkout, '.git'))) {
        await git(['-C', checkout, 'remote', 'set-url', 'origin', source.repositoryUrl])
        await git(['-C', checkout, 'fetch', '--prune', 'origin', source.branch])
        await git(['-C', checkout, 'reset', '--hard', `origin/${source.branch}`])
        await git(['-C', checkout, 'clean', '-fdx'])
      } else {
        await rm(checkout, { recursive: true, force: true })
        await git(['clone', '--single-branch', '--branch', source.branch, '--no-recurse-submodules', source.repositoryUrl, checkout])
      }
      for (const root of source.knowledgeRoots) {
        const safeRoot = safeRelative(root)
        await git(['-C', checkout, 'submodule', 'sync', '--', safeRoot]).catch(() => undefined)
        await git(['-C', checkout, 'submodule', 'update', '--init', '--depth', '1', '--', safeRoot]).catch(() => undefined)
      }
      const { stdout } = await runFile('git', ['-C', checkout, 'rev-parse', 'HEAD'], { maxBuffer: 1024 * 1024 })
      const updated = this.store.updateSkillSourceSync(sourceId, { lastSyncedAt: new Date().toISOString(), lastCommit: stdout.trim(), lastError: '' })
      await this.copyKnowledge(updated)
      let installed = 0, skipped = 0
      if (updated.autoInstall) {
        const result = await this.install({ sourceId, workspaceId: updated.workspaceId, all: true, force: false })
        installed = result.installed
        skipped = result.skipped
      }
      return { source: this.store.getSkillSource(sourceId), installed, skipped }
    } catch (error) {
      this.store.updateSkillSourceSync(sourceId, { lastError: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  async catalog(input: { workspaceId?: string; sourceId?: string; status?: string; query?: string } = {}): Promise<SkillCatalogItem[]> {
    const sources = this.store.listSkillSources().filter(source => (!input.sourceId || source.id === input.sourceId) && (!input.workspaceId || source.workspaceId === input.workspaceId))
    const result: SkillCatalogItem[] = []
    const managedTargets = new Set(this.store.listSkillInstallations(input.workspaceId ? { workspaceId: input.workspaceId } : {}).map(item => path.resolve(item.targetPath)))
    for (const source of sources) {
      const skills = await this.discoverSourceSkills(source)
      const installations = new Map(this.store.listSkillInstallations({ sourceId: source.id, workspaceId: source.workspaceId }).map(item => [item.skillKey, item]))
      for (const skill of skills) {
        const targetPath = path.join(this.store.getWorkspace(source.workspaceId).path, '.codex', 'skills', skill.targetName)
        const installation = installations.get(skill.key)
        const targetExists = await exists(targetPath)
        let status: SkillCatalogItem['status'] = 'available'
        if (installation) {
          if (!targetExists) status = 'available'
          else if (installation.sourceChecksum !== skill.checksum || installation.installedCommit !== source.lastCommit) status = 'update_available'
          else status = 'installed'
        } else if (targetExists) status = 'conflict'
        result.push({ key: skill.key, name: skill.name, description: skill.description, sourceId: source.id, sourceName: source.name, workspaceId: source.workspaceId, workspaceName: source.workspaceName, sourcePath: skill.relativePath, targetPath, status, checksum: skill.checksum, installedCommit: installation?.installedCommit ?? '' })
      }
    }

    for (const workspace of this.store.listWorkspaces().filter(item => !input.workspaceId || item.id === input.workspaceId)) {
      const localNames = new Set<string>()
      for (const rootName of ['.codex/skills', '.agents/skills', 'skills']) {
        const root = path.join(workspace.path, rootName)
        if (!await exists(root)) continue
        const skills = await discoverSkills(root, workspace.path)
        for (const skill of skills) {
          if (localNames.has(skill.targetName)) continue
          localNames.add(skill.targetName)
          if (managedTargets.has(path.resolve(skill.absolutePath))) continue
          if (result.some(item => path.resolve(item.targetPath) === path.resolve(skill.absolutePath))) continue
          result.push({ key: `local:${workspace.id}:${skill.relativePath}`, name: skill.name, description: skill.description, sourceId: '', sourceName: '本地工作区', workspaceId: workspace.id, workspaceName: workspace.name, sourcePath: skill.relativePath, targetPath: skill.absolutePath, status: 'local', checksum: skill.checksum, installedCommit: '' })
        }
      }
    }

    const query = input.query?.trim().toLocaleLowerCase()
    return result.filter(item => (!input.status || item.status === input.status) && (!query || `${item.name} ${item.description} ${item.sourceName} ${item.sourcePath}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  async install(input: { sourceId: string; workspaceId: string; skillKeys?: string[]; all?: boolean; force?: boolean }): Promise<{ installed: number; skipped: number; errors: string[] }> {
    const source = this.store.getSkillSource(input.sourceId)
    if (source.workspaceId !== input.workspaceId) throw new Error('Skill source belongs to a different Workspace')
    const workspace = this.store.getWorkspace(input.workspaceId)
    const available = await this.discoverSourceSkills(source)
    const selected = input.all ? available : available.filter(skill => input.skillKeys?.includes(skill.key))
    if (!input.all && !selected.length) throw new Error('At least one Skill is required')
    const installations = new Map(this.store.listSkillInstallations({ sourceId: source.id, workspaceId: workspace.id }).map(item => [item.skillKey, item]))
    const skillsDirectory = path.join(workspace.path, '.codex', 'skills')
    const backupDirectory = path.join(workspace.path, '.codex', 'skill-backups')
    await mkdir(skillsDirectory, { recursive: true })
    let installed = 0, skipped = 0
    const errors: string[] = []
    for (const skill of selected) {
      const targetPath = path.join(skillsDirectory, skill.targetName)
      const current = installations.get(skill.key)
      try {
        if (current && current.sourceChecksum === skill.checksum && current.installedCommit === source.lastCommit && await exists(targetPath)) { skipped += 1; continue }
        if (await exists(targetPath)) {
          if (!current && !input.force) { skipped += 1; errors.push(`${skill.name}：目标目录已存在`); continue }
          await mkdir(backupDirectory, { recursive: true })
          await rename(targetPath, path.join(backupDirectory, `${safeTimestamp()}-${skill.targetName}`))
        }
        const temporary = `${targetPath}.installing-${process.pid}`
        await rm(temporary, { recursive: true, force: true })
        await cp(skill.absolutePath, temporary, { recursive: true, dereference: true })
        await rename(temporary, targetPath)
        this.store.upsertSkillInstallation({ sourceId: source.id, workspaceId: workspace.id, skillKey: skill.key, targetName: skill.targetName, sourcePath: skill.relativePath, targetPath, installedCommit: source.lastCommit, sourceChecksum: skill.checksum })
        installed += 1
      } catch (error) {
        errors.push(`${skill.name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await this.copyKnowledge(source)
    return { installed, skipped, errors }
  }

  private async discoverSourceSkills(source: SkillSourceRecord): Promise<DiscoveredSkill[]> {
    const checkout = this.checkoutDirectory(source.id)
    if (!await exists(checkout)) return []
    const roots = source.skillRoots.length ? source.skillRoots : ['skills', '.codex/skills', '.agents/skills']
    const found: DiscoveredSkill[] = []
    for (const configuredRoot of roots) {
      const root = path.join(checkout, safeRelative(configuredRoot))
      if (!await exists(root)) continue
      found.push(...await discoverSkills(root, checkout))
    }
    return uniqueBy(found, item => item.targetName)
  }

  private async copyKnowledge(source: SkillSourceRecord): Promise<void> {
    if (!source.knowledgeRoots.length) return
    const checkout = this.checkoutDirectory(source.id)
    const workspace = this.store.getWorkspace(source.workspaceId)
    const targetRoot = path.join(workspace.path, '.codex', 'knowledge', source.id)
    await mkdir(targetRoot, { recursive: true })
    for (const configuredRoot of source.knowledgeRoots) {
      const root = safeRelative(configuredRoot)
      const sourcePath = path.join(checkout, root)
      if (!await exists(sourcePath)) continue
      const targetPath = path.join(targetRoot, path.basename(root))
      const temporary = `${targetPath}.syncing-${process.pid}`
      await rm(temporary, { recursive: true, force: true })
      await cp(sourcePath, temporary, { recursive: true, dereference: true, filter: value => !value.split(path.sep).some(part => part === '.git') })
      await rm(targetPath, { recursive: true, force: true })
      await rename(temporary, targetPath)
    }
  }

  private sourceDirectory(sourceId: string): string { return path.join(this.rootDirectory, sourceId) }
  private checkoutDirectory(sourceId: string): string { return path.join(this.sourceDirectory(sourceId), 'repo') }
}

const discoverSkills = async (root: string, relativeBase: string): Promise<DiscoveredSkill[]> => {
  const result: DiscoveredSkill[] = []
  let visited = 0
  const walk = async (directory: string): Promise<void> => {
    if (visited++ > 10000) throw new Error('Skill scan exceeded the directory limit')
    const manifest = path.join(directory, 'SKILL.md')
    if (await exists(manifest)) {
      const content = await readFile(manifest, 'utf8')
      const metadata = parseSkillMetadata(content, path.basename(directory))
      const relativePath = path.relative(relativeBase, directory).split(path.sep).join('/')
      result.push({ key: relativePath, name: metadata.name, targetName: safeTargetName(metadata.name || path.basename(directory)), description: metadata.description, absolutePath: directory, relativePath, checksum: await checksumDirectory(directory) })
      return
    }
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(entries.filter(entry => !ignoredDirectories.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())).map(async entry => {
      const child = path.join(directory, entry.name)
      try { if ((await lstat(child)).isSymbolicLink()) { const info = await lstat(child); if (!info) return } await walk(child) } catch { /* broken or unreadable entries are ignored */ }
    }))
  }
  await walk(root)
  return result
}

const parseSkillMetadata = (content: string, fallback: string): { name: string; description: string } => {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/u)?.[1] ?? ''
  const value = (key: string) => frontmatter.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'mu'))?.[1]?.trim() ?? ''
  const title = content.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? ''
  const firstParagraph = content.replace(/^---[\s\S]*?---/u, '').split(/\n\s*\n/u).map(item => item.replace(/^#+\s+/u, '').trim()).find(item => item && !item.startsWith('#')) ?? ''
  return { name: value('name') || title || fallback, description: value('description') || firstParagraph.slice(0, 240) }
}

const checksumDirectory = async (directory: string): Promise<string> => {
  const hash = createHash('sha256')
  const walk = async (current: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).filter(item => !ignoredDirectories.has(item.name)).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      hash.update(path.relative(directory, child))
      if (entry.isDirectory()) await walk(child)
      else if (entry.isFile()) hash.update(await readFile(child))
    }
  }
  await walk(directory)
  return hash.digest('hex')
}

const safeRelative = (value: string): string => {
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`Invalid source path: ${value}`)
  return normalized.replace(/^\.\//u, '').replace(/\/$/u, '')
}
const safeTargetName = (value: string): string => value.trim().replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'skill'
const safeTimestamp = (): string => new Date().toISOString().replace(/[:.]/gu, '-')
const exists = async (filename: string): Promise<boolean> => access(filename, constants.F_OK).then(() => true, () => false)
const git = async (args: string[]): Promise<void> => { await runFile('git', args, { maxBuffer: 20 * 1024 * 1024 }) }
const uniqueBy = <T>(values: T[], key: (value: T) => string): T[] => [...new Map(values.map(value => [key(value), value])).values()]
