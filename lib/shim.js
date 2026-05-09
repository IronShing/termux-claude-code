'use strict'

// Fetches the precompiled aarch64-musl LD_PRELOAD shim from a GitHub release
// asset. The shim source is in shim/resolv-redirect.c and is compiled by
// .github/workflows/build-shim.yml against musl-cross.
//
// Trust root: GitHub releases over HTTPS, with sha256 verified against a
// .sha256 sidecar file uploaded by the same workflow run. Until we move the
// shim to its own pinned release, callers may pass an expected sha256 in
// CFG.shim.sha256 (then we verify against that, ignoring the sidecar).

const fs = require('fs')
const path = require('path')
const { fetchToFile, sha256OfFile } = require('./fetch')

const FILENAME = 'libtcc-resolv-redirect.so'

function vendorDir(pkgRoot) {
  return path.join(pkgRoot, 'vendor', 'shim')
}

function shimPath(pkgRoot) {
  return path.join(vendorDir(pkgRoot), FILENAME)
}

function etcDir(pkgRoot) {
  return path.join(vendorDir(pkgRoot), 'etc')
}

function writeEtcFiles(pkgRoot) {
  // The shim redirects /etc/resolv.conf and /etc/hosts inside the musl-loaded
  // process to files under $TERMUX_CLAUDE_CODE_ETC. We populate those here.
  const dir = etcDir(pkgRoot)
  fs.mkdirSync(dir, { recursive: true })

  // resolv.conf — public DNS that doesn't require carrier-internal access.
  // 1.1.1.1 (Cloudflare) and 8.8.8.8 (Google) are universally reachable.
  // Users can override by editing this file post-install.
  const resolvPath = path.join(dir, 'resolv.conf')
  if (!fs.existsSync(resolvPath)) {
    fs.writeFileSync(resolvPath, 'nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:2 attempts:3\n')
  }

  // hosts — start from system /etc/hosts if readable, else minimal stub.
  const hostsPath = path.join(dir, 'hosts')
  if (!fs.existsSync(hostsPath)) {
    let body = '127.0.0.1\tlocalhost\n::1\t\tlocalhost\n'
    try {
      const sys = fs.readFileSync('/etc/hosts', 'utf8')
      if (sys && sys.length < 100_000) body = sys
    } catch {}
    fs.writeFileSync(hostsPath, body)
  }

  return { resolv: resolvPath, hosts: hostsPath }
}

async function ensureShim(pkgRoot, cfg) {
  const dest = shimPath(pkgRoot)
  fs.mkdirSync(vendorDir(pkgRoot), { recursive: true })

  // Write etc/ files unconditionally (idempotent).
  writeEtcFiles(pkgRoot)

  // If shim is already present and matches the configured sha256 (when given),
  // we're done.
  if (fs.existsSync(dest)) {
    if (cfg && cfg.sha256) {
      const have = await sha256OfFile(dest)
      if (have === cfg.sha256) {
        return { shim: dest, cached: true }
      }
      // Mismatch — re-fetch.
    } else {
      return { shim: dest, cached: true }
    }
  }

  if (!cfg || !cfg.url) {
    throw new Error(
      'No shim download URL configured (package.json termuxClaudeCode.shim.url). ' +
      'The shim is built by .github/workflows/build-shim.yml and uploaded as a ' +
      'release asset; configure the release URL in package.json or build locally.',
    )
  }

  await fetchToFile(cfg.url, dest)
  if (cfg.sha256) {
    const have = await sha256OfFile(dest)
    if (have !== cfg.sha256) {
      try { fs.unlinkSync(dest) } catch {}
      throw new Error(
        `shim sha256 mismatch for ${cfg.url}\n  expected ${cfg.sha256}\n  actual   ${have}`,
      )
    }
  }
  fs.chmodSync(dest, 0o755)
  return { shim: dest, cached: false }
}

module.exports = { ensureShim, shimPath, etcDir, vendorDir, writeEtcFiles }
