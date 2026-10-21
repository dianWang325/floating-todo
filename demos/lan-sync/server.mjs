import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { Store, shortCode } from './store.mjs';
import { Pake, proof, equal, seal, unseal } from './security.mjs';
import { startDiscovery } from './discovery.mjs';

const LIMIT = 512 * 1024;
const MAX_PEERS = 16;
function batches(records) {
  const result = []; let batch = [], bytes = 2;
  for (const r of records) {
    const size = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (size > 128 * 1024) throw new Error('revision byte limit');
    if (batch.length >= 100 || bytes + size > 256 * 1024) { result.push(batch); batch = []; bytes = 2; }
    batch.push(r); bytes += size;
  }
  if (batch.length) result.push(batch);
  return result;
}
const uuid = s => typeof s === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
function privateAddress(host) {
  const p = host.split('.').map(Number);
  return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (p[0] === 10 || p[0] === 127 || p[0] === 192 && p[1] === 168 ||
      p[0] === 172 && p[1] >= 16 && p[1] <= 31 || p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
const context = (a, b, dataset, mode) => [JSON.stringify(['todo-demo/1', dataset, mode, a]), JSON.stringify(['todo-demo/1', dataset, mode, b])];
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
async function readBody(req) {
  let total = 0; const chunks = [];
  for await (const b of req) { total += b.length; if (total > LIMIT) throw new Error('body limit'); chunks.push(b); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export class DemoNode {
  constructor({ dir, datasetId = 'todo-lab-2026-10-21', ip = '127.0.0.1', port = 47831,
    adminPort = 47832, mdns = true, tailscale = false, seeds = [], pollMs = 15000, name = 'demo', discoveryIp = ip }) {
    this.options = { ip, port, adminPort, mdns, tailscale, seeds, pollMs, name, discoveryIp };
    this.store = new Store(dir, datasetId); this.pake = new Pake();
    this.sessions = new Map(); this.candidates = new Map(); this.syncing = new Set();
    this.health = {}; this.paused = false; this.closed = false; this.probing = 0; this.rpcQueues = new Map();
    this.metrics = { requests: 0, rxBytes: 0, txBytes: 0, batches: 0, revisionsReceived: 0, syncs: 0, failures: 0, authRejected: 0 };
    this.cpuStart = process.cpuUsage(); this.started = performance.now();
  }
  get meta() { return this.store.meta; }
  hello() { return { protocol: 'todo-demo/1', id: this.meta.deviceId, name: this.options.name }; }
  async request(url, path, body) {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    this.metrics.txBytes += bytes?.length || 0;
    const response = await fetch(new URL(path, url), { method: bytes ? 'POST' : 'GET',
      body: bytes, headers: bytes ? { 'content-type': 'application/json' } : {},
      redirect: 'error', signal: AbortSignal.timeout(5000) });
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > LIMIT) { await reader.cancel(); throw new Error('response limit'); }
      chunks.push(Buffer.from(value));
    }
    this.metrics.rxBytes += size;
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return result;
  }
  async candidate(url, source) {
    // Discovery is untrusted. Never access paths, userinfo, or public URLs from TXT records.
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.pathname !== '/' ||
        parsed.search || parsed.hash || !privateAddress(parsed.hostname) || this.probing >= 4) return;
    this.probing++;
    try {
      const h = await this.request(url, '/hello');
      if (h.protocol !== 'todo-demo/1' || !uuid(h.id) || h.id === this.meta.deviceId) return;
      for (const [id, entry] of this.candidates) if (Date.now() - entry.seen > 120000) this.candidates.delete(id);
      if (this.candidates.size >= 64 && !this.candidates.has(h.id)) return;
      this.candidates.set(h.id, { ...h, url, source, seen: Date.now() });
      const peer = this.meta.peers[h.id];
      // An advertisement can propose a new address; authenticated sync confirms it.
      if (peer && peer.url !== url) {
        const old = peer.url; peer.url = url;
        try { await this.rpc(h.id, 'status', {}); this.store.save(); this.schedule(); }
        catch { peer.url = old; }
      }
    } finally { this.probing--; }
  }
  chargeAttempt() {
    let limit = this.meta.attempts;
    if (Date.now() - limit.start >= 60000) limit = this.meta.attempts = { start: Date.now(), count: 0 };
    if (limit.count >= 5) { this.metrics.authRejected++; throw new Error('pairing rate limit'); }
    limit.count++; this.store.save(); // Restarting the process cannot reset the budget.
  }
  async pairStart(v) {
    this.chargeAttempt();
    if (!['dynamic', 'fixed'].includes(v.mode) || v.datasetId !== this.meta.datasetId ||
        !uuid(v.id) || v.id === this.meta.deviceId ||
        !/^[a-f0-9]{66}$/.test(v.message)) throw new Error('pairing rejected');
    if (Object.keys(this.meta.peers).length >= MAX_PEERS && !this.meta.peers[v.id]) throw new Error('peer limit');
    this.store.codes();
    const sid = randomUUID(), [a, b] = context(v.id, this.meta.deviceId, v.datasetId, v.mode);
    const code = v.mode === 'fixed' ? this.meta.fixedCode : this.meta.dynamic.code;
    const start = await this.pake.call({ op: 'start', role: 'b', id: sid, code, a, b });
    const { key } = await this.pake.call({ op: 'finish', id: sid, message: v.message });
    for (const [id, s] of this.sessions) if (s.expires < Date.now()) this.sessions.delete(id);
    if (this.sessions.size >= 16) throw new Error('pairing busy');
    const binding = JSON.stringify([a, b, sid, v.message, start.message]);
    this.sessions.set(sid, { id: v.id, key, binding, mode: v.mode,
      epoch: this.meta.dynamic.epoch, fixed: this.meta.fixedCode, expires: Date.now() + 30000 });
    return { sid, message: start.message, proof: proof(key, `server:${binding}`) };
  }
  pairFinish(v) {
    const s = this.sessions.get(v.sid); this.sessions.delete(v.sid);
    if (!s || s.expires < Date.now() ||
      s.mode === 'dynamic' && (s.epoch !== this.meta.dynamic.epoch || this.meta.dynamic.expires <= Date.now()) ||
      s.mode === 'fixed' && s.fixed !== this.meta.fixedCode ||
      !equal(v.proof, proof(s.key, `client:${s.binding}`))) throw new Error('pairing rejected');
    const peer = { key: s.key, send: 0, receive: 0, pairedAt: Date.now(), url: null };
    this.meta.peers[s.id] = peer;
    this.store.save();
    return { proof: proof(s.key, `saved:${s.binding}`) };
  }
  async pair({ url, code, mode = 'dynamic' }) {
    if (!['dynamic', 'fixed'].includes(mode) || !new RegExp(`^\\d{${mode === 'fixed' ? 8 : 6}}$`).test(code)) throw new Error('code format');
    const h = await this.request(url, '/hello');
    if (h.protocol !== 'todo-demo/1' || !uuid(h.id) || h.id === this.meta.deviceId) throw new Error('peer identity');
    if (Object.keys(this.meta.peers).length >= MAX_PEERS && !this.meta.peers[h.id]) throw new Error('peer limit');
    const sid = randomUUID(), [a, b] = context(this.meta.deviceId, h.id, this.meta.datasetId, mode);
    const start = await this.pake.call({ op: 'start', role: 'a', id: sid, code, a, b });
    const r = await this.request(url, '/pair/start', { id: this.meta.deviceId, datasetId: this.meta.datasetId, mode, message: start.message });
    const { key } = await this.pake.call({ op: 'finish', id: sid, message: r.message });
    const binding = JSON.stringify([a, b, r.sid, start.message, r.message]);
    if (!equal(r.proof, proof(key, `server:${binding}`))) throw new Error('incorrect code or identity');
    const done = await this.request(url, '/pair/finish', { sid: r.sid, proof: proof(key, `client:${binding}`) });
    if (!equal(done.proof, proof(key, `saved:${binding}`))) throw new Error('confirmation rejected');
    this.meta.peers[h.id] = { key, url, send: 0, receive: 0, pairedAt: Date.now() };
    this.store.save();
    this.schedule();
    return { paired: h.id };
  }
  async rpc(id, op, body) {
    const previous = this.rpcQueues.get(id) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.rpcOnce(id, op, body));
    this.rpcQueues.set(id, task);
    try { return await task; } finally { if (this.rpcQueues.get(id) === task) this.rpcQueues.delete(id); }
  }
  async rpcOnce(id, op, body) {
    const p = this.meta.peers[id];
    if (!p?.url) throw new Error('peer address unavailable');
    const seq = ++p.send;
    this.store.save(); // Reserve sequence before transmitting; never reuse after a crash.
    const header = { from: this.meta.deviceId, to: id, dataset: this.meta.datasetId, seq, kind: 'request' };
    const r = await this.request(p.url, '/exchange', seal(p.key, header, { op, ...body }));
    if (r.header?.from !== id || r.header.to !== this.meta.deviceId || r.header.dataset !== this.meta.datasetId ||
        r.header.seq !== seq || r.header.kind !== 'response') throw new Error('response identity');
    const result = unseal(p.key, r);
    if (result.error) throw new Error(result.error);
    return result;
  }
  exchange(envelope, remoteAddress) {
    if (this.paused) throw new Error('network paused');
    const h = envelope.header, p = this.meta.peers[h?.from];
    if (!p || h.to !== this.meta.deviceId || h.dataset !== this.meta.datasetId || h.kind !== 'request' ||
      !Number.isSafeInteger(h.seq) || h.seq <= p.receive) { this.metrics.authRejected++; throw new Error('authentication or replay'); }
    const body = unseal(p.key, envelope);
    let result;
    const previous = p.receive;
    p.receive = h.seq;
    try {
      switch (body.op) {
        case 'status': result = { root: this.store.root, count: this.store.index.length }; break;
        case 'inventory': {
          if (!Number.isSafeInteger(body.cursor) || body.cursor < 0) throw new Error('cursor');
          const rows = this.store.index.slice(body.cursor, body.cursor + 256);
          result = { rows, next: body.cursor + rows.length, done: body.cursor + rows.length >= this.store.index.length }; break;
        }
        case 'get': {
          if (!Array.isArray(body.ids) || body.ids.length > 100) throw new Error('batch limit');
          const ids = new Set(body.ids);
          result = { revisions: batches(this.store.doc.revisions.filter(r => ids.has(r.revisionId)))[0] || [] }; break;
        }
        case 'put': {
          const added = this.store.merge(body.revisions);
          this.metrics.batches++; this.metrics.revisionsReceived += added;
          if (added) this.schedule();
          result = { saved: body.revisions.map(r => r.revisionId), added }; break;
        }
        default: throw new Error('operation');
      }
      // Return address is learned only inside an authenticated exchange, never from a claimed URL.
      if (!p.url && /^(\d{1,3}\.){3}\d{1,3}$/.test(remoteAddress)) p.url = `http://${remoteAddress}:${this.options.port}`;
      this.store.save();
    } catch (e) {
      // A valid but rejected message still consumes its replay sequence.
      this.meta.peers[h.from].receive = h.seq;
      try { this.store.save(); } catch { this.meta.peers[h.from].receive = previous; throw e; }
      result = { error: e.message };
    }
    return seal(p.key, { ...h, from: h.to, to: h.from, kind: 'response' }, result);
  }
  schedule(delay = 120) {
    if (this.closed) return;
    clearTimeout(this.trigger);
    this.trigger = setTimeout(() => this.syncAll(), delay);
  }
  async syncPeer(id) {
    if (this.paused || this.closed || this.syncing.has(id) || this.syncing.size >= 2) return;
    const p = this.meta.peers[id], health = this.health[id] ||= { failures: 0, retryAt: 0 };
    if (!p?.url || Date.now() < health.retryAt) return;
    this.syncing.add(id);
    const began = performance.now();
    try {
      const status = await this.rpc(id, 'status', {});
      if (status.root !== this.store.root) {
        const inventory = new Map(); let cursor = 0;
        for (let page = 0; page < 400; page++) {
          const r = await this.rpc(id, 'inventory', { cursor });
          if (!Array.isArray(r.rows) || r.rows.length > 256 || r.next < cursor) throw new Error('inventory');
          for (const row of r.rows) inventory.set(row.id, row.hash);
          cursor = r.next; if (r.done) break;
          if (page === 399) throw new Error('inventory limit');
        }
        const local = new Map(this.store.index.map(r => [r.id, r.hash]));
        for (const [id, hash] of inventory) if (local.has(id) && local.get(id) !== hash) throw new Error('revision equivocation');
        const missing = [...inventory.keys()].filter(id => !local.has(id));
        while (missing.length) {
          const wanted = new Set(missing.slice(0, 100));
          const r = await this.rpc(id, 'get', { ids: [...wanted] });
          if (!Array.isArray(r.revisions) || !r.revisions.length ||
              r.revisions.some(r => !wanted.has(r.revisionId))) throw new Error('incomplete or unsolicited revisions');
          const added = this.store.merge(r.revisions);
          this.metrics.revisionsReceived += added;
          const received = new Set(r.revisions.map(r => r.revisionId));
          for (let i = missing.length - 1; i >= 0; i--) if (received.has(missing[i])) missing.splice(i, 1);
          if (added) this.schedule();
        }
        const outgoing = this.store.doc.revisions.filter(r => !inventory.has(r.revisionId));
        for (const batch of batches(outgoing)) {
          const ack = await this.rpc(id, 'put', { revisions: batch });
          if (JSON.stringify(ack.saved) !== JSON.stringify(batch.map(r => r.revisionId))) throw new Error('incomplete ACK');
        }
      }
      health.failures = 0; health.retryAt = 0; health.lastSuccess = Date.now();
      health.durationMs = performance.now() - began; health.error = null; this.metrics.syncs++;
    } catch (e) {
      health.failures++; health.error = e.message;
      health.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(health.failures - 1, 6));
      this.metrics.failures++;
    } finally { this.syncing.delete(id); }
  }
  async syncAll() {
    const ids = Object.keys(this.meta.peers);
    for (let i = 0; i < ids.length; i += 2) await Promise.all(ids.slice(i, i + 2).map(id => this.syncPeer(id)));
  }
  status(full = true) {
    const usage = process.cpuUsage(this.cpuStart);
    return { ...this.hello(), ...(full ? this.store.summary() : { count: this.store.index.length, root: this.store.root }),
      peers: Object.entries(this.meta.peers).map(([id, p]) => ({ id, url: p.url, pairedAt: p.pairedAt, ...this.health[id] })),
      candidates: [...this.candidates.values()], paused: this.paused, metrics: this.metrics,
      resources: { rss: process.memoryUsage().rss, heapUsed: process.memoryUsage().heapUsed,
        cpuMicros: usage.user + usage.system, uptimeMs: performance.now() - this.started } };
  }
  async control(v) {
    switch (v.op) {
      case 'status': return this.status(v.full !== false);
      case 'codes': return this.store.codes();
      case 'rotate': this.sessions.clear(); return this.store.codes(true);
      case 'reset-fixed': this.sessions.clear(); this.meta.fixedCode = shortCode(8); this.store.save(); return this.store.codes();
      case 'pair': return this.pair(v);
      case 'pause': this.paused = !!v.value; if (!this.paused) { for (const h of Object.values(this.health)) h.retryAt = 0; this.schedule(); } return { paused: this.paused };
      case 'edit': { const r = this.store.edit(v); this.schedule(); return r; }
      case 'resolve': { const r = this.store.resolve(v.key, v.revisionId); this.schedule(); return r; }
      case 'sync': for (const h of Object.values(this.health)) h.retryAt = 0; await this.syncAll(); return this.status(false);
      case 'seed': await this.candidate(v.url, 'manual'); return this.status(false);
      case 'revoke': delete this.meta.peers[v.id]; this.store.save(); return { revoked: v.id };
      default: throw new Error('control operation');
    }
  }
  async start() {
    this.server = http.createServer(async (req, res) => {
      this.metrics.requests++;
      try {
        if (req.method === 'GET' && req.url === '/hello') return json(res, 200, this.hello());
        if (req.method !== 'POST') return json(res, 404, { error: 'route' });
        const v = await readBody(req); this.metrics.rxBytes += JSON.stringify(v).length;
        let result;
        if (req.url === '/pair/start') result = await this.pairStart(v);
        else if (req.url === '/pair/finish') result = this.pairFinish(v);
        else if (req.url === '/exchange') result = this.exchange(v, req.socket.remoteAddress?.replace(/^::ffff:/, ''));
        else return json(res, 404, { error: 'route' });
        this.metrics.txBytes += JSON.stringify(result).length;
        json(res, 200, result);
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    this.server.maxConnections = 32; this.server.requestTimeout = 8000; this.server.headersTimeout = 5000;
    this.server.setTimeout(8000, socket => socket.destroy());
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.port, this.options.ip, resolve); });
    this.options.port = this.server.address().port;
    this.admin = http.createServer(async (req, res) => {
      try {
        if (!equal(req.headers.authorization, `Bearer ${this.meta.adminToken}`)) return json(res, 403, { error: 'admin authentication' });
        if (req.method !== 'POST' || req.url !== '/control') return json(res, 404, { error: 'route' });
        json(res, 200, await this.control(await readBody(req)));
      } catch (e) { json(res, 400, { error: e.message }); }
    });
    this.admin.requestTimeout = 8000;
    await new Promise((resolve, reject) => { this.admin.once('error', reject); this.admin.listen(this.options.adminPort, '127.0.0.1', resolve); });
    this.options.adminPort = this.admin.address().port;
    this.stopDiscovery = startDiscovery({ ...this.options, ip: this.options.discoveryIp, id: this.meta.deviceId, onCandidate: (url, source) => this.candidate(url, source) });
    this.interval = setInterval(() => this.syncAll(), this.options.pollMs);
    this.schedule();
    return this;
  }
  async close() {
    this.closed = true; clearTimeout(this.trigger); clearInterval(this.interval); this.stopDiscovery?.();
    this.server?.closeAllConnections(); this.admin?.closeAllConnections();
    await Promise.all([this.server, this.admin].filter(Boolean).map(s => new Promise(resolve => s.close(resolve))));
    while (this.syncing.size) await new Promise(resolve => setTimeout(resolve, 20));
    this.pake.close(); this.store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const node = await new DemoNode({ dir: process.env.DEMO_STATE || './state', datasetId: process.env.DATASET_ID,
    ip: process.env.BIND_IP || '127.0.0.1', port: Number(process.env.PORT || 47831),
    adminPort: Number(process.env.ADMIN_PORT || 47832), name: process.env.DEMO_NAME || 'demo',
    discoveryIp: process.env.DISCOVERY_IP || process.env.BIND_IP || '127.0.0.1',
    mdns: process.env.MDNS !== '0', tailscale: process.env.TAILSCALE === '1',
    seeds: (process.env.SEEDS || '').split(',').filter(Boolean) }).start();
  console.log(JSON.stringify({ ready: true, ...node.hello(), port: node.options.port }));
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await node.close(); process.exit(0); });
}
