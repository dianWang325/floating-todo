# 局域网与 Tailscale 同步可行性 demo

这是独立的合成数据实验，不读取桌面应用数据，不修改正式应用的同步流程。
版本合并直接使用仓库的 `src/sync-model.js`，测试任务、删除版本与冲突分支采用现有模型。

实测结论与原始数据索引见 [报告](reports/assessment.md)。

## 部署

宿主机：`root@192.168.11.10`，Proxmox。

| LXC | 用途 | 独立 LAN 地址 | 隔离 Tailscale 地址 |
| --- | --- | --- | --- |
| 971 | 同步 A | 10.77.42.2 | 100.100.42.1 |
| 972 | 同步 B | 10.77.42.3 | 100.100.42.2 |
| 973 | 同步 C | 10.77.42.4 | 100.100.42.3 |
| 974 | 实验 Headscale 控制平面 | 10.77.42.5 | 无 |

每个容器上限 256 MiB、0.5 核，均为非特权容器，不随宿主机自动启动。
应用服务上限 160 MiB/40% 单核，Tailscale 另限 96 MiB/30%，仍受容器总体上限约束。
应用服务以 `todo-demo` 用户运行；管理员 API 仅监听容器 localhost，要求随机凭据。
第一轮实测使用表中的隔离 Headscale 网络。2026-10-21 按用户要求迁入
`https://headscale.skobalt.top`，三个 `todo-lab-971/972/973` 节点已获管理端授权，
当前 IPv4 依次为 `100.64.0.5`、`100.64.0.6`、`100.64.0.9`，VPN 状态均为 Running。
应用已绑定新地址恢复运行，数据库和应用配对关系保留；宿主机的 Tailscale 登录未更改。
原 VPN 状态备份位于各节点 `/var/lib/tailscale/pre-existing-headscale/`。
管理端放行三个测试 IP 之间的 TCP 47831 后，原配对自动迁移到新地址，
迁移前 1553 个版本完整保留。现有网络的发现、双短码、自动同步、冲突恢复及 VPN 重连测试全部通过。
结果见 `reports/existing-headscale-results.json`；隔离控制容器 974 已停止，保留用于回退。
发现探测按最多四个并发分批执行，避免现有网络中其他设备占满并发后遗漏测试节点。
隔离网络的实验设备授权不自动过期；新网络的有效期遵循管理端策略。

代码在 `/opt/todo-demo/demos/lan-sync`，状态在 `/var/lib/todo-demo/demo.sqlite3`。
`ft-demo0` 是临时专用网桥，宿主机重启后需要手动恢复；不是生产网络配置。

## 在 Mac mini 上操作

在仓库目录运行：

```sh
node demos/lan-sync/scripts/remote.mjs 971 status
node demos/lan-sync/scripts/remote.mjs 972 codes
node demos/lan-sync/scripts/remote.mjs 972 rotate
node demos/lan-sync/scripts/remote.mjs 971 '{"op":"edit","title":"来自 Mac 操作台的测试任务"}'
node demos/lan-sync/scripts/remote.mjs 973 '{"op":"status","full":true}'
```

`codes` 显示当前 6 位临时码、8 位固定码和临时码到期时间。临时码有效期 60 秒，
到期后在读取或配对时生成新码，也可立即 `rotate`；`reset-fixed` 更换固定码。
读取短码不会把它们广播到发现服务。更换短码不撤销已建立的配对。

首次配对时，在发起节点输入目标节点的一个短码：

```sh
node demos/lan-sync/scripts/remote.mjs 971 \
  '{"op":"pair","url":"http://100.64.0.6:47831","mode":"dynamic","code":"目标节点当前6位码"}'
```

固定码使用 `"mode":"fixed"` 与目标的 8 位码。重配对会更换两台设备间的凭据；
这是实验操作，应在暂停同步时进行。查看 `status` 的候选设备、同步目标和错误。
`{"op":"pause","value":true}` 暂停网络交换，恢复时把 `value` 改为 `false`。
冲突可通过 `{"op":"resolve","key":"task:任务UUID","revisionId":"希望采用的版本UUID"}` 解决。

## 协议与资源控制

- LAN：mDNS/DNS-SD，30 秒查询、60 秒通告；120 秒清理过期候选。Linux 使用通配 UDP 绑定，
  由指定接口控制组播加入和发送。
- Tailscale：每 30 秒读取本机 `tailscale status --json`，最多探测 32 个在线候选；
  不扫描整个地址段。服务身份和版本经单播探测确认，短码配对仍是独立步骤。
- 配对：Rust `spake2` 实现 PAKE，双方身份、数据集、短码类型与握手消息绑定，
  双向 HMAC 确认后保存设备对之间的随机强密钥。原始短码不在网络中发送。
- 临时码刷新或到期拒绝未完成的旧握手。每设备全局 5 次握手/分钟，计数持久化，
  不因重启重置；16 个已配对设备上限。限流按握手开始计费，成功配对同样占用额度。
