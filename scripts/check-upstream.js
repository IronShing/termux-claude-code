#!/usr/bin/env node
'use strict'

// `npm run check-upstream` — used by .github/workflows/upstream-bump.yml.
//
// Decides what to bump the upstream pin to. Strategy:
//   target = max(latest, stable, currentPin)   (semver-aware)
//   if target === currentPin: UP_TO_DATE
//   else: BUMP <target>
//
// We never downgrade — if a maintainer manually advanced the pin past stable,
// the bot won't roll it back. We prefer max(latest, stable) so we get Anthropic's
// most recently published version regardless of which tag is ahead.
//
// Exits 0 on success (workflow inspects stdout). Exits 1 only on transient
// HTTP failures so CI flakes can be retried.

const { fetchJson } = require('../lib/fetch')

const PKG = '@anthropic-ai/claude-code'
const PINNED = require('../package.json').termuxClaudeCode.upstreamPin

// Tiny semver compare. Handles "X.Y.Z" only — no prerelease, no build meta.
// Anthropic uses plain X.Y.Z for claude-code so we don't need full semver.
function cmp(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function maxVersion(...versions) {
  return versions.filter(Boolean).reduce((a, b) => (cmp(a, b) >= 0 ? a : b))
}

async function main() {
  const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(PKG)}`)
  const tags = meta['dist-tags'] || {}
  const target = maxVersion(tags.latest, tags.stable, PINNED)
  if (!target || target === PINNED) {
    console.log(`UP_TO_DATE ${PINNED}`)
    return
  }
  console.log(`BUMP ${target}`)
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exit(1)
})
