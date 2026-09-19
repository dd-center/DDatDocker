'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadIdentity } = require('../lib/identity')
const { readConfig } = require('../lib/config')

function directory(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ddathome-identity-'))
  t.after(() => fs.rmSync(value, { recursive: true, force: true }))
  return value
}

test('first start generates a distinct UUID and readable environment nickname, then reuses both', t => {
  const DATA_DIR = directory(t)
  const first = loadIdentity({ DATA_DIR })
  const second = loadIdentity({ DATA_DIR, UUID: '', NICKNAME: '' })
  assert.deepEqual(second, first)
  assert.match(first.UUID, /^[a-f0-9-]{36}$/)
  assert.equal(first.NICKNAME, `DD-Docker-${process.platform}-${process.arch}-${first.UUID.slice(0, 8)}`)
  assert.notEqual(loadIdentity({ DATA_DIR: directory(t) }).UUID, first.UUID)
  const url = new URL(readConfig({ ...first, DOCKER: 'true' }).url)
  assert.equal(url.searchParams.get('uuid'), first.UUID)
  assert.equal(url.searchParams.get('name'), first.NICKNAME)
  assert.equal(url.searchParams.get('docker'), 'docker')
  assert.equal(url.searchParams.get('platform'), `${process.platform}-${process.arch}`)
})

test('explicit nickname/UUID override generated identity and persist across recreation', t => {
  const DATA_DIR = directory(t)
  loadIdentity({ DATA_DIR })
  const env = { DATA_DIR, NICKNAME: '示例用户 的 ARM 节点', UUID: 'bcd462b0-4202-448d-9f70-e57477782f79' }
  assert.deepEqual(loadIdentity(env), { UUID: env.UUID, NICKNAME: env.NICKNAME })
  assert.deepEqual(loadIdentity({ DATA_DIR }), { UUID: env.UUID, NICKNAME: env.NICKNAME })
})

test('invalid inputs or damaged identity fail visibly instead of silently changing identity', t => {
  const DATA_DIR = directory(t)
  assert.throws(() => loadIdentity({ DATA_DIR, UUID: 'invalid' }), /UUID must/)
  fs.writeFileSync(path.join(DATA_DIR, 'identity.json'), '{corrupt')
  assert.throws(() => loadIdentity({ DATA_DIR }), /Cannot read/)
})
