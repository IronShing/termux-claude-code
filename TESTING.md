# Termux on-device test plan

This is the sequence to run on the target Android device after publishing to GitHub but **before** publishing to npm. The goal: validate the musl-loader-on-Bionic approach end-to-end and shake out any device-specific issues.

## Prereqs

- Termux from F-Droid (NOT the Play Store version — Play Store Termux is years out of date).
- Network. The install pulls ~225 MB.
- ~500 MB free in `$PREFIX` (binary + extraction + node_modules).

## Test sequence

```sh
# 1. Base packages.
pkg update -y
pkg install -y nodejs git tar coreutils

# Confirm versions are sane.
node --version            # expect: v18.x or higher
npm --version             # expect: any
which tar                 # expect: $PREFIX/bin/tar
uname -m                  # expect: aarch64

# 2. Install directly from GitHub (no npm publish needed for this test).
npm install -g github:IronShing/termux-claude-code

# Expected install output (key lines):
#   [termux-claude-code] Bootstrapping for android/arm64 (Termux=true), upstream pinned to 2.1.133.
#   [termux-claude-code] Fetching musl loader from https://dl-cdn.alpinelinux.org/...
#   [termux-claude-code] musl loader: installed → .../vendor/musl/lib/ld-musl-aarch64.so.1
#   [termux-claude-code] Resolving @anthropic-ai/claude-code-linux-arm64-musl@2.1.133 from npm registry
#   [termux-claude-code] upstream binary: installed → .../vendor/upstream-musl/claude
#   [termux-claude-code] autoUpdates=false written to /data/.../settings.json
#   [termux-claude-code] locked down vendor/upstream-musl ...
#   [termux-claude-code] Setup complete. ...
#
# An EBADPLATFORM warning above this is expected — npm refusing the optional
# dep is exactly why this wrapper exists.

# 3. Sanity-check the install.
claude doctor

# Expected: nine PASS lines and "OK  9/9 checks passed."
# If "claude binary executes" fails — that's the critical unknown. See below.

# 4. End-to-end smoke.
claude --version          # expect: a version string ending in 2.1.133

mkdir -p ~/cc-test && cd ~/cc-test
echo 'console.log("hello")' > test.js
claude -p "what does test.js print?"   # expect: a model response mentioning "hello"

# 5. Auto-updater is off.
grep -E '"autoUpdates"|"DISABLE_AUTOUPDATER"' ~/.claude/settings.json
# Expected:
#   "autoUpdates": false,
#   "DISABLE_AUTOUPDATER": "1"

# 6. Lockdown is in place.
ls -ld $(npm root -g)/termux-claude-code/vendor/upstream-musl
# Expected: dr-xr-xr-x (mode 555)

# 7. Cleanup.
npm uninstall -g termux-claude-code  # if EPERM, see uninstall section in README
```

## Failure-mode flowchart

If `claude --version` fails, run through these in order — each rules out a specific layer:

```
claude --version FAILS
│
├── error: "musl loader missing"
│   → postinstall didn't run. Either --ignore-scripts was set, or postinstall
│     errored and printed above. Re-run:
│       cd $(npm root -g)/termux-claude-code && node install.js
│
├── error: "upstream binary missing"
│   → Same as above. Likely a transient HTTPS error during the 220 MB fetch.
│     Check `npm config get registry` is reachable.
│
├── error: "Bad system call" / SIGSYS / segfault
│   → Bionic kernel doesn't allow some syscall musl is making. Check:
│       getprop ro.build.version.sdk    (should be ≥ 24, ideally ≥ 30)
│     If you're on Android < 7, the wrapper can't help.
│
├── error: "Could not find a PHDR" / "broken executable"
│   → musl loader rejecting Bun's PHDR layout. This is the failure mode #50270
│     reported with glibc's loader; if it ALSO happens with musl's loader, the
│     project is blocked on Anthropic shipping a target we can use.
│     If you see this — please open an issue with full output of:
│       file $(npm root -g)/termux-claude-code/vendor/upstream-musl/claude
│       readelf -l $(npm root -g)/termux-claude-code/vendor/upstream-musl/claude | head -40
│
├── hangs forever
│   → Probably a TTY / repo-trust prompt issue. Try:
│       script -q /dev/null claude --version
│
└── error: "EBADPLATFORM" during install (NOT during run)
    → Cosmetic. The wrapper is designed for this warning. The install should
      have continued and the postinstall should have done the work.
```

## What "success" means for this test

The minimum bar to call this project working:

- `claude doctor` reports 9/9 passes
- `claude --version` returns the pinned version string in under 5 seconds
- One simple `claude -p` query gets a real model response

If those three pass, the wrapper achieves its goal. Edge cases (specific `/`-commands, MCP servers, large contexts) can be filed as follow-ups.
