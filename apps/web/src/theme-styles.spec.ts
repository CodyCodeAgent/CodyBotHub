import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
describe('Light theme regressions', () => {
  it('defines semantic status colors independently from dark mode', () => {
    const light = css.match(/:root\[data-theme='light'\]\s*\{([^}]+)\}/)?.[1] ?? ''
    for (const token of ['green', 'danger', 'warning']) expect(light).toContain(`--${token}:`)
  })
  it('overrides dark modal decoration and error text in light mode', () => {
    expect(css).toContain(":root[data-theme='light'] .dialog { background: var(--surface)")
    expect(css).toContain(":root[data-theme='light'] .error-banner { color: var(--danger)")
    expect(css).toContain(":root[data-theme='light'] th { color: var(--text-soft)")
  })
  it('wraps long identifiers without losing content', () => {
    expect(css).toMatch(/\.detail-grid strong\s*\{[^}]*overflow-wrap: anywhere/)
    expect(css).toMatch(/\.detail-grid > div\s*\{[^}]*min-width: 0/)
  })
})
