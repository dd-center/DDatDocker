'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const validUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)

function loadIdentity(env = process.env) {
  const directory = env.DATA_DIR || path.join(process.cwd(), 'data')
  const filename = path.join(directory, 'identity.json')
  fs.mkdirSync(directory, { recursive: true })
  let saved
  try { saved = JSON.parse(fs.readFileSync(filename, 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Cannot read ${filename}: ${error.message}. Keep or repair the existing identity before restarting.`)
  }
  if (saved && (!validUUID(saved.uuid) || typeof saved.nickname !== 'string' || !saved.nickname.trim())) throw new Error(`Invalid saved identity in ${filename}`)
  const uuid = env.UUID?.trim() || saved?.uuid || randomUUID()
  if (!validUUID(uuid)) throw new Error('UUID must be a UUID such as xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')
  const nickname = env.NICKNAME?.trim() || saved?.nickname || `DD-Docker-${process.platform}-${process.arch}-${uuid.slice(0, 8)}`
  if (nickname.length > 100 || /[\r\n\x00-\x1f]/.test(nickname)) throw new Error('NICKNAME must be 1–100 characters without control characters')
  const identity = { uuid, nickname }
  if (!saved || saved.uuid !== uuid || saved.nickname !== nickname) {
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(identity, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, filename)
    } finally {
      try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return { UUID: uuid, NICKNAME: nickname }
}

module.exports = { loadIdentity }
