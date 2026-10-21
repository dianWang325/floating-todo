import mdnsFactory from 'multicast-dns';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const SERVICE = '_floatingtodo._tcp.local';

export async function probeInBatches(entries, probe) {
  for (let i = 0; i < entries.length; i += 4) {
    await Promise.allSettled(entries.slice(i, i + 4).map(probe));
  }
}

export function startDiscovery({ id, ip, port, onCandidate, tailscale = false, seeds = [], mdns = true }) {
  const timers = [], discovered = new Map();
  let stopped = false, scanning = false;
  const candidate = (url, source) => {
    for (const [address, time] of discovered) if (Date.now() - time > 120000) discovered.delete(address);
    const last = discovered.get(url) || 0;
    if (Date.now() - last < 25000 || discovered.size >= 128 && !discovered.has(url)) return;
    discovered.set(url, Date.now());
    return Promise.resolve(onCandidate(url, source)).catch(() => {});
  };
  let socket;
  if (mdns && ip) {
    // Bind wildcard to receive packets addressed to the multicast group on Linux.
    // `interface` selects membership and egress; binding to that unicast IP drops group traffic.
    socket = mdnsFactory({ bind: '0.0.0.0', interface: ip, ip: '224.0.0.251', multicast: true });
    socket.on('error', () => {});
    const instance = `${id}.${SERVICE}`;
    const host = `${id}.local`;
    const announce = () => socket.respond({ answers: [
      { name: SERVICE, type: 'PTR', ttl: 120, data: instance },
      { name: instance, type: 'SRV', ttl: 120, data: { port, target: host, weight: 0, priority: 0 } },
      { name: host, type: 'A', ttl: 120, data: ip },
      { name: instance, type: 'TXT', ttl: 120, data: ['protocol=demo-1'] }
    ] });
    socket.on('query', q => {
      if (q.questions.some(x => [SERVICE, instance, host].includes(x.name))) announce();
    });
    socket.on('response', packet => {
      const records = [...(packet.answers || []), ...(packet.additionals || [])];
      for (const srv of records.filter(r => r.type === 'SRV' && r.name.endsWith('.' + SERVICE) && r.name !== instance)) {
        const addr = records.find(r => r.name === srv.data.target && r.type === 'A');
        if (addr) candidate(`http://${addr.data}:${srv.data.port}`, 'mdns');
      }
    });
    const query = () => socket.query([{ name: SERVICE, type: 'PTR' }]);
    socket.on('ready', () => { announce(); query(); });
    timers.push(setInterval(query, 30000), setInterval(announce, 60000));
  }
  async function scan() {
    if (scanning || stopped) return;
    scanning = true;
    try {
      await probeInBatches(seeds.slice(0, 32), url => candidate(url, 'seed'));
      if (tailscale) {
        const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: 4000, maxBuffer: 512 * 1024 });
        const status = JSON.parse(stdout);
        if (status.BackendState !== 'Running') return;
        await probeInBatches(Object.values(status.Peer || {}).filter(p => p.Online).slice(0, 32), peer => {
          const ip = peer.TailscaleIPs?.find(a => !a.includes(':'));
          if (ip && !stopped) return candidate(`http://${ip}:${port}`, 'tailscale');
        });
      }
    } catch { /* Not installed/logged in is a supported offline state. */ }
    finally { scanning = false; }
  }
  scan();
  timers.push(setInterval(scan, 30000));
  return () => { stopped = true; timers.forEach(clearInterval); socket?.destroy(); };
}
