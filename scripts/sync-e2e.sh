#!/usr/bin/env bash
# Real-Cloudflare end-to-end for `piquette sync` (#135). NOT run in CI and not run
# in the phase that built the client — it needs a deployed hub (#136) behind
# Cloudflare Access.
#
#   source ~/.config/piquette/cloudflare.env     # (this script sources it for you)
#   export PIQUETTE_SYNC_ENDPOINT=https://piquette-hub.<you>.workers.dev
#   export PIQUETTE_SYNC_CLIENT_ID=<access service token id>
#   export PIQUETTE_SYNC_CLIENT_SECRET=<access service token secret>
#   npm run build:cli && scripts/sync-e2e.sh
#
# Required env (checked up front; secrets are never echoed):
#   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, R2_ACCESS_KEY_ID,
#   R2_SECRET_ACCESS_KEY, CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_ALLOWED_EMAIL
#     -> passed through for the hub stage (deploying/inspecting the Worker);
#        `piquette sync` itself never sees CLOUDFLARE_API_TOKEN.
#   PIQUETTE_SYNC_ENDPOINT, PIQUETTE_SYNC_CLIENT_ID, PIQUETTE_SYNC_CLIENT_SECRET
#     -> the factory side: where to push, and the Access service token.
#
# Steps: seed a temp repo's trace db through the real Tracer -> `piquette sync
# --dry-run` (sends nothing) -> `piquette sync` (pushes) -> `piquette sync` again (must
# send nothing) -> `GET /ingest/v1` with the Access headers (the hub reports
# its supported sync_schema range).
set -euo pipefail

ENV_FILE="${PIQUETTE_CLOUDFLARE_ENV:-$HOME/.config/piquette/cloudflare.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

missing=()
for var in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY \
  CF_ACCESS_TEAM_DOMAIN CF_ACCESS_ALLOWED_EMAIL PIQUETTE_SYNC_ENDPOINT PIQUETTE_SYNC_CLIENT_ID PIQUETTE_SYNC_CLIENT_SECRET; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if ((${#missing[@]} > 0)); then
  echo "sync-e2e: missing required env: ${missing[*]}" >&2
  echo "sync-e2e: set them in $ENV_FILE (see scripts/sync-e2e.sh header)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIQUETTE=(node "$ROOT/dist/cli/bin.js")
[[ -f "$ROOT/dist/cli/bin.js" ]] || { echo "sync-e2e: run 'npm run build:cli' first" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
git init -q
git remote add origin "https://github.com/piquette-e2e/sync-e2e.git"
mkdir -p .piquette
cat > .piquette/piquette.config.yaml <<YAML
sync:
  endpoint: ${PIQUETTE_SYNC_ENDPOINT}
  level: trace
  factory_name: e2e@$(hostname)
YAML

echo "== seeding a trace db through the real Tracer"
node --input-type=module -e "
import { Tracer } from '$ROOT/dist/core/tracer.js';
import { makeEventRecord } from '$ROOT/dist/core/data_types.js';
const t = await Tracer.open('$WORK/.piquette/data/piquette.db', '$WORK/events.jsonl');
await t.sessionStart('e2e00001', 'e2e', 'plan');
await t.sessionRequest('e2e00001', 'e2e request');
for (let i = 0; i < 3; i++) await t.event(makeEventRecord({ adw_id: 'e2e00001', type: 'log', name: 'tick ' + i, payload: { n: i } }));
await t.sessionFinish('e2e00001', true);
await t.close();
"

echo "== piquette sync --dry-run (must send nothing)"
"${PIQUETTE[@]}" sync --dry-run

echo "== piquette sync (first push)"
"${PIQUETTE[@]}" sync

echo "== piquette sync again (must report up to date)"
"${PIQUETTE[@]}" sync | tee "$WORK/second.out"
grep -q "up to date" "$WORK/second.out" || { echo "sync-e2e: second pass should send nothing" >&2; exit 1; }

echo "== GET /ingest/v1 (supported sync_schema range)"
# Headers go in a mode-600 file (`-H @file`), never argv: `ps` shows argv to other users.
HDRS="$WORK/probe.headers"
( umask 077; printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "${PIQUETTE_SYNC_CLIENT_ID}" "${PIQUETTE_SYNC_CLIENT_SECRET}" > "$HDRS" )
status=$(curl -sS -o "$WORK/probe.json" -w '%{http_code}' -H "@$HDRS" "${PIQUETTE_SYNC_ENDPOINT%/}/ingest/v1")
rm -f "$HDRS"
echo "HTTP $status: $(cat "$WORK/probe.json")"
[[ "$status" == "200" ]] || { echo "sync-e2e: probe failed" >&2; exit 1; }

echo "sync-e2e: ok"
