#!/usr/bin/env bash
# The in-app update test as CI runs it (ci.yml's In-app update job; the Diagnose workflow with updater: true), from the
# repository root: the published release before this one ($FROM, default v0.5.2) updated to this build through its
# Update, signed with the real updater key ($S_KEY, $S_KEY_PASSWORD). The feed is a throwaway pre-release
# ($FEED_RELEASE; a release's updater reads only https), deleted when this ends. Without the key: two builds of this
# code, a throwaway key and a local feed. Needs GH_TOKEN with contents: write, and $BUNDLES (app or nsis).
set -euo pipefail
FROM="${FROM:-v0.5.2}"
REPO="${GITHUB_REPOSITORY:-jldeen/scenecast}"
TMP="${RUNNER_TEMP:-$(mktemp -d)}"
FEED_RELEASE="${FEED_RELEASE:-ci-update-$(date +%s)-$RUNNER_OS}"
BUNDLES="${BUNDLES:-$([ "${RUNNER_OS:-}" = Windows ] && echo nsis || echo app)}"
[ -d apps/desktop/node_modules ] || npm ci --prefix apps/desktop
rm -rf "$TMP/new" "$TMP/old"; mkdir -p "$TMP/new" "$TMP/old"
b=src-tauri/target/debug/bundle
take() { if [ "$RUNNER_OS" = macOS ]; then cp $b/macos/*.app.tar.gz $b/macos/*.app.tar.gz.sig "$TMP/new/"; else cp $b/nsis/*"$1"*-setup.exe $b/nsis/*"$1"*-setup.exe.sig "$TMP/new/"; fi; }
cleanup() { [ -n "${S_KEY:-}" ] && gh release delete "$FEED_RELEASE" -R "$REPO" --yes --cleanup-tag >/dev/null 2>&1 || true; }
trap cleanup EXIT
pushd apps/desktop >/dev/null
if [ -n "${S_KEY:-}" ]; then
  version=$(node -p "require('./src-tauri/tauri.conf.json').version")
  echo '{"bundle":{"createUpdaterArtifacts":true}}' > src-tauri/tauri.update-test.json
  TAURI_SIGNING_PRIVATE_KEY="$S_KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${S_KEY_PASSWORD:-}" npx tauri build --debug --bundles "$BUNDLES" --config src-tauri/tauri.update-test.json
  take "$version"
  if [ "$RUNNER_OS" = macOS ]; then
    gh release download "$FROM" -R "$REPO" -p "Scenecast_${FROM#v}_universal.app.tar.gz" -D "$TMP" --clobber
    tar -xzf "$TMP/Scenecast_${FROM#v}_universal.app.tar.gz" -C "$TMP/old"
  else
    gh release download "$FROM" -R "$REPO" -p "Scenecast_${FROM#v}_x64-setup.exe" -D "$TMP/old" --clobber
  fi
else
  echo "::warning::no updater key: the update is tested between two builds of this code, not from $FROM"
  version=0.3.99
  npx tauri signer generate --ci -p test -w "$TMP/update-test.key" -f
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TMP/update-test.key")" TAURI_SIGNING_PRIVATE_KEY_PASSWORD=test
  conf() {
    node -e "const fs=require('fs');fs.writeFileSync('src-tauri/tauri.update-test.json',JSON.stringify({version:process.argv[1],bundle:{createUpdaterArtifacts:true},plugins:{updater:{pubkey:fs.readFileSync(process.argv[2],'utf8').trim(),endpoints:['http://127.0.0.1:47811/latest.json'],dangerousInsecureTransportProtocol:true,windows:{installMode:'passive'}}}}))" "$1" "$TMP/update-test.key.pub"
  }
  conf 0.3.99
  npx tauri build --debug --bundles "$BUNDLES" --config src-tauri/tauri.update-test.json
  take 0.3.99
  conf 0.3.98
  npx tauri build --debug --bundles "$BUNDLES" --config src-tauri/tauri.update-test.json
  if [ "$RUNNER_OS" = macOS ]; then cp -R $b/macos/Scenecast.app "$TMP/old/"; else cp $b/nsis/*0.3.98*-setup.exe "$TMP/old/"; fi
fi
popd >/dev/null
ls -la "$TMP/new" "$TMP/old"
if [ -n "${S_KEY:-}" ]; then
  base="https://github.com/$REPO/releases/download/$FEED_RELEASE/"
  node apps/desktop/scripts/latest-json.mjs "$TMP/new" "$version" "$base"
  gh release create "$FEED_RELEASE" -R "$REPO" --prerelease --latest=false --target "${GITHUB_SHA:-$(git rev-parse HEAD)}" \
    --title "CI update test (deleted after the run)" --notes "The in-app update test's feed. Deleted when the run ends." "$TMP"/new/*
  export UPDATE_FEED="${base}latest.json"
fi
old="$(ls -d "$TMP"/old/* | head -1)"
node apps/desktop/tests/update.test.mjs "$old" "$TMP/new" "$version"
