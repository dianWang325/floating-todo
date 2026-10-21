#!/bin/bash
set -euo pipefail
mkdir -p /etc/headscale /var/lib/headscale /var/run/headscale
chmod 700 /var/lib/headscale /var/run/headscale
cat >/etc/systemd/system/todo-headscale.service <<'EOF'
[Unit]
Description=Isolated Todo demo Headscale control
After=network-online.target
[Service]
ExecStart=/usr/local/bin/headscale -c /etc/headscale/config.yaml serve
Restart=on-failure
RestartSec=3
MemoryMax=128M
CPUQuota=30%
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now todo-headscale
systemctl disable --now postfix.service cron.service 2>/dev/null || true
