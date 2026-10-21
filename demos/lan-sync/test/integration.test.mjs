import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DemoNode } from '../server.mjs';
import { Pake, proof, seal, unseal } from '../security.mjs';
import { Store } from '../store.mjs';

const delay = ms => new Promise(r => setTimeout(r, ms));
async function fixture(n = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'todo-lan-test-')), nodes = [];
  for (let i = 0; i < n; i++) nodes.push(await new DemoNode({ dir: join(dir, String(i)), port: 0, adminPort: 0, mdns: false, pollMs: 60000 }).start());
  return { nodes, dir, close: async () => { await Promise.all(nodes.map(n => n.close())); rmSync(dir, { recursive: true, force: true }); } };
}
const url = n => `http://127.0.0.1:${n.options.port}`;
async function pair(a, b, mode = 'dynamic') {
  await a.pair({ url: url(b), mode, code: b.store.codes()[mode] });
  b.meta.peers[a.meta.deviceId].url = url(a); b.store.save();
}
async function converge(nodes) {
  for (let i = 0; i < 5; i++) {
    for (const n of nodes) { for (const h of Object.values(n.health)) h.retryAt = 0; await n.syncAll(); }
    if (nodes.every(n => n.store.root === nodes[0].store.root)) return;
  }
  assert.equal(new Set(nodes.map(n => n.store.root)).size, 1, 'all version sets converge');
}

test('dynamic + persistent short codes, three-way relay, independent edits and idempotency', async () => {
  const f = await fixture(); const [a, b, c] = f.nodes;
  try {
    await pair(a, b); await pair(b, c, 'fixed');
    a.store.edit({ title: 'from A' }); c.store.edit({ title: 'from C' });
    await converge(f.nodes);
    assert.equal(a.store.index.length, 2);
    assert.equal(a.store.summary().conflicts.length, 0);
    const root = a.store.root;
    await converge(f.nodes); assert.ok(f.nodes.every(n => n.store.root === root && n.store.index.length === 2));
    assert.equal(Object.keys(a.meta.peers).length, 1, 'trust is not transitively granted');
  } finally { await f.close(); }
});

test('concurrent edit/delete keeps alternative; resolving it converges on every node', async () => {
  const f = await fixture(); const [a, b, c] = f.nodes;
  try {
    await pair(a, b); await pair(b, c, 'fixed');
    const first = a.store.edit({ title: 'base' }); await converge(f.nodes);
    const ra = a.store.edit({ id: first.entityId, title: 'offline A' });
    await delay(3); b.store.edit({ id: first.entityId, title: 'deleted B', deleted: true });
    await converge(f.nodes);
    assert.ok(f.nodes.every(n => n.store.summary().conflicts.length === 1));
    assert.equal(a.store.summary().entities[0].deleted, true);
    c.store.resolve(`task:${first.entityId}`, ra.revisionId);
    await converge(f.nodes);
    assert.ok(f.nodes.every(n => n.store.summary().conflicts.length === 0 && n.store.summary().entities[0].payload.title === 'offline A'));
  } finally { await f.close(); }
});

test('wrong/rotated codes fail, fixed code survives rotation; pairing budget persists', async () => {
  const f = await fixture(2); const [a, b] = f.nodes;
  try {
    const old = b.store.codes();
    b.store.codes(true);
    await assert.rejects(a.pair({ url: url(b), code: old.dynamic }), /incorrect code/);
    await pair(a, b, 'fixed');
    for (let i = 0; i < 3; i++) await assert.rejects(a.pair({ url: url(b), code: 'not-code' }), /code format/);
    const now = b.store.codes().dynamic;
    const wrong = now === '000000' ? '000001' : '000000';
    for (let i = 0; i < 3; i++) await assert.rejects(a.pair({ url: url(b), code: wrong }), /incorrect code/);
    await assert.rejects(a.pair({ url: url(b), code: now }), /rate limit/);
    const reloaded = new Store(join(f.dir, '1'), b.meta.datasetId);
    assert.equal(reloaded.meta.attempts.count, 5); reloaded.close();
    assert.equal(b.meta.fixedCode, old.fixed);
  } finally { await f.close(); }
});

test('rotation invalidates an already-started PAKE exchange', async () => {
  const f = await fixture(1); const [b] = f.nodes; const worker = new Pake();
  try {
    const id = randomUUID(), sid = randomUUID(), mode = 'dynamic', dataset = b.meta.datasetId;
    const aIdent = JSON.stringify(['todo-demo/1', dataset, mode, id]);
    const bIdent = JSON.stringify(['todo-demo/1', dataset, mode, b.meta.deviceId]);
    const a = await worker.call({ op: 'start', role: 'a', id: sid, code: b.store.codes().dynamic, a: aIdent, b: bIdent });
    const r = await b.pairStart({ id, datasetId: dataset, mode, message: a.message });
    const { key } = await worker.call({ op: 'finish', id: sid, message: r.message });
    b.store.codes(true);
    const binding = JSON.stringify([aIdent, bIdent, r.sid, a.message, r.message]);
    assert.throws(() => b.pairFinish({ sid: r.sid, proof: proof(key, `client:${binding}`) }), /rejected/);
    assert.equal(Object.keys(b.meta.peers).length, 0);
  } finally { worker.close(); await f.close(); }
});

