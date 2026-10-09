#!/usr/bin/env bash
# Applies a Kong declarative configuration on the VPS. Run over SSH by ci-cd.yml and rollback.yml.
#
# Inputs (environment):
#   CONTAINER_NAME      container and /opt/parc/<name> state directory
#   KONG_IMAGE          pinned Kong image, e.g. kong:3.9.3
#   REVISION            git commit of the configuration (recorded for rollback)
#   KONG_CONFIG_BASE64  configuration to apply; omit with USE_PREVIOUS=true
#   USE_PREVIOUS        "true" re-applies the configuration that ran before the current one
#
# Kong holds no secrets, so there is no .env. The configuration is the deployable unit: the
# previous one is kept beside it, and a failed health check restores the last known-good one.
set -euo pipefail

: "${CONTAINER_NAME:?}" "${KONG_IMAGE:?}"
USE_PREVIOUS="${USE_PREVIOUS:-false}"
REVISION="${REVISION:-unknown}"

STATE_ROOT=/opt/parc
STATE_DIR="$STATE_ROOT/$CONTAINER_NAME"
# Mounted read-only into the container; Kong runs as a non-root user, so it must be world-readable.
CONFIG_DIR="$STATE_DIR/config"
ACTIVE="$CONFIG_DIR/kong.yml"
PREVIOUS="$STATE_DIR/kong.previous.yml"
CANDIDATE="$STATE_DIR/kong.candidate.yml"
LAST_GOOD="$STATE_DIR/kong.last-good.yml"
STATUS_URL=http://127.0.0.1:8100/status

if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
  echo "Cannot create $STATE_DIR. Prepare the server once: sudo mkdir -p $STATE_ROOT && sudo chown $(id -un):$(id -gn) $STATE_ROOT" >&2
  exit 1
fi
chmod 700 "$STATE_DIR"
mkdir -p "$CONFIG_DIR"
chmod 755 "$CONFIG_DIR"

if [ "$USE_PREVIOUS" = true ]; then
  if [ ! -f "$PREVIOUS" ]; then
    echo "No rollback target available: pass a ref, or deploy at least twice first so a previous configuration is recorded." >&2
    exit 1
  fi
  cp "$PREVIOUS" "$CANDIDATE"
  REVISION=$(cat "$STATE_DIR/previous_revision.txt" 2>/dev/null || echo unknown)
else
  : "${KONG_CONFIG_BASE64:?}"
  printf '%s' "$KONG_CONFIG_BASE64" | base64 -d >"$CANDIDATE"
fi
chmod 644 "$CANDIDATE"

echo "Pulling $KONG_IMAGE"
docker pull "$KONG_IMAGE"

# Reject a bad configuration before touching the running gateway.
docker run --rm --network none \
  -e KONG_DATABASE=off \
  -v "$CANDIDATE:/kong/candidate.yml:ro" \
  "$KONG_IMAGE" kong config parse /kong/candidate.yml

stop_gateway() {
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

start_gateway() {
  # Every listener is loopback-only: Caddy terminates TLS on 443 and proxies to 8090.
  # The BFFs also run with --network host, so their service names resolve to loopback.
  # Caddy is the only trusted proxy, which makes rate limiting key on the real client address.
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart always \
    --network host \
    --read-only \
    --tmpfs /tmp \
    --add-host parc-mobile-bff:127.0.0.1 \
    --add-host parc-admin-bff:127.0.0.1 \
    -e KONG_DATABASE=off \
    -e KONG_PREFIX=/tmp/kong \
    -e KONG_DECLARATIVE_CONFIG=/kong/declarative/kong.yml \
    -e KONG_PROXY_LISTEN=127.0.0.1:8090 \
    -e KONG_ADMIN_LISTEN=127.0.0.1:8091 \
    -e KONG_ADMIN_GUI_LISTEN=off \
    -e KONG_STATUS_LISTEN=127.0.0.1:8100 \
    -e KONG_TRUSTED_IPS=127.0.0.1,::1 \
    -e KONG_REAL_IP_HEADER=X-Forwarded-For \
    -e KONG_REAL_IP_RECURSIVE=on \
    -e KONG_PROXY_ACCESS_LOG=/dev/stdout \
    -e KONG_ADMIN_ACCESS_LOG=/dev/stdout \
    -e KONG_PROXY_ERROR_LOG=/dev/stderr \
    -e KONG_ADMIN_ERROR_LOG=/dev/stderr \
    -v "$CONFIG_DIR:/kong/declarative:ro" \
    "$KONG_IMAGE"
}

gateway_ready() {
  curl --fail --silent --max-time 2 "$STATUS_URL" >/dev/null
}

wait_until_ready() {
  # Give crash-looping containers time to show up as restarts before the first probe.
  sleep 5
  for _ in $(seq 1 20); do
    gateway_ready && return 0
    sleep 3
  done
  return 1
}

rm -f "$LAST_GOOD"
[ -f "$ACTIVE" ] && cp "$ACTIVE" "$LAST_GOOD"
LAST_GOOD_REVISION=$(cat "$STATE_DIR/current_revision.txt" 2>/dev/null || echo unknown)
mv "$CANDIDATE" "$ACTIVE"

echo "Replacing the gateway container with revision $REVISION..."
stop_gateway
start_gateway

if wait_until_ready; then
  if [ -f "$LAST_GOOD" ]; then
    mv "$LAST_GOOD" "$PREVIOUS"
    echo "$LAST_GOOD_REVISION" >"$STATE_DIR/previous_revision.txt"
  fi
  echo "$REVISION" >"$STATE_DIR/current_revision.txt"
  echo "Gateway deploy succeeded: revision $REVISION"
  # A BFF being down is not a gateway failure, so only report upstream reachability.
  for route in /mobile/health/live /admin/health/live; do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:8090$route" >/dev/null; then
      echo "Upstream reachable: $route"
    else
      echo "Warning: $route is not reachable through Kong; check the BFF container." >&2
    fi
  done
  docker image prune -af --filter "until=72h"
else
  echo "Gateway failed its status check; restoring the last known-good configuration." >&2
  docker logs --tail 50 "$CONTAINER_NAME" >&2 || true
  stop_gateway
  if [ -f "$LAST_GOOD" ]; then
    mv "$LAST_GOOD" "$ACTIVE"
    start_gateway
  fi
  exit 1
fi
