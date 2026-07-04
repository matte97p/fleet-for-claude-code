#!/usr/bin/env bash
# Build one platform vsix and publish it to the VS Code Marketplace, and to
# Open VSX when OVSX_PAT is set. Re-runnable: a target/version that already
# exists is treated as success, so re-running a release never fails on dupes.
#
# Required env: TARGET (e.g. darwin-arm64), VSCE_PAT.
# Optional env: OVSX_PAT (enables the Open VSX mirror).
set -euo pipefail

if [ -z "${TARGET:-}" ]; then echo "TARGET not set"; exit 1; fi

VSIX="fleet-${TARGET}.vsix"

echo "==> Packaging ${VSIX}"
# No --no-dependencies: we WANT the SDK + its per-platform binary bundled.
npx @vscode/vsce package --target "${TARGET}" -o "${VSIX}"

# Publish to a registry, tolerating an already-published (target, version).
publish() {
  local name="$1"; shift
  local out status
  set +e
  out="$("$@" 2>&1)"
  status=$?
  set -e
  echo "${out}"
  if [ "${status}" -ne 0 ]; then
    if echo "${out}" | grep -qiE "already (exists|published)"; then
      echo "==> ${name}: this target/version is already published — treating as success."
      return 0
    fi
    echo "==> ${name}: publish failed."
    return "${status}"
  fi
  echo "==> ${name}: published."
}

echo "==> Publishing ${TARGET} to VS Code Marketplace"
publish "VS Code Marketplace" npx @vscode/vsce publish --packagePath "${VSIX}"

if [ -n "${OVSX_PAT:-}" ]; then
  echo "==> Publishing ${TARGET} to Open VSX"
  publish "Open VSX" npx ovsx publish "${VSIX}" -p "${OVSX_PAT}"
else
  echo "==> OVSX_PAT not set — skipping Open VSX mirror."
fi
