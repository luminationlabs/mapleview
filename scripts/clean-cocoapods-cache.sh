#!/usr/bin/env bash
# Clear CocoaPods external podspec caches that bake in absolute paths.
# If this repo moves directories, the cached JSONs keep pointing at the
# old location and `pod install` reuses them — most visibly, HERMES_CLI_PATH
# in Pods-MapleView.*.xcconfig keeps pointing at a hermesc that no longer
# exists, and the "Bundle React Native code and images" phase fails.
set -euo pipefail

CACHE_DIR="$HOME/Library/Caches/CocoaPods/Pods/Specs/External"
PODS=(hermes-engine React-Core-prebuilt ReactNativeDependencies)

for pod in "${PODS[@]}"; do
  if [ -d "$CACHE_DIR/$pod" ]; then
    echo "Removing $CACHE_DIR/$pod"
    rm -rf "$CACHE_DIR/$pod"
  fi
done

echo "Done. Next: (cd ios && pod install)"
