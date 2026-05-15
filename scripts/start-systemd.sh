#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/sanzh/Documents/Projects/codex-notification-bot"
cd "$APP_DIR"

if [[ "${CODEX_BIN:-codex}" == "codex" ]]; then
  if command -v codex >/dev/null 2>&1; then
    export CODEX_BIN="$(command -v codex)"
  else
    CODEX_CANDIDATE="$(
      find "$HOME/.vscode/extensions" -path "*/bin/linux-x86_64/codex" -type f -print 2>/dev/null \
        | sort -V \
        | tail -n 1
    )"
    if [[ -z "$CODEX_CANDIDATE" ]]; then
      echo "Could not find codex binary. Set CODEX_BIN in .env or update scripts/start-systemd.sh." >&2
      exit 127
    fi
    export CODEX_BIN="$CODEX_CANDIDATE"
  fi
fi

exec /usr/bin/node "$APP_DIR/dist/src/index.js"
