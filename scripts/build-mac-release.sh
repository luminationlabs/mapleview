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
