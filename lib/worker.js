'use strict'

const http = require('node:http')
const { Client } = require('./client')
const { Relay } = require('./relay')
const { readConfig } = require('./config')
const { log } = require('./log')

function runWorker(config = readConfig()) {
  const client = new Client(config, { log })
  const relay = new Relay(client)
  const snapshot = () => ({ identity: config.identity, ...client.snapshot(), relay: relay.snapshot(), memory: process.memoryUsage() })
  const server = http.createServer((request, response) => {
    const path = request.url?.split('?')[0]
    if (!['/healthz', '/livez', '/status'].includes(path)) {
      response.writeHead(404).end()
      return
    }
    const state = snapshot()
    response.writeHead(path === '/healthz' && !state.ready ? 503 : 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(path === '/livez' ? { alive: true } : state))
  })
  server.requestTimeout = 5000
  server.headersTimeout = 5000
  server.keepAliveTimeout = 1000
  server.on('error', error => {
    log('error', 'health_server_error', { error: error.message })
    shutdown(1)
  })
  server.listen(config.port, config.healthHost, () => {
    log('info', 'started', { port: config.port, concurrency: config.concurrency, roomLimit: config.roomLimit, intervalMs: config.interval })
    client.start()
  })
  const statsTimer = setInterval(() => log('info', 'status', snapshot()), config.statusInterval)
  // IPC comes from the same event loop as task work; a frozen worker cannot fake it.
  let heartbeatPending = false
  const heartbeat = setInterval(() => {
    if (process.connected && !heartbeatPending) {
      heartbeatPending = true
      process.send({ type: 'heartbeat' }, () => { heartbeatPending = false })
    }
  }, 1000)
  let stopping = false
  function shutdown(code = 0) {
    if (stopping) return
    stopping = true
    log('info', 'shutdown')
    clearInterval(statsTimer)
    clearInterval(heartbeat)
    relay.stop()
    client.stop()
    server.close(() => process.exit(code))
    server.closeAllConnections()
    setTimeout(() => process.exit(code), 3000).unref()
  }
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())
  process.on('disconnect', () => shutdown())
  return { client, relay, server, snapshot }
}

if (require.main === module) runWorker()
module.exports = { runWorker }
