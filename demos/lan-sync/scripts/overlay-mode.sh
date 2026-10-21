#!/bin/bash
set -euo pipefail
for id in 971 972 973; do
  address=$(pct exec "$id" -- /opt/tailscale/tailscale ip -4)
  pct exec "$id" -- mkdir -p /etc/systemd/system/todo-sync-demo.service.d
  pct exec "$id" -- sh -c 'cat > /etc/systemd/system/todo-sync-demo.service.d/overlay.conf' <<EOF
[Service]
Environment=BIND_IP=$address
Environment=MDNS=0
Environment=TAILSCALE=1
Environment=PATH=/usr/local/bin:/opt/node/bin:/usr/bin:/bin
EOF
  pct exec "$id" -- systemctl daemon-reload
  pct exec "$id" -- systemctl restart todo-sync-demo
done
