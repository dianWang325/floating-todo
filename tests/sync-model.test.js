import test from 'node:test';
import assert from 'node:assert/strict';
import { newDocument, migrateSnapshot, projectView, writeRevision, mergeRevisions, currentEntities, conflicts, resolveConflict, commitView, setTaskOrder, exportDocument, importRevisionsAsEdits, canonical } from '../src/sync-model.js';
const base = () => ({ schemaVersion: 2, selectedDay: 'today', projects: [], tags: [], colorCounters: { projects: 0, tags: 0 }, itemsByDay: { today: [], tomorrow: [], dayAfterTomorrow: [] }, recurringItems: [], settings: { opacity: .7 }, memo: { text: '', expanded: false }, lastActiveDate: '2026-10-20' });
const task = (id, extra = {}) => ({ id, title: id, detail: '', time: null, completed: false, createdAt: 1, projectId: null, tagIds: [], ...extra });
const payload = (id, extra = {}) => ({ ...task(id), kind: 'one_off', scheduledDate: '2026-10-20', ...extra });
const fork = doc => ({ ...structuredClone(doc), deviceId: crypto.randomUUID(), outbox: [] });
const active = (doc, id) => currentEntities(doc).get(`task:${id}`);

test('migration deduplicates identical backups and does not fabricate modification times', async () => {
  const s = base(); s.itemsByDay.today.push(task('a'));
  const a = await migrateSnapshot(s), b = await migrateSnapshot(s);
  assert.notEqual(a.deviceId, b.deviceId); assert.equal(mergeRevisions(a, b.revisions), 0);
  assert.equal(active(a, 'a').modifiedAt, 0); assert.equal(conflicts(a).length, 0);
});
test('different tasks merge; concurrent edits converge in either delivery order and preserve all branches', () => {
  const root = newDocument(); writeRevision(root, 'task', 'a', payload('a'), { now: 100 });
  const devices = [fork(root), fork(root), fork(root)];
  devices.forEach((doc, i) => writeRevision(doc, 'task', 'a', payload('a', { title: `edit ${i}` }), { now: 200 + i }));
  writeRevision(devices[0], 'task', 'b', payload('b'));
  const x = newDocument(), y = newDocument();
  devices.forEach(d => mergeRevisions(x, d.revisions)); devices.reverse().forEach(d => mergeRevisions(y, d.revisions));
  assert.equal(active(x, 'a').payload.title, 'edit 2'); assert.equal(active(y, 'a').revisionId, active(x, 'a').revisionId);
  assert.equal(conflicts(x)[0].heads.length, 3); assert.ok(active(x, 'b'));
  const c = conflicts(x)[0]; resolveConflict(x, c.key, c.heads[0]); mergeRevisions(y, x.revisions);
  assert.equal(conflicts(y).length, 0); assert.equal(active(y, 'a').payload.title, 'edit 0');
});
test('causal updates win after clock rollback; editing does not silently discard other conflicts', () => {
  const doc = newDocument(); writeRevision(doc, 'task', 'a', payload('a'), { now: 1000 });
  const other = fork(doc); writeRevision(other, 'task', 'a', payload('a', { title: 'other' }), { now: 2000 });
  writeRevision(doc, 'task', 'a', payload('a', { title: 'local' }), { now: 10 });
  assert.equal(active(doc, 'a').payload.title, 'local'); mergeRevisions(doc, other.revisions);
  writeRevision(doc, 'task', 'a', payload('a', { title: 'third edit' }), { now: 5 });
  assert.equal(active(doc, 'a').payload.title, 'third edit'); assert.equal(conflicts(doc).length, 1);
});
test('delete/edit conflict can restore a task and deletion state stays recoverable', () => {
  const doc = newDocument(); writeRevision(doc, 'task', 'a', payload('a'), { now: 1 }); const peer = fork(doc);
  writeRevision(doc, 'task', 'a', payload('a'), { deleted: true, now: 10 });
  writeRevision(peer, 'task', 'a', payload('a', { title: 'restored' }), { now: 11 }); mergeRevisions(doc, peer.revisions);
  assert.equal(active(doc, 'a').deleted, false); assert.ok(conflicts(doc)[0].heads.some(r => r.deleted));
});
test('out of order revisions wait for parents; duplicate and tampered batches are atomic', () => {
  const source = newDocument(); const first = writeRevision(source, 'task', 'a', payload('a'));
  const second = writeRevision(source, 'task', 'a', payload('a', { completed: true })); const target = newDocument();
  mergeRevisions(target, [second]); assert.equal(currentEntities(target).size, 0);
  mergeRevisions(target, [first]); assert.equal(active(target, 'a').payload.completed, true);
  assert.equal(mergeRevisions(target, source.revisions), 0);
  const invalid = { ...first, payload: { ...first.payload, title: 'tampered' } }, count = target.revisions.length;
  assert.throws(() => mergeRevisions(target, [invalid])); assert.equal(target.revisions.length, count);
});
test('rollover is a projection: completed history remains, overdue dates remain unchanged', async () => {
  const s = base(); s.itemsByDay.today = [task('open'), task('done', { completed: true })]; s.itemsByDay.tomorrow = [task('tomorrow')];
  const doc = await migrateSnapshot(s), count = doc.revisions.length;
  const view = projectView(doc, s, '2026-10-21');
  assert.deepEqual(new Set(view.itemsByDay.today.map(t => t.id)), new Set(['open', 'tomorrow']));
  assert.equal(view.itemsByDay.today.find(t => t.id === 'open').scheduledDate, '2026-10-20');
  assert.equal(doc.revisions.length, count); assert.ok(active(doc, 'done'));
  const after = structuredClone(view); after.itemsByDay.today[0].title = 'updated'; commitView(doc, view, after);
  assert.ok(!active(doc, 'done').deleted);
});
test('daily completions merge by date, cancel overrides same day, streak is derived', async () => {
  const s = base(); s.recurringItems = [task('daily')]; const doc = await migrateSnapshot(s);
  const a = fork(doc), b = fork(doc);
  writeRevision(a, 'completion', 'daily/2026-10-20', { taskId: 'daily', date: '2026-10-20', completed: true });
  writeRevision(b, 'completion', 'daily/2026-10-21', { taskId: 'daily', date: '2026-10-21', completed: true });
  mergeRevisions(a, b.revisions); assert.equal(projectView(a, s, '2026-10-21').recurringItems[0].streak, 2);
  writeRevision(a, 'completion', 'daily/2026-10-21', { taskId: 'daily', date: '2026-10-21', completed: false });
  assert.equal(projectView(a, s, '2026-10-21').recurringItems[0].completed, false);
});
test('legacy streak is retained without inventing historical check-ins', async () => {
  const s = base(); s.recurringItems = [task('daily', { completed: true, streak: 8, lastDone: '2026-10-20' })];
  const doc = await migrateSnapshot(s);
  assert.equal(doc.revisions.filter(r => r.entityType === 'completion').length, 1);
  assert.equal(projectView(doc, s, '2026-10-20').recurringItems[0].streak, 8);
  writeRevision(doc, 'completion', 'daily/2026-10-21', { taskId: 'daily', date: '2026-10-21', completed: true });
  assert.equal(projectView(doc, s, '2026-10-21').recurringItems[0].streak, 9);
});
test('local preferences and notification receipts never create synchronized edits', async () => {
  const s = base(); s.itemsByDay.today = [task('a', { time: '12:00' })]; const doc = await migrateSnapshot(s);
  const before = projectView(doc, s, '2026-10-20'), after = structuredClone(before), count = doc.revisions.length;
  after.settings.opacity = .4; after.memo.expanded = true; after.selectedDay = 'tomorrow'; after.itemsByDay.today[0].notified = true;
  commitView(doc, before, after); assert.equal(doc.revisions.length, count);
  const peer = fork(doc); peer.receipts = {}; peer.local = {};
  assert.equal(projectView(peer, s, '2026-10-20').itemsByDay.today[0].notified, false);
});
test('manual ordering is independent of content and survives a peer title edit', async () => {
  const s = base(); s.itemsByDay.today = [task('a'), task('b'), task('c')]; const doc = await migrateSnapshot(s), peer = fork(doc);
  setTaskOrder(doc, ['c', 'a', 'b'], 'c'); writeRevision(peer, 'task', 'c', payload('c', { title: 'edited' })); mergeRevisions(doc, peer.revisions);
  assert.deepEqual(projectView(doc, s, '2026-10-20').itemsByDay.today.map(t => t.id), ['c', 'a', 'b']); assert.equal(conflicts(doc).length, 0);
});
test('same name categories converge and deletion clears stale offline references', () => {
  const doc = newDocument(); writeRevision(doc, 'projects', 'p1', { id: 'p1', name: 'Work', color: '#123456' }, { now: 1 });
  writeRevision(doc, 'projects', 'p2', { id: 'p2', name: 'work', color: '#abcdef' }, { now: 2 });
  writeRevision(doc, 'task', 'a', payload('a', { projectId: 'p2' }), { now: 3 });
  let view = projectView(doc, base(), '2026-10-20'); assert.equal(view.projects.length, 1); assert.equal(view.itemsByDay.today[0].projectId, 'p1');
  writeRevision(doc, 'projects', 'p1', { id: 'p1', name: 'work', color: '#abcdef' }, { deleted: true, now: 4 });
  view = projectView(doc, base(), '2026-10-20'); assert.equal(view.projects.length, 0); assert.equal(view.itemsByDay.today[0].projectId, null);
});
test('portable backup excludes device credentials/identity and imports as new versions', async () => {
  const s = base(); s.itemsByDay.today = [task('a')]; const doc = await migrateSnapshot(s); doc.sync.url = 'https://private.example';
  const backup = exportDocument(doc, projectView(doc, s, '2026-10-20'));
  assert.equal(backup.schemaVersion, 3); assert.ok(!JSON.stringify(backup).includes('private.example'));
  const peer = newDocument(); writeRevision(peer, 'task', 'local', payload('local')); const id = peer.deviceId;
  importRevisionsAsEdits(peer, backup.syncData.revisions); assert.equal(peer.deviceId, id); assert.ok(active(peer, 'local')); assert.ok(active(peer, 'a'));
});
test('different colors for concurrent same-name categories remain recoverable and can be resolved', () => {
  const doc = newDocument();
  writeRevision(doc, 'projects', 'p1', { id: 'p1', name: 'Work', color: '#123456' }, { now: 1 });
  const peer = newDocument(); writeRevision(peer, 'projects', 'p2', { id: 'p2', name: 'Work', color: '#abcdef' }, { now: 2 });
  mergeRevisions(doc, peer.revisions);
  const conflict = conflicts(doc).find(c => c.key === 'projects:p1'); assert.ok(conflict);
  resolveConflict(doc, conflict.key, conflict.heads[0]);
  assert.equal(conflicts(doc).length, 0); assert.equal(projectView(doc, base()).projects[0].color, '#123456');
  mergeRevisions(peer, doc.revisions); assert.equal(conflicts(peer).length, 0); assert.equal(projectView(peer, base()).projects[0].color, '#123456');
});
test('undoing a migrated completed habit retains the previous streak after reload', async () => {
  const s = base(); s.recurringItems = [task('daily', { completed: true, streak: 8, lastDone: '2026-10-20' })];
  const doc = await migrateSnapshot(s); writeRevision(doc, 'completion', 'daily/2026-10-20', { taskId: 'daily', date: '2026-10-20', completed: false });
  assert.equal(projectView(doc, s, '2026-10-20').recurringItems[0].streak, 7);
  assert.equal(projectView(doc, s, '2026-10-21').recurringItems[0].streak, 0);
});
test('a new empty device does not create an empty memo conflict on first sync', async () => {
  const doc = await migrateSnapshot(base()); const peer = newDocument(); writeRevision(peer, 'memo', 'main', { text: 'existing memo' });
  mergeRevisions(doc, peer.revisions); assert.equal(conflicts(doc).length, 0); assert.equal(projectView(doc, base()).memo.text, 'existing memo');
});
test('identical concurrent edits do not become a spurious conflict after the next edit', () => {
  const doc = newDocument(); writeRevision(doc, 'task', 'a', payload('a'), { now: 1 }); const peer = fork(doc);
  writeRevision(doc, 'task', 'a', payload('a', { completed: true }), { now: 2 }); writeRevision(peer, 'task', 'a', payload('a', { completed: true }), { now: 3 });
  mergeRevisions(doc, peer.revisions); assert.equal(conflicts(doc).length, 0);
  writeRevision(doc, 'task', 'a', payload('a', { completed: true, title: 'next edit' }), { now: 4 }); assert.equal(conflicts(doc).length, 0);
});
