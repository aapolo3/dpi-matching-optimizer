#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Keep in sync with devDependencies.firebase-tools in package.json.
FIREBASE_TOOLS_VERSION=14.27.0
npx -y "firebase-tools@${FIREBASE_TOOLS_VERSION}" login --reauth
npx -y "firebase-tools@${FIREBASE_TOOLS_VERSION}" deploy --only firestore,storage,hosting --project dpi-matching-optimizer
