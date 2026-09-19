'use strict'

// Read-only reproduction against the exact upstream core.js supplied as argv[2].
// The relay is isolated to avoid opening any public live-room connections.
const fs = require('node:fs')
const vm = require('node:vm')
const { EventEmitter, once } = require('node:events')
const assert = require('node:assert/strict')

async function main() {
  const source = process.argv[2]
  if (!source) throw new Error('Usage: node scripts/reproduce-upstream.js /path/to/upstream/core.js')
  const context = { module: { exports: {} }, require: name => name === './relay' ? () => new EventEmitter() : require(name), fetch, setTimeout, console }
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), context, { filename: source })
  const Upstream = context.module.exports
  class FakeWS {
    readyState = 1
    sent = []
    send(text) { this.sent.push(text) }
  }
  const client = new Upstream('ws://test', { start: false, WebSocket: FakeWS })
  client.connect()
  assert.throws(() => client.ws.onmessage({ data: 'null' }))
  console.log('REPRODUCED: malformed upstream message escapes the event handler')

  let calls = 0
  client.customFetch = () => { calls++; return new Promise(() => {}) }
  for (let i = 0; i < 100; i++) client.ws.onmessage({ data: JSON.stringify({ key: String(i), data: { type: 'http', url: 'https://api.bilibili.com/' } }) })
  assert.equal(calls, 100)
  console.log('REPRODUCED: 100 stalled HTTP tasks start without a concurrency bound')

  let release
  client.customFetch = () => new Promise(resolve => { release = resolve })
  client.ws.onmessage({ data: JSON.stringify({ key: 'old-session', data: { type: 'http', url: 'https://api.bilibili.com/' } }) })
  client.ws = new FakeWS()
  release(new Response('{"code":0}'))
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(JSON.parse(client.ws.sent[0]).key, 'old-session')
  console.log('REPRODUCED: old-session result is sent on the replacement connection')

  client.dispatcher = {}
  client.connect()
  const rejection = once(process, 'unhandledRejection')
  client.ws.onmessage({ data: JSON.stringify({ key: 'proxy', data: { type: 'http', url: 'https://api.bilibili.com/' } }) })
  assert.match((await rejection)[0].message, /dispatcher is not defined/)
  console.log('REPRODUCED: dispatcher option triggers an unhandled ReferenceError')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
