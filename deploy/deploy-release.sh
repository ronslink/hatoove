#!/usr/bin/env bash
# Atomic, digest-pinned production release script for Hatoove on the droplet.
# Usage: deploy-release.sh <git-revision-40-hex> <archive-tar-path> <archive-sha256-64-hex>
set -euo pipefail
umask 077

if [ "$#" -ne 3 ]; then
  printf 'usage: %s <git-revision> <archive-path> <archive-sha256>\n' "$0" >&2
  exit 2
fi

revision="$1"
archive="$2"
archive_sha256="$3"

case "$revision" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) printf 'Invalid git revision: %s\n' "$revision" >&2; exit 2 ;;
esac
case "$archive_sha256" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;;
  *) printf 'Invalid archive sha256: %s\n' "$archive_sha256" >&2; exit 2 ;;
esac

short_rev="${revision:0:7}"
ops="$(dirname "$archive")"
build="/opt/hatoove/build/$revision"
src="/opt/hatoove/src"
config="/opt/hatoove/config/production.env"

mkdir -p -m 0700 /opt/hatoove/ops /opt/hatoove/build "$ops"
exec 9>/opt/hatoove/ops/deployment.lock
flock -n 9 || { printf 'Another deployment holds /opt/hatoove/ops/deployment.lock.\n' >&2; exit 1; }

printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check

running_migrators="$(docker ps -q --filter label=com.docker.compose.project=hatoove-production --filter label=com.docker.compose.service=migrate)"
test -z "$running_migrators"
test "$(docker inspect hatoove-production-db-1 --format '{{.State.Health.Status}}')" = "healthy"

rm -rf "$build"
mkdir -m 0700 "$build"
tar -xf "$archive" -C "$build"
test ! -e "$build/.env" && test ! -e "$build/.git"

printf 'Building image for revision %s...\n' "$revision"
docker build --pull=false \
  --label "org.opencontainers.image.revision=$revision" \
  --label "org.hatoove.release=DEPLOY-$short_rev" \
  -t "hatoove-app:$short_rev" \
  "$build" > "$ops/build.log" 2>&1

image="$(docker image inspect "hatoove-app:$short_rev" --format '{{.Id}}')"
test "$(docker image inspect "hatoove-app@$image" --format '{{.Id}}')" = "$image"

printf 'Running isolated container & listening-media preflight checks...\n'
docker run --rm --network none --read-only --memory 256m --pids-limit 64 --entrypoint sh "$image" \
  -c 'set -eu; test ! -f /app/.env; test ! -d /app/.git; test "$(id -u)" = 1000'
docker run --rm --network none --read-only --memory 256m --pids-limit 64 "$image" \
  node tools/media-mount-check.mjs --require-recordings > "$ops/media-check.log" 2>&1
grep -E 'PASS|FAIL|referenced recordings' "$ops/media-check.log"
printf '%s\n' "$image" > "$ops/image-id"

dc() {
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    docker compose --project-name hatoove-production --env-file "$config" \
    -f "$src/compose.production.yaml" -f "$src/compose.production.local-db.yaml" "$@"
}

cp -p "$config" "$ops/production.env.before"
rm -rf "$ops/previous-source"
cp -a "$src" "$ops/previous-source"

db_user="$(grep '^HATOVE_PG_ADMIN_USER=' "$config" | cut -d= -f2)"
db_name="$(grep '^OWNAPI_PG_DATABASE=' "$config" | cut -d= -f2)"

printf 'Taking pre-deploy PostgreSQL backup...\n'
docker exec hatoove-production-db-1 sh -c \
  "PGPASSWORD=\$(tr -d '\r\n' < /run/secrets/pg_admin) pg_dump -h 127.0.0.1 -U \"$db_user\" -d \"$db_name\" -Fc" \
  > "$ops/pre-deploy.dump"
test -s "$ops/pre-deploy.dump"

failure_stop() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    dc stop --timeout 60 app worker > "$ops/failure-stop.log" 2>&1 || true
    printf 'failed:%s\n' "$status" > "$ops/deployment-status"
    printf 'Deployment failed (exit %s); app and worker stopped and backup retained in %s.\n' "$status" "$ops" >&2
  fi
  exit "$status"
}
trap failure_stop EXIT

printf 'Stopping app and worker...\n'
dc stop --timeout 60 app worker > "$ops/stop.log" 2>&1
test -z "$(dc ps --status running --quiet app worker)"

rm -rf "$src"
cp -a "$build" "$src"
printf '%s\n' "$revision" > "$src/.reviewed-commit"
sed -i "s|^HATOVE_APP_IMAGE=.*|HATOVE_APP_IMAGE=hatoove-app@$image|" "$config"

printf 'Running fresh migrator...\n'
dc up --no-deps --force-recreate --abort-on-container-exit --exit-code-from migrate migrate > "$ops/migration.log" 2>&1

printf 'Starting app and worker...\n'
dc up -d --no-deps --wait --wait-timeout 120 app worker > "$ops/start.log" 2>&1

for service in app worker; do
  test "$(docker inspect "hatoove-production-$service-1" --format '{{.Image}}')" = "$image"
  test "$(docker inspect "hatoove-production-$service-1" --format '{{.State.Running}}')" = "true"
done
test "$(docker inspect hatoove-production-app-1 --format '{{.State.Health.Status}}')" = "healthy"

ready_code="$(curl --silent --show-error --max-time 15 --output "$ops/ready.json" --write-out '%{http_code}' https://hatoove.com/api/ready)"
test "$ready_code" = "200"
grep -q '"ready":true' "$ops/ready.json"

printf 'succeeded\n' > "$ops/deployment-status"
trap - EXIT
printf 'DEPLOYED revision=%s image=%s ready=200\n' "$revision" "$image"
