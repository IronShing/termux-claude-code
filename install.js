#!/usr/bin/env node
'use strict'

// Bootstrap script for termux-claude-code.
//
// Two entry points:
//   1. Postinstall hook (via package.json scripts.postinstall, which spawns us
//      with absolute path to sidestep npm cwd quirks on Termux + github sources).
//   2. First-run bootstrap from bin/claude when vendor/ is incomplete.
//   3. Manual `node install.js [--debug] [--check]` for diagnostics.
//
// What it does:
//   - fetches @anthropic-ai/claude-code-linux-arm64-musl from the npm registry
//     (npm itself won't install it on android because the optional dep declares
//     os:["linux"], so we sideload it ourselves),
//   - fetches the musl libc dynamic loader from Alpine (sha256-pinned),
//   - merges autoUpdates:false into ~/.claude/settings.json,
//   - chmod -R a-w's the upstream binary dir so the in-process auto-updater
//     physically can't overwrite it.
//
// On non-Termux platforms it's a no-op.
//
// Trust roots:
//   - upstream binary:  npm registry HTTPS + dist.shasum (sha1) + dist.integrity (sha512)
//   - musl loader:      pinned sha256 in package.json (Alpine APK)

const fs = require('fs')
const path = require('path')

const PKG_ROOT = __dirname
const CFG = require('./package.json').termuxClaudeCode

const args = process.argv.slice(2)
const DEBUG = args.includes('--debug') || process.env.TERMUX_CLAUDE_CODE_DEBUG === '1'
const CHECK_ONLY = args.includes('--check')

function log(msg) {
  console.log(`[termux-claude-code] ${msg}`)
}
function warn(msg) {
  console.warn(`[termux-claude-code] WARNING: ${msg}`)
}
function debug(msg) {
  if (DEBUG) console.log(`[termux-claude-code:debug] ${msg}`)
}

// Lazy-require so that on a partial install (e.g. lib/ missing) we report a
// useful error from CHECK_ONLY rather than crashing on require time.
function loadModules() {
  return {
    platform: require('./lib/platform'),
    musl: require('./lib/musl'),
    upstream: require('./lib/upstream'),
    lockdown: require('./lib/lockdown'),
    settings: require('./lib/settings'),
    shim: require('./lib/shim'),
  }
}

function check() {
  const m = loadModules()
  const checks = []
  function add(label, fn) {
    try {
      const detail = fn(m)
      checks.push({ ok: true, label, detail })
    } catch (err) {
      checks.push({ ok: false, label, detail: err.message })
    }
  }

  add('Termux detected', () => {
    if (!m.platform.isTermux()) {
      throw new Error(`not Termux (${m.platform.describePlatform()})`)
    }
    return m.platform.describePlatform()
  })

  add('arch is aarch64', () => {
    if (!m.platform.isAarch64()) throw new Error(`arch=${process.arch}`)
    return process.arch
  })

  add('package root resolves', () => {
    if (!fs.existsSync(path.join(PKG_ROOT, 'package.json'))) {
      throw new Error(`no package.json at ${PKG_ROOT}`)
    }
    return PKG_ROOT
  })

  add('node version', () => process.version)

  add('musl loader present', () => {
    const p = m.musl.loaderPath(PKG_ROOT)
    const st = fs.statSync(p)
    return `${p} (${st.size} bytes)`
  })

  add('upstream binary present', () => {
    const p = m.upstream.binaryPath(PKG_ROOT)
    const st = fs.statSync(p)
    return `${p} (${(st.size / 1024 / 1024).toFixed(1)} MB)`
  })

  add('upstream version pin', () => {
    const marker = path.join(path.dirname(m.upstream.binaryPath(PKG_ROOT)), '.version')
    return fs.readFileSync(marker, 'utf8').trim()
  })

  add('settings.json autoUpdates', () => {
    const p = m.settings.settingsPath()
    const s = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (s.autoUpdates !== false) throw new Error('not false')
    return p
  })

  const pad = Math.max(...checks.map((c) => c.label.length))
  let failed = 0
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label.padEnd(pad)}  ${c.detail}`)
    if (!c.ok) failed++
  }
  console.log('')
  if (failed === 0) {
    console.log(`OK  ${checks.length}/${checks.length} checks passed.`)
  } else {
    console.log(`FAIL  ${failed}/${checks.length} checks. Run \`node install.js\` to bootstrap.`)
  }
  process.exit(failed === 0 ? 0 : 1)
}

