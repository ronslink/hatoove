#!/usr/bin/env bash
# Install the reviewed Compose release in every location docker resolves plugins from.
#
# Why this exists: `production-compose-check.mjs --compose` renders the production pair and
# asserts the JSON strictly, and `production-runtime-check.mjs` does the same. Both spawn
# docker with an isolated HOME and DOCKER_CONFIG, so a plugin installed only in the user
# directory is invisible to them and the render silently falls back to the system plugin.
# A Compose release whose JSON dialect differs then looks like an unsafe configuration
# (the 2.38.2 family omits an explicit bind.create_host_path).
#
# The version and checksum below are the single source for CI, and they match the release
# the droplet runs (docker-compose-plugin 5.6.0-1~ubuntu.24.04~noble).
set -eu

version=5.6.0
sha256=40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a
asset="https://github.com/docker/compose/releases/download/v${version}/docker-compose-linux-x86_64"

as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 --retry-delay 2 -o "$tmp/docker-compose" "$asset"
echo "${sha256}  $tmp/docker-compose" | sha256sum -c -
chmod 0755 "$tmp/docker-compose"

replaced=0
for dir in /usr/local/lib/docker/cli-plugins /usr/local/libexec/docker/cli-plugins \
           /usr/lib/docker/cli-plugins /usr/libexec/docker/cli-plugins; do
  if [ -e "$dir/docker-compose" ]; then
    as_root install -m 0755 "$tmp/docker-compose" "$dir/docker-compose"
    replaced=$((replaced + 1))
  fi
done
mkdir -p "$HOME/.docker/cli-plugins"
install -m 0755 "$tmp/docker-compose" "$HOME/.docker/cli-plugins/docker-compose"
# Fail closed: if no system plugin directory was found, the checker's sandbox would still
# resolve a different release and the version guard would fail for the wrong reason.
[ "$replaced" -ge 1 ]

# Prove the release the sandboxed checker will actually resolve, in the same shape the
# checker uses (isolated HOME and DOCKER_CONFIG).
scratch="$(mktemp -d)"
mkdir -p "$scratch/docker"
HOME="$scratch" DOCKER_CONFIG="$scratch/docker" docker compose version --short | grep -qx "$version"
rm -rf "$scratch"
echo "compose plugin pinned to $version in $replaced system director(y|ies) and the user directory"
