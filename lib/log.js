'use strict'

function log(level, event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }))
}

module.exports = { log }
