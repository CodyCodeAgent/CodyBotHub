import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, lstat, chmod, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceSyncConfig } from './scheduled-types.js'
const exec = promisify(execFile)
export const ignoredSkillFile = (name: string) =>
  ['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.cache'].includes(name) ||
  name.startsWith('.env') ||
  /\.local(?:\.|$)/u.test(name)
const within = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`)
const exists = async (file: string) =>
  stat(file).then(
    () => true,
    () => false
  )
const git = async (cwd: string, args: string[], signal?: AbortSignal, raw = false): Promise<string> => {
  try {
    const output = (
      await exec('git', args, { cwd, timeout: 90000, maxBuffer: 8 * 1024 * 1024, ...(signal ? { signal } : {}) })
    ).stdout
    return raw ? output : output.trim()
  } catch (error) {
    const e = error as Error & { stderr?: string; code?: number | string }
    throw Object.assign(
      new Error(
        `Git ${args[0]} 失败：${(e.stderr || e.message).replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gu, 'https://***@').slice(0, 2000)}`
      ),
      { gitExitCode: e.code }
    )
  }
}
const reference = async (cwd: string, branch: string) => {
  if (!branch || branch.startsWith('-')) throw new Error('请配置有效目标分支')
  await git(cwd, ['check-ref-format', '--branch', branch])
}
const ensureFastForward = async (
  root: string,
  before: string,
  after: string,
  branch: string,
  signal: AbortSignal,
  event: (phase: string, message: string, data?: unknown) => void
) => {
  const ancestor = async () => {
    try {
      await git(root, ['merge-base', '--is-ancestor', before, after], signal)
      return true
    } catch (error) {
      if ((error as { gitExitCode?: unknown }).gitExitCode === 1) return false
      throw error
    }
  }
  if (await ancestor()) return
  for (const deepen of [200, 1000]) {
    if ((await git(root, ['rev-parse', '--is-shallow-repository'], signal)) !== 'true') break
    event('deepen', `补全浅克隆历史以核对快进关系：${path.basename(root)}`, { branch, deepen })
    await git(root, ['fetch', '--no-recurse-submodules', `--deepen=${deepen}`, 'origin', branch], signal)
    if (await ancestor()) return
  }
  throw Object.assign(
    new Error(
      `非快进更新：${path.basename(root)} 当前 ${before.slice(0, 12)} 不是目标 ${after.slice(0, 12)} 的祖先；可能存在本地提交或浅克隆历史仍不完整，已保留现场，不能强制覆盖`
    ),
    { nonFastForward: true }
  )
}
const prepareMerge = async (root: string, before: string, remote: string, signal: AbortSignal): Promise<string> => {
  try {
    await git(root, ['merge-base', '--is-ancestor', remote, before], signal)
    return before
  } catch (error) {
    if ((error as { gitExitCode?: unknown }).gitExitCode !== 1) throw error
  }
  let tree = ''
  try {
    const result = await exec('git', ['merge-tree', '--write-tree', before, remote], {
      cwd: root,
      signal,
      timeout: 90000,
      maxBuffer: 8 * 1024 * 1024
    })
    tree = result.stdout.split('\n')[0]!.trim()
  } catch (error) {
    const detail = error as Error & { stdout?: string; stderr?: string }
    const conflicts = detail.stdout
      ?.split('\n')
      .filter((line) => line.startsWith('CONFLICT'))
      .join('\n')
    throw new Error(`子模块合并预检失败，工作目录未改变：${conflicts || detail.stderr || detail.message}`)
  }
  if (!/^[a-f\d]{40,64}$/u.test(tree)) throw new Error('合并预检没有返回有效树对象，未应用更新')
  return git(
    root,
    [
      '-c',
      'user.name=CodyBotHub',
      '-c',
      'user.email=codybothub@localhost',
      'commit-tree',
      tree,
      '-p',
      before,
      '-p',
      remote,
      '-m',
      'CodyBotHub: merge remote update while preserving local commits'
    ],
    signal
  )
}
export const inspectWorkspace = async (
  directory: string
): Promise<{
  root: string
  branch: string
  commit: string
  changes: string
  submodules: Array<{ path: string; initialized: boolean; commit: string }>
}> => {
  const root = await realpath(directory),
    top = await realpath(await git(root, ['rev-parse', '--show-toplevel']))
  if (root !== top) throw new Error('工作区必须指向仓库根目录，不能更新其父目录仓库')
  const modules: Array<{ path: string; initialized: boolean; commit: string }> = []
  let config = ''
  try {
    config = await git(root, ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'])
  } catch {
    /* A repository without submodules is valid. */
  }
  for (const line of config.split('\n').filter(Boolean)) {
    const sub = line.replace(/^\S+\s+/u, '')
    const dir = path.resolve(root, sub)
    if (!within(root, dir)) throw new Error('子模块目录越出工作区')
    const initialized = await exists(path.join(dir, '.git'))
    modules.push({ path: sub, initialized, commit: initialized ? await git(dir, ['rev-parse', 'HEAD']) : '' })
  }
  return {
    root,
    branch: await git(root, ['branch', '--show-current']),
    commit: await git(root, ['rev-parse', 'HEAD']),
    changes: await git(root, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all']),
    submodules: modules
  }
}
const skillFiles = async (root: string): Promise<string[]> => {
  const canonical = await realpath(root),
    files: string[] = []
  let visited = 0
  const walk = async (dir: string) => {
    if (++visited > 20000) throw new Error('技能文件超过扫描上限')
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignoredSkillFile(e.name)) continue
      const file = path.join(dir, e.name),
        resolved = await realpath(file)
      if (!within(canonical, resolved)) throw new Error('技能含指向目录外的符号链接')
      if (e.isDirectory() || (e.isSymbolicLink() && (await stat(resolved)).isDirectory())) await walk(file)
      else if ((await stat(resolved)).isFile()) files.push(path.relative(root, file))
    }
  }
  await walk(root)
  return files
}
export const skillContentHash = async (root: string): Promise<string> => {
  const hash = createHash('sha256')
  for (const f of await skillFiles(root)) {
    hash.update(f)
    hash.update(await readFile(path.join(root, f)))
  }
  return hash.digest('hex')
}
type Installed = { source: string; checksum: string }
type Backup = { target: string; backup: string; staging: string; runtime: string[]; created: boolean }
type LocalFile = { path: string; checksum: string; mode: number }
type LocalBackup = LocalFile & { backup: string; beforeBlob: string; afterBlob: string; upstreamChanged: boolean }
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export const validatePreservedPaths = (files: string[]): string[] => {
  if (files.length > 100) throw new RangeError('本机保留文件超过上限')
  return [
    ...new Set(
      files.map((file) => {
        if (
          !file ||
          path.isAbsolute(file) ||
          file.includes('\\') ||
          /[\x00-\x1f*?\[\]]/u.test(file) ||
          file.split('/').some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') ||
          file === '.gitmodules'
        )
          throw new RangeError(`本机保留文件需要精确相对路径，不支持目录或通配符：${file}`)
        return file
      })
    )
  ]
}
const blob = async (root: string, commit: string, file: string) => {
  const entry = await git(root, ['ls-tree', '-z', commit, '--', file], undefined, true)
  const match = entry.match(/^(100644|100755) blob ([a-f\d]+)\t([^\0]+)\0$/u)
  if (!match || match[3] !== file)
    throw new Error(`本机保留文件必须是主仓库已跟踪的普通文件，远端删除/改名需人工处理：${file}`)
  return match[2]!
}
const localState = async (root: string, files: string[]): Promise<LocalFile[]> => {
  const result: LocalFile[] = []
  for (const file of files) {
    const target = path.join(root, file),
      info = await lstat(target)
    if (!info.isFile() || (await realpath(target)) !== target)
      throw new Error(`本机保留文件不能是符号链接或目录：${file}`)
    if (info.size > 8 * 1024 * 1024) throw new Error(`本机保留文件超过 8 MiB 上限：${file}`)
    await blob(root, 'HEAD', file)
    result.push({ path: file, checksum: checksum(await readFile(target)), mode: info.mode & 0o777 })
  }
  return result
}
const checkChanges = async (root: string, files: string[], signal?: AbortSignal) => {
  const staged = await git(root, ['diff', '--cached', '--name-only', '-z', '--'], signal, true)
  if (staged) throw new Error('工作区有暂存修改，请先人工处理；本机保留清单不会处理暂存区')
  const changes = (
    await git(
      root,
      ['diff', '--no-renames', '--name-only', '-z', '--ignore-submodules=all', 'HEAD', '--'],
      signal,
      true
    )
  )
    .split('\0')
    .filter(Boolean)
  const blocked = changes.filter((file) => !files.includes(file))
  if (blocked.length) throw new Error(`工作区有未列入本机保留清单的本地修改，已保留现场：\n${blocked.join('\n')}`)
}
const restoreLocalFiles = async (root: string, files: LocalBackup[]) => {
  for (const file of files) {
    const bytes = await readFile(file.backup)
    if (checksum(bytes) !== file.checksum) throw new Error(`本机文件备份校验失败：${file.path}`)
    const target = path.join(root, file.path),
      parent = path.dirname(target)
    if ((await realpath(parent)) !== parent) throw new Error(`本机文件父目录发生变化：${file.path}`)
    const temporary = path.join(
      parent,
      `.codybothub-restore-${createHash('sha256').update(file.path).digest('hex').slice(0, 16)}`
    )
    // Exclusive creation never overwrites an unrelated local temporary file or symlink.
    await writeFile(temporary, bytes, { flag: 'wx', mode: file.mode })
    try {
      await chmod(temporary, file.mode)
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
export const runtimeFiles = async (root: string): Promise<string[]> => {
  const paths: string[] = []
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (ignoredSkillFile(e.name)) {
        paths.push(path.relative(root, p))
        continue
      }
      if (e.isDirectory()) await walk(p)
    }
  }
  await walk(root)
  return paths
}
export class WorkspaceSyncService {
  constructor(private readonly dataDirectory: string) {}
  pendingRecovery(): Array<{ root: string; reason: string }> {
    const base = path.join(this.dataDirectory, 'workspace-sync')
    if (!existsSync(base)) return []
    const result: Array<{ root: string; reason: string }> = []
    for (const entry of readdirSync(base, { withFileTypes: true }))
      if (entry.isDirectory())
        try {
          const journal = JSON.parse(readFileSync(path.join(base, entry.name, 'journal.json'), 'utf8'))
          if (['applying', 'rollback_failed'].includes(journal.phase))
            result.push({
              root: journal.root,
              reason: `资源同步 ${entry.name} 未完整结束，请检查 ${path.join(base, entry.name, 'journal.json')} 后解除维护暂停`
            })
        } catch {}
    return result
  }
  acknowledgeRecovery(root: string): void {
    const base = path.join(this.dataDirectory, 'workspace-sync')
    if (!existsSync(base)) return
    for (const entry of readdirSync(base, { withFileTypes: true }))
      if (entry.isDirectory())
        try {
          const file = path.join(base, entry.name, 'journal.json'),
            journal = JSON.parse(readFileSync(file, 'utf8'))
          if (journal.root === root && ['applying', 'rollback_failed'].includes(journal.phase)) {
            journal.phase = 'reviewed'
            writeFileSync(file, JSON.stringify(journal, null, 2), { mode: 0o600 })
          }
        } catch {}
  }

  async run(input: {
    workspaceId: string
    workspacePath: string
    runId: string
    config: WorkspaceSyncConfig
    signal: AbortSignal
    event: (phase: string, message: string, data?: unknown) => void
    maintain: <T>(action: () => Promise<T>) => Promise<T>
    syncSource: (id: string) => Promise<unknown>
    verify: () => Promise<unknown>
  }): Promise<Record<string, unknown>> {
    const { config, signal, event } = input,
      initial = await inspectWorkspace(input.workspacePath),
      root = initial.root
    const preservedPaths = validatePreservedPaths(config.preserveLocalFiles || [])
    await checkChanges(root, preservedPaths, signal)
    const initialLocalFiles = await localState(root, preservedPaths)
    await reference(root, config.branch)
    event('fetch', '检查主仓库远端更新')
    await git(root, ['fetch', '--no-recurse-submodules', '--prune', 'origin', config.branch], signal)
    const target = await git(root, ['rev-parse', `refs/remotes/origin/${config.branch}`]),
      currentBranch = initial.branch
    if (currentBranch !== config.branch)
      throw new Error(`当前分支 ${currentBranch || 'detached HEAD'} 与目标 ${config.branch} 不同，请先人工切换分支`)
    await ensureFastForward(root, initial.commit, target, config.branch, signal, event)
    const plan: Array<{
        path: string
        before: string
        after: string
        mode: string
        required: boolean
        branchBefore: string
        nested: Array<{ path: string; before: string; branch: string }>
      }> = [],
      warnings: string[] = []
    for (const selected of config.submodules) {
      const known = initial.submodules.find((m) => m.path === selected.path),
        dir = path.resolve(root, selected.path)
      try {
        event('submodule_fetch', `检查子模块 ${selected.path}`, {
          path: selected.path,
          mode: selected.mode,
          branch: selected.branch
        })
        if (!known?.initialized) throw new Error('子模块尚未初始化，请先在工作区准备该服务')
        if (!within(root, await realpath(dir))) throw new Error('子模块越出工作区')
        if (await git(dir, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all']))
          throw new Error('子模块有本地修改')
        let after = ''
        if (selected.mode === 'branch' || selected.mode === 'merge') {
          await reference(dir, selected.branch)
          await git(dir, ['fetch', '--no-recurse-submodules', 'origin', selected.branch], signal)
          after = await git(dir, ['rev-parse', `refs/remotes/origin/${selected.branch}`])
          try {
            await ensureFastForward(dir, known.commit, after, selected.branch, signal, event)
          } catch (error) {
            if (selected.mode !== 'merge' || !(error as { nonFastForward?: boolean }).nonFastForward) throw error
            const remote = after
            after = await prepareMerge(dir, known.commit, remote, signal)
            event('submodule_merge', `合并版本已预检：${selected.path}`, {
              before: known.commit,
              remote,
              prepared: after
            })
          }
        } else {
          const tree = await git(root, ['ls-tree', target, '--', selected.path])
          after = tree.match(/^160000 commit ([a-f\d]+)\t/u)?.[1] || ''
          if (!after) throw new Error('目标主仓库未声明此子模块')
          try {
            await git(dir, ['cat-file', '-e', `${after}^{commit}`])
          } catch {
            await git(dir, ['fetch', 'origin', after], signal)
          }
        }
        const nested: Array<{ path: string; before: string; branch: string }> = []
        const status = await git(dir, ['submodule', 'status', '--recursive'], signal)
        for (const line of status.split('\n').filter(Boolean)) {
          const match = line.match(/^[ +U-]?([a-f\d]{40}) (.+?)(?: \(.*\))?$/u)
          if (!match || line.startsWith('-')) continue
          const child = path.join(dir, match[2]!)
          if (await git(child, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all']))
            throw new Error(`嵌套子模块 ${match[2]} 有本地修改`)
          nested.push({ path: match[2]!, before: match[1]!, branch: await git(child, ['branch', '--show-current']) })
        }
        plan.push({
          path: selected.path,
          before: known.commit,
          after,
          mode: selected.mode,
          required: selected.required,
          branchBefore: await git(dir, ['branch', '--show-current']),
          nested
        })
      } catch (error) {
        if (selected.required) throw error
        warnings.push(`${selected.path}：${error instanceof Error ? error.message : String(error)}`)
        event('submodule_skip', `可选子模块保留原版本：${selected.path}`, { error: warnings.at(-1) })
      }
    }
    const directory = path.join(this.dataDirectory, 'workspace-sync', input.runId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const journal = {
      root,
      before: initial.commit,
      after: target,
      modules: plan,
      phase: 'prepared',
      backups: [] as Backup[],
      localFiles: [] as LocalBackup[],
      warnings
    }
    const persist = () =>
      writeFile(path.join(directory, 'journal.json'), JSON.stringify(journal, null, 2), { mode: 0o600 })
    await persist()
    event('prepared', '远端准备完成，等待工作区空闲', {
      before: initial.commit,
      after: target,
      submodules: plan,
      warnings
    })
    return input.maintain(async () => {
      signal.throwIfAborted()
      const fresh = await inspectWorkspace(root)
      if (fresh.commit !== initial.commit || fresh.branch !== currentBranch)
        throw new Error('准备期间工作区发生变化，已取消本次应用')
      await checkChanges(root, preservedPaths, signal)
      if (JSON.stringify(await localState(root, preservedPaths)) !== JSON.stringify(initialLocalFiles))
        throw new Error('准备期间本机保留文件发生变化，已取消本次应用')
      for (const m of plan) {
        if (
          (await git(path.join(root, m.path), ['rev-parse', 'HEAD'])) !== m.before ||
          (await git(path.join(root, m.path), [
            'status',
            '--porcelain',
            '--untracked-files=no',
            '--ignore-submodules=all'
          ]))
        )
          throw new Error(`准备期间子模块 ${m.path} 发生变化`)
      }
      for (const [index, file] of initialLocalFiles.entries()) {
        const beforeBlob = await blob(root, initial.commit, file.path),
          afterBlob = await blob(root, target, file.path)
        const backup = path.join(directory, `local-file-${index}.bin`)
        const bytes = await readFile(path.join(root, file.path))
        if (checksum(bytes) !== file.checksum) throw new Error(`备份前本机文件发生变化：${file.path}`)
        await writeFile(backup, bytes, { flag: 'wx', mode: 0o600 })
        journal.localFiles.push({ ...file, backup, beforeBlob, afterBlob, upstreamChanged: beforeBlob !== afterBlob })
      }
      await persist()
      journal.phase = 'applying'
      await persist()
      event('applying', '工作区已空闲，开始应用更新')
      const manifestFile = path.join(this.dataDirectory, 'managed-skills', `${input.workspaceId}.json`)
      let manifest: Record<string, Installed> = {}
      try {
        manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
      } catch {}
      const oldManifest = JSON.stringify(manifest)
      let installed = 0,
        updated = 0,
        unchanged = 0
      try {
        await git(root, ['update-ref', `refs/codybothub-backups/${input.runId}`, initial.commit])
        if (preservedPaths.length)
          await git(root, ['restore', '--source=HEAD', '--worktree', '--', ...preservedPaths], signal)
        if (initial.commit !== target) await git(root, ['merge', '--ff-only', target], signal)
        await restoreLocalFiles(root, journal.localFiles)
        for (const file of journal.localFiles) {
          if (file.upstreamChanged) warnings.push(`${file.path}：远端有修改，已按配置保留本机完整内容，请核对远端差异`)
          event('local_file', `保留本机文件 ${file.path}`, {
            path: file.path,
            checksum: file.checksum,
            beforeBlob: file.beforeBlob,
            afterBlob: file.afterBlob,
            upstreamChanged: file.upstreamChanged
          })
        }
        for (const m of plan) {
          const dir = path.join(root, m.path)
          await git(dir, ['update-ref', `refs/codybothub-backups/${input.runId}`, m.before])
          try {
            if (m.before !== m.after) await git(dir, ['checkout', '--detach', m.after], signal)
            await git(dir, ['submodule', 'update', '--init', '--recursive'], signal)
          } catch (error) {
            if (m.required) throw error
            await git(dir, m.branchBefore ? ['checkout', m.branchBefore] : ['checkout', '--detach', m.before])
            for (const nested of [...m.nested].reverse())
              await git(
                path.join(dir, nested.path),
                nested.branch ? ['checkout', nested.branch] : ['checkout', '--detach', nested.before]
              )
            m.after = m.before
            warnings.push(`${m.path}：更新失败，保留原版本；${String(error)}`)
          }
          event('submodule', `已核对 ${m.path}`, m)
        }
        if (config.installSkills) {
          const found = new Map<string, { source: string; hash: string }>(),
            visited = new Set<string>(),
            conflicts = new Set<string>()
          let scanned = 0
          const discover = async (dir: string) => {
            if (++scanned > 10000) throw new Error('技能目录超过扫描上限')
            const canonical = await realpath(dir)
            if (!within(root, canonical)) throw new Error('技能根目录越出工作区')
            if (visited.has(canonical)) return
            visited.add(canonical)
            if (await exists(path.join(dir, 'SKILL.md'))) {
              const source = await readFile(path.join(dir, 'SKILL.md'), 'utf8'),
                name = (source.match(/^name:\s*["']?([^\n"']+)/mu)?.[1] || path.basename(dir)).trim()
              if (!/^[\p{L}\p{N}_.-]{1,120}$/u.test(name) || name === '.' || name === '..') {
                const relative = path.relative(root, dir)
                warnings.push(`${relative}：技能名称 ${JSON.stringify(name)} 不适合作为安装目录，已跳过该技能`)
                event('skill_skip', `跳过名称不合法的技能：${relative}`, { name, source: relative })
                return
              }
              const hash = await skillContentHash(canonical),
                previous = found.get(name)
              if (conflicts.has(name)) return
              if (previous && previous.hash !== hash) {
                conflicts.add(name)
                warnings.push(`${name}：多个来源内容冲突，已保留原安装`)
                found.delete(name)
                return
              }
              found.set(name, { source: canonical, hash })
              return
            }
            for (const e of await readdir(dir, { withFileTypes: true }))
              if (!ignoredSkillFile(e.name) && (e.isDirectory() || e.isSymbolicLink()))
                await discover(path.join(dir, e.name))
          }
          for (const item of config.skillRoots) {
            const dir = path.resolve(root, item)
            if (!within(root, dir)) throw new Error('技能根目录越出工作区')
            if (await exists(dir)) await discover(dir)
          }
          for (const [name, item] of found) {
            signal.throwIfAborted()
            const targetDir = path.join(root, '.codex', 'skills', name),
              present = await exists(targetDir)
            if (present && (await realpath(targetDir)) === item.source) {
              unchanged++
              continue
            }
            const previous = manifest[name],
              currentHash = present ? await skillContentHash(targetDir) : ''
            if (currentHash === item.hash) {
              manifest[name] = { source: item.source, checksum: item.hash }
              unchanged++
              continue
            }
            if (present && (!previous || previous.checksum !== currentHash)) {
              warnings.push(`${name}：安装目录存在本地修改或同名来源，已跳过`)
              continue
            }
            const temporary = path.join(directory, `skill-${name}`),
              backup = path.join(directory, `backup-${name}`)
            await cp(item.source, temporary, {
              recursive: true,
              dereference: true,
              filter: (source) => !path.relative(item.source, source).split(path.sep).some(ignoredSkillFile)
            })
            const entry: Backup = {
              target: targetDir,
              backup,
              staging: temporary,
              runtime: present ? await runtimeFiles(targetDir) : [],
              created: !present
            }
            journal.backups.push(entry)
            await persist()
            await mkdir(path.dirname(targetDir), { recursive: true })
            if (present) await rename(targetDir, backup)
            for (const rel of entry.runtime) {
              await mkdir(path.dirname(path.join(temporary, rel)), { recursive: true })
              await rename(path.join(backup, rel), path.join(temporary, rel))
            }
            await rename(temporary, targetDir)
            manifest[name] = { source: item.source, checksum: item.hash }
            if (present) updated++
            else installed++
            event('skill', `${present ? '更新' : '安装'}技能 ${name}`, {
              name,
              checksum: item.hash,
              source: item.source
            })
          }
          await mkdir(path.dirname(manifestFile), { recursive: true })
          await writeFile(manifestFile, JSON.stringify(manifest, null, 2), { mode: 0o600 })
        }
        for (const id of config.sourceIds) {
          signal.throwIfAborted()
          event('skill_source', `同步独立技能源 ${id}`)
          await input.syncSource(id)
        }
        signal.throwIfAborted()
        await restoreLocalFiles(root, journal.localFiles)
        const verification = await input.verify()
        event('verify', '技能和知识资源识别已验证', verification)
        journal.phase = 'completed'
        await persist()
        const result = {
          before: initial.commit,
          after: target,
          submodules: plan,
          actualSubmodules: (await inspectWorkspace(root)).submodules,
          skills: { installed, updated, unchanged },
          preservedLocalFiles: journal.localFiles.map(({ backup, mode, ...file }) => file),
          warnings,
          verification,
          backupDirectory: directory
        }
        event('completed', '工作区同步完成', result)
        return result
      } catch (error) {
        const rollbackErrors: string[] = []
        for (const entry of [...journal.backups].reverse())
          try {
            if (await exists(entry.backup)) {
              for (const rel of entry.runtime) {
                const file = (await exists(path.join(entry.target, rel)))
                  ? path.join(entry.target, rel)
                  : path.join(entry.staging, rel)
                if (await exists(file)) {
                  await mkdir(path.dirname(path.join(entry.backup, rel)), { recursive: true })
                  await rename(file, path.join(entry.backup, rel))
                }
              }
              await rm(entry.target, { recursive: true, force: true })
              await rename(entry.backup, entry.target)
            } else if (entry.created) await rm(entry.target, { recursive: true, force: true })
          } catch (e) {
            rollbackErrors.push(String(e))
          }
        for (const m of [...plan].reverse())
          try {
            const dir = path.join(root, m.path)
            await git(dir, m.branchBefore ? ['checkout', m.branchBefore] : ['checkout', '--detach', m.before])
            for (const nested of [...m.nested].reverse())
              await git(
                path.join(dir, nested.path),
                nested.branch ? ['checkout', nested.branch] : ['checkout', '--detach', nested.before]
              )
          } catch (e) {
            rollbackErrors.push(String(e))
          }
        try {
          if (preservedPaths.length)
            await git(root, ['restore', '--source=HEAD', '--worktree', '--', ...preservedPaths])
          // Refresh Git's stat cache after atomic local-file restores, without staging content.
          await git(root, ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=all'])
          if ((await git(root, ['rev-parse', 'HEAD'])) !== initial.commit)
            await git(root, ['reset', '--keep', initial.commit])
        } catch (e) {
          rollbackErrors.push(String(e))
        }
        try {
          await restoreLocalFiles(root, journal.localFiles)
        } catch (e) {
          rollbackErrors.push(String(e))
        }
        await mkdir(path.dirname(manifestFile), { recursive: true })
        await writeFile(manifestFile, oldManifest, { mode: 0o600 })
        journal.phase = rollbackErrors.length ? 'rollback_failed' : 'rolled_back'
        journal.warnings.push(...rollbackErrors)
        await persist()
        event(
          'rollback',
          rollbackErrors.length ? '恢复未完成，需要人工核实' : '代码和本轮技能安装已恢复',
          rollbackErrors
        )
        throw Object.assign(
          new Error(
            `${error instanceof Error ? error.message : String(error)}${rollbackErrors.length ? `；恢复未完成，请核实工作区后再运行：${rollbackErrors.join('; ')}` : '；已恢复本轮代码与技能更新'}${config.sourceIds.length ? '；独立技能源的同步结果需单独核实' : ''}`
          ),
          { workspaceNeedsReview: rollbackErrors.length > 0 }
        )
      }
    })
  }
}
