import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectWorkspace, WorkspaceSyncService, skillContentHash } from '../src/workspace-sync.js'
import type { WorkspaceSyncConfig } from '../src/scheduled-types.js'
vi.setConfig({ testTimeout: 20000 })
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
const commit = (dir: string, message: string) => {
  git(dir, 'add', '.')
  git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message)
}
const setup = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'workspace-sync-'))
  dirs.push(dir)
  const source = path.join(dir, 'source'),
    workspace = path.join(dir, 'workspace'),
    data = path.join(dir, 'data')
  mkdirSync(source)
  git(source, 'init', '-b', 'main')
  mkdirSync(path.join(source, 'skills/demo'), { recursive: true })
  writeFileSync(path.join(source, 'README.md'), 'version one')
  writeFileSync(path.join(source, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: original\n---\n# Demo')
  commit(source, 'first')
  execFileSync('git', ['clone', '--branch', 'main', source, workspace], { stdio: 'pipe' })
  const service = new WorkspaceSyncService(data),
    config: WorkspaceSyncConfig = {
      branch: 'main',
      submodules: [],
      installSkills: true,
      skillRoots: ['skills'],
      sourceIds: []
    }
  let count = 0
  const run = (verify: () => Promise<unknown> = async () => ({ skills: ['demo'], knowledgeRoots: [] })) =>
    service.run({
      workspaceId: 'workspace-id',
      workspacePath: workspace,
      runId: `run-${++count}`,
      config,
      signal: new AbortController().signal,
      event: vi.fn(),
      maintain: (action) => action(),
      syncSource: async () => ({}),
      verify
    })
  return { source, workspace, data, service, config, run }
}
describe('workspace resource synchronization', () => {
  it('installs new skills, preserves runtime environments and detects content-only changes', async () => {
    const s = setup()
    expect((await s.run()).skills).toEqual({ installed: 1, updated: 0, unchanged: 0 })
    const target = path.join(s.workspace, '.codex/skills/demo')
    mkdirSync(path.join(target, '.venv'), { recursive: true })
    writeFileSync(path.join(target, '.venv/runtime'), 'keep runtime')
    writeFileSync(path.join(target, '.env'), 'local auth')
    const oldHash = await skillContentHash(target)
    writeFileSync(path.join(target, '.venv/other'), 'new runtime cache')
    expect(await skillContentHash(target)).toBe(oldHash)
    writeFileSync(path.join(s.source, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: updated\n---\n# New')
    commit(s.source, 'skill update')
    expect((await s.run()).skills).toEqual({ installed: 0, updated: 1, unchanged: 0 })
    expect(readFileSync(path.join(target, '.venv/runtime'), 'utf8')).toBe('keep runtime')
    expect(readFileSync(path.join(target, '.env'), 'utf8')).toBe('local auth')
    expect(readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('updated')
    expect((await s.run()).skills).toEqual({ installed: 0, updated: 0, unchanged: 1 })
  })
  it('refuses tracked local changes before applying any update', async () => {
    const s = setup()
    writeFileSync(path.join(s.workspace, 'README.md'), 'local edit')
    writeFileSync(path.join(s.source, 'README.md'), 'remote edit')
    commit(s.source, 'remote update')
    await expect(s.run()).rejects.toThrow('本地修改')
    expect(readFileSync(path.join(s.workspace, 'README.md'), 'utf8')).toBe('local edit')
  })
  it('keeps a locally modified installed skill and reports the conflict', async () => {
    const s = setup()
    await s.run()
    const target = path.join(s.workspace, '.codex/skills/demo/SKILL.md')
    writeFileSync(target, 'local skill edit')
    writeFileSync(path.join(s.source, 'skills/demo/SKILL.md'), '---\nname: demo\n---\nremote edit')
    commit(s.source, 'remote skill')
    const result = await s.run()
    expect(result.warnings).toEqual([expect.stringContaining('本地修改')])
    expect(readFileSync(target, 'utf8')).toBe('local skill edit')
  })
  it('rolls back repository and skills when resource verification fails', async () => {
    const s = setup()
    await s.run()
    const before = git(s.workspace, 'rev-parse', 'HEAD'),
      target = path.join(s.workspace, '.codex/skills/demo')
    mkdirSync(path.join(target, '.venv'))
    writeFileSync(path.join(target, '.venv/runtime'), 'keep')
    writeFileSync(path.join(s.source, 'README.md'), 'version two')
    writeFileSync(path.join(s.source, 'skills/demo/SKILL.md'), '---\nname: demo\n---\nupdated')
    commit(s.source, 'next')
    await expect(
      s.run(async () => {
        throw new Error('index validation failed')
      })
    ).rejects.toThrow('已恢复')
    expect(git(s.workspace, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('original')
    expect(readFileSync(path.join(target, '.venv/runtime'), 'utf8')).toBe('keep')
  })
  it('reports optional submodule failures without silently succeeding mandatory modules', async () => {
    const s = setup()
    s.config.submodules = [{ path: 'missing', mode: 'pinned', branch: '', required: true }]
    await expect(s.run()).rejects.toThrow('未初始化')
    s.config.submodules[0]!.required = false
    const result = await s.run()
    expect(result.warnings).toEqual([expect.stringContaining('未初始化')])
  })
  it('rejects a workspace pointing inside a parent repository', async () => {
    const s = setup()
    await expect(inspectWorkspace(path.join(s.workspace, 'skills'))).rejects.toThrow('仓库根目录')
  })
  it('preserves untracked configuration and does not treat it as a reason to erase files', async () => {
    const s = setup()
    writeFileSync(path.join(s.workspace, 'local-config.txt'), 'personal')
    await s.run()
    expect(readFileSync(path.join(s.workspace, 'local-config.txt'), 'utf8')).toBe('personal')
  })
  it('keeps a durable journal and backup reference for interrupted maintenance', async () => {
    const s = setup()
    await s.run()
    expect(existsSync(path.join(s.data, 'workspace-sync/run-1/journal.json'))).toBe(true)
    const p = path.join(s.data, 'workspace-sync/run-1/journal.json'),
      journal = JSON.parse(readFileSync(p, 'utf8'))
    journal.phase = 'applying'
    writeFileSync(p, JSON.stringify(journal))
    expect(s.service.pendingRecovery()).toEqual([
      { root: expect.any(String), reason: expect.stringContaining('未完整结束') }
    ])
    s.service.acknowledgeRecovery(journal.root)
    expect(s.service.pendingRecovery()).toEqual([])
    expect(git(s.workspace, 'rev-parse', 'refs/codybothub-backups/run-1')).toHaveLength(40)
  })
})
