import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import { WorkspaceSyncService } from '../../src/workspace-sync.js'
import type { WorkspaceSyncConfig } from '../../src/scheduled-types.js'

const fixtureDirectories = new Set<string>()

export const git = (directory: string, ...args: string[]) =>
  execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()

export const commit = (directory: string, message: string) => {
  git(directory, 'add', '.')
  git(directory, '-c', 'user.name=CodyBotHub Test', '-c', 'user.email=test@localhost', 'commit', '-m', message)
}

export const cleanupWorkspaceSyncFixtures = () => {
  for (const directory of fixtureDirectories) {
    rmSync(directory, { recursive: true, force: true })
    fixtureDirectories.delete(directory)
  }
}

export const setupWorkspaceSync = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'workspace-sync-'))
  fixtureDirectories.add(directory)
  const source = path.join(directory, 'source')
  const workspace = path.join(directory, 'workspace')
  const data = path.join(directory, 'data')
  mkdirSync(source)
  git(source, 'init', '-b', 'main')
  mkdirSync(path.join(source, 'skills/demo'), { recursive: true })
  writeFileSync(path.join(source, 'README.md'), 'version one')
  writeFileSync(path.join(source, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: original\n---\n# Demo')
  commit(source, 'first')
  execFileSync('git', ['clone', '--branch', 'main', source, workspace], { stdio: 'pipe' })

  const service = new WorkspaceSyncService(data)
  const config: WorkspaceSyncConfig = {
    branch: 'main',
    submodules: [],
    installSkills: true,
    skillRoots: ['skills'],
    sourceIds: []
  }
  let runCount = 0
  const run = (
    verify: () => Promise<unknown> = async () => ({ skills: ['demo'], knowledgeRoots: [] }),
    maintain: <T>(action: () => Promise<T>) => Promise<T> = action => action()
  ) => service.run({
    workspaceId: 'workspace-id',
    workspacePath: workspace,
    runId: `run-${++runCount}`,
    config,
    signal: new AbortController().signal,
    event: vi.fn(),
    maintain,
    syncSource: async () => ({}),
    verify
  })
  return { source, workspace, data, service, config, run }
}

export const setupDivergedModule = (conflict = false) => {
  const fixture = setupWorkspaceSync()
  const moduleSource = path.join(path.dirname(fixture.source), 'module-source')
  mkdirSync(moduleSource)
  git(moduleSource, 'init', '-b', 'main')
  writeFileSync(path.join(moduleSource, 'guide.md'), 'shared baseline\n')
  commit(moduleSource, 'base')
  git(fixture.source, '-c', 'protocol.file.allow=always', 'submodule', 'add', moduleSource, 'services/docs')
  commit(fixture.source, 'module')
  git(fixture.workspace, 'fetch', 'origin', 'main')
  git(fixture.workspace, 'merge', '--ff-only', 'origin/main')
  git(fixture.workspace, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init')
  const module = path.join(fixture.workspace, 'services/docs')
  writeFileSync(path.join(module, conflict ? 'guide.md' : 'local.txt'), 'local knowledge\n')
  commit(module, 'local knowledge')
  const before = git(module, 'rev-parse', 'HEAD')
  writeFileSync(path.join(moduleSource, conflict ? 'guide.md' : 'remote.txt'), 'remote knowledge\n')
  commit(moduleSource, 'remote knowledge')
  fixture.config.submodules = [{ path: 'services/docs', mode: 'merge', branch: 'main', required: true }]
  return { ...fixture, module, moduleSource, before }
}