- 数据消息使用 AES-256-GCM、HKDF 派生方向密钥、随机 nonce、持久化序号防重放，
  响应绑定请求序号。重试重新对账，不重复应用版本。
- 按版本 ID 与规范化内容哈希分页对账，保留父版本、删除标记及冲突分支；
  每页 256 项，每批最多 100 版本且 JSON 不超过 256 KiB，单版本上限 128 KiB。
- 修改后 120 ms 合并调度；每节点最多两个同步目标并发，每目标 RPC 串行。
  空闲时 15 秒轻量摘要核对；失败退避到 60 秒，实际重试在调度触发时执行。
- SQLite WAL、`synchronous=FULL`，版本和接收状态事务保存之后确认。
  只有一个业务写入者。同步经版本集合传播，转发不重写作者、ID 或修改时间。
- 实验拒绝超前本机超过 5 分钟的版本，避免异常时钟推进逻辑时钟。

## 构建与复测

Mac mini 已有 Node 24 和 Rust，Rust PAKE 在 macOS arm64 与 Debian amd64 上分别实际编译。
Linux Node 使用官方 24.22.0 tarball，Tailscale 使用官方 1.104.1 tarball，
Headscale 为官方 0.29.5 二进制；下载均做 SHA-256 核对。

```sh
cd demos/lan-sync
npm ci --ignore-scripts
npm run build
npm test
```

`test/integration.test.mjs` 验证双短码、失效握手、限流持久化、重放/篡改、
冲突保留与替换、离线补齐、丢失确认、崩溃后持久状态、1,000 版本分页与大记录字节分批。
`node --test ../../tests/sync-model.test.js` 单独验证原有合并规则。

部署脚本只针对已列出的实验容器：

- `scripts/provision.sh`：创建三个容器及网桥，已有 ID 时直接停止。
- `scripts/service.sh`：容器内创建受限应用服务。
- `scripts/lab.py`：宿主机上的完整 LAN 测试，控制 API 通过容器网络命名空间访问。
- `scripts/benchmark.py`：保存最终 LAN 延迟原始样本，P95 使用 nearest-rank。
- `scripts/headscale.yaml`、`headscale-service.sh`：隔离控制平面配置。
- `scripts/tailscale-lab.sh`：为三个新容器映射 TUN，使用独立的一小时单次注册密钥加入实验网络。
- `scripts/overlay-mode.sh`：服务仅绑定 Tailscale IP，关闭 mDNS，启用 Tailscale 节点发现。
- `scripts/overlay-test.py`：验证发现来源、物理地址不可用、双短码、冲突、VPN 断线恢复与开销。
- `scripts/soak.py`：真实三节点追加 1,000 次修改，再持续同步五分钟。
- `scripts/resources.py`：空闲时测量服务 cgroup 与网卡字节差值。

这些脚本记录实际部署步骤，依赖文中模板、二进制和文件路径，不是通用的一键安装器。
重复执行测试会增加合成任务；不要对真实数据目录运行。

## 实验边界

本 demo 的 PAKE 库尚无独立安全审计（[库的安全说明](https://docs.rs/spake2/0.4.0/spake2/)）；
固定码与配对密钥存放在权限受限的实验 SQLite 中。
应用层 AEAD 协议不是经过审计的完整生产传输协议，重连没有前向保密。
正式接入应使用系统安全存储，并评估经过审计的 PAKE 与 TLS/Noise 集成。
测试控制平面 HTTP 仅存在于专用桥接网络，正式控制平面应使用 HTTPS。

三台 LXC 共享宿主机与时钟。真实 Tailscale 测试覆盖同宿主机上的 WireGuard 直连隧道，
不能代表跨运营商 NAT、DERP 中继、Wi-Fi 漫游、异构设备或长期运行。
当前发现探测使用 IPv4；纯 IPv6 网络、系统防火墙授权与手机后台均未覆盖。
短期稳定性测试不能证明不存在长期故障。

Node 服务是可测量的模型原型。正式 Tauri 应用应复用现有前端运行环境并把网络服务放入 Rust，
无需额外打包 Node；demo 的 RSS 不能直接等同于正式应用的新增内存。

参考：[Tailscale LXC 配置](https://tailscale.com/kb/1130/lxc-unprivileged/)、
[Headscale 注册机制](https://headscale.net/stable/ref/registration/)、
[DNS-SD 标准](https://www.rfc-editor.org/info/rfc6763/)。

## 停止与清理

停止实验可在宿主机执行 `pct stop 971`、`pct stop 972`、`pct stop 973`、`pct stop 974`。
数据保留，容器不会自动随宿主机启动。恢复 LAN 模式时，移除三个容器中的
`/etc/systemd/system/todo-sync-demo.service.d/overlay.conf`，再 reload/restart 应用服务。
删除容器、数据库或专用网桥属于清理步骤，需确认不再保留本次实验后再执行。
