import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listBrowsableDirectories } from '../src/directories.js'

describe('directory picker', () => {
  it('lists direct child directories and blocks escaping the configured roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'cody-bot-hub-directories-'))
    try {
      mkdirSync(join(root, 'zeta'))
      mkdirSync(join(root, 'alpha', 'nested'), { recursive: true })
      symlinkSync(tmpdir(), join(root, 'outside-link'))
      const listing = listBrowsableDirectories(root, [root])
      expect(listing.current).toBe(realpathSync(root))
      expect(listing.directories.map(item => item.name)).toEqual(['alpha', 'zeta'])
      expect(listBrowsableDirectories(join(root, 'alpha'), [root]).parent).toBe(realpathSync(root))
      expect(() => listBrowsableDirectories(join(root, 'outside-link'), [root])).toThrow('允许浏览范围')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
