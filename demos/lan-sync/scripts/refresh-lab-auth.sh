#!/bin/bash
set -euo pipefail
# Reauthorize only synthetic lab devices after changing the lab expiry policy.
for id in 971 972 973; do
  authkey=$(pct exec 974 -- /usr/local/bin/headscale -c /etc/headscale/config.yaml preauthkeys create --user 1 --expiration 1h)
  pct exec "$id" -- /opt/tailscale/tailscale up --force-reauth --login-server http://10.77.42.5:8080 \
    --auth-key "$authkey" --accept-dns=false --hostname "todo-lab-$id" --timeout=30s
  unset authkey
  pct exec "$id" -- /opt/tailscale/tailscale ip -4
done
