#!/bin/sh
set -e

REPO="yorch/ccpod"
BINARY="ccpod"

# ── Platform detection ────────────────────────────────────────────────────────

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin|linux) ;;
  *)
    echo "error: unsupported OS: $OS" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64)        ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "error: unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ASSET="${BINARY}-${OS}-${ARCH}"

# ── Version resolution ────────────────────────────────────────────────────────

if [ -n "${CCPOD_VERSION:-}" ]; then
  TAG="$CCPOD_VERSION"
else
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
  if [ -z "$TAG" ]; then
    echo "error: could not determine latest release tag" >&2
    exit 1
  fi
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"

# ── Install destination ───────────────────────────────────────────────────────

if [ -n "${CCPOD_INSTALL_DIR:-}" ]; then
  INSTALL_DIR="$CCPOD_INSTALL_DIR"
elif [ -w "/usr/local/bin" ]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

mkdir -p "$INSTALL_DIR"
INSTALL_PATH="${INSTALL_DIR}/${BINARY}"

# ── Download and install ──────────────────────────────────────────────────────

echo "Downloading ccpod ${TAG} (${OS}/${ARCH})..."

TMP_PATH="${INSTALL_PATH}.tmp.$$"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$TMP_PATH"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_PATH" "$DOWNLOAD_URL"
else
  echo "error: curl or wget required" >&2
  exit 1
fi

# ── Checksum verification ─────────────────────────────────────────────────────
# Verify the download against SHASUMS256.txt from the same release (matches the
# in-app updater). Returns: 0 verified/skipped, 1 checksum unavailable, 2 mismatch.
verify_checksum() {
  sums_url="https://github.com/${REPO}/releases/download/${TAG}/SHASUMS256.txt"
  sums_file="${TMP_PATH}.sums"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$sums_url" -o "$sums_file" 2>/dev/null || { rm -f "$sums_file"; return 1; }
  else
    wget -qO "$sums_file" "$sums_url" 2>/dev/null || { rm -f "$sums_file"; return 1; }
  fi

  expected=$(grep " ${ASSET}\$" "$sums_file" | awk '{print $1}' | head -n1)
  rm -f "$sums_file"
  [ -n "$expected" ] || return 1

  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$TMP_PATH" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$TMP_PATH" | awk '{print $1}')
  else
    echo "warning: no sha256 tool found; skipping checksum verification" >&2
    return 0
  fi

  if [ "$expected" != "$actual" ]; then
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    return 2
  fi
  echo "✓ checksum verified"
  return 0
}

# Capture the status without `set -e` aborting on the non-zero "unavailable"
# (1) and "mismatch" (2) returns — both are handled explicitly below.
set +e
verify_checksum
VERIFY_RC=$?
set -e
if [ "$VERIFY_RC" = "2" ]; then
  rm -f "$TMP_PATH"
  echo "error: checksum mismatch for ${ASSET}; refusing to install" >&2
  exit 1
elif [ "$VERIFY_RC" = "1" ]; then
  echo "warning: could not verify checksum for ${TAG} (no SHASUMS256.txt); proceeding" >&2
fi

chmod +x "$TMP_PATH"

if ! mv "$TMP_PATH" "$INSTALL_PATH" 2>/dev/null; then
  rm -f "$TMP_PATH"
  echo "error: cannot write to ${INSTALL_DIR}" >&2
  echo "       try: CCPOD_INSTALL_DIR=~/.local/bin sh install.sh" >&2
  echo "       or:  sudo sh install.sh" >&2
  exit 1
fi

# ── PATH hint ─────────────────────────────────────────────────────────────────

echo "✓ ccpod ${TAG} installed to ${INSTALL_PATH}"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    printf "\n  Add to your PATH:\n    export PATH=\"%s:\$PATH\"\n" "$INSTALL_DIR"
    ;;
esac

printf "\n  Get started: ccpod init\n"
