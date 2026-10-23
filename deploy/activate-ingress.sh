#!/usr/bin/env bash
# Activate the reviewed IndexNow ownership response at the Hatoove ingress.
#
# This is NOT an application deployment. It restarts ONLY the ingress container
# so it re-reads the already staged reviewed `deploy/Caddyfile`, then proves the
# public contract and that app, worker, database and volumes were untouched.
#
# Usage:
#   deploy/activate-ingress.sh --check <reviewed-commit-40hex> <caddyfile-sha256-64hex>
#   deploy/activate-ingress.sh --apply <reviewed-commit-40hex> <caddyfile-sha256-64hex>
#
# --check runs every read-only preflight and prints the plan; it never restarts,
# writes, or changes anything. --apply performs the restart and verification.
# Both refuse when the staged source or Caddyfile no longer matches the reviewed
# values, when another deployment holds the lock, or when not on the production
# host.
#
# Obtain the reviewed Caddyfile SHA256 locally before running:
#   git show <reviewed-commit>:deploy/Caddyfile | sha256sum
#
# Production activation requires Ron's explicit authorization. This script does
# not authorize itself.

set -Eeuo pipefail
umask 077

usage() {
  printf 'Usage: %s --check|--apply <reviewed-commit-40hex> <caddyfile-sha256-64hex>\n' "$0" >&2
  exit 2
}

[[ "$#" -eq 3 ]] || usage
mode=$1
source_revision=$2
expected_config=$3
[[ "$mode" == --check || "$mode" == --apply ]] || usage

key=16a91221eb78411198dbd6254bf9e653
production_host=hatoove-app-01
src=/opt/hatoove/src
config=$src/deploy/Caddyfile
env_file=/opt/hatoove/config/production.env
ingress=hatoove-production-ingress-1

compose=(env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  docker compose --project-name hatoove-production --env-file "$env_file" \
  -f "$src/compose.production.yaml" -f "$src/compose.production.local-db.yaml")

fail() {
  printf 'activate-ingress: %s\n' "$*" >&2
  exit 1
}

