import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ignoredSkillFile, skillContentHash, validatePreservedPaths } from '../src/workspace-sync.js'

describe('workspace sync policies without Git processes', () => {
  it.each(['../file', '/tmp/file', '.git/config', '.gitmodules', '*.toml', 'dir/', 'dir/../file'])
    ('rejects unsafe preserved path %s', file => {
      expect(() => validatePreservedPaths([file])).toThrow('精确相对路径')
    })

  it('deduplicates exact preserved files and enforces the list limit', () => {
    expect(validatePreservedPaths(['README.md', 'config/local.toml', 'README.md'])).toEqual(['README.md', 'config/local.toml'])
    expect(() => validatePreservedPaths(Array.from({ length: 101 }, (_, index) => `f${index}`))).toThrow('超过上限')
  })

  it.each(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.cache', '.env', '.env.production', 'settings.local.json'])
    ('excludes runtime-only skill entry %s', name => {
      expect(ignoredSkillFile(name)).toBe(true)
    })

  it('hashes skill content independently of runtime caches and credentials', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skill-content-'))
    try {
      writeFileSync(path.join(root, 'SKILL.md'), '# Original')
      const original = await skillContentHash(root)
      mkdirSync(path.join(root, '.venv'))
      writeFileSync(path.join(root, '.venv', 'cache'), 'runtime')
      writeFileSync(path.join(root, '.env'), 'secret')
      expect(await skillContentHash(root)).toBe(original)
      writeFileSync(path.join(root, 'SKILL.md'), '# Updated')
      expect(await skillContentHash(root)).not.toBe(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
