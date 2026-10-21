#!/bin/bash
set -euo pipefail
# Run on the lab Proxmox host after the LAN run has finished.
# Uses only the dedicated Headscale at 10.77.42.5, never the host's tailnet.
for id in 971 972 973; do
  pct stop "$id"
  pct set "$id" --dev0 /dev/net/tun
  pct start "$id"
  pct push "$id" /tmp/todo-tailscale.tgz /tmp/tailscale.tgz
  pct exec "$id" -- sh -c 'mkdir -p /opt/tailscale /var/lib/tailscale; tar -xzf /tmp/tailscale.tgz -C /opt/tailscale --strip-components=1; ln -sf /opt/tailscale/tailscale /usr/local/bin/tailscale'
  pct exec "$id" -- sh -c 'cat > /etc/systemd/system/todo-tailscaled.service' <<'UNIT'
[Unit]
Description=Isolated Todo demo Tailscale
After=network-online.target
[Service]
ExecStart=/opt/tailscale/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock --port=41641
Restart=on-failure
MemoryMax=96M
CPUQuota=30%
[Install]
WantedBy=multi-user.target
UNIT
  pct exec "$id" -- systemctl daemon-reload
  pct exec "$id" -- systemctl enable --now todo-tailscaled
  # The one-hour, single-use synthetic key is kept off terminal output and out of git.
  authkey=$(pct exec 974 -- /usr/local/bin/headscale -c /etc/headscale/config.yaml preauthkeys create --user 1 --expiration 1h)
  pct exec "$id" -- /opt/tailscale/tailscale up --login-server http://10.77.42.5:8080 --auth-key "$authkey" --accept-dns=false --hostname "todo-lab-$id" --timeout=30s
  unset authkey
done