[[ "$(hostname -s)" == "$production_host" ]] || fail "Run this on $production_host."
[[ "$source_revision" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid reviewed commit.'
[[ "$expected_config" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid Caddyfile SHA256.'
[[ -f "$config" ]] || fail "Missing staged Caddyfile: $config"
[[ -f "$src/.reviewed-commit" ]] || fail "Missing staged release marker: $src/.reviewed-commit"

exec 9>/opt/hatoove/ops/deployment.lock
flock -n 9 || fail 'Another deployment holds the deployment lock.'

[[ "$(tr -d '\r\n' < "$src/.reviewed-commit")" == "$source_revision" ]] || fail 'Staged source is not the reviewed commit.'
actual_config=$(sha256sum "$config" | cut -d' ' -f1)
[[ "$actual_config" == "$expected_config" ]] || fail "Staged Caddyfile SHA256 mismatch (found $actual_config)."

docker inspect "$ingress" >/dev/null 2>&1 || fail "Ingress container $ingress not found."
[[ "$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$ingress")" == hatoove-production ]] || fail 'Unexpected ingress compose project.'
image=$(docker inspect --format '{{.Image}}' "$ingress")

protected() {
  docker inspect --format '{{.Name}} {{.Id}} {{.Image}} {{.State.StartedAt}}' \
    hatoove-production-app-1 hatoove-production-worker-1 hatoove-production-db-1
}

local_curl() {
  curl --silent --show-error --connect-timeout 2 --max-time 5 \
    --resolve 'hatoove.com:443:127.0.0.1' --resolve 'hatoove.com:80:127.0.0.1' "$@"
}

verify_public_contract() {
  local dir=$1 status body content_type suffix foreign redirect ready
  status=$(local_curl --output "$dir/key.txt" --write-out '%{http_code}' "https://hatoove.com/$key.txt" || true)
  [[ "$status" == 200 ]] || { printf 'Key status: %s\n' "$status" >&2; return 1; }
  body=$(tr -d '\r\n' < "$dir/key.txt")
  [[ "$body" == "$key" ]] || { printf 'Key body mismatch.\n' >&2; return 1; }
  content_type=$(local_curl --output /dev/null --write-out '%{content_type}' "https://hatoove.com/$key.txt" || true)
  [[ "$content_type" == text/plain* ]] || { printf 'Key content type: %s\n' "$content_type" >&2; return 1; }
  suffix=$(local_curl --output /dev/null --write-out '%{http_code}' "https://hatoove.com/$key.txt/private" || true)
  [[ "$suffix" != 200 ]] || { printf 'Suffixed path is public.\n' >&2; return 1; }
  foreign=$(local_curl --header 'Host: indexnow-invalid.invalid' --output /dev/null --write-out '%{http_code}' "https://hatoove.com/$key.txt" || true)
  [[ "$foreign" == 421 ]] || { printf 'Foreign-host status: %s\n' "$foreign" >&2; return 1; }
  redirect=$(local_curl --output /dev/null --write-out '%{http_code}' "http://hatoove.com/$key.txt" || true)
  [[ "$redirect" == 308 ]] || { printf 'HTTP redirect status: %s\n' "$redirect" >&2; return 1; }
  ready=$(local_curl --output /dev/null --write-out '%{http_code}' "https://hatoove.com/api/ready" || true)
  [[ "$ready" == 200 ]] || { printf 'Application readiness: %s\n' "$ready" >&2; return 1; }
}

printf 'Reviewed source:    %s\n' "$source_revision"
printf 'Reviewed Caddyfile: sha256 %s\n' "$expected_config"
printf 'Ingress image:      %s\n' "$image"

# Validate the staged candidate with the exact running ingress image before any restart.
docker run --rm --pull never --network none --read-only --entrypoint caddy \
  --mount "type=bind,source=$config,target=/etc/caddy/Caddyfile,readonly" \
  "$image" validate --config /etc/caddy/Caddyfile --adapter caddyfile

probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
served_status=$(local_curl --output "$probe/served.txt" --write-out '%{http_code}' "https://hatoove.com/$key.txt" || true)
served_body=$(tr -d '\r\n' < "$probe/served.txt" 2>/dev/null || true)
printf 'Key served now:     HTTP %s\n' "$served_status"

if [[ "$served_status" == 200 && "$served_body" == "$key" ]]; then
  if verify_public_contract "$probe"; then
    printf 'Already active: the ingress serves the exact key; no restart performed.\n'
    exit 0
  fi
  fail 'Ingress serves the key but the public contract failed; review before changing anything.'
fi

if [[ "$mode" == --check ]]; then
  printf '\nPlan: restart only %s with --no-deps so it re-reads the reviewed Caddyfile.\n' "$ingress"
  printf 'Then require: key 200/exact body/text-plain, suffixed path non-200, foreign Host 421,\n'
  printf 'HTTP 308, /api/ready 200, unchanged app/worker/db identities and unchanged ingress image.\n'
  printf 'No restart or write has been performed. Re-run with --apply to execute.\n'
  exit 0
fi

ops=/opt/hatoove/ops/indexnow
install -d -m 0700 "$ops"
release="$ops/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -m 0700 "$release"
cp -p "$config" "$release/Caddyfile.reviewed"
docker exec "$ingress" cat /etc/caddy/Caddyfile > "$release/Caddyfile.served-before"
protected > "$release/protected.before"
printf '%s\n' "$image" > "$release/ingress-image.txt"
printf '%s\n' "$source_revision" > "$release/reviewed-commit.txt"

rollback() {
  local status=$1
  trap - ERR INT TERM
  set +e
  printf 'Activation failed; restoring the previously served ingress configuration.\n' >&2
  if ! cat "$release/Caddyfile.served-before" > "$config"; then
    printf 'RECOVERY REQUIRED: could not rewrite the prior config. Preserve the ingress process and inspect %s\n' "$release" >&2
    exit "$status"
  fi
  if ! "${compose[@]}" restart --no-deps ingress; then
    printf 'RECOVERY REQUIRED: prior config restored but the ingress restart failed. Preserve the ingress process and inspect %s\n' "$release" >&2
    exit "$status"
  fi
  if ! local_curl --fail --output /dev/null "https://hatoove.com/api/ready"; then
    printf 'RECOVERY REQUIRED: ingress restarted with the prior config but readiness failed. Inspect %s\n' "$release" >&2
    exit "$status"
  fi
  printf 'Rolled back: prior configuration restored, verified and ingress restarted. Evidence: %s\n' "$release" >&2
  exit "$status"
}
trap 'rollback $?' ERR INT TERM

printf 'Restarting ingress only...\n'
"${compose[@]}" restart --no-deps ingress

for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if verify_public_contract "$release"; then break; fi
  sleep 1
done
if ! verify_public_contract "$release"; then rollback 1; fi
if [[ "$(docker exec "$ingress" sha256sum /etc/caddy/Caddyfile | cut -d' ' -f1)" != "$expected_config" ]]; then
  printf 'Ingress did not load the reviewed Caddyfile.\n' >&2
  rollback 1
fi
if [[ "$(protected)" != "$(cat "$release/protected.before")" ]]; then
  printf 'Protected container identity changed.\n' >&2
  rollback 1
fi
if [[ "$(docker inspect --format '{{.Image}}' "$ingress")" != "$image" ]]; then
  printf 'Ingress image changed.\n' >&2
  rollback 1
fi
if [[ "$(tr -d '\r\n' < "$src/.reviewed-commit")" != "$source_revision" ]]; then
  printf 'Reviewed source marker changed.\n' >&2
  rollback 1
fi

trap - ERR INT TERM
rm -rf "$probe"
printf 'Ingress activated; app, worker, database and volumes untouched. Evidence: %s\n' "$release"