async function bootstrap() {
  const m = loadModules()

  if (process.env.TERMUX_CLAUDE_CODE_SKIP_POSTINSTALL === '1') {
    log('Skipping bootstrap (TERMUX_CLAUDE_CODE_SKIP_POSTINSTALL=1).')
    return
  }

  debug(`PKG_ROOT=${PKG_ROOT}`)
  debug(`process.platform=${process.platform} process.arch=${process.arch}`)
  debug(`process.env.PREFIX=${process.env.PREFIX || '(unset)'}`)
  debug(`process.cwd()=${process.cwd()}`)

  if (!m.platform.isTermux()) {
    log(
      `Not on Termux (detected ${m.platform.describePlatform()}). ` +
        'No-op — install @anthropic-ai/claude-code directly instead.',
    )
    return
  }

  if (!m.platform.isAarch64()) {
    warn(
      `Termux on ${process.arch}. Only arm64 is supported (Anthropic does ` +
        'not publish a 32-bit arm or x86 native binary). The `claude` command ' +
        'will not work on this device.',
    )
    return
  }

  // Ensure vendor/ exists. On a re-bootstrap we may have a partially-locked
  // tree from a previous run — unlock it before writing.
  const vendorRoot = path.join(PKG_ROOT, 'vendor')
  if (fs.existsSync(vendorRoot)) {
    debug('unlocking previous vendor/ tree before re-bootstrap')
    try {
      m.lockdown.unlock(vendorRoot)
    } catch (err) {
      warn(`unlock of previous vendor/ tree failed: ${err.message} (proceeding)`)
    }
  } else {
    fs.mkdirSync(vendorRoot, { recursive: true })
  }

  const upstreamVersion = CFG.upstreamPin
  log(`Bootstrapping for ${m.platform.describePlatform()}, upstream pinned to ${upstreamVersion}.`)

  // 1. musl loader.
  const musl = await m.musl.ensureMusl(PKG_ROOT, CFG.muslApk)
  log(`musl loader: ${musl.cached ? 'cached' : 'installed'} → ${musl.loader}`)

  // 2. Upstream native binary (~225 MB).
  const upstream = await m.upstream.ensureUpstreamBinary(PKG_ROOT, upstreamVersion)
  log(`upstream binary: ${upstream.cached ? 'cached' : 'installed'} → ${upstream.binary}`)

  // 2a. resolv.conf shim. musl reads /etc/resolv.conf at the literal system
  // path — Termux's read-only /etc has no such file, so DNS fails inside the
  // claude binary unless we LD_PRELOAD a redirector. shim.js writes the
  // vendored etc/ files unconditionally and downloads the .so when CFG.shim
  // is configured; if CFG.shim is missing we still write the etc/ files so
  // the bin/claude shim can warn intelligently.
  if (CFG.shim && CFG.shim.url) {
    try {
      const shim = await m.shim.ensureShim(PKG_ROOT, CFG.shim)
      log(`resolv shim: ${shim.cached ? 'cached' : 'installed'} → ${shim.shim}`)
    } catch (err) {
      warn(`resolv shim install failed: ${err.message}`)
      warn('  DNS may fail with ECONNREFUSED — the binary still launches.')
      m.shim.writeEtcFiles(PKG_ROOT) // at least populate etc/ for a future retry
    }
  } else {
    m.shim.writeEtcFiles(PKG_ROOT)
    warn('No resolv shim URL in package.json — DNS workaround will not be active.')
    warn('  Build manually: cd shim && aarch64-linux-musl-gcc -shared -fPIC -O2 \\')
    warn('    -o ../vendor/shim/libtcc-resolv-redirect.so resolv-redirect.c -ldl')
  }

  // Defensive verification — never assume the previous step's output is intact.
  const finalLoader = m.musl.loaderPath(PKG_ROOT)
  const finalBinary = m.upstream.binaryPath(PKG_ROOT)
  if (!fs.existsSync(finalLoader)) {
    throw new Error(`musl loader missing after install: ${finalLoader}`)
  }
  if (!fs.existsSync(finalBinary)) {
    throw new Error(`upstream binary missing after install: ${finalBinary}`)
  }
  if (fs.statSync(finalBinary).size < 50_000_000) {
    throw new Error(
      `upstream binary suspiciously small (${fs.statSync(finalBinary).size} bytes). ` +
        'Likely a partial download — re-run install.',
    )
  }
  debug(`final loader OK: ${finalLoader}`)
  debug(`final binary OK: ${finalBinary} (${fs.statSync(finalBinary).size} bytes)`)

  // 3. Disable in-process auto-updater via settings.json.
  const settingsResult = m.settings.applyAutoUpdaterDisable()
  if (settingsResult.ok) {
    log(`autoUpdates=false written to ${settingsResult.path}`)
  } else {
    warn(settingsResult.message)
  }

  // 4. Lockdown vendor/upstream-musl/ — defense in depth against the updater.
  try {
    m.lockdown.lockdown(m.upstream.vendorDir(PKG_ROOT))
    log('locked vendor/upstream-musl (defense against in-process updater)')
  } catch (err) {
    warn(`lockdown failed: ${err.message} (continuing — your install still works)`)
  }

  log('')
  log('Setup complete. Run `claude --version` to verify.')
  log('Pinned upstream version: ' + upstreamVersion)
  log('Settings file: ' + m.settings.settingsPath())
  log('')
  log('Security note: this wrapper is community-maintained. Anthropic does')
  log('not endorse it. Repo trust still applies — review .claude/settings.json,')
  log('.mcp.json, and apiKeyHelper before running `claude` in unfamiliar repos.')
}

if (require.main === module) {
  if (CHECK_ONLY) {
    check()
  } else {
    bootstrap().catch((err) => {
      console.error('[termux-claude-code] bootstrap failed:')
      console.error('  ' + (err.stack || err.message))
      console.error('')
      console.error('  For more detail, re-run with --debug:')
      console.error('    node ' + __filename + ' --debug')
      console.error('  For a state report:')
      console.error('    node ' + __filename + ' --check')
      process.exit(1)
    })
  }
}

module.exports = { bootstrap, check, PKG_ROOT }
