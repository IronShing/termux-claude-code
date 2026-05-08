'use strict'

const fs = require('fs')
const path = require('path')

// Remove write permission from individual files under the upstream binary
// directory so naive in-place overwrites by the in-process auto-updater fail.
//
// We deliberately do NOT chmod directories. Earlier versions did, but on
// Termux with `npm install -g github:...`, postinstall runs inside an npm
// tmp dir (e.g. _cacache/tmp/git-cloneXXX). Read-only dirs there blocked
// npm's later cleanup with EACCES. The primary auto-updater defenses are
// still env DISABLE_AUTOUPDATER=1 and ~/.claude/settings.json autoUpdates:false;
// file-level chmod is layer 3 hardening only.
function lockdown(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue // chmod follows; lchmod isn't portable
    if (entry.isDirectory()) {
      lockdown(full)
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full)
        const mode = (st.mode & 0o7777) & ~0o222 // drop u+w, g+w, o+w
        fs.chmodSync(full, mode)
      } catch {}
    }
  }
}

function unlock(dir) {
  // Used by the upgrade flow to undo lockdown before npm re-installs.
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
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
