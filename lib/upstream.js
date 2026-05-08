'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { fetchAndVerify, fetchJson } = require('./fetch')

// We don't pin the upstream sha in our repo because we want weekly auto-bumps.
// Instead we resolve the official integrity from the npm registry's metadata
// at install time and verify against that. The trust root is the registry over
// HTTPS — same trust as `npm install` itself.
const REGISTRY_URL = 'https://registry.npmjs.org'
const PKG = '@anthropic-ai/claude-code-linux-arm64-musl'

function vendorDir(pkgRoot) {
  return path.join(pkgRoot, 'vendor', 'upstream-musl')
}

function binaryPath(pkgRoot) {
  return path.join(vendorDir(pkgRoot), 'claude')
}

function integrityToHex(integrity) {
  // npm dist.integrity is "sha512-<base64>". We re-emit hex sha512 for our own
  // verifier in fetch.js (which only takes hex sha256 today). Easiest path:
  // verify sha1 (dist.shasum) at fetch time, then verify the sha512 here.
  return integrity
}

async function ensureUpstreamBinary(pkgRoot, version) {
  const dest = binaryPath(pkgRoot)
  const versionMarker = path.join(vendorDir(pkgRoot), '.version')
  if (
    fs.existsSync(dest) &&
    fs.existsSync(versionMarker) &&
    fs.readFileSync(versionMarker, 'utf8').trim() === version
  ) {
    return { binary: dest, cached: true }
  }

  fs.mkdirSync(vendorDir(pkgRoot), { recursive: true })

  // 1. Pull the package metadata to get tarball URL + integrity for THIS version.
  console.log(`[termux-claude-code] Resolving ${PKG}@${version} from npm registry`)
  const meta = await fetchJson(
    `${REGISTRY_URL}/${encodeURIComponent(PKG)}/${encodeURIComponent(version)}`,
  )
  if (!meta || !meta.dist || !meta.dist.tarball) {
    throw new Error(`No tarball metadata for ${PKG}@${version}`)
  }
  const tarballUrl = meta.dist.tarball
  const shasumHex = meta.dist.shasum // sha1 of the tarball, hex
  const integrity = meta.dist.integrity // sha512-base64, optional

  // 2. Download with sha1 verification (registry's published shasum).
  // fetchAndVerify only handles sha256 — for upstream we verify sha1 manually
  // because that's what npm publishes (and what npm itself verifies).
  const tgzPath = path.join(vendorDir(pkgRoot), 'upstream.tgz')
  await downloadAndVerifySha1(tarballUrl, tgzPath, shasumHex)

  // 3. Verify sha512 integrity if present (defense in depth).
  if (integrity && integrity.startsWith('sha512-')) {
    const expected = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
    const actual = await sha512OfFile(tgzPath)
    if (actual !== expected) {
      try { fs.unlinkSync(tgzPath) } catch {}
      throw new Error(
        `sha512 integrity mismatch for ${tarballUrl}\n  expected ${expected}\n  actual   ${actual}`,
      )
    }
  }

  // 4. Extract. The upstream tarball lays out package/{claude, package.json, ...};
  // we strip the package/ prefix and put files directly in vendor/upstream-musl/.
  const r = spawnSync(
    'tar',
    ['-xzf', tgzPath, '-C', vendorDir(pkgRoot), '--strip-components=1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (r.status !== 0 || !fs.existsSync(dest)) {
    throw new Error(
      `tar extraction failed (exit=${r.status})\nstderr: ${r.stderr?.toString() || ''}`,
    )
  }
  fs.chmodSync(dest, 0o755)
  fs.writeFileSync(versionMarker, version + '\n')
  try { fs.unlinkSync(tgzPath) } catch {}

  return { binary: dest, cached: false }
}

function downloadAndVerifySha1(url, destPath, expectedSha1Hex) {
  const { fetchToFile } = require('./fetch')
  const crypto = require('crypto')
  return fetchToFile(url, destPath).then(
    () =>
      new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha1')
        const stream = fs.createReadStream(destPath)
        stream.on('data', (c) => hash.update(c))
        stream.on('end', () => {
          const actual = hash.digest('hex')
          if (expectedSha1Hex && actual !== expectedSha1Hex) {
            try { fs.unlinkSync(destPath) } catch {}
            reject(
              new Error(
                `sha1 mismatch for ${url}\n  expected ${expectedSha1Hex}\n  actual   ${actual}`,
              ),
            )
          } else {
            resolve()
          }
        })
        stream.on('error', reject)
      }),
  )
}

function sha512OfFile(filePath) {
  const crypto = require('crypto')
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (c) => hash.update(c))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

module.exports = { ensureUpstreamBinary, vendorDir, binaryPath }
