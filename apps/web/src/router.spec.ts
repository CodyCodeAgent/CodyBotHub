import { describe, expect, it } from 'vitest'
import { routes } from './routes'

describe('application routes', () => {
  it('loads every view through a dynamic import boundary', () => {
    expect(routes).not.toHaveLength(0)
    for (const route of routes) {
      expect(route.component, `${String(route.name)} should be lazy`).toBeTypeOf('function')
    }
  })

  it('keeps route names and paths unique', () => {
    const names = routes.map(route => route.name)
    const paths = routes.map(route => route.path)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(paths).size).toBe(paths.length)
  })
})
