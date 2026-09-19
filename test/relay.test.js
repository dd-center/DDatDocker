'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const WebSocket = require('ws')
const { Relay } = require('../lib/relay')
const { encode } = require('../lib/bili-protocol')
const { readConfig } = require('../lib/config')
const { until, delay } = require('./helpers')

async function setup(t, onConnect, overrides = {}) {
  const wss = new WebSocket.WebSocketServer({ port: 0, host: '127.0.0.1' })
  await once(wss, 'listening')
  wss.on('connection', ws => { ws.on('error', () => {}); onConnect(ws) })
  const client = new EventEmitter()
  client.config = { ...readConfig({ LIMIT: '2' }), handshakeTimeout: 100, cooldown: 100, roomInterval: 50, ...overrides }
  client.log = () => {}
  let room = 0
  client.ask = async () => ++room
  const sent = []
  client.send = value => { sent.push(value); return true }
  class LocalWS extends WebSocket {
    constructor(url, options) { super(`ws://127.0.0.1:${wss.address().port}`, options) }
  }
  let configs = 0
  const fetchImpl = async () => {
    configs++
    return new Response(JSON.stringify({ code: 0, data: { token: 'test', host_list: [{ host: 'test.chat.bilibili.com', wss_port: 443 }] } }))
  }
  const relay = new Relay(client, { WebSocketImpl: LocalWS, fetchImpl })
  relay.start()
  const clock = setInterval(() => { relay.nextConfigAt = 0; relay.tick() }, 10)
  t.after(async () => {
    clearInterval(clock)
    relay.stop()
    for (const ws of wss.clients) ws.terminate()
    await new Promise(resolve => wss.close(resolve))
  })
  return { client, relay, sent, configs: () => configs, wss }
}

test('live relay authenticates, forwards valid events and obeys room limit', async t => {
  const { relay, sent, configs } = await setup(t, ws => {
    ws.on('message', frame => {
      const operation = frame.readUInt32BE(8)
      if (operation === 7) ws.send(encode(8, { code: 0 }))
      if (operation === 2) {
        const heartbeat = Buffer.concat([encode(3).subarray(0, 16), Buffer.from([0, 0, 0, 42])])
        heartbeat.writeUInt32BE(20, 0)
        ws.send(heartbeat)
        ws.send(encode(5, { cmd: 'LIVE' }))
      }
    })
  })
  await until(() => relay.snapshot().live === 2)
  await until(() => sent.filter(item => item.relay.e === 'LIVE').length === 2)
  assert.ok(sent.some(item => item.relay.e === 'heartbeat' && item.relay.data === 42))
  await delay(100)
  assert.equal(configs(), 2)
  assert.equal(relay.rooms.size, 2)
  relay.stop()
  await until(() => relay.rooms.size === 0)
  assert.equal(relay.timer, null)
})

test('auth denial is never counted as a live room and schedules bounded retry', async t => {
  const { relay } = await setup(t, ws => ws.on('message', () => ws.send(encode(8, { code: -101 }))), { roomLimit: 1 })
  await until(() => relay.stats.failures > 0)
  assert.equal(relay.snapshot().live, 0)
  assert.equal(relay.rooms.size, 1)
  assert.match(relay.stats.lastError, /auth denied/)
})

test('hung auth and malformed frames are contained within a relay connection', async t => {
  let connections = 0
  const { relay } = await setup(t, ws => {
    if (++connections === 2) ws.on('message', () => ws.send(Buffer.alloc(16)))
  })
  await until(() => relay.stats.failures >= 2)
  assert.equal(relay.snapshot().live, 0)
  assert.equal(relay.rooms.size, 2)
})

test('late room configuration after stop cannot open an orphan socket', async () => {
  const client = new EventEmitter()
  client.config = { ...readConfig({ LIMIT: '1' }), roomInterval: 10 }
  client.log = () => {}
  client.ask = async () => 42
  let release
  let created = 0
  const relay = new Relay(client, {
    fetchImpl: () => new Promise(resolve => { release = resolve }),
    WebSocketImpl: class { constructor() { created++ } },
  })
  try {
    relay.start()
    await delay(10)
    relay.tick()
    await until(() => release)
    relay.stop()
    release(new Response('{"code":0,"data":{"token":"test","host_list":[{"host":"test.chat.bilibili.com"}]}}'))
    await delay(20)
    assert.equal(created, 0)
    assert.equal(relay.rooms.size, 0)
  } finally { relay.stop() }
})
