'use strict'

const http = require('node:http')
const host = process.env.HEALTH_HOST === '::' ? '::1' : process.env.HEALTH_HOST === '0.0.0.0' || !process.env.HEALTH_HOST ? '127.0.0.1' : process.env.HEALTH_HOST
const request = http.get({ host, port: Number(process.env.HEALTH_PORT || 9464), path: '/healthz', timeout: 3000 }, response => {
  response.resume()
  process.exitCode = response.statusCode === 200 ? 0 : 1
})
request.on('timeout', () => request.destroy(new Error('Health check timeout')))
request.on('error', () => { process.exitCode = 1 })
