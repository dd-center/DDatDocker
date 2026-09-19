'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const path = require('node:path')
const net = require('node:net')
const { fixture, until } = require('./helpers')

test('independent watchdog kills an event-loop freeze and exits nonzero', { timeout: 5000 }, async t => {
  const script = `require('./lib/supervisor').supervise(${JSON.stringify(path.join(__dirname, 'fixtures/frozen-worker.js'))}, { timeout: 200 })`
  const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') })
  let output = ''
  child.stdout.on('data', data => { output += data })
  t.after(() => child.kill('SIGKILL'))
  const [code] = await once(child, 'exit')
  assert.equal(code, 1)
  assert.match(output, /watchdog_timeout/)
})

test('actual supervised worker exposes useful status and stops cleanly on SIGTERM', { timeout: 10000 }, async t => {
  const f = await fixture()
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const child = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, URL: f.wsURL, LIMIT: '0', INTERVAL: '100', HEALTH_HOST: '127.0.0.1', HEALTH_PORT: String(port), ALLOWED_TASK_HOSTS: '127.0.0.1' } })
  child.stdout.resume()
  child.stderr.resume()
  t.after(async () => { child.kill('SIGKILL'); await f.close() })
  await until(() => f.state.results.length >= 1)
  const response = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(response.status, 200)
  const status = await response.json()
  assert.ok(status.valid >= 1)
  assert.equal(status.relay.enabled, false)
  const done = once(child, 'exit')
  child.kill('SIGTERM')
  assert.equal((await done)[0], 0)
})
