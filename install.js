#!/usr/bin/env node
'use strict'

// Postinstall for termux-claude-code.
// Runs after `npm install`. Fetches the upstream linux-arm64-musl native
// binary (which npm itself will not install on android because the optional
// dep declares os:["linux"]), fetches the musl libc loader from Alpine,
// disables the in-process auto-updater, and locks the upstream binary dir
// against the auto-updater. On non-Termux platforms it's a no-op.
//
// Trust roots:
//   - upstream binary:  npm registry HTTPS + dist.shasum + dist.integrity
//   - musl loader:      pinned sha256 in package.json (Alpine APK)

const fs = require('fs')
const path = require('path')
const { isTermux, isAarch64, describePlatform } = require('./lib/platform')
const { ensureMusl, loaderPath, libDir } = require('./lib/musl')
const { ensureUpstreamBinary, vendorDir, binaryPath } = require('./lib/upstream')
const { lockdown } = require('./lib/lockdown')
const { applyAutoUpdaterDisable, settingsPath } = require('./lib/settings')

const PKG_ROOT = __dirname
const CFG = require('./package.json').termuxClaudeCode

function log(msg) {
  console.log(`[termux-claude-code] ${msg}`)
}

function warn(msg) {
  console.warn(`[termux-claude-code] WARNING: ${msg}`)
}

async function main() {
  if (process.env.TERMUX_CLAUDE_CODE_SKIP_POSTINSTALL === '1') {
    log('Skipping postinstall (TERMUX_CLAUDE_CODE_SKIP_POSTINSTALL=1).')
    return
  }

  if (!isTermux()) {
    log(
      `Not on Termux (detected ${describePlatform()}). ` +
        'This wrapper is a no-op on non-Termux platforms — install ' +
        '@anthropic-ai/claude-code directly instead.',
    )
    return
  }

  if (!isAarch64()) {
    warn(
      `Detected Termux on ${process.arch}. Only arm64 is supported (Anthropic ` +
        'does not publish a 32-bit arm or x86 native binary). The `claude` ' +
        'command will not work.',
    )
    return
  }

  const upstreamVersion = CFG.upstreamPin
  log(`Bootstrapping for ${describePlatform()}, upstream pinned to ${upstreamVersion}.`)

  // 1. musl loader — small (~600KB), fetched from Alpine, sha256-pinned.
  const musl = await ensureMusl(PKG_ROOT, CFG.muslApk)
  log(`musl loader: ${musl.cached ? 'cached' : 'installed'} → ${musl.loader}`)

  // 2. Upstream native binary — large (~220MB), fetched from npm registry,
  //    integrity verified against the registry's published shasum/integrity.
  const upstream = await ensureUpstreamBinary(PKG_ROOT, upstreamVersion)
  log(
    `upstream binary: ${upstream.cached ? 'cached' : 'installed'} → ${upstream.binary}`,
  )

  // 3. Disable the in-process auto-updater via the user's settings.json.
  //    Without this layer the updater silently re-fetches `latest` on first
  //    run, defeating our version pin.
  const settingsResult = applyAutoUpdaterDisable()
  if (settingsResult.ok) {
    log(`autoUpdates=false written to ${settingsResult.path}`)
  } else {
    warn(settingsResult.message)
  }

  // 4. Filesystem lockdown of the upstream binary dir. If layers 1+2 (env
  //    DISABLE_AUTOUPDATER + settings.json autoUpdates:false) are bypassed by
  //    a future upstream change, an attempt to overwrite the binary will fail
  //    EPERM at the filesystem layer. To upgrade, the user runs `npm install
  //    -g termux-claude-code@latest` which triggers our postinstall again
  //    (which unlocks-then-relocks).
  try {
    // The upstream optional dep itself is in node_modules; its parent path is
    // resolvable at install time. But we already vendored a copy under our own
    // tree at vendor/upstream-musl, which is what bin/claude actually executes.
    // Lock that.
    lockdown(vendorDir(PKG_ROOT))
    log('locked down vendor/upstream-musl (defense against in-process updater)')
  } catch (err) {
    warn(`lockdown failed: ${err.message}`)
  }

  log('')
  log('Setup complete. Run `claude --version` to verify, then `claude doctor`.')
  log('Pinned upstream version: ' + upstreamVersion)
  log('Settings file: ' + settingsPath())
  log('')
  log('Security note: this wrapper is community-maintained. Anthropic does not')
  log('endorse it. Review repo trust before pasting `claude` into a workspace ')
  log('with untrusted .claude/settings.json or .mcp.json — the upstream is')
  log('still vulnerable to repo-trust class issues. See README.')
}

main().catch((err) => {
  console.error('[termux-claude-code] postinstall failed:')
  console.error('  ' + (err.stack || err.message))
  process.exit(1)
})
