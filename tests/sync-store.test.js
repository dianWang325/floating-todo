import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncStore } from '../src/sync-store.js';
import { writeRevision, currentEntities, conflicts, dateInZone } from '../src/sync-model.js';
const snapshot = () => ({ selectedDay: 'today', projects: [], tags: [], colorCounters: { projects: 0, tags: 0 }, itemsByDay: { today: [], tomorrow: [], dayAfterTomorrow: [] }, recurringItems: [], settings: {}, memo: { text: '', expanded: false }, lastActiveDate: dateInZone() });
const task = id => ({ id, kind: 'one_off', title: id, detail: '', scheduledDate: dateInZone(), time: null, completed: false, createdAt: 1, projectId: null, tagIds: [] });
function server() {
  const dirs = new Set(['']), files = new Map();
  return { dirs, files, dropNextUpload: false, failStorage: false,
    bridge() {
      const remote = this; let local = null;
      return async (name, args = {}) => {
        if (name === 'storage_load') return local;
        if (name === 'storage_save') { if (remote.failStorage) throw new Error('disk full'); local = args.json; return; }
        if (name === 'sync_set_password') return;
        assert.equal(name, 'dav_request'); const { path, method, body } = args;
        if (method === 'MKCOL') { const exists = dirs.has(path); dirs.add(path); return { status: exists ? 405 : 201 }; }
        if (method === 'PUT') {
          if (files.has(path)) return { status: 412 };
          files.set(path, body);
          if (remote.dropNextUpload && path.includes('/changes/')) { remote.dropNextUpload = false; throw new Error('connection lost after server commit'); }
          return { status: 201 };
        }
        if (method === 'GET') return { status: files.has(path) ? 200 : 404, body: files.get(path) || '' };
        if (method === 'PROPFIND') {
          const entries = [...dirs, ...files.keys()].filter(p => p !== path && p.startsWith(path) && !p.slice(path.length).replace(/\/$/, '').includes('/')).map(p => ({ path: p, collection: dirs.has(p) }));
          return { status: dirs.has(path) ? 207 : 404, entries };
        }
        throw new Error('unexpected request');
      };
    }
  };
}
async function device(remote) {
  const store = new SyncStore({ native: true, invoke: remote.bridge() }); await store.init(snapshot(), '{}');
  Object.assign(store.doc.sync, { url: 'https://example.test/dav/', username: 'test', spaceId: 'test' }); return store;
}
test('two devices exchange edits through immutable WebDAV batches and converge', async () => {
  const remote = server(), a = await device(remote), b = await device(remote);
  writeRevision(a.doc, 'task', 'a', task('a')); writeRevision(b.doc, 'task', 'b', task('b'));
  await Promise.all([a.sync(true), b.sync(true)]); await a.sync(true); await b.sync(true);
  assert.ok(currentEntities(a.doc).has('task:b')); assert.ok(currentEntities(b.doc).has('task:a'));
  assert.equal(a.doc.outbox.length, 0); assert.equal(b.doc.outbox.length, 0);
  writeRevision(a.doc, 'task', 'a', { ...task('a'), title: 'from A' }, { now: Date.now() + 100 });
  writeRevision(b.doc, 'task', 'a', { ...task('a'), title: 'from B' }, { now: Date.now() + 200 });
  await a.sync(true); await b.sync(true); await a.sync(true);
  assert.equal(conflicts(a.doc).length, 1); assert.equal(conflicts(b.doc).length, 1);
  assert.equal(currentEntities(a.doc).get('task:a').payload.title, 'from B');
});
test('interrupted upload survives restart and retries the same batch without duplicates', async () => {
  const remote = server(), a = await device(remote);
  writeRevision(a.doc, 'task', 'a', task('a')); remote.dropNextUpload = true;
  await assert.rejects(a.sync(true)); const batch = a.doc.pendingBatch.batchId;
  const resumed = new SyncStore({ native: true, invoke: a.invoke }); await resumed.init(snapshot(), '{}');
  assert.equal(resumed.doc.pendingBatch.batchId, batch); await resumed.sync(true);
  assert.equal(resumed.doc.outbox.length, 0); assert.equal([...remote.files.keys()].filter(p => p.endsWith(batch + '.json')).length, 1);
});
test('local persistence failure prevents upload and recovers on explicit retry', async () => {
  const remote = server(), a = await device(remote); writeRevision(a.doc, 'task', 'a', task('a'));
  remote.failStorage = true; await assert.rejects(a.sync(true)); assert.equal(remote.files.size, 0);
  remote.failStorage = false; await a.sync(true); assert.equal(a.doc.outbox.length, 0);
});
test('corrupted remote batch is rejected without consuming pending edits', async () => {
  const remote = server(), a = await device(remote), b = await device(remote);
  writeRevision(a.doc, 'task', 'a', task('a')); await a.sync(true);
  const path = [...remote.files.keys()].find(p => p.includes('/changes/'));
  const batch = JSON.parse(remote.files.get(path)); batch.revisions[0].payload.text = 'tampered'; remote.files.set(path, JSON.stringify(batch));
  const count = b.doc.outbox.length; await assert.rejects(b.sync(true), /校验/); assert.equal(b.doc.outbox.length, count);
});
test('new local edits made during upload remain queued and are eventually uploaded', async () => {
  const remote = server(), a = await device(remote), bridge = a.invoke; let injected = false;
  writeRevision(a.doc, 'task', 'initial', task('initial'));
  a.invoke = async (name, args) => {
    if (!injected && name === 'dav_request' && args.method === 'PUT' && args.path.includes('/changes/')) { injected = true; writeRevision(a.doc, 'task', 'during', task('during')); }
    return bridge(name, args);
  };
  await a.sync(true); const b = await device(remote); await b.sync(true);
  assert.ok(currentEntities(b.doc).has('task:during')); assert.equal(a.doc.outbox.length, 0);
});
test('the first UI edit after initialization is tracked independently from the baseline', async () => {
  const remote = server(), store = new SyncStore({ native: true, invoke: remote.bridge() });
  const view = await store.init(snapshot(), '{}');
  view.itemsByDay.today.push(task('first')); store.commit(view); await store.queue;
  assert.ok(currentEntities(store.doc).has('task:first'));
  const restarted = new SyncStore({ native: true, invoke: store.invoke }); const loaded = await restarted.init(snapshot(), '{}');
  assert.equal(loaded.itemsByDay.today[0].id, 'first');
});