test('encrypted transport rejects replay, tampering, foreign dataset and unauthenticated access', async () => {
  const f = await fixture(2); const [a, b] = f.nodes;
  try {
    await pair(a, b); await delay(250);
    const p = a.meta.peers[b.meta.deviceId], seq = ++p.send; a.store.save();
    const header = { from: a.meta.deviceId, to: b.meta.deviceId, dataset: a.meta.datasetId, seq, kind: 'request' };
    const envelope = seal(p.key, header, { op: 'status' });
    const response = await a.request(url(b), '/exchange', envelope);
    assert.equal(unseal(p.key, response).count, 0);
    await assert.rejects(a.request(url(b), '/exchange', envelope), /replay/);
    const changed = seal(p.key, { ...header, seq: seq + 1 }, { op: 'status' }); changed.data = 'AA==';
    await assert.rejects(a.request(url(b), '/exchange', changed));
    await assert.rejects(a.request(url(b), '/exchange', seal(p.key, { ...header, dataset: 'foreign', seq: seq + 1 }, {})));
    const denied = await fetch(`http://127.0.0.1:${b.options.adminPort}/control`, { method: 'POST', body: '{"op":"codes"}' });
    assert.equal(denied.status, 403);
  } finally { await f.close(); }
});

test('offline peer catches up, sender retries lost ACK without duplicating revisions', async () => {
  const f = await fixture(2); const [a, b] = f.nodes;
  try {
    await pair(a, b); b.paused = true;
    a.store.edit({ title: 'offline delivery' }); await a.syncAll();
    assert.equal(b.store.index.length, 0);
    b.paused = false;
    const original = a.request.bind(a); let lost = false;
    a.request = async (...args) => {
      const result = await original(...args);
      if (args[1] === '/exchange' && !lost && unseal(a.meta.peers[b.meta.deviceId].key, args[2]).op === 'put') {
        lost = true; throw new Error('injected lost ACK');
      }
      return result;
    };
    await converge(f.nodes); await converge(f.nodes);
    assert.equal(lost, true);
    assert.equal(b.store.index.length, 1);
  } finally { await f.close(); }
});

test('invalid batch rolls back, same-ID mutation fails, missing parents remain pending, future clock rejected', async () => {
  const f = await fixture(2); const [a, b] = f.nodes;
  try {
    const parent = a.store.edit({ title: 'parent' });
    const child = a.store.edit({ id: parent.entityId, title: 'child' });
    b.store.merge([child]); assert.equal(b.store.summary().entities.length, 0);
    b.store.merge([parent]); assert.equal(b.store.summary().entities[0].payload.title, 'child');
    assert.throws(() => b.store.merge([{ ...parent, payload: { ...parent.payload, title: 'mutated' } }]), /ID/);
    const root = b.store.root;
    assert.throws(() => b.store.merge([{ ...parent, revisionId: randomUUID() }, { invalid: true }]));
    assert.equal(b.store.root, root);
    assert.throws(() => b.store.merge([{ ...parent, revisionId: randomUUID(), modifiedAt: Date.now() + 3600000 }]), /future clock/);
  } finally { await f.close(); }
});

test('restart preserves revisions, paired credentials, replay counter and fixed code', async () => {
  const f = await fixture(2); const [a, b] = f.nodes;
  try {
    await pair(a, b, 'fixed'); a.store.edit({ title: 'durable' }); await converge(f.nodes);
    const root = b.store.root, code = b.meta.fixedCode, receive = b.meta.peers[a.meta.deviceId].receive;
    await b.close(); f.nodes.splice(1, 1);
    const restarted = await new DemoNode({ dir: join(f.dir, '1'), port: 0, adminPort: 0, mdns: false }).start();
    f.nodes.push(restarted);
    assert.equal(restarted.store.root, root);
    assert.equal(restarted.meta.fixedCode, code);
    assert.equal(restarted.meta.peers[a.meta.deviceId].receive, receive);
  } finally { await f.close(); }
});

test('1000 revisions paginate and converge; concurrent RPCs retain sequence ordering', async () => {
  const f = await fixture(2); const [a, b] = f.nodes;
  try {
    await pair(a, b);
    const template = a.store.edit({ title: 'template' });
    for (let base = 0; base < 1000; base += 100) {
      a.store.merge(Array.from({ length: 100 }, (_, j) => {
        const id = randomUUID();
        return { ...template, revisionId: randomUUID(), entityId: id, payload: { ...template.payload, id, title: `bulk ${base + j}` } };
      }));
    }
    await converge(f.nodes);
    assert.equal(b.store.index.length, 1001);
    await Promise.all(Array.from({ length: 10 }, () => a.rpc(b.meta.deviceId, 'status', {})));
  } finally { await f.close(); }
});

test('byte-limited batches transfer large records in both directions without overflowing HTTP limit', async () => {
  const f = await fixture(2); const [a, b] = f.nodes;
  try {
    await pair(a, b);
    const template = a.store.edit({ title: 'large template' });
    for (const n of [a, b]) {
      n.store.merge(Array.from({ length: 12 }, () => {
        const id = randomUUID();
        return { ...template, revisionId: randomUUID(), entityId: id, payload: { ...template.payload, id, detail: 'x'.repeat(40000) } };
      }));
    }
    await converge(f.nodes);
    assert.equal(b.store.index.length, 25);
  } finally { await f.close(); }
});
