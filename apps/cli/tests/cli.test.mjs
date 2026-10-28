import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { run } from '../src/cli.mjs'

function output() {
  let stdout = '', stderr = ''
  return { stdout: { write: text => { stdout += text } }, stderr: { write: text => { stderr += text } }, result: () => ({ stdout, stderr }) }
}
test('help and invalid inputs return stable exit codes without contacting a service', async () => {
  const io = output()
  assert.equal(await run(['--help'], io), 0)
  assert.match(io.result().stdout, /message submit/)
  assert.equal(await run(['identity', 'whoami'], { ...io, env: {} }), 2)
  assert.equal(await run(['task', 'wait', 'x', '--timeout', 'NaN'], { ...io, env: { CODYBOTHUB_TOKEN: 'test' } }), 2)
  assert.equal(await run(['message', 'submit', '--input', '-', '--text', 'mixed'], { ...io, env: { CODYBOTHUB_TOKEN: 'test' } }), 2)
})

test('stdin JSON is forwarded intact, only Authorization carries credentials, and async returns a task handle', async t => {
  let received, headers
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received = JSON.parse(body); headers = request.headers
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ taskId: 'local-task', status: 'queued' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const input = { chatId: 'oc_group', topicId: 'root', sender: { id: 'ou_user' }, message: { type: 'card', text: '调查', raw: { service: 'payments' } }, messageId: 'om_message' }
  const io = output()
  assert.equal(await run(['message', 'submit', '--input', '-', '--scene-id', 'selected-scene', '--async'], { ...io, stdin: Readable.from([JSON.stringify(input)]), env: { CODYBOTHUB_URL: `http://127.0.0.1:${server.address().port}`, CODYBOTHUB_TOKEN: 'test-secret' } }), 0)
  assert.deepEqual(received, { ...input, sceneId: 'selected-scene' })
  assert.equal(headers.authorization, 'Bearer test-secret')
  assert.equal(JSON.parse(io.result().stdout).taskId, 'local-task')
  assert.doesNotMatch(io.result().stdout + io.result().stderr, /test-secret/)
})

test('routing flags cannot silently override conflicting values in input JSON', async () => {
  for (const [flag, key] of [['--scene-id', 'sceneId'], ['--bot-id', 'botId']]) {
    const io = output()
    const code = await run(['message', 'submit', '--input', '-', flag, 'new', '--json'], {
      ...io, stdin: Readable.from([JSON.stringify({ [key]: 'original' })]), env: { CODYBOTHUB_TOKEN: 'test' },
    })
    assert.equal(code, 2)
    assert.match(JSON.parse(io.result().stdout).error, /conflicts/)
  }
})

test('wait timeout returns 124 with taskId and does not cancel server work', async t => {
  const requests = []
  const server = createServer(async (request, response) => {
    requests.push(request.url)
    if (request.url.includes('/wait')) await new Promise(resolve => setTimeout(resolve, 1000))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ taskId: '00000000-0000-4000-8000-000000000000', status: 'running' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const io = output()
  const code = await run(['task', 'wait', '00000000-0000-4000-8000-000000000000', '--timeout', '1', '--json'], { ...io, env: { CODYBOTHUB_URL: `http://127.0.0.1:${server.address().port}`, CODYBOTHUB_TOKEN: 'test' } })
  assert.equal(code, 124)
  assert.equal(JSON.parse(io.result().stdout).status, 'running')
  assert.equal(requests.length, 2)
  assert.match(io.result().stderr, /continues/)
})
