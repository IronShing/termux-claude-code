'use strict'

const fs = require('fs')
const https = require('https')
const crypto = require('crypto')
const { URL } = require('url')

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 60_000

function fetchToFile(url, destPath, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.get(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: { 'user-agent': 'termux-claude-code-installer' },
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${url}`))
            return
          }
          const next = new URL(res.headers.location, url).toString()
          res.resume()
          fetchToFile(next, destPath, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
          res.resume()
          return
        }
        const file = fs.createWriteStream(destPath)
        res.pipe(file)
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())))
        file.on('error', reject)
      },
    )
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout fetching ${url}`))
    })
    req.on('error', reject)
  })
}

function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function fetchAndVerify(urls, expectedSha256, destPath) {
  const errors = []
  for (const url of urls) {
    try {
      await fetchToFile(url, destPath)
      const actual = await sha256OfFile(destPath)
      if (expectedSha256 && actual !== expectedSha256) {
        // Don't try mirrors when checksum mismatches — that's a tampering signal.
        try { fs.unlinkSync(destPath) } catch {}
        throw new Error(
          `sha256 mismatch for ${url}\n  expected: ${expectedSha256}\n  actual:   ${actual}`,
        )
      }
      return { url, sha256: actual }
    } catch (err) {
      errors.push(`  ${url}: ${err.message}`)
      try { fs.unlinkSync(destPath) } catch {}
    }
  }
  throw new Error('All download URLs failed:\n' + errors.join('\n'))
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.get(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        headers: {
          'user-agent': 'termux-claude-code-installer',
          accept: 'application/json',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
          res.resume()
          return
        }
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout fetching ${url}`))
    })
    req.on('error', reject)
  })
}

module.exports = { fetchToFile, sha256OfFile, fetchAndVerify, fetchJson }
