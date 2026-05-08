'use strict'

const fs = require('fs')
const path = require('path')

// Recursively remove write permission. We do this on the upstream binary
// directory so the in-process auto-updater (which silently re-fetches `latest`
// on first run otherwise) physically cannot rewrite files. Two layers we don't
// own already enforced via env (DISABLE_AUTOUPDATER=1) and ~/.claude/settings.json
// (autoUpdates: false). This is layer three: defense in depth, since a bug in
// one of the other layers could let the updater win.
function lockdown(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue // chmod follows; lchmod isn't portable
    if (entry.isDirectory()) {
      lockdown(full)
      try { fs.chmodSync(full, 0o555) } catch {}
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full)
        const mode = (st.mode & 0o7777) & ~0o222 // drop u+w, g+w, o+w
        fs.chmodSync(full, mode)
      } catch {}
    }
  }
  try { fs.chmodSync(dir, 0o555) } catch {}
}

function unlock(dir) {
  // Used by the upgrade flow to undo lockdown before npm re-installs.
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  try { fs.chmodSync(dir, 0o755) } catch {}
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      try { fs.chmodSync(full, 0o755) } catch {}
      unlock(full)
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full)
        fs.chmodSync(full, (st.mode & 0o7777) | 0o200)
      } catch {}
    }
  }
}

module.exports = { lockdown, unlock }
