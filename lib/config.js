'use strict'

const { version } = require('../package.json')

function number(env, key, fallback, min = 1, max = 2147483647) {
  const value = env[key] === undefined ? fallback : Number(env[key])
  if (!Number.isSafeInteger(value) || value < min || value > max || env[key] === '') {
    throw new Error(`${key} must be an integer between ${min} and ${max}`)
  }
  return value
}

function bool(value = 'false') {
  if (['true', '1'].includes(value.toLowerCase())) return true
  if (['false', '0', ''].includes(value.toLowerCase())) return false
  throw new Error(`Invalid boolean: ${value}`)
}

function readConfig(env = process.env) {
  const url = new URL(env.URL || 'wss://cluster.vtbs.moe')
  if (!['wss:', 'ws:'].includes(url.protocol)) throw new Error('URL must use ws:// or wss://')
  if (!bool(env.HIDE)) {
    url.searchParams.set('runtime', `node/${process.version}`)
    url.searchParams.set('version', `docker-${version}`)
    url.searchParams.set('platform', `${process.platform}-${process.arch}`)
    if (bool(env.DOCKER || env.docker)) url.searchParams.set('docker', 'docker')
  }
  if (env.UUID) url.searchParams.set('uuid', env.UUID)
  if (env.NICKNAME) url.searchParams.set('name', env.NICKNAME)
  const config = {
    identity: { nickname: env.NICKNAME || null, uuid: env.UUID || null, platform: `${process.platform}-${process.arch}`, version, docker: bool(env.DOCKER || env.docker) },
    url: url.href,
    interval: number(env, 'INTERVAL', 1280, 100),
    concurrency: number(env, 'HTTP_CONCURRENCY', 2, 1, 64),
    httpTimeout: number(env, 'HTTP_TIMEOUT_MS', 10000, 100, 12000),
    maxBodyBytes: number(env, 'MAX_BODY_BYTES', 2 * 1024 * 1024, 1024, 16 * 1024 * 1024),
    maxBufferedBytes: number(env, 'MAX_BUFFERED_BYTES', 8 * 1024 * 1024, 65536, 64 * 1024 * 1024),
    allowedHosts: (env.ALLOWED_TASK_HOSTS || 'api.bilibili.com,api.live.bilibili.com,space.bilibili.com').split(',').map(v => v.trim().toLowerCase()).filter(Boolean),
    handshakeTimeout: number(env, 'CONNECT_TIMEOUT_MS', 10000),
    pingInterval: number(env, 'PING_INTERVAL_MS', 30000),
    pongTimeout: number(env, 'PONG_TIMEOUT_MS', 10000),
    queryTimeout: number(env, 'QUERY_TIMEOUT_MS', 5000),
    probeInterval: number(env, 'PROBE_INTERVAL_MS', 30000),
    pullTimeout: 5000,
    retryMin: number(env, 'RECONNECT_MIN_MS', 1000),
    retryMax: number(env, 'RECONNECT_MAX_MS', 60000),
    stableAfter: 60000,
    cooldown: number(env, 'COOLDOWN_MS', 60000),
    cooldownMax: number(env, 'COOLDOWN_MAX_MS', 300000),
    roomLimit: number(env, 'LIMIT', 5, 0, 1000),
    roomInterval: number(env, 'ROOM_INTERVAL_MS', 5000, 1000),
    roomHeartbeatTimeout: 75000,
    port: number(env, 'HEALTH_PORT', 9464, 1, 65535),
    healthHost: env.HEALTH_HOST || '0.0.0.0',
    statusInterval: number(env, 'STATUS_INTERVAL_MS', 60000),
    watchdogTimeout: number(env, 'WATCHDOG_TIMEOUT_MS', 45000, 5000),
    verbose: bool(env.VERBOSE),
    tickInterval: 250,
  }
  if (config.retryMax < config.retryMin) throw new Error('RECONNECT_MAX_MS must be >= RECONNECT_MIN_MS')
  if (config.cooldownMax < config.cooldown) throw new Error('COOLDOWN_MAX_MS must be >= COOLDOWN_MS')
  if (!config.allowedHosts.length) throw new Error('ALLOWED_TASK_HOSTS cannot be empty')
  return config
}

module.exports = { readConfig }
