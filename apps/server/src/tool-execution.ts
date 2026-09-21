import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { HubStore } from './db.js'
import type { ToolPackageRecord, ToolRecord } from './types.js'

export type ToolStepResult = {
  toolId: string
  toolName: string
  phase: string
  command: string
  arguments: string[]
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

const valueAt = (input: Record<string, unknown>, path: string): unknown => path.split('.').reduce<unknown>((value, key) => value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined, input)
const render = (template: string, input: Record<string, unknown>): string => template.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match, key: string) => {
  if (key === 'json') return JSON.stringify(input)
  const value = valueAt(input, key)
  if (value === undefined || value === null) throw new Error(`Tool argument ${key} is required`)
  return typeof value === 'string' ? value : JSON.stringify(value)
})

const renderValue = (template: unknown, input: Record<string, unknown>): unknown => {
  if (Array.isArray(template)) return template.map(item => renderValue(item, input))
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template as Record<string, unknown>).map(([key, value]) => [key, renderValue(value, input)]))
  if (typeof template !== 'string') return template
  const exact = template.match(/^\{\{\s*([^}]+?)\s*\}\}$/u)
  if (exact) {
    const value = exact[1] === 'json' ? input : valueAt(input, exact[1]!)
    if (value === undefined || value === null) throw new Error(`Tool argument ${exact[1]} is required`)
    return value
  }
  return render(template, input)
}

const validateInput = (schema: Record<string, unknown>, input: Record<string, unknown>, toolName: string): void => {
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
  const missing = required.filter(key => input[key] === undefined || input[key] === null || input[key] === '')
  if (missing.length) throw new Error(`Tool ${toolName} is missing required arguments: ${missing.join(', ')}`)
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties as Record<string, unknown> : {}
  for (const [key, definition] of Object.entries(properties)) {
    if (input[key] === undefined || !definition || typeof definition !== 'object') continue
    const expected = (definition as Record<string, unknown>).type
    const actual = Array.isArray(input[key]) ? 'array' : input[key] === null ? 'null' : typeof input[key]
    if (typeof expected === 'string' && expected !== actual && !(expected === 'integer' && actual === 'number')) throw new Error(`Tool ${toolName} argument ${key} must be ${expected}`)
  }
}

const execute = (command: string, args: string[], cwd: string, timeoutSeconds: number): Promise<Omit<ToolStepResult, 'toolId' | 'toolName' | 'phase'>> => new Promise((resolve, reject) => {
  const started = Date.now(), child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', finished = false, timedOut = false
  let killTimer: ReturnType<typeof setTimeout> | null = null
  const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-100_000)
  child.stdout.on('data', chunk => { stdout = append(stdout, chunk as Buffer) })
  child.stderr.on('data', chunk => { stderr = append(stderr, chunk as Buffer) })
  const timer = setTimeout(() => {
    if (finished) return
    timedOut = true
    child.kill('SIGTERM')
    killTimer = setTimeout(() => { if (!finished) child.kill('SIGKILL') }, 2_000)
    killTimer.unref?.()
  }, Math.max(1, timeoutSeconds) * 1_000)
  timer.unref?.()
  child.on('error', error => { finished = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error) })
  child.on('close', code => {
    finished = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer)
    const result = { command, arguments: args, exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - started }
    if (timedOut) reject(Object.assign(new Error(`${command} timed out after ${Math.max(1, timeoutSeconds)} seconds`), { result }))
    else if (code === 0) resolve(result)
    else reject(Object.assign(new Error(`${command} exited with code ${code ?? -1}: ${stderr || stdout}`.slice(0, 4_000)), { result }))
  })
})

const scriptRuntime = (tool: ToolRecord, cwd: string): { command: string; arguments: string[] } => {
  const language = tool.scriptLanguage || 'python'
  const extension = language === 'shell' ? 'sh' : language === 'node' ? 'js' : 'py'
  const directory = path.join(cwd, '.codybothub', 'tools', tool.id)
  mkdirSync(directory, { recursive: true })
  const source = path.join(directory, `main.${extension}`)
  writeFileSync(source, tool.scriptContent, { encoding: 'utf8', mode: 0o700 })
  const command = language === 'shell' ? '/bin/bash' : language === 'node' ? 'node' : '/usr/bin/python3'
  return { command, arguments: [source] }
}

const invocation = (tool: ToolRecord, input: Record<string, unknown>, cwd: string): { command: string; arguments: string[] } => {
  if (tool.executorType === 'bits_rpc') {
    const config = tool.rpcConfig
    if (!config.service || !config.method) throw new Error(`Tool ${tool.name} is missing its Bits RPC service or method`)
    const request = renderValue(config.requestTemplate, input)
    const payload = {
      action: 'rpc', psm: config.service, func_name: config.method,
      request: JSON.stringify(request), vregion: config.vregion, env: config.environment || 'prod', cluster: config.cluster || 'default',
    }
    return { command: tool.command || 'gdpa-cli', arguments: ['run', 'bam-query', '--input', JSON.stringify(payload)] }
  }
  if (tool.scriptContent) {
    const runtime = scriptRuntime(tool, cwd)
    return { command: runtime.command, arguments: [...runtime.arguments, ...tool.argumentsTemplate.map(value => render(value, input))] }
  }
  return { command: tool.command, arguments: tool.argumentsTemplate.map(value => render(value, input)) }
}

export class ToolPackageRunner {
  constructor(private readonly store: HubStore) {}

  async runTool(tool: ToolRecord, input: Record<string, unknown>, cwd: string, phase = 'execute'): Promise<ToolStepResult> {
    if (!tool.enabled) throw new Error(`Tool ${tool.name} is disabled`)
    validateInput(tool.inputSchema, input, tool.name)
    const prepared = invocation(tool, input, cwd)
    const result = await execute(prepared.command, prepared.arguments, cwd, tool.timeoutSeconds)
    if (tool.executorType === 'bits_rpc' && /"success"\s*:\s*false/iu.test(result.stdout)) throw Object.assign(new Error(`${tool.name} returned success=false`), { result })
    return { toolId: tool.id, toolName: tool.name, phase, ...result }
  }

  async run(pack: ToolPackageRecord, args: Record<string, unknown>, cwd: string): Promise<ToolStepResult[]> {
    const results: ToolStepResult[] = []
    for (const step of pack.steps) {
      const tool = this.store.getTool(step.toolId)
      if (tool.workspaceId !== pack.workspaceId) throw new Error(`Tool ${tool.name} belongs to another Workspace`)
      // Package-level step arguments are administrator policy and must not be overridden by model-supplied values.
      const input = { ...args, ...step.arguments }
      try {
        results.push(await this.runTool(tool, input, cwd, step.phase))
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        throw Object.assign(failure, { partialResults: [...results] })
      }
    }
    return results
  }
}
