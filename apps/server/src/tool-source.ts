import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { HubStore } from './db.js'
import type { ToolRecord } from './types.js'

export const removeToolSource = (store: HubStore, tool: ToolRecord): void => {
  const workspace = store.getWorkspace(tool.workspaceId)
  rmSync(path.join(workspace.path, '.codybothub', 'tools', tool.id), { recursive: true, force: true })
}

export const syncToolSource = (store: HubStore, tool: ToolRecord): void => {
  const workspace = store.getWorkspace(tool.workspaceId)
  const directory = path.join(workspace.path, '.codybothub', 'tools', tool.id)
  if (!tool.scriptContent) { removeToolSource(store, tool); return }
  const extension = tool.scriptLanguage === 'shell' ? 'sh' : tool.scriptLanguage === 'node' ? 'js' : 'py'
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, `main.${extension}`), tool.scriptContent, { encoding: 'utf8', mode: 0o700 })
  writeFileSync(path.join(directory, 'tool.json'), `${JSON.stringify({ id: tool.id, name: tool.name, language: tool.scriptLanguage, version: tool.scriptVersion, updatedAt: tool.updatedAt }, null, 2)}\n`, 'utf8')
}
