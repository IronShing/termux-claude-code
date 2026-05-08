'use strict'

const fs = require('fs')

function isTermux() {
  if (process.platform === 'android') return true
  const prefix = process.env.PREFIX
  if (prefix && prefix.includes('com.termux')) return true
  // Last-ditch: directory check, in case PREFIX was unset by a wrapper.
  try {
    fs.accessSync('/data/data/com.termux/files/usr', fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function termuxPrefix() {
  return process.env.PREFIX || '/data/data/com.termux/files/usr'
}

function isAarch64() {
  return process.arch === 'arm64'
}

function describePlatform() {
  return `${process.platform}/${process.arch} (Termux=${isTermux()})`
}

module.exports = { isTermux, termuxPrefix, isAarch64, describePlatform }
