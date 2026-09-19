'use strict'

const WebSocket = require('ws')
const { fetchText } = require('./http')
const { encode, decode, relayEvent } = require('./bili-protocol')

class Relay {
  constructor(client, { fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    this.client = client
    this.config = client.config
    this.log = client.log
    this.fetchImpl = fetchImpl
    this.WebSocket = WebSocketImpl
    this.rooms = new Map()
    this.active = false
    this.generation = 0
    this.picking = false
    this.loading = false
    this.nextPickAt = 0
    this.nextConfigAt = 0
    this.stats = { forwarded: 0, failures: 0, lastError: null }
    client.on('connected', () => this.start())
    client.on('disconnected', () => this.stop())
  }

  start() {
    if (this.active || !this.config.roomLimit) return
    this.active = true
    this.generation++
    this.timer = setInterval(() => this.tick(), 500)
    this.tick()
  }

  stop() {
    this.active = false
    this.generation++
    clearInterval(this.timer)
    this.timer = null
    for (const room of this.rooms.values()) {
      room.controller?.abort()
      room.connection?.terminate()
    }
    this.rooms.clear()
    this.loading = false
    this.picking = false
  }

  tick() {
    if (!this.active) return
    const now = Date.now()
    const generation = this.generation
    if (!this.picking && this.rooms.size < this.config.roomLimit && now >= this.nextPickAt) {
      this.picking = true
      this.nextPickAt = now + this.config.roomInterval
      this.client.ask({ type: 'pickRoom' }).then(id => {
        if (generation !== this.generation || !Number.isSafeInteger(id) || id <= 0 || this.rooms.has(id)) return
        this.rooms.set(id, { id, connection: null, controller: null, live: false, nextAt: 0, failures: 0 })
      }).catch(error => {
        if (generation === this.generation) this.stats.lastError = error.message
      }).finally(() => { if (generation === this.generation) this.picking = false })
    }
    for (const room of this.rooms.values()) {
      if (room.connection) {
        const timeout = room.live ? this.config.roomHeartbeatTimeout : this.config.handshakeTimeout
        if (now - room.lastResponseAt > timeout) this.fail(room, 'live_heartbeat_or_auth_timeout')
        else if (room.live && now >= room.nextHeartbeatAt) {
          room.nextHeartbeatAt = now + 30000
          this.send(room, encode(2))
        }
      } else if (!this.loading && now >= this.nextConfigAt && now >= room.nextAt) {
        this.loading = true
        this.nextConfigAt = now + 2000
        void this.open(room, generation).finally(() => { if (generation === this.generation) this.loading = false })
      }
    }
  }

  isCurrent(room, ws) {
    return this.active && this.rooms.get(room.id) === room && (!ws || room.connection === ws)
  }

  async open(room, generation) {
    const controller = new AbortController()
    room.controller = controller
    try {
      const response = await fetchText(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${room.id}&type=0`, {
        signal: controller.signal, timeout: this.config.httpTimeout, maxBytes: 262144,
        allowedHosts: ['api.live.bilibili.com'], fetchImpl: this.fetchImpl,
      })
      if (!this.isCurrent(room) || generation !== this.generation) return
      const result = JSON.parse(response.text)
      if (response.status !== 200 || result.code !== 0 || !result.data?.token) throw new Error(`Live config HTTP ${response.status}, API ${result.code}`)
      const host = result.data.host_list?.find(item => typeof item.host === 'string' && /(^|\.)chat\.bilibili\.com$/.test(item.host))
      if (!host) throw new Error('No valid live host')
      const port = host.wss_port || 443
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid live port')
      const ws = new this.WebSocket(`wss://${host.host}:${port}/sub`, { handshakeTimeout: this.config.handshakeTimeout, maxPayload: this.config.maxBodyBytes, perMessageDeflate: false })
      room.connection = ws
      room.lastResponseAt = Date.now()
      room.nextHeartbeatAt = 0
      let chain = Promise.resolve()
      let queuedBytes = 0
      let queuedMessages = 0
      ws.on('open', () => {
        if (!this.isCurrent(room, ws)) return
        this.send(room, encode(7, { uid: 0, roomid: room.id, protover: 3, platform: 'web', type: 2, key: result.data.token }))
      })
      ws.on('message', raw => {
        if (!this.isCurrent(room, ws)) return
        queuedBytes += raw.length
        queuedMessages++
        if (queuedBytes > this.config.maxBodyBytes || queuedMessages > 100) return this.fail(room, 'live_decode_queue_limit')
        chain = chain.then(async () => {
          if (!this.isCurrent(room, ws)) return
          const packets = await decode(Buffer.from(raw), this.config.maxBodyBytes)
          if (!this.isCurrent(room, ws)) return
          for (const packet of packets) {
            if (packet.operation === 8) {
              if (packet.data?.code !== 0) throw new Error(`Live auth denied: ${packet.data?.code}`)
              room.live = true
              room.lastResponseAt = Date.now()
              room.nextHeartbeatAt = Date.now() + 30000
              this.send(room, encode(2))
            } else if (packet.operation === 3 && room.live) {
              room.lastResponseAt = Date.now()
              room.failures = 0
              this.forward({ roomid: room.id, e: 'heartbeat', data: packet.data })
            } else if (packet.operation === 5 && room.live) {
              const event = relayEvent(room.id, packet.data)
              if (event) this.forward(event)
            }
          }
        }).catch(error => {
          if (this.isCurrent(room, ws)) this.fail(room, error.message)
        }).finally(() => { queuedBytes -= raw.length; queuedMessages-- })
      })
      ws.on('error', error => { if (this.isCurrent(room, ws)) this.fail(room, error.message) })
      ws.on('close', () => { if (this.isCurrent(room, ws)) this.fail(room, 'live_closed') })
    } catch (error) {
      if (this.isCurrent(room) && generation === this.generation) {
        this.nextConfigAt = Date.now() + this.config.cooldown
        this.fail(room, error.message)
      }
    } finally {
      if (room.controller === controller) room.controller = null
    }
  }

  fail(room, error) {
    const ws = room.connection
    room.connection = null
    room.live = false
    room.failures++
    room.nextAt = Date.now() + Math.min(60000, 2000 * 2 ** Math.min(room.failures, 5))
    ws?.terminate()
    this.stats.failures++
    this.stats.lastError = error
    this.log('warn', 'relay_retry', { roomid: room.id, error, retryMs: room.nextAt - Date.now() })
  }

  send(room, data) {
    const ws = room.connection
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount + data.length > 65536) return this.fail(room, 'live_send_buffer_limit')
    try {
      ws.send(data, error => { if (error && this.isCurrent(room, ws)) this.fail(room, error.message) })
    } catch (error) { if (this.isCurrent(room, ws)) this.fail(room, error.message) }
  }

  forward(relay) {
    if (this.client.send({ relay })) this.stats.forwarded++
  }

  snapshot() {
    return { enabled: this.config.roomLimit > 0, limit: this.config.roomLimit, rooms: this.rooms.size, live: [...this.rooms.values()].filter(room => room.live).length, ...this.stats }
  }
}

module.exports = { Relay }
