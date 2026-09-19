'use strict'

const { promisify } = require('node:util')
const { inflate, brotliDecompress } = require('node:zlib')
const inflateAsync = promisify(inflate)
const brotliAsync = promisify(brotliDecompress)

// Wire format follows bilibili-live-ws 6.3.1 (MIT). Explicit length, depth,
// packet and decompression budgets also cover corrupt/compressed frames.
function encode(operation, body = '') {
  const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const packet = Buffer.alloc(16 + payload.length)
  packet.writeUInt32BE(packet.length, 0)
  packet.writeUInt16BE(16, 4)
  packet.writeUInt16BE(1, 6)
  packet.writeUInt32BE(operation, 8)
  packet.writeUInt32BE(1, 12)
  payload.copy(packet, 16)
  return packet
}

async function decode(buffer, maxBytes = 2 * 1024 * 1024) {
  const packets = []
  const budget = { bytes: maxBytes, packets: 5000 }
  async function unpack(input, depth) {
    if (depth > 3 || input.length > budget.bytes) throw new Error('Live frame budget exceeded')
    budget.bytes -= input.length
    for (let offset = 0; offset < input.length;) {
      if (input.length - offset < 16 || --budget.packets < 0) throw new Error('Invalid live packet')
      const length = input.readUInt32BE(offset)
      const header = input.readUInt16BE(offset + 4)
      const version = input.readUInt16BE(offset + 6)
      const operation = input.readUInt32BE(offset + 8)
      if (header < 16 || length < header || offset + length > input.length) throw new Error('Invalid live packet length')
      const body = input.subarray(offset + header, offset + length)
      if (version === 2 || version === 3) {
        if (budget.bytes <= 0) throw new Error('Live decompression budget exceeded')
        const decompress = version === 2 ? inflateAsync : brotliAsync
        await unpack(await decompress(body, { maxOutputLength: budget.bytes }), depth + 1)
      } else if (operation === 3) {
        if (body.length < 4) throw new Error('Invalid live heartbeat')
        packets.push({ operation, data: body.readUInt32BE(0) })
      } else if (operation === 5 || operation === 8) {
        packets.push({ operation, data: JSON.parse(body.toString('utf8')) })
      }
      offset += length
    }
  }
  await unpack(buffer, 0)
  return packets
}

// Preserve the Cluster-center relay schema and de-duplication tokens.
function relayEvent(roomid, message) {
  const cmd = message.cmd?.split(':')[0]
  const data = message.data
  if (['LIVE', 'PREPARING', 'ROUND'].includes(cmd)) return { roomid, e: cmd }
  if (cmd === 'ROOM_CHANGE' && typeof data?.title === 'string') return { roomid, e: cmd, data: data.title, token: `${roomid}_ROOM_CHANGE_${data.title}` }
  if (cmd === 'DANMU_MSG') {
    const info = message.info
    if (!Array.isArray(info?.[0]) || !Array.isArray(info?.[2]) || info[0][9]) return
    const [mid, uname] = info[2]
    const timestamp = info[0][4]
    return { roomid, e: cmd, data: { message: info[1], uname, timestamp, mid }, token: `${roomid}_DANMU_MSG_${mid}_${timestamp}` }
  }
  if (cmd === 'SEND_GIFT' && data) return { roomid, e: cmd, data: { coinType: data.coin_type, giftId: data.giftId, totalCoin: data.total_coin, uname: data.uname, mid: data.uid }, token: `${roomid}_SEND_GIFT_${data.uid}_${data.tid}` }
  if (cmd === 'GUARD_BUY' && data) return { roomid, e: cmd, data: { mid: data.uid, uname: data.username, num: data.num, price: data.price, giftId: data.gift_id, level: data.guard_level }, token: `${roomid}_GUARD_BUY_${data.uid}_${data.start_time}` }
}

module.exports = { encode, decode, relayEvent }
