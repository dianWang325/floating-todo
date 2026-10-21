#!/bin/bash
set -euo pipefail
# Run inside a newly provisioned demo container after unpacking /opt/todo-demo.
ip="$1"
name="$2"
id todo-demo >/dev/null 2>&1 || useradd --system --home /var/lib/todo-demo --create-home todo-demo
chown todo-demo:todo-demo /var/lib/todo-demo
chmod 700 /var/lib/todo-demo
cat >/etc/systemd/system/todo-sync-demo.service <<EOF
[Unit]
Description=Floating Todo LAN sync feasibility demo
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=todo-demo
WorkingDirectory=/opt/todo-demo/demos/lan-sync
Environment=DEMO_STATE=/var/lib/todo-demo
Environment=BIND_IP=$ip
Environment=DEMO_NAME=$name
Environment=NODE_NO_WARNINGS=1
ExecStart=/opt/node/bin/node server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/todo-demo
MemoryMax=160M
CPUQuota=40%
TasksMax=32
LimitNOFILE=256
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now todo-sync-demo
# These template services are unnecessary in disposable test guests.
systemctl disable --now postfix.service cron.service 2>/dev/null || true
