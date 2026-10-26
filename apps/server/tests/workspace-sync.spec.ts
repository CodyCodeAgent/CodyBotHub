import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  chmodSync,
  statSync
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectWorkspace,
  skillContentHash,
  validatePreservedPaths
} from '../src/workspace-sync.js'
import {
  cleanupWorkspaceSyncFixtures,
  commit,
  git,
  setupDivergedModule,
  setupWorkspaceSync as setup
} from './helpers/workspace-sync-fixture.js'
vi.setConfig({ testTimeout: 20000 })
const fullGitIt = it.skipIf(process.env.CODY_FULL_GIT_TESTS !== '1')
afterEach(cleanupWorkspaceSyncFixtures)
describe('workspace resource synchronization', () => {
  fullGitIt('reports invalid skill metadata without rolling back other repository updates or valid skills', async () => {
    const s = setup()
    mkdirSync(path.join(s.source, 'skills/invalid'), { recursive: true })
    writeFileSync(
      path.join(s.source, 'skills/invalid/SKILL.md'),
      '---\nname: invalid/child\n---\n# Invalid directory name'
    )
    writeFileSync(path.join(s.source, 'README.md'), 'new code')
    commit(s.source, 'bad metadata alongside valid updates')
    const result = await s.run()
    expect(result.warnings).toEqual([expect.stringContaining('skills/invalid：技能名称 "invalid/child"')])
    expect(readFileSync(path.join(s.workspace, 'README.md'), 'utf8')).toBe('new code')
    expect(existsSync(path.join(s.workspace, '.codex/skills/demo/SKILL.md'))).toBe(true)
    expect(existsSync(path.join(s.workspace, '.codex/skills/invalid'))).toBe(false)
    expect(git(s.workspace, 'rev-parse', 'HEAD')).toBe(git(s.source, 'rev-parse', 'HEAD'))
  })
  it('merges a selected divergent submodule without dropping local commits or repeating merges', async () => {
    const s = setupDivergedModule()
    await s.run()
    expect(readFileSync(path.join(s.module, 'local.txt'), 'utf8')).toBe('local knowledge\n')
    expect(readFileSync(path.join(s.module, 'remote.txt'), 'utf8')).toBe('remote knowledge\n')
    git(s.module, 'merge-base', '--is-ancestor', s.before, 'HEAD')
    git(s.module, 'merge-base', '--is-ancestor', git(s.moduleSource, 'rev-parse', 'HEAD'), 'HEAD')
    const after = git(s.module, 'rev-parse', 'HEAD')
    await s.run()
    expect(git(s.module, 'rev-parse', 'HEAD')).toBe(after)
  })
  fullGitIt('leaves conflicting submodules untouched and supports explicitly skipping optional modules', async () => {
    const s = setupDivergedModule(true)
    await expect(s.run()).rejects.toThrow('guide.md')
    expect(git(s.module, 'rev-parse', 'HEAD')).toBe(s.before)
    expect(readFileSync(path.join(s.module, 'guide.md'), 'utf8')).toBe('local knowledge\n')
    expect(() => git(s.module, 'rev-parse', '--verify', 'MERGE_HEAD')).toThrow()
    s.config.submodules[0]!.required = false
    expect((await s.run()).warnings).toEqual([expect.stringContaining('合并预检失败')])
    expect(git(s.module, 'rev-parse', 'HEAD')).toBe(s.before)
  })
  fullGitIt('restores the original submodule commit if validation fails after a clean merge', async () => {
    const s = setupDivergedModule()
    await expect(
      s.run(async () => {
        throw new Error('index unavailable')
      })
    ).rejects.toThrow('已恢复')
    expect(git(s.module, 'rev-parse', 'HEAD')).toBe(s.before)
    expect(readFileSync(path.join(s.module, 'local.txt'), 'utf8')).toBe('local knowledge\n')
    expect(existsSync(path.join(s.module, 'remote.txt'))).toBe(false)
  })
  it('deepens shallow history before deciding that a fast-forward is impossible', async () => {
    const s = setup()
    rmSync(s.workspace, { recursive: true })
    execFileSync('git', ['clone', '--depth=1', '--branch', 'main', pathToFileURL(s.source).href, s.workspace], {
      stdio: 'pipe'
    })
    for (let index = 0; index < 3; index++) {
      writeFileSync(path.join(s.source, 'README.md'), `upstream ${index}`)
      commit(s.source, 'remote commit')
    }
    git(s.workspace, 'fetch', '--depth=1', 'origin', 'main')
    expect(() => git(s.workspace, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main')).toThrow()
    await s.run()
    expect(git(s.workspace, 'rev-parse', 'HEAD')).toBe(git(s.source, 'rev-parse', 'HEAD'))
    expect(readFileSync(path.join(s.workspace, 'README.md'), 'utf8')).toBe('upstream 2')
  })
  fullGitIt('still refuses genuinely divergent local commits instead of resetting them', async () => {
    const s = setup()
    writeFileSync(path.join(s.workspace, 'README.md'), 'local commit')
    commit(s.workspace, 'local branch')
    const before = git(s.workspace, 'rev-parse', 'HEAD')
    writeFileSync(path.join(s.source, 'README.md'), 'remote commit')
    commit(s.source, 'remote branch')
    await expect(s.run()).rejects.toThrow('非快进')
    expect(git(s.workspace, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(path.join(s.workspace, 'README.md'), 'utf8')).toBe('local commit')
  })
  it('keeps allowlisted local content and mode while recording upstream file changes, including later runs', async () => {
    const s = setup()
    s.config.preserveLocalFiles = ['README.md']
    const bytes = Buffer.from([0, 1, 255, 10, 13])
    writeFileSync(path.join(s.workspace, 'README.md'), bytes)
    chmodSync(path.join(s.workspace, 'README.md'), 0o750)
    writeFileSync(path.join(s.source, 'README.md'), 'upstream changes')
    writeFileSync(path.join(s.source, 'new.txt'), 'new code')
    commit(s.source, 'remote update')
    const result = await s.run()
    expect(git(s.workspace, 'rev-parse', 'HEAD')).toBe(git(s.source, 'rev-parse', 'HEAD'))
    expect(readFileSync(path.join(s.workspace, 'README.md'))).toEqual(bytes)
    expect(statSync(path.join(s.workspace, 'README.md')).mode & 0o777).toBe(0o750)
    expect(readFileSync(path.join(s.workspace, 'new.txt'), 'utf8')).toBe('new code')
    expect(result.preservedLocalFiles).toEqual([expect.objectContaining({ path: 'README.md', upstreamChanged: true })])
    expect(result.warnings).toEqual([expect.stringContaining('远端有修改')])
    const journal = JSON.parse(readFileSync(path.join(s.data, 'workspace-sync/run-1/journal.json'), 'utf8'))
    expect(readFileSync(journal.localFiles[0].backup)).toEqual(bytes)
    expect(statSync(journal.localFiles[0].backup).mode & 0o077).toBe(0)
    await s.run()
    expect(readFileSync(path.join(s.workspace, 'README.md'))).toEqual(bytes)
  })
  fullGitIt('restores local overrides as well as repository HEAD after verification failure', async () => {
    const s = setup(),
      before = git(s.workspace, 'rev-parse', 'HEAD')
    s.config.preserveLocalFiles = ['README.md']
    writeFileSync(path.join(s.workspace, 'README.md'), 'machine config')
    writeFileSync(path.join(s.source, 'README.md'), 'new upstream config')
    commit(s.source, 'next')
    await expect(
      s.run(async () => {
        throw new Error('verification error')
      })
    ).rejects.toThrow('已恢复')
    expect(git(s.workspace, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(path.join(s.workspace, 'README.md'), 'utf8')).toBe('machine config')
    expect(git(s.workspace, 'diff', '--cached', '--name-only')).toBe('')
  })
  fullGitIt('continues rejecting unrelated tracked modifications and staged changes', async () => {
    const s = setup()
    s.config.preserveLocalFiles = ['README.md']
    writeFileSync(path.join(s.workspace, 'skills/demo/SKILL.md'), 'unsaved business edit')
    await expect(s.run()).rejects.toThrow('未列入')
    git(s.workspace, 'restore', '--', 'skills/demo/SKILL.md')
    writeFileSync(path.join(s.workspace, 'README.md'), 'staged config')
    git(s.workspace, 'add', 'README.md')
    await expect(s.run()).rejects.toThrow('暂存')
    expect(readFileSync(path.join(s.workspace, 'README.md'), 'utf8')).toBe('staged config')
  })
  fullGitIt('refuses an upstream deletion of a preserved file before changing the workspace', async () => {
    const s = setup(),
      before = git(s.workspace, 'rev-parse', 'HEAD')
    s.config.preserveLocalFiles = ['README.md']
    writeFileSync(path.join(s.workspace, 'README.md'), 'machine config')
    git(s.source, 'rm', 'README.md')
    commit(s.source, 'delete config')
    await expect(s.run()).rejects.toThrow('删除/改名')
    expect(git(s.workspace, 'rev-parse', 'HEAD')).toBe(before)
    expect(readFileSync(path.join(s.workspace, 'README.md'), 'utf8')).toBe('machine config')
  })
  fullGitIt('rejects path traversal, globs, submodule paths and symlinks in preserve lists', async () => {
    for (const file of ['../file', '/tmp/file', '.git/config', '.gitmodules', '*.toml', 'dir/', 'dir/../file'])
      expect(() => validatePreservedPaths([file])).toThrow('精确相对路径')
    const s = setup()
    s.config.preserveLocalFiles = ['skills']
    await expect(s.run()).rejects.toThrow('目录')
    rmSync(path.join(s.workspace, 'README.md'))
    symlinkSync(path.join(s.workspace, 'skills/demo/SKILL.md'), path.join(s.workspace, 'README.md'))
    s.config.preserveLocalFiles = ['README.md']
    await expect(s.run()).rejects.toThrow('符号链接')
  })
  fullGitIt('cancels when preserved content changes while waiting for maintenance access', async () => {
    const s = setup()
    s.config.preserveLocalFiles = ['README.md']
    await expect(
      s.run(undefined, (action) => {
        writeFileSync(path.join(s.workspace, 'README.md'), 'another user edit')
        return action()
      })
    ).rejects.toThrow('准备期间本机保留文件发生变化')
    expect(readFileSync(path.join(s.workspace, 'README.md'), 'utf8')).toBe('another user edit')
  })
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
  fullGitIt('keeps a locally modified installed skill and reports the conflict', async () => {
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
  fullGitIt('reports optional submodule failures without silently succeeding mandatory modules', async () => {
    const s = setup()
    s.config.submodules = [{ path: 'missing', mode: 'pinned', branch: '', required: true }]
    await expect(s.run()).rejects.toThrow('未初始化')
    s.config.submodules[0]!.required = false
    const result = await s.run()
    expect(result.warnings).toEqual([expect.stringContaining('未初始化')])
  })
  fullGitIt('rejects a workspace pointing inside a parent repository', async () => {
    const s = setup()
    await expect(inspectWorkspace(path.join(s.workspace, 'skills'))).rejects.toThrow('仓库根目录')
  })
  fullGitIt('preserves untracked configuration and does not treat it as a reason to erase files', async () => {
    const s = setup()
    writeFileSync(path.join(s.workspace, 'local-config.txt'), 'personal')
    await s.run()
    expect(readFileSync(path.join(s.workspace, 'local-config.txt'), 'utf8')).toBe('personal')
  })
  fullGitIt('keeps a durable journal and backup reference for interrupted maintenance', async () => {
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
