import type { ThemePreference } from './types'

const media = window.matchMedia('(prefers-color-scheme: dark)')
let preference: ThemePreference = 'system'

export const applyTheme = (value: ThemePreference): void => {
  preference = value
  document.documentElement.dataset.theme = value === 'system' ? (media.matches ? 'dark' : 'light') : value
  document.documentElement.dataset.themePreference = value
}

export const announceTheme = (value: ThemePreference): void => {
  applyTheme(value)
  window.dispatchEvent(new CustomEvent<ThemePreference>('cody-theme-change', { detail: value }))
}

media.addEventListener('change', () => { if (preference === 'system') applyTheme('system') })
applyTheme('system')
