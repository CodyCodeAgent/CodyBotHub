import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HubStore } from '../src/db.js'
import { SkillSyncService } from '../src/skills.js'

const temporaryDirectories: string[] = []
const temporary = (name: string) => { const value = mkdtempSync(path.join(tmpdir(), name)); temporaryDirectories.push(value); return value }
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })

afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('SkillSyncService', () => {
  it('isolates conflicting source variants while listing and installing unrelated Skills', async () => {
    const workspacePath = temporary('codybothub-conflict-workspace-')
    const cachePath = temporary('codybothub-conflict-cache-')
    const store = new HubStore(':memory:')
    try {
      const workspace = store.createWorkspace({ name: 'Conflict fixture', path: workspacePath })
      const source = store.createSkillSource({ name: 'Mixed roots', repositoryUrl: '/unused', branch: 'main', workspaceId: workspace.id, skillRoots: ['skills', '.agents/skills', '.claude/skills', 'skills'], knowledgeRoots: [], autoInstall: false })
      const writeSkill = (root: string, relative: string, name: string, description: string) => {
        const directory = path.join(root, relative)
        mkdirSync(directory, { recursive: true })
        writeFileSync(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# Skill\n`)
      }
      const checkout = path.join(cachePath, source.id, 'repo')
      writeSkill(checkout, 'skills/api', 'api-mind', 'Version A')
      writeSkill(checkout, '.agents/skills/api', 'api-mind', 'Version B')
      writeSkill(checkout, '.claude/skills/api', 'api-mind', 'Version A')
      writeSkill(checkout, 'skills/healthy', 'healthy', 'Unrelated remote')
      writeSkill(workspacePath, '.codex/skills/local-only', 'local-only', 'Existing local')
      writeSkill(workspacePath, '.codex/skills/api-mind', 'api-mind', 'Preserve installed version')
      const service = new SkillSyncService(store, cachePath)
      const catalog = await service.catalog()
      expect(catalog).toHaveLength(3)
      const conflict = catalog.find(item => item.name === 'api-mind')!
      expect(conflict.status).toBe('source_conflict')
      expect(conflict.conflictPaths).toEqual(['skills/api', '.agents/skills/api', '.claude/skills/api'])
      expect(catalog).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'healthy', status: 'available' }), expect.objectContaining({ name: 'local-only', status: 'local' })]))
      expect(await service.catalog({ status: 'source_conflict', query: '.agents/skills/api' })).toEqual([conflict])
      const manifest = path.join(workspacePath, '.codex/skills/api-mind/SKILL.md')
      const original = readFileSync(manifest, 'utf8')
      expect(await service.install({ sourceId: source.id, workspaceId: workspace.id, all: true, force: true })).toMatchObject({ installed: 1, skipped: 1, errors: [expect.stringContaining('请先处理来源冲突')] })
      expect(readFileSync(manifest, 'utf8')).toBe(original)
      expect(await service.install({ sourceId: source.id, workspaceId: workspace.id, skillKeys: [conflict.key], force: true })).toMatchObject({ installed: 0, skipped: 1, errors: [expect.stringContaining('请先处理来源冲突')] })
      expect(readFileSync(manifest, 'utf8')).toBe(original)
      expect(await service.catalog({ status: 'installed' })).toHaveLength(1)
    } finally { store.close() }
  })

  it('deduplicates identical copies deterministically without creating a source conflict', async () => {
    const workspacePath = temporary('codybothub-identical-workspace-')
    const cachePath = temporary('codybothub-identical-cache-')
    const store = new HubStore(':memory:')
    try {
      const workspace = store.createWorkspace({ name: 'Identical fixture', path: workspacePath })
      const source = store.createSkillSource({ name: 'Identical roots', repositoryUrl: '/unused', branch: 'main', workspaceId: workspace.id, skillRoots: ['skills', '.agents/skills'], knowledgeRoots: [], autoInstall: false })
      for (const root of source.skillRoots) {
        const directory = path.join(cachePath, source.id, 'repo', root, 'same-skill')
        mkdirSync(directory, { recursive: true })
        writeFileSync(path.join(directory, 'SKILL.md'), '---\nname: same-skill\n---\n# Identical\n')
      }
      const service = new SkillSyncService(store, cachePath)
      expect(await service.catalog()).toMatchObject([{ key: '.agents/skills/same-skill', status: 'available' }])
      expect(await service.install({ sourceId: source.id, workspaceId: workspace.id, all: true })).toEqual({ installed: 1, skipped: 0, errors: [] })
      expect(await service.catalog()).toMatchObject([{ key: '.agents/skills/same-skill', status: 'installed' }])
    } finally { store.close() }
  })

  it('syncs a clean mirror and installs versioned Skills into a Workspace', async () => {
    const sourceRepository = temporary('codybothub-skill-source-')
    mkdirSync(path.join(sourceRepository, 'skills', 'demo-skill'), { recursive: true })
    writeFileSync(path.join(sourceRepository, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: First version\n---\n# Demo\n')
    git(sourceRepository, 'init')
    git(sourceRepository, 'checkout', '-b', 'main')
    git(sourceRepository, 'add', '.')
    git(sourceRepository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial')

    const workspacePath = temporary('codybothub-skill-workspace-')
    const cachePath = temporary('codybothub-skill-cache-')
    const store = new HubStore(':memory:')
    const workspace = store.createWorkspace({ name: 'AI Hub', path: workspacePath })
    const account = store.createAdminAccount({ loginName: 'admin', displayName: 'Admin', passwordHash: 'hash' })
    expect(account.theme).toBe('system')
    expect(store.setAdminTheme(account.id, 'light').theme).toBe('light')
    const source = store.createSkillSource({ name: 'Remote', repositoryUrl: sourceRepository, branch: 'main', workspaceId: workspace.id, skillRoots: ['skills'], knowledgeRoots: [], autoInstall: false })
    const service = new SkillSyncService(store, cachePath)

    const synced = await service.sync(source.id)
    expect(synced.source.lastCommit).toHaveLength(40)
    expect(await service.catalog({ workspaceId: workspace.id })).toMatchObject([{ name: 'demo-skill', status: 'available', sourceName: 'Remote' }])

    const installed = await service.install({ sourceId: source.id, workspaceId: workspace.id, all: true })
    expect(installed).toMatchObject({ installed: 1, skipped: 0, errors: [] })
    const manifest = path.join(workspacePath, '.codex', 'skills', 'demo-skill', 'SKILL.md')
    expect(existsSync(manifest)).toBe(true)
    expect(await service.catalog({ workspaceId: workspace.id, status: 'installed' })).toHaveLength(1)

    writeFileSync(path.join(sourceRepository, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Second version\n---\n# Demo\n')
    git(sourceRepository, 'add', '.')
    git(sourceRepository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'update')
    await service.sync(source.id)
    expect(await service.catalog({ workspaceId: workspace.id, status: 'update_available' })).toHaveLength(1)
    await service.install({ sourceId: source.id, workspaceId: workspace.id, all: true })
    expect(readFileSync(manifest, 'utf8')).toContain('Second version')
    expect(existsSync(path.join(workspacePath, '.codex', 'skill-backups'))).toBe(true)

    const installedDirectory = path.dirname(manifest)
    mkdirSync(path.join(installedDirectory, '.venv'), { recursive: true })
    writeFileSync(path.join(installedDirectory, '.venv', 'runtime'), 'local environment')
    writeFileSync(path.join(installedDirectory, '.env'), 'local configuration')
    writeFileSync(path.join(sourceRepository, 'skills', 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: Third version\n---\n# Demo\n')
    git(sourceRepository, 'add', '.')
    git(sourceRepository, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'third')
    await service.sync(source.id)
    await service.install({ sourceId: source.id, workspaceId: workspace.id, all: true })
    expect(readFileSync(path.join(installedDirectory, '.venv', 'runtime'), 'utf8')).toBe('local environment')
    expect(readFileSync(path.join(installedDirectory, '.env'), 'utf8')).toBe('local configuration')
    writeFileSync(manifest, 'manual skill changes')
    const preserved = await service.install({ sourceId: source.id, workspaceId: workspace.id, all: true })
    expect(preserved.errors).toEqual([expect.stringContaining('本地内容已修改')])
    expect(readFileSync(manifest, 'utf8')).toBe('manual skill changes')
    const conflicting = store.createSkillSource({ name: 'Conflicting remote', repositoryUrl: sourceRepository, branch: 'main', workspaceId: workspace.id, skillRoots: ['skills'], knowledgeRoots: [], autoInstall: true })
    await expect(service.sync(conflicting.id)).rejects.toThrow('安装未全部完成')
    expect(store.getSkillSource(conflicting.id).lastSyncedAt).toBe('')

    store.close()
  }, 20000)
})
