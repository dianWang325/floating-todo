#!/bin/bash
# Validate the shipped image: Tauri removes the intermediate .app for DMG-only builds.
set -euo pipefail
root="${1:-src-tauri/target}"
mount_dir=""
mounted=false
cleanup() {
  if "$mounted"; then
    hdiutil detach "$mount_dir" -quiet || return 1
    mounted=false
  fi
  if [ -n "$mount_dir" ]; then rmdir "$mount_dir"; fi
}
trap cleanup EXIT
count=0
while IFS= read -r -d '' dmg; do
  mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/floating-todo-dmg.XXXXXX")"
  hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mount_dir" -quiet
  mounted=true
  app="$mount_dir/floating todo.app"
  if [ ! -d "$app" ]; then
    echo "Expected floating todo.app inside $dmg" >&2
    exit 1
  fi
  identifier=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist")
  if [ "$identifier" != "com.gaopengfei.floating-todo" ]; then
    echo "Unexpected application identifier: $identifier" >&2
    exit 1
  fi
  codesign --verify --deep --strict --verbose=2 "$app"
  echo "Verified installer: $dmg"
  cleanup
  mount_dir=""
  count=$((count + 1))
done < <(find "$root" -type f -path '*/release/bundle/dmg/*.dmg' -print0)
if [ "$count" -eq 0 ]; then
  echo "No macOS DMG installer found in $root" >&2
  exit 1
fi
