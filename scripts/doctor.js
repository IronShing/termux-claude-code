#!/usr/bin/env node
'use strict'

// `npm run doctor` — sanity-check installation. Prints a one-line OK/FAIL per
// thing we care about, then a final summary. No external deps.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')
const { isTermux, describePlatform, isAarch64 } = require('../lib/platform')
const { loaderPath, libDir } = require('../lib/musl')
const { binaryPath } = require('../lib/upstream')
const { settingsPath } = require('../lib/settings')

const PKG_ROOT = path.resolve(__dirname, '..')
const CFG = require('../package.json').termuxClaudeCode

const results = []
function check(label, fn) {
  try {
    const detail = fn()
    results.push({ ok: true, label, detail })
  } catch (err) {
    results.push({ ok: false, label, detail: err.message })
  }
}

check('platform is Termux', () => {
  if (!isTermux()) throw new Error(`detected ${describePlatform()}, not Termux`)
  return describePlatform()
})

check('arch is aarch64', () => {
  if (!isAarch64()) throw new Error(`detected ${process.arch}`)
  return process.arch
})

check('musl loader present', () => {
  const p = loaderPath(PKG_ROOT)
  const st = fs.statSync(p)
  if (!st.isFile()) throw new Error('not a file')
  if ((st.mode & 0o111) === 0) throw new Error('not executable')
  return `${p} (${st.size} bytes)`
})

check('musl libc symlink present', () => {
  const p = path.join(libDir(PKG_ROOT), 'libc.musl-aarch64.so.1')
  const st = fs.lstatSync(p)
  if (!st.isSymbolicLink() && !st.isFile()) throw new Error('missing')
  return p
})

check('upstream binary present', () => {
  const p = binaryPath(PKG_ROOT)
  const st = fs.statSync(p)
  if (!st.isFile()) throw new Error('not a file')
  if ((st.mode & 0o111) === 0) throw new Error('not executable')
  if (st.size < 50_000_000) throw new Error(`suspiciously small: ${st.size}`)
  return `${p} (${(st.size / 1024 / 1024).toFixed(1)} MB)`
})

check('upstream version pin matches package.json', () => {
  const marker = path.join(path.dirname(binaryPath(PKG_ROOT)), '.version')
  const installed = fs.readFileSync(marker, 'utf8').trim()
  if (installed !== CFG.upstreamPin) {
    throw new Error(`installed=${installed} pinned=${CFG.upstreamPin} — re-run npm install`)
  }
  return installed
})

check('upstream binary is read-only (lockdown)', () => {
  const p = binaryPath(PKG_ROOT)
  const st = fs.statSync(p)
  if ((st.mode & 0o222) !== 0) throw new Error(`writable mode=${(st.mode & 0o7777).toString(8)}`)
  return `mode=${(st.mode & 0o7777).toString(8)}`
})

check('settings.json autoUpdates is false', () => {
  const p = settingsPath()
  if (!fs.existsSync(p)) throw new Error(`missing ${p}`)
  const s = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (s.autoUpdates !== false) throw new Error('autoUpdates is not false')
  if (s.env?.DISABLE_AUTOUPDATER !== '1') throw new Error('env.DISABLE_AUTOUPDATER is not "1"')
  return p
})

check('claude binary executes (--version)', () => {
  const shim = path.join(PKG_ROOT, 'bin', 'claude')
  const r = spawnSync(shim, ['--version'], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) {
    throw new Error(`exit=${r.status}\nstderr: ${(r.stderr || '').slice(0, 400)}`)
  }
  return (r.stdout || '').trim().split('\n')[0]
})

const pad = Math.max(...results.map((r) => r.label.length))
let failed = 0
for (const r of results) {
  const icon = r.ok ? 'PASS' : 'FAIL'
  console.log(`${icon}  ${r.label.padEnd(pad)}  ${r.detail}`)
  if (!r.ok) failed++
}
console.log('')
if (failed === 0) {
  console.log(`OK  ${results.length}/${results.length} checks passed.`)
} else {
  console.log(`FAIL  ${failed}/${results.length} checks failed. See README troubleshooting matrix.`)
  process.exit(1)
}
