#!/usr/bin/env bash
# Manual frontend deploy: build, sync to S3, invalidate CloudFront.
# Not git-triggered - deploy explicitly by running this after a frontend
# change is committed and pushed. Bucket/distribution are identifiers, not
# secrets, so they're fine to keep in the repo.
set -euo pipefail

BUCKET="wildfiredashboard-frontend"
DISTRIBUTION_ID="E1VCY3J0XQGN24"
PRODUCTION_API_URL="https://wildfiredashboard-production.up.railway.app"

cd "$(dirname "$0")/frontend"
# Override the shared root .env's VITE_API_BASE_URL (which is set to
# localhost for local dev against a local backend) for this build only -
# a process env var with the VITE_ prefix takes precedence over the .env
# file in Vite's loadEnv, so the .env file itself is never touched.
VITE_API_BASE_URL="$PRODUCTION_API_URL" npm run build

# index.html synced with no-cache separately from everything else: S3's
# default response has no Cache-Control header at all, which lets browsers
# apply their own heuristic caching - meaning a browser could keep serving
# a stale index.html (pointing at an old, deleted JS/CSS bundle hash) for
# a while after a deploy, even though CloudFront's invalidation below only
# clears the CDN edge cache, not the browser's own. Vite's other output
# files are content-hashed (filename changes every build), so caching
# those aggressively is always safe - only index.html itself needs to be
# revalidated on every load.
aws s3 sync dist/ "s3://$BUCKET" --delete --exclude "index.html" \
  --cache-control "public, max-age=31536000, immutable"
aws s3 cp dist/index.html "s3://$BUCKET/index.html" \
  --cache-control "no-cache, must-revalidate" --content-type "text/html"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"
