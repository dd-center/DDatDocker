'use strict'

// Explicit opt-in live protocol check. It does real work but never sends chat.
const { randomUUID } = require('node:crypto')
const { Client } = require('../lib/client')
const { readConfig } = require('../lib/config')

async function main() {
  const uuid = randomUUID()
  const nickname = `DD-Docker-check-${uuid.slice(0, 8)}`
  const config = readConfig({ ...process.env, UUID: uuid, NICKNAME: nickname, LIMIT: '0' })
  const client = new Client(config)
  const seconds = Number(process.env.SMOKE_SECONDS || 60)
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 600) throw new Error('SMOKE_SECONDS must be 10–600')
  try {
    client.start()
    await new Promise(resolve => setTimeout(resolve, seconds * 1000))
    const homes = await client.ask('homes').catch(() => [])
    const record = homes.find(home => home.name === nickname)
    console.log(JSON.stringify({ seconds, ...client.snapshot(), serverRecord: record || null }, null, 2))
    if (!record || record.resolves < 1 || !client.stats.valid) process.exitCode = 1
  } finally { client.stop() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
