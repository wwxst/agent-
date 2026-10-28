#!/usr/bin/env bash
# Pinned full-repository observation probe; runs in a fresh temporary directory.
# No GitHub push and no modification to an existing local checkout.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${AGENT_REPO_URL:-https://github.com/wwxst/agent-.git}"
commit=72bf0ce79d8beaf83565072d9c5ade39ae15803d
work="$(mktemp -d -t agent-kernel-probe-XXXXXXXX)"
trap 'rm -rf "$work"' EXIT
git clone --quiet "$repo" "$work/repo"
cd "$work/repo"
git checkout --quiet --detach "$commit"
cp "$root/full-repo-comparative-probe.test.ts" tests/full-repo-comparative-probe.test.ts
npm install --ignore-scripts --no-audit --no-fund
npm run build
node --test dist/tests/full-repo-comparative-probe.test.js
