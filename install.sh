#!/usr/bin/env bash
# AI Contribution Tracker — one-line installer (macOS / Linux)
#
#   curl -sSL https://raw.githubusercontent.com/Varonis-Systems/AI-Contribution-Tracker/refs/heads/feat/standalone-cli-distribution/install.sh | bash
#
# Downloads the self-contained `ai-track` binary for your platform, installs it
# to ~/.local/bin, and runs `ai-track init`. No Node, no npm, no VS Code required.
set -euo pipefail

# Binaries are attached to the latest GitHub Release. Override for forks/testing.
ASSET_BASE="${AI_TRACK_ASSET_BASE:-https://github.com/Varonis-Systems/AI-Contribution-Tracker/releases/latest/download}"
INSTALL_DIR="${AI_TRACK_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="ai-track"

say()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ─── Detect platform ────────────────────────────────────────
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux)  plat="linux" ;;
  Darwin) plat="darwin" ;;
  *) die "Unsupported OS: $os (use install.ps1 on Windows)" ;;
esac
case "$arch" in
  x86_64|amd64) a="x64" ;;
  arm64|aarch64) a="arm64" ;;
  *) die "Unsupported architecture: $arch" ;;
esac

asset="ai-track-${plat}-${a}"
url="${ASSET_BASE}/${asset}"

echo ""
echo "AI Contribution Tracker — installing ${asset}"
echo ""

# ─── Download ───────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
target="${INSTALL_DIR}/${BIN_NAME}"
tmp="$(mktemp)"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp" || die "Download failed: $url"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url" || die "Download failed: $url"
else
  die "Neither curl nor wget is available."
fi

chmod +x "$tmp"
mv "$tmp" "$target"

if [ "$plat" = "darwin" ]; then
  if command -v codesign >/dev/null 2>&1; then
    # Bun --compile embeds an incomplete signature slot that codesign refuses
    # to overwrite ("invalid or unsupported format"), so strip it first, then
    # apply a fresh ad-hoc signature.
    codesign --remove-signature "$target" 2>/dev/null || true
    codesign --sign - --force "$target" 2>/dev/null \
      && say "Ad-hoc signed binary (required to run on Apple Silicon)" \
      || warn "Could not ad-hoc sign — binary may be killed on Apple Silicon."
  fi
  xattr -d com.apple.quarantine "$target" 2>/dev/null || true
fi
say "Installed binary: $target"

# ─── Ensure it's on PATH ────────────────────────────────────
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    warn "$INSTALL_DIR is not on your PATH."
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      if [ -f "$rc" ] && ! grep -q "$INSTALL_DIR" "$rc" 2>/dev/null; then
        printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$rc"
        say "Added $INSTALL_DIR to PATH in $rc"
      fi
    done
    export PATH="$INSTALL_DIR:$PATH"
    ;;
esac

# ─── Try to install the VS Code companion extension (optional) ──
if command -v code >/dev/null 2>&1; then
  code --install-extension YoavLax.ai-contribution-tracker >/dev/null 2>&1 \
    && say "Installed VS Code companion extension (inline-suggestion tracking)" \
    || warn "Could not install VS Code extension (continuing without it)"
elif command -v code-insiders >/dev/null 2>&1; then
  code-insiders --install-extension YoavLax.ai-contribution-tracker >/dev/null 2>&1 \
    && say "Installed VS Code Insiders companion extension" \
    || warn "Could not install VS Code extension (continuing without it)"
else
  warn "VS Code 'code' command not found — skipping companion extension (inline tracking)."
fi

# ─── Run init ───────────────────────────────────────────────
echo ""
"$target" init

echo ""
say "Done. Open a new terminal so 'ai-track' is on your PATH."
echo ""
