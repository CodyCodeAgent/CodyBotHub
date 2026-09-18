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

    store.close()
  })
})
