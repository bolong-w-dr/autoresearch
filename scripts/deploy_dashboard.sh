#!/usr/bin/env bash
# Upload the static dashboard to the S3 bucket behind CloudFront and invalidate.
#
# Usage:
#   scripts/deploy_dashboard.sh <bucket> <cloudfront-distribution-id> [--config path/to/config.js]
#
# The data/ prefix (the service's result store) is never touched.
set -euo pipefail

BUCKET="${1:?bucket name required}"
DISTRIBUTION_ID="${2:?cloudfront distribution id required}"
CONFIG_OVERRIDE=""
if [[ "${3:-}" == "--config" ]]; then
  CONFIG_OVERRIDE="${4:?path to config.js required}"
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/dashboard"

echo "Syncing $SRC -> s3://$BUCKET/"
aws s3 sync "$SRC" "s3://$BUCKET/" \
  --exclude "data/*" \
  --exclude ".*" \
  --delete \
  --cache-control "public, max-age=300" \
  --metadata-directive REPLACE

# index.html and config.js must never be served stale.
for f in index.html config.js; do
  aws s3 cp "$SRC/$f" "s3://$BUCKET/$f" --cache-control "no-cache" --content-type "$([[ $f == *.js ]] && echo application/javascript || echo text/html)"
done
if [[ -n "$CONFIG_OVERRIDE" ]]; then
  echo "Using config override $CONFIG_OVERRIDE"
  aws s3 cp "$CONFIG_OVERRIDE" "s3://$BUCKET/config.js" --cache-control "no-cache" --content-type application/javascript
fi

echo "Invalidating distribution $DISTRIBUTION_ID"
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/*" --query 'Invalidation.Id' --output text
echo "Done."
