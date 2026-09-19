'use strict'

const http = require('node:http')
const { once } = require('node:events')
const { WebSocketServer } = require('ws')
const { readConfig } = require('../lib/config')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 4000) {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out')
    await delay(10)
  }
}

async function fixture(options = {}) {
  const state = { connections: 0, pulls: 0, results: [], active: 0, maxActive: 0, requests: 0 }
  const httpServer = http.createServer((req, res) => {
    state.requests++
    state.active++
    state.maxActive = Math.max(state.maxActive, state.active)
    res.on('close', () => state.active--)
    if (options.http) return options.http(req, res, state)
    if (req.url === '/hang') return
    if (req.url === '/body-hang') { res.writeHead(200); res.write('{'); return }
    if (req.url === '/large') { res.end('x'.repeat(4096)); return }
    if (req.url === '/bad') { res.end('<html>error</html>'); return }
    if (req.url === '/blocked') { res.writeHead(429); res.end('{"code":-412}'); return }
    res.setHeader('content-type', 'application/json')
    res.end('{"code":0,"data":{"ok":true}}')
  })
  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  const httpURL = `http://127.0.0.1:${httpServer.address().port}`
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: options.autoPong ?? true })
  await once(wss, 'listening')
  const wsURL = `ws://127.0.0.1:${wss.address().port}`
  wss.on('connection', ws => {
    state.connections++
    const connection = state.connections
    ws.on('error', () => {})
    options.connect?.(ws, state)
    ws.on('message', raw => {
      const text = String(raw)
      if (text === 'DDDhttp') {
        state.pulls++
        if (options.pull) return options.pull(ws, state, httpURL)
        ws.send(JSON.stringify({ key: `job-${state.pulls}`, data: { type: 'http', url: `${httpURL}/ok` } }))
      } else {
        const message = JSON.parse(text)
        if (message.query) {
          if (options.query) return options.query(ws, message, state)
          ws.send(JSON.stringify({ key: message.key, data: { type: 'query', result: 1 } }))
        } else {
          state.results.push({ connection, ...message })
          if (state.results.length > (options.resultLimit ?? Infinity)) state.results.shift()
        }
      }
    })
  })
  const config = { ...readConfig({ URL: wsURL, LIMIT: '0' }), interval: 30, tickInterval: 5, httpTimeout: 120, handshakeTimeout: 100, queryTimeout: 100, probeInterval: 100, pingInterval: 80, pongTimeout: 60, pullTimeout: 80, retryMin: 20, retryMax: 100, stableAfter: 300, cooldown: 200, cooldownMax: 400, allowedHosts: ['127.0.0.1'] }
  async function close() {
    for (const ws of wss.clients) ws.terminate()
    await new Promise(resolve => wss.close(resolve))
    httpServer.closeAllConnections()
    await new Promise(resolve => httpServer.close(resolve))
  }
  return { state, wss, httpServer, httpURL, wsURL, config, close }
}

module.exports = { delay, until, fixture }
