#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Smoke test for the self-hosted image: run it the way the Quadlet unit does
# (read-only root, no capabilities, tmpfs /tmp, data volume, pepper as a
# file secret) and check health, the app shell, the image healthcheck and the
# build metadata.
# Usage: scripts/container-smoke.sh <image>
set -euo pipefail

image="${1:?usage: $0 <image>}"
name="someday-smoke-$$"
volume="someday-smoke-$$"
secrets="$(mktemp -d)"
cleanup() {
  podman rm -f "$name" >/dev/null 2>&1 || true
  podman volume rm -f "$volume" >/dev/null 2>&1 || true
  rm -rf "$secrets"
}
trap cleanup EXIT

head -c 48 /dev/urandom | base64 > "$secrets/token_pepper"
chmod 644 "$secrets/token_pepper"

podman run -d --name "$name" \
  --read-only --tmpfs /tmp --cap-drop all --security-opt no-new-privileges \
  -v "$volume:/data" -v "$secrets/token_pepper:/run/secrets/token_pepper:ro,Z" \
  -p 127.0.0.1:18080:8080 \
  -e PUBLIC_ORIGIN=http://localhost:18080 \
  -e TOKEN_PEPPER_FILE=/run/secrets/token_pepper \
  -e BOOTSTRAP_ADMIN_TOKEN=smoke-test-bootstrap-token-0123 \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:18080/healthz >/dev/null 2>&1; then break; fi
  sleep 1
done

health="$(curl -fsS http://127.0.0.1:18080/api/health)"
echo "health: $health"
grep -q '"status":"ok"' <<<"$health"
grep -q '"config_errors":\[\]' <<<"$health"

# Capture before grepping: `cmd | grep -q` exits at the first match, the writer
# gets SIGPIPE and pipefail turns that into exit 141.
shell="$(curl -fsS http://127.0.0.1:18080/)"
grep -q '<div id="app">' <<<"$shell"
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/assets/missing.js)" = 404
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/settings)" = 401

podman healthcheck run "$name"
podman exec "$name" cat /etc/build-info
logs="$(podman logs "$name")"
grep -q 'migrations applied' <<<"$logs"
echo "container smoke test OK"
