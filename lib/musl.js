'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { fetchAndVerify } = require('./fetch')

// Layout under <pkgRoot>/vendor/musl/:
//   apk/musl.apk        the source APK we downloaded (kept for verification)
//   lib/ld-musl-aarch64.so.1   the loader (extracted)
//   lib/libc.musl-aarch64.so.1 symlink → ld-musl-aarch64.so.1
function muslDir(pkgRoot) {
  return path.join(pkgRoot, 'vendor', 'musl')
}

function loaderPath(pkgRoot) {
  return path.join(muslDir(pkgRoot), 'lib', 'ld-musl-aarch64.so.1')
}

function libDir(pkgRoot) {
  return path.join(muslDir(pkgRoot), 'lib')
}

async function ensureMusl(pkgRoot, muslConfig) {
  const loader = loaderPath(pkgRoot)
  if (fs.existsSync(loader) && fs.statSync(loader).size > 0) {
    return { loader, libDir: libDir(pkgRoot), cached: true }
  }

  fs.mkdirSync(path.join(muslDir(pkgRoot), 'apk'), { recursive: true })
  const apkPath = path.join(muslDir(pkgRoot), 'apk', 'musl.apk')

  const urls = [muslConfig.url, ...(muslConfig.mirrors || [])]
  console.log(`[termux-claude-code] Fetching musl loader from ${muslConfig.url}`)
  await fetchAndVerify(urls, muslConfig.sha256, apkPath)

  // APK is a gzipped tar (with extra signature/index entries our `tar` will warn
  // about and ignore — that's expected). Extract into musl/ root; the APK lays
  // out lib/ld-musl-aarch64.so.1 and the libc symlink under lib/.
  const r = spawnSync(
    'tar',
    ['-xzf', apkPath, '-C', muslDir(pkgRoot), '--exclude=.PKGINFO', '--exclude=.SIGN.*'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  // tar emits warnings to stderr for the APK-TOOLS.checksum.SHA1 ext header.
  // Don't treat those as failures — only check exit code AND that the loader is present.
  if (!fs.existsSync(loader)) {
    throw new Error(
      `musl extraction did not produce ${loader}\n` +
        `tar exit=${r.status}\nstderr: ${r.stderr?.toString() || ''}`,
    )
  }
  fs.chmodSync(loader, 0o755)

  // Some tar versions skip the libc symlink — recreate if missing.
  const libcLink = path.join(libDir(pkgRoot), 'libc.musl-aarch64.so.1')
  if (!fs.existsSync(libcLink)) {
    fs.symlinkSync('ld-musl-aarch64.so.1', libcLink)
  }

  return { loader, libDir: libDir(pkgRoot), cached: false }
}

module.exports = { ensureMusl, muslDir, loaderPath, libDir }
