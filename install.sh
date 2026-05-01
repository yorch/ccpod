#!/usr/bin/env bash
set -euo pipefail

REPO="yorch/ccpod"
BINARY="ccpod"
INSTALL_DIR="${CCPOD_INSTALL_DIR:-/usr/local/bin}"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)  OS=linux ;;
  Darwin*) OS=darwin ;;
  *) echo "error: unsupported OS: $OS" >&2; exit 1 ;;
esac

# Detect architecture (map to Bun target names)
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)        ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# Resolve version
VERSION="${CCPOD_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | sed 's/.*"tag_name": "\(.*\)".*/\1/')"
fi

if [ -z "$VERSION" ]; then
  echo "error: could not determine latest release version" >&2
  exit 1
fi

FILENAME="${BINARY}-${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${FILENAME}"

echo "Installing ${BINARY} ${VERSION} (${OS}/${ARCH})..."

# Use sudo only if install dir is not writable
if [ -w "$INSTALL_DIR" ]; then
  SUDO=""
else
  SUDO="sudo"
fi

$SUDO curl -fsSL "$URL" -o "${INSTALL_DIR}/${BINARY}"
$SUDO chmod +x "${INSTALL_DIR}/${BINARY}"

echo "Installed: ${INSTALL_DIR}/${BINARY}"
echo "Run 'ccpod init' to get started."
