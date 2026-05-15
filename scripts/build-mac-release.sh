#!/usr/bin/env bash
# Build MapleView as a standalone Mac Catalyst Release .app.
# JS is bundled in — no Metro required at runtime.
# Output: <repo>/build/mac/MapleView.app
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -d "ios/MapleView.xcworkspace" ]; then
  echo "ios/ missing — running expo prebuild…"
  npx expo prebuild --platform ios
fi

./scripts/fix-maccatalyst-frameworks.sh

# Preflight: CocoaPods caches external podspecs by source-content hash, so the
# absolute HERMES_CLI_PATH baked in by hermes-engine.podspec survives a repo
# move and `pod install` happily reuses it. Catch that before xcodebuild
# wastes minutes failing in the JS bundle phase.
XCCONFIG="ios/Pods/Target Support Files/Pods-MapleView/Pods-MapleView.release.xcconfig"
if [ -f "$XCCONFIG" ]; then
  HERMESC=$(awk -F'[[:space:]]*=[[:space:]]*' '/^HERMES_CLI_PATH[[:space:]]*=/ {print $2; exit}' "$XCCONFIG")
  if [ -n "$HERMESC" ] && [ ! -x "$HERMESC" ]; then
    echo "error: HERMES_CLI_PATH=$HERMESC (from $XCCONFIG) doesn't exist." >&2
    echo "CocoaPods has cached a stale external podspec — usually from a previous repo location." >&2
    echo "Fix: ./scripts/clean-cocoapods-cache.sh && (cd ios && pod install)" >&2
    exit 1
  fi
fi

OUT_DIR="build/mac"
DERIVED="${TMPDIR%/}/MapleViewDerivedData-Release"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "Building (Release-maccatalyst)…"
xcodebuild \
  -workspace ios/MapleView.xcworkspace \
  -scheme MapleView \
  -configuration Release \
  -destination 'platform=macOS,variant=Mac Catalyst,arch=arm64' \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  build | (grep -E '(error|warning):|BUILD' || true)

APP_SRC="$DERIVED/Build/Products/Release-maccatalyst/MapleView.app"
if [ ! -d "$APP_SRC" ]; then
  echo "Build produced no .app at $APP_SRC" >&2
  exit 1
fi

echo "Copying to $OUT_DIR/…"
cp -R "$APP_SRC" "$OUT_DIR/"

APP="$OUT_DIR/MapleView.app"
echo ""
echo "Done. Standalone app at: $(pwd)/$APP"
echo "Launch with:  open \"$APP\""
echo "Install with: cp -R \"$APP\" /Applications/"
