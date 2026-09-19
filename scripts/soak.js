'use strict'

const assert = require('node:assert/strict')
const { Client } = require('../lib/client')
const { fixture, delay } = require('../test/helpers')

async function main() {
  const seconds = Number(process.env.SOAK_SECONDS || 120)
  if (!Number.isFinite(seconds) || seconds < 10) throw new Error('SOAK_SECONDS must be >= 10')
  const f = await fixture({ resultLimit: 128, pull(ws, state, url) {
    if (state.pulls % 17 === 0) return // silent server load shedding
    if (state.pulls % 11 === 0) ws.send('{malformed')
    const path = state.pulls % 7 === 0 ? '/hang' : '/ok'
    ws.send(JSON.stringify({ key: String(state.pulls), data: { type: 'http', url: url + path } }))
  } })
  const client = new Client({ ...f.config, interval: 10, concurrency: 3 })
  const memory = []
  let peakInFlight = 0
  const chaos = setInterval(() => { for (const ws of f.wss.clients) ws.terminate() }, 700)
  const sampling = setInterval(() => {
    memory.push(process.memoryUsage().rss)
    peakInFlight = Math.max(peakInFlight, client.snapshot().inFlight)
  }, 100)
  try {
    client.start()
    await delay(seconds * 1000)
    assert.ok(client.stats.valid > seconds * 5)
    assert.ok(client.stats.connections > seconds / 2)
    assert.ok(peakInFlight <= 3)
    // Absolute budget is intentional: short runs cannot establish a long-term leak slope.
    assert.ok(Math.max(...memory) < 256 * 1024 * 1024, 'RSS exceeded container memory budget')
    console.log(JSON.stringify({ seconds, ...client.snapshot(), peakInFlight, peakRSSMiB: Math.round(Math.max(...memory) / 1048576), finalRSSMiB: Math.round(memory.at(-1) / 1048576) }, null, 2))
  } finally {
    clearInterval(chaos)
    clearInterval(sampling)
    client.stop()
    await f.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
