import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = (relative: string) =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
  }

describe('workspace dependency versions', () => {
  it('uses one CodyWebCore release across the browser and server', () => {
    const web = manifest('../package.json')
    const server = manifest('../../server/package.json')
    expect(web.dependencies?.['@codycodeagent/cody-web-core']).toBe(
      server.dependencies?.['@codycodeagent/cody-web-core']
    )
  })
})
