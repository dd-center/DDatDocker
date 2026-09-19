'use strict'

const headers = {
  'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 15_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/105.0.5195.100 Mobile/15E148 Safari/604.1',
  Cookie: '_uuid=;rpdid=',
}

function validateURL(raw, allowedHosts) {
  const url = new URL(raw)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error('Task URL is not allowed')
  }
  return url
}

// Timeout covers DNS, TLS, headers AND streamed/decompressed response body.
async function fetchText(url, { signal, timeout, maxBytes, fetchImpl = fetch, allowedHosts }) {
  const target = validateURL(url, allowedHosts)
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('HTTP deadline exceeded')), timeout)
  let reader
  try {
    const response = await fetchImpl(target, { headers, signal: controller.signal, redirect: 'error' })
    if (Number(response.headers.get('content-length')) > maxBytes) {
      controller.abort()
      throw new Error('HTTP body too large')
    }
    reader = response.body?.getReader()
    const chunks = []
    let bytes = 0
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) {
          controller.abort()
          throw new Error('HTTP body too large')
        }
        chunks.push(Buffer.from(value))
      }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), status: response.status }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (reader) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

module.exports = { fetchText, validateURL }
