#!/usr/bin/env bash
# Fail if runtime source code uses console.* directly.
# Runtime code should use createLogger() from src/logger.ts instead.
#
# Excluded:
#   - CLI commands (src/cli*, onboard, setup) -- user-facing terminal output
#   - Test files (*.test.ts, mock-*) -- test output
#   - banner.ts -- ASCII art display
#   - whatsapp/session.ts installConsoleFilters() -- intentional console interception (Baileys noise filter)
#   - JSDoc examples (lines starting with ' *')

set -euo pipefail

hits=$(grep -rn 'console\.\(log\|error\|warn\|info\)(' src/ --include='*.ts' \
  | grep -v '/cli' \
  | grep -v '\.test\.' \
  | grep -v 'mock-channel' \
  | grep -v 'banner\.ts' \
  | grep -v 'session\.ts.*\(originalLog\|originalError\|originalWarn\|console\.\(log\|error\|warn\) =\)' \
  | grep -v 'setup\.ts' \
  | grep -v 'onboard\.ts' \
  | grep -v 'slack-wizard\.ts' \
  | grep -v 'cron/cli\.ts' \
  | grep -v ' \* ' \
  || true)

if [ -n "$hits" ]; then
  echo "ERROR: Found console.* calls in runtime code (use createLogger instead):"
  echo "$hits"
  exit 1
fi

echo "OK: No console.* in runtime code."
