'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { once } = require('node:events')
const { Client } = require('../lib/client')
const { fixture, until, delay } = require('./helpers')

async function setup(t, options = {}, overrides = {}, dependencies = {}) {
  const f = await fixture(options)
  const client = new Client({ ...f.config, ...overrides }, dependencies)
  t.after(async () => { client.stop(); await f.close() })
  client.start()
  return { ...f, client }
}

test('completes real HTTP tasks and verifies application readiness', async t => {
  const { client, state } = await setup(t)
  await until(() => state.results.length >= 3 && client.snapshot().ready)
  assert.equal(JSON.parse(state.results[0].data).code, 0)
  assert.ok(client.snapshot().valid >= 3)
  assert.equal(state.connections, 1)
})

test('wait, ignored pulls, broadcasts and malformed messages do not stop work', async t => {
  const { client, state } = await setup(t, { pull(ws, state, url) {
    if (state.pulls === 1) for (const raw of ['wait', 'null', '{bad', '[]', JSON.stringify({ payload: { type: 'danmaku' } })]) ws.send(raw)
    else if (state.pulls === 2) return // legal server-side load shedding
    else ws.send(JSON.stringify({ key: String(state.pulls), data: { type: 'http', url: `${url}/ok` } }))
  } })
  await until(() => state.results.length >= 2)
  assert.equal(state.connections, 1)
  assert.equal(client.stats.malformed, 3)
})

test('HTTP header and body stalls expire and release capacity', async t => {
  const { client, state } = await setup(t, { pull(ws, state, url) {
    const path = state.pulls === 1 ? '/hang' : state.pulls === 2 ? '/body-hang' : '/ok'
    ws.send(JSON.stringify({ key: String(state.pulls), data: { type: 'http', url: url + path } }))
  } }, { concurrency: 1 })
  await until(() => state.results.length >= 3)
  assert.equal(JSON.parse(state.results[0].data).code, 233)
  assert.equal(JSON.parse(state.results[1].data).code, 233)
  assert.equal(JSON.parse(state.results[2].data).code, 0)
  assert.equal(client.stats.failed, 2)
  assert.ok(state.maxActive <= 1)
})

test('unsolicited task bursts never exceed concurrency or build an unbounded queue', async t => {
  const { state, client } = await setup(t, { pull(ws, state, url) {
    if (state.pulls > 1) return
    for (let i = 0; i < 30; i++) ws.send(JSON.stringify({ key: `burst-${i}`, data: { type: 'http', url: `${url}/hang` } }))
  } }, { concurrency: 2 })
  await until(() => state.results.length >= 30)
  assert.equal(state.requests, 2)
  assert.equal(client.stats.overloaded, 28)
  assert.ok(state.maxActive <= 2)
})

test('normal server close reconnects and resumes useful work', async t => {
  const { state, wss } = await setup(t)
  await until(() => state.results.length >= 1)
  for (const ws of wss.clients) ws.close(1012, 'restart')
  await until(() => state.results.some(result => result.connection === 2))
  assert.equal(state.connections, 2)
})

test('TCP/WebSocket pong silence forces termination and reconnection', async t => {
  const { state, client } = await setup(t, { autoPong: false })
  await until(() => state.connections >= 2)
  assert.ok(client.stats.disconnects >= 1)
  assert.match(client.stats.lastFailure, /pong_timeout/)
})

test('responsive socket with a stalled server application is recovered', async t => {
  const { state, client } = await setup(t, { query() {} })
  await until(() => state.connections >= 2)
  assert.match(client.stats.lastFailure, /application_probe_failed/)
})

test('late old-session work cannot be submitted on the new socket', async t => {
  let release
  const blockedFetch = () => new Promise(resolve => { release = () => resolve(new Response('{"code":0}')) })
  const { state, wss, client } = await setup(t, { pull(ws, state, url) {
    if (state.pulls === 1) ws.send(JSON.stringify({ key: 'old-key', data: { type: 'http', url: `${url}/ok` } }))
    else ws.send('wait')
  } }, {}, { fetchImpl: blockedFetch })
  await until(() => release)
  for (const ws of wss.clients) ws.terminate()
  await until(() => state.connections === 2)
  release()
  await until(() => client.stats.cancelled === 1)
  assert.equal(state.results.length, 0)
})

test('disconnect cancels HTTP requests and outstanding query timers', async t => {
  const { state, wss, client } = await setup(t, { query(ws, message) {
    if (message.query === 'online') ws.send(JSON.stringify({ key: message.key, data: { type: 'query', result: 1 } }))
  }, pull(ws, state, url) {
    ws.send(JSON.stringify({ key: String(state.pulls), data: { type: 'http', url: `${url}/hang` } }))
  } })
  await until(() => state.active > 0)
  const old = client.session
  const query = assert.rejects(client.ask('unanswered'), /Session ended/)
  for (const ws of wss.clients) ws.terminate()
  await query
  await until(() => client.stats.cancelled > 0)
  assert.equal(old.queries.size, 0)
  assert.equal(old.jobs.size, 0)
})

test('oversized and non-JSON responses are failures, not valid work', async t => {
  const { state, client } = await setup(t, { pull(ws, state, url) {
    ws.send(JSON.stringify({ key: String(state.pulls), data: { type: 'http', url: `${url}${state.pulls === 1 ? '/large' : '/bad'}` } }))
  } }, { maxBodyBytes: 1024 })
  await until(() => state.results.length >= 2)
  assert.ok(state.results.every(result => JSON.parse(result.data).code === 233))
  assert.equal(client.stats.valid, 0)
})

test('rate limits pause task pulls without disconnecting the cluster socket', async t => {
  const { state, client } = await setup(t, { pull(ws, state, url) {
    ws.send(JSON.stringify({ key: String(state.pulls), data: { type: 'http', url: `${url}/blocked` } }))
  } })
  await until(() => client.cooldownUntil > Date.now())
  const pulls = state.pulls
  await delay(120)
  assert.equal(state.pulls, pulls)
  assert.equal(state.connections, 1)
  assert.ok(client.snapshot().ready)
  await until(() => state.pulls > pulls)
})

test('send-buffer exhaustion reconnects instead of buffering indefinitely', async t => {
  const { state, client } = await setup(t)
  await until(() => client.snapshot().ready)
  const old = client.session
  Object.defineProperty(old.ws, 'bufferedAmount', { get: () => 99999999 })
  assert.equal(client.send('test'), false)
  await until(() => state.connections >= 2)
  assert.match(client.stats.lastFailure, /send_buffer_limit/)
})

test('a hanging WebSocket handshake times out; stop cancels all retries', async t => {
  const sockets = new Set()
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const f = await fixture()
  const client = new Client({ ...f.config, url: `ws://127.0.0.1:${server.address().port}` })
  t.after(async () => {
    client.stop()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    await f.close()
  })
  client.start()
  await until(() => client.stats.disconnects >= 2)
  client.stop()
  const disconnects = client.stats.disconnects
  await delay(200)
  assert.equal(client.session, null)
  assert.equal(client.timer, null)
  assert.equal(client.stats.disconnects, disconnects)
})
