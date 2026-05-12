#!/usr/bin/env bash
# Build and launch MapleView as a Mac Catalyst app on this machine.
# Expects Metro to be running separately (npm run start).
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d "ios/MapleView.xcworkspace" ]; then
  echo "ios/ missing — running expo prebuild…"
  npx expo prebuild --platform ios
fi

./scripts/fix-maccatalyst-frameworks.sh

DERIVED="${TMPDIR%/}/MapleViewDerivedData"
echo "Building (Debug-maccatalyst)…"
xcodebuild \
  -workspace ios/MapleView.xcworkspace \
  -scheme MapleView \
  -configuration Debug \
  -destination 'platform=macOS,variant=Mac Catalyst,arch=arm64' \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  build | (grep -E '(error|warning):|BUILD' || true)

APP="$DERIVED/Build/Products/Debug-maccatalyst/MapleView.app"
if [ ! -d "$APP" ]; then
  echo "Build produced no .app at $APP" >&2
  exit 1
fi

echo "Launching $APP"
open "$APP"
