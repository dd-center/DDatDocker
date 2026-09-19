'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('node:zlib')
const { encode, decode, relayEvent } = require('../lib/bili-protocol')
const { readConfig } = require('../lib/config')
const { validateURL } = require('../lib/http')

test('config parses booleans explicitly and rejects dangerous resource settings', () => {
  const config = readConfig({ HIDE: 'false', LIMIT: '0', VERBOSE: 'false' })
  assert.equal(config.roomLimit, 0)
  assert.equal(config.verbose, false)
  assert.match(config.url, /runtime=/)
  for (const env of [{ INTERVAL: '-1' }, { LIMIT: 'Infinity' }, { HTTP_CONCURRENCY: '0' }, { HTTP_TIMEOUT_MS: '15000' }, { VERBOSE: 'yes' }, { URL: 'https://example.com' }, { RECONNECT_MIN_MS: '100000' }]) assert.throws(() => readConfig(env))
})

test('task URLs are constrained to configured HTTP hosts, without credentials', () => {
  assert.equal(validateURL('https://api.bilibili.com/x', ['api.bilibili.com']).hostname, 'api.bilibili.com')
  for (const url of ['file:///etc/passwd', 'http://127.0.0.1/', 'https://api.bilibili.com.evil.test/', 'https://user:pass@api.bilibili.com/']) assert.throws(() => validateURL(url, ['api.bilibili.com']))
})

test('decoder handles concatenated packets, auth JSON and compressed messages', async () => {
  const auth = encode(8, { code: 0 })
  const message = encode(5, { cmd: 'LIVE' })
  assert.equal((await decode(auth))[0].data.code, 0)
  for (const version of [2, 3]) {
    const body = version === 2 ? zlib.deflateSync(message) : zlib.brotliCompressSync(message)
    const frame = Buffer.concat([encode(5).subarray(0, 16), body])
    frame.writeUInt32BE(frame.length, 0)
    frame.writeUInt16BE(version, 6)
    const result = await decode(Buffer.concat([auth, frame]))
    assert.equal(result[1].data.cmd, 'LIVE')
  }
})

test('decoder rejects corrupt lengths and decompression bombs without looping', async () => {
  for (const buffer of [Buffer.alloc(16), Buffer.alloc(3), encode(5, 'not json')]) await assert.rejects(decode(buffer))
  const frame = Buffer.concat([encode(5).subarray(0, 16), zlib.deflateSync(Buffer.alloc(10000))])
  frame.writeUInt32BE(frame.length, 0)
  frame.writeUInt16BE(2, 6)
  await assert.rejects(decode(frame, 1024))
})

test('relay data keeps server tokens and ignores malformed danmaku', () => {
  assert.deepEqual(relayEvent(42, { cmd: 'LIVE' }), { roomid: 42, e: 'LIVE' })
  assert.equal(relayEvent(42, { cmd: 'DANMU_MSG', info: [] }), undefined)
  assert.equal(relayEvent(42, { cmd: 'SEND_GIFT', data: { uid: 7, tid: 'id' } }).token, '42_SEND_GIFT_7_id')
})
