#!/bin/bash
set -euo pipefail
# Run on the explicitly selected Proxmox host. Never modifies existing guests.
for id in 971 972 973; do
  test ! -e "/etc/pve/lxc/$id.conf"
  test ! -e "/etc/pve/qemu-server/$id.conf"
done
if ip link show ft-demo0 >/dev/null 2>&1; then
  echo "ft-demo0 already exists; inspect before provisioning" >&2
  exit 1
fi
ip link add ft-demo0 type bridge
ip addr add 10.77.42.1/29 dev ft-demo0
ip link set ft-demo0 up
for i in 1 2 3; do
  id=$((970+i))
  pct create "$id" local:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
    --hostname "todo-sync-demo-$i" --unprivileged 1 \
    --rootfs nvme:4 --memory 256 --swap 128 --cores 1 --cpulimit 0.5 \
    --net0 "name=eth0,bridge=vmbr0,ip=dhcp,type=veth" \
    --net1 "name=eth1,bridge=ft-demo0,ip=10.77.42.$((i+1))/29,type=veth" \
    --onboot 0 --description "Floating Todo isolated sync demo; disposable synthetic data; 2026-10-21"
  pct start "$id"
done
