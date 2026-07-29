#!/usr/bin/env bash
# Manual frontend deploy: build, sync to S3, invalidate CloudFront.
# Not git-triggered - deploy explicitly by running this after a frontend
# change is committed and pushed. Bucket/distribution are identifiers, not
# secrets, so they're fine to keep in the repo.
set -euo pipefail

BUCKET="wildfiredashboard-frontend"
DISTRIBUTION_ID="E1VCY3J0XQGN24"

cd "$(dirname "$0")/frontend"
npm run build

aws s3 sync dist/ "s3://$BUCKET" --delete
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*"
