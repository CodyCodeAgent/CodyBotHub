import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceResourceIndex } from '../src/resources.js'

const temporaryDirectories: string[] = []
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('WorkspaceResourceIndex', () => {
  it('discovers knowledge and Skill references again on every request', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'codybothub-resources-'))
    temporaryDirectories.push(workspace)
    mkdirSync(path.join(workspace, 'knowledge'), { recursive: true })
    mkdirSync(path.join(workspace, '.codex', 'skills', 'budget', 'references'), { recursive: true })
    writeFileSync(path.join(workspace, 'knowledge', 'database.md'), '# 预算数据库\n\n记录预算表结构和分片规则。')
    writeFileSync(path.join(workspace, '.codex', 'skills', 'budget', 'references', 'alerts.md'), '# 告警案例\n\n记录实时对账案例。')
    const index = new WorkspaceResourceIndex()
    expect(await index.listKnowledge(workspace, '对账')).toMatchObject([{ title: '告警案例' }, { title: '预算数据库' }])

    writeFileSync(path.join(workspace, 'knowledge', 'new.md'), '# 新知识\n\n刚刚增加的排查资料。')
    expect((await index.listKnowledge(workspace)).map(item => item.title)).toContain('新知识')
  })
})
