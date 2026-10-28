#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const help = `CodyBotHub CLI

  codybothub identity whoami
  codybothub identity register       Use CODYBOTHUB_REGISTRATION_TOKEN (one time)
  codybothub scene list [--bot-id ID] [--json]
  codybothub message submit --input message.json [--async] [--json]
  codybothub message submit --scene-id ID --input message.json [--json]
  codybothub message submit --input -             Read JSON from stdin
  codybothub message submit --chat-id ID --message-id ID --sender-id ID --text TEXT
  codybothub task get TASK_ID [--json]
  codybothub task wait TASK_ID [--timeout 300] [--json]

Message flags: --bot-id, --scene-id, --chat-name, --topic-id, --sender-name,
               --sender-type (user|bot|app), --message-type, --title, --created-at
Global flags:  --url URL, --json, --help
Environment:   CODYBOTHUB_URL (default http://127.0.0.1:4310), CODYBOTHUB_TOKEN
Exit codes:    0 success, 1 task failed, 2 request/input error, 124 wait timeout,
               130 interrupted (the server task continues)
`

class CliError extends Error { constructor(message, code = 2) { super(message); this.code = code } }
const terminal = task => ['completed', 'failed', 'cancelled'].includes(task.status)

async function stdinText(stream) {
  const chunks = []
  let size = 0
  for await (const chunk of stream) {
    size += Buffer.byteLength(chunk)
    if (size > 1024 * 1024) throw new CliError('Input exceeds 1 MiB')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function run(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, signal } = {}) {
  let json = argv.includes('--json'), latestTask
  try {
    const stringOptions = ['url', 'input', 'timeout', 'bot-id', 'scene-id', 'chat-id', 'chat-name', 'topic-id', 'message-id', 'sender-id', 'sender-name', 'sender-type', 'message-type', 'title', 'text', 'created-at']
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      ...Object.fromEntries(stringOptions.map(key => [key, { type: 'string' }])),
      async: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } })
    json = Boolean(values.json)
    if (values.help || !positionals.length) { stdout.write(help); return 0 }
    const [domain, command, taskId] = positionals
    if (!['identity whoami', 'identity register', 'scene list', 'message submit', 'task get', 'task wait'].includes(`${domain} ${command}`)) throw new CliError('Unknown command. Use --help')
    if (positionals.length !== (domain === 'task' ? 3 : 2)) throw new CliError('Unexpected or missing command arguments')
    const base = new URL(values.url ?? env.CODYBOTHUB_URL ?? 'http://127.0.0.1:4310')
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new CliError('URL must be an HTTP(S) server origin')
    const registration = domain === 'identity' && command === 'register'
    const token = registration ? env.CODYBOTHUB_REGISTRATION_TOKEN : env.CODYBOTHUB_TOKEN
    if (!token) throw new CliError(`${registration ? 'CODYBOTHUB_REGISTRATION_TOKEN' : 'CODYBOTHUB_TOKEN'} is required`)
    const seconds = Number(values.timeout ?? 300)
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) throw new CliError('--timeout must be an integer from 1 to 86400 seconds')
    const request = async (path, method = 'GET', body, timeout = 30_000) => {
      const response = await fetch(new URL(path, base), {
        method, redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      })
      const result = await response.json().catch(() => { throw new CliError(`HTTP ${response.status}: server did not return JSON`) })
      if (!response.ok) throw new CliError(`HTTP ${response.status}: ${result.error ?? response.statusText}`)
      return result
    }
    if (domain === 'identity') {
      const result = await request(registration ? '/api/v1/identities/register' : '/api/v1/identity', registration ? 'POST' : 'GET', registration ? {} : undefined)
      stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      if (registration) stderr.write('Save the returned token as CODYBOTHUB_TOKEN. It will not be shown again.\n')
      return 0
    }
    if (domain === 'scene') {
      const query = values['bot-id'] ? `?botId=${encodeURIComponent(values['bot-id'])}` : ''
      const result = await request(`/api/v1/scenes${query}`)
      stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return 0
    }
    if (domain === 'message') {
      const messageOptions = stringOptions.filter(key => !['url', 'input', 'timeout'].includes(key))
      let input
      if (values.input) {
        if (messageOptions.some(key => !['bot-id', 'scene-id'].includes(key) && values[key] !== undefined)) throw new CliError('--input can only be combined with --bot-id or --scene-id')
        const text = values.input === '-' ? await stdinText(stdin) : await readFile(values.input, 'utf8')
        if (Buffer.byteLength(text) > 1024 * 1024) throw new CliError('Input exceeds 1 MiB')
        input = JSON.parse(text)
        for (const [flag, key] of [['bot-id', 'botId'], ['scene-id', 'sceneId']]) {
          if (values[flag] === undefined) continue
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CliError('Message input must be a JSON object')
          if (input[key] !== undefined && input[key] !== values[flag]) throw new CliError(`--${flag} conflicts with ${key} in the input JSON`)
          input[key] = values[flag]
        }
      } else {
        for (const key of ['chat-id', 'message-id', 'sender-id', 'text']) if (!values[key]) throw new CliError(`--${key} is required (or use --input)`)
        input = {
          chatId: values['chat-id'], messageId: values['message-id'],
          sender: { id: values['sender-id'], ...(values['sender-name'] ? { name: values['sender-name'] } : {}), ...(values['sender-type'] ? { type: values['sender-type'] } : {}) },
          message: { text: values.text, ...(values['message-type'] ? { type: values['message-type'] } : {}), ...(values.title ? { title: values.title } : {}) },
          ...Object.fromEntries([['bot-id', 'botId'], ['scene-id', 'sceneId'], ['chat-name', 'chatName'], ['topic-id', 'topicId'], ['created-at', 'createdAt']].filter(([flag]) => values[flag] !== undefined).map(([flag, key]) => [key, values[flag]])),
        }
      }
      latestTask = await request('/api/v1/messages', 'POST', input)
      stderr.write(`Task: ${latestTask.taskId}\n`)
      if (values.async) { stdout.write(`${JSON.stringify(latestTask)}\n`); return 0 }
    } else {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) throw new CliError('Invalid task ID')
      latestTask = await request(`/api/v1/tasks/${taskId}`)
    }
    if (!(domain === 'task' && command === 'get')) {
      const deadline = Date.now() + seconds * 1000
      while (!terminal(latestTask) && Date.now() < deadline) {
        const remaining = deadline - Date.now(), wait = Math.min(25_000, Math.max(0, remaining))
        latestTask = await request(`/api/v1/tasks/${latestTask.taskId}/wait?timeoutMs=${wait}`, 'GET', undefined, Math.min(30_000, remaining + 1000))
      }
      if (!terminal(latestTask)) {
        stdout.write(`${JSON.stringify(latestTask)}\n`)
        stderr.write('Wait timed out; the task continues. Use task wait with this taskId.\n')
        return 124
      }
    }
    if (json || !terminal(latestTask)) stdout.write(`${JSON.stringify(latestTask, null, 2)}\n`)
    else if (latestTask.status === 'completed') stdout.write(`${latestTask.answer ?? ''}\n`)
    else stderr.write(`${latestTask.error ?? latestTask.status}\n`)
    return ['failed', 'cancelled'].includes(latestTask.status) ? 1 : 0
  } catch (error) {
    const code = signal?.aborted ? 130 : error instanceof CliError ? error.code : 2
    const message = signal?.aborted ? 'Interrupted; accepted tasks continue on the server' : error.message ?? String(error)
    if (json) stdout.write(`${JSON.stringify({ error: message, ...(latestTask ? { taskId: latestTask.taskId } : {}) })}\n`)
    else stderr.write(`${message}\n`)
    return code
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.exitCode = await run(process.argv.slice(2), { signal: controller.signal })
}
