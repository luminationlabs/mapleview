#!/usr/bin/env bash
# Patches RN prebuilt frameworks for Mac Catalyst.
#
# RN 0.84 ships the Mac Catalyst slices of hermes/React/ReactNativeDependencies
# with broken layouts (duplicated files instead of symlinks into Versions/).
# Xcode's codesign step fails with "bundle format is ambiguous".
# This script rebuilds the expected symlinks. Idempotent.
#
# Reference: https://github.com/facebook/react-native/issues/55540
set -euo pipefail

cd "$(dirname "$0")/.."

fix_framework() {
  local dir="$1" name="$2" version="$3"
  [ -d "$dir" ] || { echo "skip (missing): $dir"; return; }
  pushd "$dir" > /dev/null
  [ -e "$name" ] && [ ! -L "$name" ] && rm -rf "$name"
  [ -e Resources ] && [ ! -L Resources ] && rm -rf Resources
  [ -L "$name" ] || ln -s "Versions/Current/$name" "$name"
  [ -L Resources ] || ln -s Versions/Current/Resources Resources
  if [ -d Versions ]; then
    pushd Versions > /dev/null
    [ -e Current ] && [ ! -L Current ] && rm -rf Current
    [ -L Current ] || ln -s "$version" Current
    popd > /dev/null
  fi
  popd > /dev/null
  echo "fixed: $dir"
}

fix_framework \
  "ios/Pods/hermes-engine/destroot/Library/Frameworks/universal/hermesvm.xcframework/ios-arm64_x86_64-maccatalyst/hermesvm.framework" \
  hermesvm 1

fix_framework \
  "ios/Pods/React-Core-prebuilt/React.xcframework/ios-arm64_x86_64-maccatalyst/React.framework" \
  React A

RND_DIR="ios/Pods/ReactNativeDependencies/framework/packages/react-native/ReactNativeDependencies.xcframework/ios-arm64_x86_64-maccatalyst/ReactNativeDependencies.framework"
fix_framework "$RND_DIR" ReactNativeDependencies A
# Move bundle resources into the versioned Resources dir if they landed at top
if [ -d "$RND_DIR" ]; then
  shopt -s nullglob
  for b in "$RND_DIR"/ReactNativeDependencies_*.bundle; do
    [ -e "$b" ] || continue
    mkdir -p "$RND_DIR/Versions/A/Resources"
    mv "$b" "$RND_DIR/Versions/A/Resources/"
  done
fi
