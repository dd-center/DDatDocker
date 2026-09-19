'use strict'

const { fork } = require('node:child_process')
const { log } = require('./log')

function supervise(entry, { timeout = 45000, grace = 5000, env = process.env } = {}) {
  const child = fork(entry, [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  let lastBeat = Date.now()
  let stopping = false
  let watchdogFailed = false
  let killTimer
  child.on('message', message => { if (message?.type === 'heartbeat') lastBeat = Date.now() })
  const timer = setInterval(() => {
    if (!stopping && Date.now() - lastBeat > timeout) {
      watchdogFailed = true
      stopping = true
      log('error', 'watchdog_timeout', { stalledMs: Date.now() - lastBeat })
      child.kill('SIGKILL')
    }
  }, Math.min(1000, Math.max(10, Math.floor(timeout / 4))))
  const stop = () => {
    if (stopping) return
    stopping = true
    clearInterval(timer)
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child.kill('SIGKILL'), grace)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  child.on('error', error => {
    log('error', 'worker_spawn_failed', { error: error.message })
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    clearInterval(timer)
    clearTimeout(killTimer)
    log(code === 0 ? 'info' : 'error', 'worker_exit', { code, signal })
    process.exit(watchdogFailed ? 1 : stopping ? 0 : code || 1)
  })
  return child
}

module.exports = { supervise }
