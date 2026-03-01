#!/usr/bin/env bash
# Fail if runtime source code uses console.* directly.
# Runtime code should use createLogger() from src/logger.ts instead.
#
# Excluded:
#   - CLI commands (src/cli*, src/cron/cli.ts, onboard, setup) -- user-facing terminal output
#   - Test files (*.test.ts, mock-*) -- test output
#   - banner.ts -- ASCII art display
#   - JSDoc examples (lines starting with ' *')

set -euo pipefail

hits=$(grep -rEn 'console\.(log|error|warn|info|debug|trace)[[:space:]]*\(' src/ --include='*.ts' \
  --exclude='*.test.ts' \
  --exclude='mock-*.ts' \
  --exclude='mock-channel.ts' \
  --exclude='banner.ts' \
  --exclude='setup.ts' \
  --exclude='onboard.ts' \
  --exclude='slack-wizard.ts' \
  --exclude='cli.ts' \
  --exclude-dir='cli' \
  | grep -Ev ':[0-9]+:[[:space:]]*\* ' \
  || true)

if [ -n "$hits" ]; then
  echo "ERROR: Found console.* calls in runtime code (use createLogger instead):"
  echo "$hits"
  exit 1
fi

echo "OK: No console.* in runtime code."
