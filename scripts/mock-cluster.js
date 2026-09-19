'use strict'

// Isolated Docker integration fixture. Never connects to the public cluster.
const http = require('node:http')
const { WebSocketServer } = require('ws')
const host = process.env.MOCK_HOST || 'mock'
const state = { connections: 0, results: 0, valid: 0, pulls: 0 }
let key = 0
const wss = new WebSocketServer({ port: 18080 })
wss.on('connection', ws => {
  state.connections++
  ws.on('error', () => {})
  ws.on('message', raw => {
    if (String(raw) === 'DDDhttp') {
      state.pulls++
      ws.send(JSON.stringify({ key: String(++key), data: { type: 'http', url: `http://${host}:18081/task` } }))
    } else {
      const message = JSON.parse(String(raw))
      if (message.query) ws.send(JSON.stringify({ key: message.key, data: { type: 'query', result: 1 } }))
      else if (message.data) {
        state.results++
        if (JSON.parse(message.data).code === 0) state.valid++
      }
    }
  })
})
http.createServer((req, res) => {
  if (req.url === '/task') res.end('{"code":0,"data":{"mock":true}}')
  else if (req.url === '/disconnect') {
    for (const ws of wss.clients) ws.terminate()
    res.end('ok')
  } else res.end(JSON.stringify(state))
}).listen(18081)
