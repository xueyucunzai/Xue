#!/usr/bin/env bash
set -euo pipefail
: "${RENDER_API_KEY:?Set RENDER_API_KEY}"
: "${RENDER_SERVICE_ID:?Set RENDER_SERVICE_ID}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${CF_WORKER_NAME:?Set CF_WORKER_NAME}"

json="$(curl -fsS -H "Authorization: Bearer ${RENDER_API_KEY}" "https://api.render.com/v1/services/${RENDER_SERVICE_ID}")"
url="$(python -c 'import json,sys; d=json.load(sys.stdin); print(d.get("service",{}).get("serviceDetails",{}).get("url") or d.get("service",{}).get("url") or "")' <<<"$json")"
if [[ -z "$url" ]]; then echo "Could not discover Render public URL" >&2; exit 1; fi
printf '%s' "$url" | npx wrangler secret put QUANT_ENGINE_URL --name "$CF_WORKER_NAME" --account-id "$CLOUDFLARE_ACCOUNT_ID"
echo "Cloudflare Worker secret updated."
