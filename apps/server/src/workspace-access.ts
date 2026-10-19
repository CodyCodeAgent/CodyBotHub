import { realpathSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
const rootOf = (root: string) => {
  try {
    return realpathSync.native(root)
  } catch {
    return path.resolve(root)
  }
}
export const workspacePathsOverlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** Single process coordinator. The scheduler's SQLite lease ensures one maintenance worker per database. */
export class WorkspaceAccess {
  private pauses: Record<string, string> = {}
  constructor(private readonly pauseFile?: string) {
    if (pauseFile && existsSync(pauseFile)) {
      try {
        this.pauses = JSON.parse(readFileSync(pauseFile, 'utf8'))
      } catch {
        throw new Error('工作区维护状态无法读取，拒绝忽略保护记录')
      }
    }
  }
  private persist(): void {
    if (this.pauseFile) {
      mkdirSync(path.dirname(this.pauseFile), { recursive: true })
      writeFileSync(this.pauseFile, JSON.stringify(this.pauses, null, 2), { mode: 0o600 })
    }
  }
  pause(root: string, reason: string): void {
    this.pauses[rootOf(root)] = reason
    this.persist()
  }
  paused(root: string): string {
    root = rootOf(root)
    return Object.entries(this.pauses)
      .filter(([key]) => workspacePathsOverlap(root, key))
      .map(([, reason]) => reason)
      .join('; ')
  }
  resume(root: string): void {
    root = rootOf(root)
    if (this.writers.some((w) => workspacePathsOverlap(w.root, root))) throw new Error('维护操作尚未结束，不能解除暂停')
    for (const key of Object.keys(this.pauses)) if (workspacePathsOverlap(root, key)) delete this.pauses[key]
    this.persist()
  }

  private readers = new Map<string, { root: string; owner: string }>()
  private writers: Array<{ root: string; owner: string }> = []
  async use<T>(root: string, action: () => Promise<T>, owner: string = randomUUID(), signal?: AbortSignal): Promise<T> {
    root = rootOf(root)
    if (this.paused(root)) throw new Error(`工作区已暂停，需要管理员核实恢复：${this.paused(root)}`)
    while (this.writers.some((w) => w.owner !== owner && workspacePathsOverlap(root, w.root))) {
      signal?.throwIfAborted()
      await sleep(100)
    }
    signal?.throwIfAborted()
    if (this.paused(root)) throw new Error(`工作区已暂停，需要管理员核实恢复：${this.paused(root)}`)
    const id = randomUUID()
    this.readers.set(id, { root, owner })
    try {
      return await action()
    } finally {
      this.readers.delete(id)
    }
  }
  async maintain<T>(
    root: string,
    owner: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
    waitMs = 15 * 60000
  ): Promise<T> {
    root = rootOf(root)
    if (this.paused(root)) throw new Error(`工作区已暂停，需要管理员核实恢复：${this.paused(root)}`)
    const writer = { root, owner },
      deadline = Date.now() + waitMs
    this.writers.push(writer)
    try {
      while (
        this.writers.some(
          (w) =>
            w !== writer &&
            this.writers.indexOf(w) < this.writers.indexOf(writer) &&
            workspacePathsOverlap(w.root, root)
        ) ||
        [...this.readers.values()].some((r) => r.owner !== owner && workspacePathsOverlap(r.root, root))
      ) {
        signal?.throwIfAborted()
        if (Date.now() > deadline) throw new Error('等待工作区空闲超时，本次未应用更新')
        await sleep(100)
      }
      signal?.throwIfAborted()
      if (this.paused(root)) throw new Error(`工作区已暂停，需要管理员核实恢复：${this.paused(root)}`)
      return await action()
    } finally {
      this.writers = this.writers.filter((w) => w !== writer)
    }
  }
  health(): { readers: number; maintenance: number } {
    return { readers: this.readers.size, maintenance: this.writers.length }
  }
}
