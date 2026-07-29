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

aws s3 sync dist/ "s3://$BUCKET" --delete
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"
