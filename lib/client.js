'use strict'

const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')
const WebSocket = require('ws')
const { fetchText } = require('./http')

class Client extends EventEmitter {
  constructor(config, { fetchImpl = fetch, WebSocketImpl = WebSocket, random = Math.random, log = () => {} } = {}) {
    super()
    this.config = config
    this.fetchImpl = fetchImpl
    this.WebSocket = WebSocketImpl
    this.random = random
    this.log = log
    this.running = false
    this.session = null
    this.timer = null
    this.retryAt = 0
    this.failures = 0
    this.cooldownUntil = 0
    this.rateFailures = 0
    this.startedAt = Date.now()
    this.stats = { connections: 0, disconnects: 0, received: 0, submitted: 0, valid: 0, failed: 0, cancelled: 0, overloaded: 0, malformed: 0, lastTaskAt: null, lastTaskTarget: null, lastValidAt: null, lastFailure: null }
  }

  start() {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => this.tick(), this.config.tickInterval)
    this.tick()
  }

  stop() {
    this.running = false
    clearInterval(this.timer)
    this.timer = null
    if (this.session) this.drop(this.session, 'shutdown')
  }

  tick() {
    if (!this.running) return
    const now = Date.now()
    const s = this.session
    const c = this.config
    if (!s) {
      if (now >= this.retryAt) this.connect()
      return
    }
    if (s.ws.readyState !== WebSocket.OPEN) return
    if (s.pingSentAt && now - s.pingSentAt >= c.pongTimeout) return this.drop(s, 'pong_timeout')
    if (!s.pingSentAt && now >= s.nextPingAt) {
      s.pingSentAt = now
      s.nextPingAt = now + c.pingInterval
      try { s.ws.ping(String(now)) } catch { return this.drop(s, 'ping_failed') }
    }
    if (now >= s.nextProbeAt && !s.probing) {
      s.probing = true
      s.nextProbeAt = now + c.probeInterval
      this.ask('online', s).then(result => {
        if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('Invalid online response')
        if (this.session === s) {
          s.lastProbeAt = Date.now()
          if (Date.now() - s.openedAt >= c.stableAfter) this.failures = 0
        }
      }).catch(() => this.drop(s, 'application_probe_failed')).finally(() => { s.probing = false })
    }
    // DDDhttp may intentionally get no reply. Expire the reservation, not the connection.
    if (s.pullUntil && now >= s.pullUntil) s.pullUntil = 0
    if (!s.pullUntil && s.jobs.size < c.concurrency && now >= s.nextPullAt && now >= this.cooldownUntil) {
      s.pullUntil = now + c.pullTimeout
      s.nextPullAt = now + c.interval
      if (!this.send('DDDhttp', s)) s.pullUntil = 0
    }
  }

  connect() {
    const c = this.config
    const s = { ws: null, jobs: new Map(), queries: new Map(), openedAt: 0, lastProbeAt: 0, nextPullAt: 0, pullUntil: 0, nextPingAt: 0, pingSentAt: 0, nextProbeAt: 0, probing: false }
    this.session = s
    try {
      s.ws = new this.WebSocket(c.url, { handshakeTimeout: c.handshakeTimeout, maxPayload: 1024 * 1024, perMessageDeflate: false })
    } catch (error) {
      this.drop(s, `connect_error: ${error.message}`)
      return
    }
    s.ws.on('open', () => {
      if (this.session !== s) return
      s.openedAt = Date.now()
      this.stats.connections++
      this.log('info', 'connected', { connections: this.stats.connections })
      this.emit('connected')
      this.tick()
    })
    s.ws.on('pong', data => {
      if (this.session === s && String(data) === String(s.pingSentAt)) s.pingSentAt = 0
    })
    s.ws.on('message', (raw, binary) => {
      if (this.session !== s) return
      try {
        if (binary) throw new Error('Unexpected binary message')
        const message = String(raw) === 'wait' ? { empty: true } : JSON.parse(String(raw))
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message')
        if (message.empty || message.data?.type === 'wait') s.pullUntil = 0
        else if (message.data?.type === 'query') {
          const query = s.queries.get(message.key)
          if (query) {
            clearTimeout(query.timer)
            s.queries.delete(message.key)
            query.resolve(message.data.result)
          }
        } else if (message.data?.type === 'http') {
          s.pullUntil = 0
          if (typeof message.key !== 'string' || !message.key || typeof message.data.url !== 'string') throw new Error('Invalid task')
          void this.processTask(s, message.key, message.data.url)
        }
        // Broadcast payloads are informational; the worker never sends chat messages.
      } catch (error) {
        this.stats.malformed++
        this.log('warn', 'invalid_message', { error: error.message })
      }
    })
    s.ws.on('error', error => this.drop(s, `socket_error: ${error.message}`))
    s.ws.on('close', (code, reason) => this.drop(s, `closed_${code}: ${String(reason).slice(0, 120)}`))
  }

  drop(s, reason) {
    if (this.session !== s) return
    this.session = null
    for (const job of s.jobs.values()) job.abort(new Error('Session ended'))
    for (const query of s.queries.values()) {
      clearTimeout(query.timer)
      query.reject(new Error('Session ended'))
    }
    s.queries.clear()
    // terminate avoids waiting for a close handshake over a dead link.
    s.ws?.terminate()
    this.stats.disconnects++
    this.stats.lastFailure = reason
    const base = Math.min(this.config.retryMax, this.config.retryMin * 2 ** Math.min(this.failures++, 20))
    const delay = Math.round(base * (0.5 + this.random() * 0.5))
    this.retryAt = Date.now() + delay
    this.log('warn', 'disconnected', { reason, retryMs: this.running ? delay : null })
    this.emit('disconnected', reason)
  }

  send(data, s = this.session) {
    if (!s || this.session !== s || s.ws?.readyState !== WebSocket.OPEN) return false
    const text = typeof data === 'string' ? data : JSON.stringify(data)
    if (s.ws.bufferedAmount + Buffer.byteLength(text) > this.config.maxBufferedBytes) {
      this.drop(s, 'send_buffer_limit')
      return false
    }
    try {
      s.ws.send(text, error => { if (error) this.drop(s, `send_error: ${error.message}`) })
      return true
    } catch (error) {
      this.drop(s, `send_error: ${error.message}`)
      return false
    }
  }

  ask(query, s = this.session) {
    if (!s || s.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected'))
    if (s.queries.size >= 8) return Promise.reject(new Error('Too many queries'))
    return new Promise((resolve, reject) => {
      const key = randomUUID()
      const timer = setTimeout(() => {
        s.queries.delete(key)
        reject(new Error('Query timeout'))
      }, this.config.queryTimeout)
      s.queries.set(key, { resolve, reject, timer })
      if (!this.send({ key, query }, s)) {
        clearTimeout(timer)
        s.queries.delete(key)
        reject(new Error('Query send failed'))
      }
    })
  }

  async processTask(s, key, url) {
    if (s.jobs.has(key)) return
    if (s.jobs.size >= this.config.concurrency) {
      this.stats.overloaded++
      this.send({ key, data: JSON.stringify({ code: 233, message: 'Worker capacity exceeded' }) }, s)
      return
    }
    const controller = new AbortController()
    s.jobs.set(key, controller)
    this.stats.received++
    this.stats.lastTaskAt = Date.now()
    try {
      const target = new URL(url)
      this.stats.lastTaskTarget = `${target.hostname}${target.pathname}`
    } catch { this.stats.lastTaskTarget = 'invalid URL' }
    const started = Date.now()
    let text
    let valid = false
    let error
    try {
      const result = await fetchText(url, { signal: controller.signal, timeout: this.config.httpTimeout, maxBytes: this.config.maxBodyBytes, allowedHosts: this.config.allowedHosts, fetchImpl: this.fetchImpl })
      text = result.text
      let data
      try { data = JSON.parse(text) } catch { /* reject HTML, empty and other non-JSON bodies */ }
      valid = result.status >= 200 && result.status < 300 && data?.code === 0
      const code = data?.code
      if (!valid) {
        error = `HTTP ${result.status}, API code ${code ?? 'non-JSON'}${typeof data?.message === 'string' ? `: ${data.message.slice(0, 120)}` : ''}`
        if ([403, 412, 429].includes(result.status) || [-412, -352, -509].includes(code)) {
          const delay = Math.min(this.config.cooldownMax, this.config.cooldown * 2 ** Math.min(this.rateFailures++, 10))
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay)
          this.log('warn', 'http_cooldown', { durationMs: delay, status: result.status, code })
        }
        // Never let HTML or a code:0 error page be mistaken for success by the server.
        if (!data || typeof code !== 'number' || code === 0) text = JSON.stringify({ code: 233, message: error })
      } else {
        this.rateFailures = 0
      }
    } catch (cause) {
      error = cause.message
      text = JSON.stringify({ code: 233, message: 'Worker fetch failed' })
    } finally {
      s.jobs.delete(key)
    }
    if (this.session !== s || controller.signal.aborted) {
      this.stats.cancelled++
      return
    }
    if (this.send({ key, data: text }, s)) {
      this.stats.submitted++
      if (valid) {
        this.stats.valid++
        this.stats.lastValidAt = Date.now()
      } else {
        this.stats.failed++
        this.stats.lastFailure = error
      }
      if (!valid || this.config.verbose) this.log(valid ? 'info' : 'warn', 'task_result', { key, valid, durationMs: Date.now() - started, error })
      this.emit('task', { key, valid })
    }
  }

  snapshot() {
    const s = this.session
    const connected = s?.ws?.readyState === WebSocket.OPEN
    const ready = Boolean(connected && s.lastProbeAt && Date.now() - s.lastProbeAt < this.config.probeInterval + this.config.queryTimeout + 1000)
    return { ready, connected, uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000), inFlight: s?.jobs.size || 0, pendingQueries: s?.queries.size || 0, lastProbeAt: s?.lastProbeAt || null, cooldownUntil: this.cooldownUntil > Date.now() ? this.cooldownUntil : null, ...this.stats }
  }
}

module.exports = { Client }
