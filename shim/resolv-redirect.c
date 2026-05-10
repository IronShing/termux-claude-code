/*
 * termux-claude-code: musl /etc/resolv.conf redirect shim
 *
 * Compiled against musl libc, loaded via LD_PRELOAD into the upstream
 * claude binary by bin/claude. Intercepts open()/openat()/fopen()/fopen64()
 * for hardcoded /etc/ paths and redirects them to writable copies under
 * $TERMUX_CLAUDE_CODE_ETC.
 *
 * Why this exists: on Termux/Android the system /etc/ partition is read-only
 * and /etc/resolv.conf does not exist. musl's resolver hardcodes that path,
 * so when our musl-loaded process tries DNS it gets nothing, falls back to
 * 127.0.0.1:53 (no listener), and Bun reports the resulting refused TCP RST
 * as ECONNREFUSED on the API host. Bionic-linked Termux tools don't hit
 * this because Termux's libc reads $PREFIX/etc/ instead of /etc/.
 *
 * We intercept exactly two paths:
 *   /etc/resolv.conf  -> $TERMUX_CLAUDE_CODE_ETC/resolv.conf
 *   /etc/hosts        -> $TERMUX_CLAUDE_CODE_ETC/hosts
 *
 * No other paths are touched. If the env var is unset the shim is a no-op.
 *
 * Diagnostics: set TERMUX_CLAUDE_CODE_SHIM_DEBUG=1 to log shim load + every
 * intercepted call (including the requested path) to stderr. Use this to
 * verify LD_PRELOAD took effect and to see what paths the host process
 * actually opens.
 *
 * Build: aarch64-linux-musl-gcc -shared -fPIC -O2 -o libtcc-resolv-redirect.so resolv-redirect.c -ldl
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static const char *ETC_RESOLV = "/etc/resolv.conf";
static const char *ETC_HOSTS  = "/etc/hosts";

static int debug_enabled(void) {
	const char *v = getenv("TERMUX_CLAUDE_CODE_SHIM_DEBUG");
	return v != NULL && *v == '1';
}

static void debug_log(const char *fn, const char *path, const char *redir) {
	if (!debug_enabled()) return;
	char line[8192];
	int n;
	if (redir != NULL) {
		n = snprintf(line, sizeof(line),
			"[shim:%d] %s(\"%s\") -> \"%s\"\n",
			(int) getpid(), fn, path ? path : "(null)", redir);
	} else {
		n = snprintf(line, sizeof(line),
			"[shim:%d] %s(\"%s\")\n",
			(int) getpid(), fn, path ? path : "(null)");
	}
	if (n > 0) (void) write(2, line, (size_t) n);
}

__attribute__((constructor))
static void shim_init(void) {
	if (!debug_enabled()) return;
	const char *root = getenv("TERMUX_CLAUDE_CODE_ETC");
	char line[4096];
	int n = snprintf(line, sizeof(line),
		"[shim:%d] loaded; TERMUX_CLAUDE_CODE_ETC=%s\n",
		(int) getpid(), root ? root : "(unset)");
	if (n > 0) (void) write(2, line, (size_t) n);
}

/* Resolve to a buffer the caller owns. Returns the original path if no
 * redirect applies, or a pointer into out_buf if redirected. */
static const char *
maybe_redirect(const char *path, char *out_buf, size_t out_sz)
{
	if (path == NULL) return path;
	const char *root = getenv("TERMUX_CLAUDE_CODE_ETC");
	if (root == NULL || *root == '\0') return path;

	const char *suffix = NULL;
	if (strcmp(path, ETC_RESOLV) == 0) suffix = "resolv.conf";
	else if (strcmp(path, ETC_HOSTS) == 0) suffix = "hosts";
	else return path;

	int n = snprintf(out_buf, out_sz, "%s/%s", root, suffix);
	if (n < 0 || (size_t)n >= out_sz) return path;
	return out_buf;
}

typedef int (*open_fn)(const char *, int, ...);
typedef int (*openat_fn)(int, const char *, int, ...);
typedef FILE *(*fopen_fn)(const char *, const char *);

int
open(const char *path, int flags, ...)
{
	static open_fn real = NULL;
	if (real == NULL) real = (open_fn) dlsym(RTLD_NEXT, "open");

	mode_t mode = 0;
	if (flags & O_CREAT) {
		va_list ap;
		va_start(ap, flags);
		mode = (mode_t) va_arg(ap, int);
		va_end(ap);
	}

	char buf[4096];
	const char *p = maybe_redirect(path, buf, sizeof(buf));
	debug_log("open", path, p == path ? NULL : p);
	return real(p, flags, mode);
}

int
openat(int dirfd, const char *path, int flags, ...)
{
	static openat_fn real = NULL;
	if (real == NULL) real = (openat_fn) dlsym(RTLD_NEXT, "openat");

	mode_t mode = 0;
	if (flags & O_CREAT) {
		va_list ap;
		va_start(ap, flags);
		mode = (mode_t) va_arg(ap, int);
		va_end(ap);
	}

	char buf[4096];
	const char *p = maybe_redirect(path, buf, sizeof(buf));
	debug_log("openat", path, p == path ? NULL : p);
	return real(dirfd, p, flags, mode);
}

FILE *
fopen(const char *path, const char *mode)
{
	static fopen_fn real = NULL;
	if (real == NULL) real = (fopen_fn) dlsym(RTLD_NEXT, "fopen");

	char buf[4096];
	const char *p = maybe_redirect(path, buf, sizeof(buf));
	debug_log("fopen", path, p == path ? NULL : p);
	return real(p, mode);
}

/* fopen64 is a glibc-ism; musl aliases fopen to fopen64 internally but some
 * binaries (Bun-compiled JS engines included) emit explicit fopen64 calls.
 * We provide both for safety. */
FILE *
fopen64(const char *path, const char *mode)
{
	static fopen_fn real = NULL;
	if (real == NULL) {
		real = (fopen_fn) dlsym(RTLD_NEXT, "fopen64");
		if (real == NULL) real = (fopen_fn) dlsym(RTLD_NEXT, "fopen");
	}

	char buf[4096];
	const char *p = maybe_redirect(path, buf, sizeof(buf));
	debug_log("fopen64", path, p == path ? NULL : p);
	return real(p, mode);
}
