# termux-claude-code

Run the latest **security-patched** version of [`@anthropic-ai/claude-code`](https://www.npmjs.com/package/@anthropic-ai/claude-code) on Termux (Android, aarch64).

> **Community-maintained. Not affiliated with, endorsed by, or sponsored by Anthropic.** This wrapper exists because the previous community wrapper (`Ishabdullah/claude-code-termux`) only works on Claude Code ≤ 2.1.112 — versions that ship without fixes for **CVE-2026-35020 / 35021 / 35022** (the command-injection chain) and the **TrustFall** one-click RCE via `.mcp.json`. See [anthropics/claude-code#50270](https://github.com/anthropics/claude-code/issues/50270) for upstream context.

## What this does

`@anthropic-ai/claude-code` ≥ 2.1.113 ships as a Bun-compiled native binary, fanned out via per-platform optional npm deps (`-linux-arm64`, `-linux-arm64-musl`, etc.). On Termux:

- `process.platform === 'android'`, which the upstream `install.cjs`'s platform map doesn't recognise → no binary is placed → `claude` is broken.
- The published `linux-arm64-musl` variant is **dynamically linked** to `/lib/ld-musl-aarch64.so.1` — Anthropic does not ship a static-musl variant — so dropping it onto Bionic alone won't run.

This wrapper:

1. Pins a known-good upstream version in our `package.json` (auto-bumped weekly via PR).
2. At install time, fetches the upstream `linux-arm64-musl` binary directly from the npm registry (with sha1 + sha512 verification against the registry's own metadata) — bypassing npm's `os: ["linux"]` filter that would otherwise skip it on Android.
3. Fetches the `musl` libc dynamic loader from Alpine Linux's CDN (sha256-pinned in `package.json`).
4. Installs a `claude` shim that runs the binary via the bundled musl loader: no `patchelf`, no system-path writes, no root.
5. Sets `autoUpdates: false` in `~/.claude/settings.json`, exports `DISABLE_AUTOUPDATER=1` from the shim, and `chmod a-w`'s the upstream binary file — three layers of defense against the in-process auto-updater silently re-fetching `latest` and clobbering our pin.

**Resilient bootstrap.** Postinstall on Termux can be flaky (npm spawn-shell quirks with github sources, cwd resolution issues, etc). To survive that:

- Postinstall runs install logic via absolute paths (no reliance on cwd) and is best-effort — even if it fails, `npm install` reports success.
- The `claude` shim itself detects an incomplete `vendor/` directory and runs the bootstrap inline on first invocation. Subsequent runs are zero-overhead.
- **We do not depend on `@anthropic-ai/claude-code` as an npm dependency.** Doing so would chain-trigger upstream's own postinstall, which fails on Termux with `spawn sh ENOENT` (Termux has no `/bin/sh`). Instead we sideload the binary directly from the npm registry, sidestepping the failure entirely.

## Install (Termux)

```sh
pkg update && pkg install nodejs git tar
npm install -g termux-claude-code
claude --version
claude doctor   # if --version works, this should also work
```

The `npm install -g` step fetches ~225 MB (the upstream native binary) plus ~600 KB of musl libc. Allow 1–2 minutes on a slow connection.

If `npm install` warns about `EBADPLATFORM`, you can ignore it — the wrapper is designed for that warning and the actual binary is fetched out-of-band by the postinstall.

### Verify (after install)

```sh
claude doctor
```

Expected output (last line): `OK  9/9 checks passed.`

If a check fails, see **Troubleshooting** below.

## Security caveats — please read

This wrapper closes one specific gap (the post-2.1.113 Termux regression), **not** the full set of risks of running an agentic CLI on a personal Android device:

- **Repo trust still applies.** When you `cd` into a repo and start `claude`, the upstream binary still reads `.claude/settings.json`, `.mcp.json`, and any `apiKeyHelper` configured at user or project scope. Treat every cloned repo as untrusted by default. (Background: TrustFall / one-click RCE class — Anthropic patched the in-binary handling in ≥ 2.1.113, but the threat model is fundamentally social.)
- **The npm install path is privileged.** `postinstall` runs arbitrary code from us, from `@anthropic-ai/claude-code`, and from any transitive deps. Read `install.js` in this repo before installing if that matters to you. We have no transitive deps.
- **The musl libc we fetch is not GPG-verified** — it's pinned to a specific Alpine APK by sha256, fetched over HTTPS. The trust root is sha256 + TLS, not Alpine's signing key. (Listed under Stretch goals in the issue tracker.)
- **The auto-updater is hard-disabled.** This means you do **not** get upstream security fixes automatically. Bumps land via our weekly PR cron. If you want immediate fixes, watch [our releases](https://github.com/IronShing/termux-claude-code/releases) or run `npm install -g termux-claude-code@latest` manually.

## Upgrading

The auto-updater is disabled and the upstream binary directory is read-only, so **you upgrade by reinstalling the wrapper:**

```sh
npm install -g termux-claude-code@latest
```

Postinstall unlocks, refetches, and re-locks. Idempotent.

## Uninstall

```sh
npm uninstall -g termux-claude-code
# Optional cleanup:
rm -f ~/.claude/settings.json   # only if you don't have other Claude configs you want to keep
```

If `npm uninstall` fails with EPERM, that's the lockdown — flip permissions first:

```sh
chmod -R u+w "$(npm root -g)/termux-claude-code/vendor"
npm uninstall -g termux-claude-code
```

## Troubleshooting

When in doubt, run `node $(npm root -g)/termux-claude-code/install.js --check` for a status report, or `--debug` to re-bootstrap with verbose output.

| Symptom | Likely cause | Fix |
|---|---|---|
| `claude: command not found` | npm global bin not on `$PATH` | `echo 'export PATH=$PATH:$(npm config get prefix)/bin' >> ~/.bashrc && source ~/.bashrc` |
| `[termux-claude-code] First-run bootstrap…` on first `claude` invocation | Postinstall didn't complete; shim is recovering. Expected behaviour. | Wait — it downloads ~225 MB once. Subsequent runs are instant. |
| `[termux-claude-code] Bootstrap failed.` | Network / Alpine CDN hiccup, transient HTTPS error, or corrupt download | Re-run: `node $(npm root -g)/termux-claude-code/install.js --debug` |
| `claude --version` hangs / never returns | musl loader / Bionic kernel mismatch (the unproven failure mode) | Run `claude doctor`. If "claude binary executes" fails, paste full `--check` output to a new issue. |
| `doctor: settings.json autoUpdates is false: missing` | Manual edit removed it | Re-run install or set manually in `~/.claude/settings.json` |
| `doctor: upstream binary is read-only (lockdown): writable` | Lockdown failed during postinstall (non-fatal) | `chmod a-w $(npm root -g)/termux-claude-code/vendor/upstream-musl/claude` |
| `EBADPLATFORM` warning on install | Cosmetic — npm noticing the os filter | Safe to ignore. The wrapper sideloads the binary out-of-band. |
| `claude` works but pasting into a new dir hangs | Repo-trust prompt — upstream waits on TTY | Make sure you have a real TTY; `script -q /dev/null claude` if running under a wrapped shell |
| `npm error spawn sh ENOENT` during install | Should not happen — we removed the upstream dep precisely to avoid this. If you see it, please file an issue. | Workaround: `npm config set script-shell $PREFIX/bin/sh && npm install -g termux-claude-code` |

## How it works (technical)

`bin/claude` is a static shell shim. It runs:

```sh
$PKG_ROOT/vendor/musl/lib/ld-musl-aarch64.so.1 \
  --library-path $PKG_ROOT/vendor/musl/lib \
  $PKG_ROOT/vendor/upstream-musl/claude "$@"
```

Bionic's kernel is a regular Linux kernel — the syscall ABI matches musl's expectations. The musl dynamic loader, once invoked, brings up musl's userspace and the Bun-compiled binary runs the same way it would on Alpine. We never touch `/lib`, never need `patchelf`, never need `proot`. The only platform-specific risk is whether the musl loader and Bun's runtime happen to disagree on something subtle (TLS layout, signal handling) — that's the unknown that on-device testing exists to surface.

The ~225 MB upstream binary is **not** vendored in our npm tarball. Our tarball ships under 100 KB (mostly README) — it's all install-time code that pulls from the npm registry.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

If `claude doctor` fails on your device, please open an issue with the full output of:

```sh
claude doctor
uname -a
echo $PREFIX
node --version
```

The single thing this project most needs is on-device validation of the musl-loader-on-Bionic approach. Reports either way are valuable.
