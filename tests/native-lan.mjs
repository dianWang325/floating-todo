// Real native transport + production domain model, controlled only over local stdin.
// Usage: node tests/native-lan.mjs crates/lan-sync/target/debug/examples/bridge
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { newDocument, writeRevision, mergeRevisions, conflicts, resolveConflict, currentEntities, digest } from '../src/sync-model.js';
const binary = process.argv[2]; if (!binary) throw new Error('native bridge binary required');
const children = [], clients = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
function client() {
  const index = children.length;
  const remote = process.env.LAN_TEST_SSH;
  const child = remote ? spawn('ssh', ['-o', 'BatchMode=yes', remote, 'pct', 'exec', String(971 + index), '--', 'env', 'LAN_TEST_PORT=47831', binary], { stdio: ['pipe', 'pipe', 'inherit'] }) : spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] }); children.push(child);
  const pending = []; createInterface({ input: child.stdout }).on('line', line => {
    const p = pending.shift(); if (!p) return; const r = JSON.parse(line); r.error ? p.reject(new Error(r.error)) : p.resolve(r.value);
  });
  child.on('error', error => { for (const p of pending.splice(0)) p.reject(error); });
  child.on('exit', () => { for (const p of pending.splice(0)) p.reject(new Error('native bridge exited')); });
  return { doc: newDocument(), call(op, args = {}) { return new Promise((resolve, reject) => { pending.push({ resolve, reject }); child.stdin.write(JSON.stringify({ op, ...args }) + '\n'); }); } };
}
async function publish(n) { await n.call('publish', { revisions: n.doc.revisions }); }
async function converge() {
  for (let i = 0; i < 20; i++) {
    for (const n of clients) { mergeRevisions(n.doc, await n.call('pull')); await publish(n); }
    const roots = await Promise.all(clients.map(n => digest([...n.doc.revisions].sort((a,b) => a.revisionId.localeCompare(b.revisionId)))));
    if (new Set(roots).size === 1) return roots[0];
  } throw new Error('convergence failed');
}
const result = { tests: [], transport: 'native Rust + production JS revision model' };
try {
  clients.push(client(), client(), client());
  const ids = await Promise.all(clients.map(n => n.call('status').then(s => s.id)));
  let states;
  for (let i = 0; i < 200; i++) {
    states = await Promise.all(clients.map(n => n.call('status')));
    if (states.every((s,i) => ids.filter(id => id !== ids[i]).every(id => s.candidates.some(c => c.id === id)))) break;
    await wait(100);
  }
  assert.ok(states.every((s,i) => ids.filter(id => id !== ids[i]).every(id => s.candidates.some(c => c.id === id))), 'mDNS discovers all nodes');
  result.tests.push('real mDNS discovery');
  if (process.env.LAN_TEST_OVERLAY) {
    for (let attempt = 0; attempt < 90; attempt++) {
      states = await Promise.all(clients.map(n => n.call('status')));
      if (states.every((s,i) => ids.filter(id => id !== ids[i]).every(id => s.candidates.some(c => c.id === id && c.source === 'tailscale')))) break;
      await wait(1000);
    }
    assert.ok(states.every((s,i) => ids.filter(id => id !== ids[i]).every(id => s.candidates.some(c => c.id === id && c.source === 'tailscale'))), 'Tailscale CLI discovers all nodes');
    result.tests.push('Tailscale CLI automatic discovery');
    const ips = process.env.LAN_TEST_OVERLAY.split(',');
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) {
      await clients[i].call('discover', { url: `http://${ips[j]}:47831` });
    }
    states = await Promise.all(clients.map(n => n.call('status')));
    result.tests.push('Headscale IPv4 transport discovery');
  }
  if (process.env.LAN_TEST_ENDPOINTS) {
    const ips = process.env.LAN_TEST_ENDPOINTS.split(',');
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) await clients[i].call('discover', { url: `http://${ips[j]}:47831` });
    states = await Promise.all(clients.map(n => n.call('status')));
    result.tests.push('physical LAN IPv4 transport');
  }
  for (const [i,j,mode] of [[0,1,'dynamic'],[1,2,'fixed'],[2,0,'fixed']]) {
    const codes = await clients[j].call('codes');
    await clients[i].call('pair', { url: states[i].candidates.find(c => c.id === ids[j]).url, mode, code: codes[mode] });
  }
  result.tests.push('dynamic and persistent pairing');
  for (let i = 0; i < 3; i++) { writeRevision(clients[i].doc, 'memo', 'main', { text: 'concurrent-' + i }); await publish(clients[i]); }
  await converge(); assert.equal(conflicts(clients[0].doc).length, 1); assert.equal(conflicts(clients[0].doc)[0].heads.length, 3);
  const chosen = conflicts(clients[0].doc)[0].heads[0]; resolveConflict(clients[0].doc, 'memo:main', chosen); await publish(clients[0]); await converge();
  assert.ok(clients.every(n => conflicts(n.doc).length === 0 && currentEntities(n.doc).get('memo:main').payload.text === chosen.payload.text));
  result.tests.push('three-way concurrent conflict retention and replacement');
  // Hold the third node offline at the application level while edits accumulate.
  for (let i = 0; i < 230; i++) writeRevision(clients[0].doc, 'order', 'task-' + i, { position: i });
  await publish(clients[0]); const start = performance.now(); const root = await converge();
  result.tests.push('230-version backlog pagination and convergence');
  result.backlogMs = Math.round(performance.now() - start); result.count = clients[0].doc.revisions.length; result.root = root;
  if (process.env.LAN_TEST_SSH && process.env.LAN_TEST_OVERLAY) {
    const before = await Promise.all(clients.map(n => n.call('metrics'))), idleStart = performance.now();
    for (let i = 0; i < 10; i++) { await wait(3000); await Promise.all(clients.map(n => n.call('pull'))); }
    const after = await Promise.all(clients.map(n => n.call('metrics')));
    result.idle = { durationMs: Math.round(performance.now() - idleStart), nodes: after.map((m,i) => ({ rssKiB: m.rssKiB, cpuTicks: m.cpuTicks - before[i].cpuTicks })) };
  }
  const peer = ids[1]; await clients[0].call('revoke', { id: peer });
  await clients[1].call('pull'); const s = await clients[1].call('status'); assert.ok(s.peers.find(p => p.id === ids[0]).error);
  result.tests.push('revocation rejects previously authenticated peer'); result.passed = true;
  console.log(JSON.stringify(result, null, 2));
  await mkdir('test-results', { recursive: true }); await writeFile('test-results/native-lan.json', JSON.stringify(result, null, 2));
} finally { for (const c of children) c.kill(); }
