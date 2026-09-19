#!/usr/bin/env node
'use strict'

const path = require('node:path')
const { readConfig } = require('./lib/config')
const { supervise } = require('./lib/supervisor')
const { log } = require('./lib/log')
const { loadIdentity } = require('./lib/identity')

try {
  readConfig() // Reject invalid settings before writing persistent identity.
  const env = { ...process.env, ...loadIdentity() }
  const config = readConfig(env)
  log('info', 'identity', { nickname: env.NICKNAME, uuid: env.UUID, environment: `${process.platform}-${process.arch}` })
  if (process.argv.includes('--worker')) {
    require('./lib/worker').runWorker(config)
  } else {
    supervise(path.join(__dirname, 'lib/worker.js'), { timeout: config.watchdogTimeout, env })
  }
} catch (error) {
  log('error', 'invalid_config', { error: error.message })
  process.exitCode = 1
}
