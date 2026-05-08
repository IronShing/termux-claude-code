'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

// Merge our required keys into ~/.claude/settings.json without clobbering
// anything the user has set. We only touch:
//   autoUpdates       (false)  — disables the in-process updater
//   env.DISABLE_AUTOUPDATER ("1") — second-layer defense; some upstream code
//                                   paths read the env directly
function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return {}
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null // signal: file exists but is malformed; caller decides
  }
}

function applyAutoUpdaterDisable() {
  const p = settingsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const existing = readJsonSafe(p)
  if (existing === null) {
    // Don't blow away malformed user settings — write a sibling and instruct.
    const sidecar = p + '.termux-claude-code.json'
    fs.writeFileSync(
      sidecar,
      JSON.stringify({ autoUpdates: false, env: { DISABLE_AUTOUPDATER: '1' } }, null, 2),
    )
    return {
      ok: false,
      reason: 'malformed-existing',
      sidecar,
      message:
        `Could not parse existing ${p}. Wrote required keys to ${sidecar} — ` +
        'please merge them manually.',
    }
  }
  const next = { ...existing }
  next.autoUpdates = false
  next.env = { ...(next.env || {}), DISABLE_AUTOUPDATER: '1' }
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n')
  return { ok: true, path: p }
}

module.exports = { applyAutoUpdaterDisable, settingsPath }
